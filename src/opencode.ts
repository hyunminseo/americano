// 내장 opencode 서버와의 연결·로그인을 담당한다. Electron에 의존하지 않고
// baseUrl + Basic 인증 fetch를 주입받아 동작하므로 단위 테스트가 가능하다.
export interface OpencodeV2Client {
  global: { health(): Promise<{ data?: { version?: string; healthy?: boolean }; error?: unknown }> };
  provider: {
    list(): Promise<{ data?: { all?: { id: string; name?: string }[]; default?: Record<string, string>; connected?: string[] }; error?: unknown }>;
    auth(): Promise<{ data?: Record<string, { type: 'oauth' | 'api'; label: string; prompts?: { type: string; key: string; message: string; placeholder?: string }[] }[]>; error?: unknown }>;
    oauth: {
      authorize(params: { providerID: string; method?: number }): Promise<{ data?: { url: string; method: 'auto' | 'code'; instructions: string }; error?: unknown }>;
      callback(params: { providerID: string; code?: string }): Promise<{ data?: unknown; error?: unknown }>;
    };
  };
  auth: {
    set(params: { providerID: string; auth: Record<string, unknown> }): Promise<{ data?: unknown; error?: unknown }>;
  };
  session: {
    create(params: { title: string }): Promise<{ data?: { id: string }; error?: unknown }>;
    prompt(params: {
      sessionID: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      system?: string;
      parts?: { type: 'text'; text: string }[];
      format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number };
    }): Promise<{ data?: { info?: { structured?: unknown; error?: { name?: string; message?: string } } }; error?: unknown }>;
    delete(params: { sessionID: string }): Promise<unknown>;
  };
  config: {
    providers(): Promise<{ data?: { default?: Record<string, string> }; error?: unknown }>;
  };
}

export function authedFetch(password: string): typeof fetch {
  const header = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  return ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', header);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

export async function connectOpencode(baseUrl: string, customFetch?: typeof fetch): Promise<OpencodeV2Client> {
  const sdk = await import('@opencode-ai/sdk/v2/client') as typeof import('@opencode-ai/sdk/v2/client', { with: { 'resolution-mode': 'import' } });
  const config: Record<string, unknown> = { baseUrl };
  if (customFetch) config.fetch = customFetch;
  return sdk.createOpencodeClient(config) as unknown as OpencodeV2Client;
}

export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  methods: { type: 'oauth' | 'api'; label: string; prompts?: { type: string; key: string; message: string; placeholder?: string }[] }[];
  defaultModel?: string;
}

export async function serverVersion(client: OpencodeV2Client): Promise<string> {
  const health = await client.global.health();
  if (health.error) throw new Error(`서버 오류: ${JSON.stringify(health.error).slice(0, 200)}`);
  return `opencode ${health.data?.version || ''}`.trim();
}

const VISIBLE_PROVIDERS = ['opencode-go'];

export async function listProviders(client: OpencodeV2Client, allowlist?: string[]): Promise<ProviderInfo[]> {
  const [listed, methods, defaults] = await Promise.all([
    client.provider.list(),
    client.provider.auth(),
    client.config.providers().catch(() => ({ data: undefined })),
  ]);
  if (listed.error) throw new Error(`공급자 목록 실패: ${JSON.stringify(listed.error).slice(0, 200)}`);
  const connected = new Set(listed.data?.connected || []);
  return (listed.data?.all || [])
    .filter((provider) => !allowlist || allowlist.includes(provider.id))
    .map((provider) => ({
    id: provider.id,
    name: provider.name || provider.id,
    connected: connected.has(provider.id),
    methods: (methods.data || {})[provider.id] || [],
    defaultModel: defaults.data?.default?.[provider.id],
  }));
}

// OAuth 로그인 시작: 브라우저에 열 URL과 방식을 돌려준다.
// method 0(기본 방식)을 지정해야 서버가 authorize URL을 만든다.
export async function startLogin(client: OpencodeV2Client, providerID: string): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
  const authorized = await client.provider.oauth.authorize({ providerID, method: 0 });
  if (authorized.error || !authorized.data?.url) throw new Error(`로그인 시작 실패: ${JSON.stringify(authorized.error || 'no url').slice(0, 200)}`);
  return authorized.data;
}

export async function finishLogin(client: OpencodeV2Client, providerID: string, code?: string): Promise<void> {
  const done = await client.provider.oauth.callback(code ? { providerID, code } : { providerID });
  if (done.error) throw new Error(`로그인 완료 실패: ${JSON.stringify(done.error).slice(0, 200)}`);
}

export async function setApiKey(client: OpencodeV2Client, providerID: string, fields: Record<string, string>): Promise<void> {
  const done = await client.auth.set({ providerID, auth: { type: 'api', ...fields } });
  if (done.error) throw new Error(`키 저장 실패: ${JSON.stringify(done.error).slice(0, 200)}`);
}

export async function isConnected(client: OpencodeV2Client, providerID: string): Promise<boolean> {
  const listed = await client.provider.list();
  return (listed.data?.connected || []).includes(providerID);
}
