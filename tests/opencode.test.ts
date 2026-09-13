const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { authedFetch, connectOpencode, serverVersion, listProviders, startLogin } = require('../src/opencode.js');

test('내장 서버 인증 fetch가 Basic 헤더를 붙인다', async () => {
  const seen: Record<string, string> = {};
  const original = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (async (input: string, init: { headers?: HeadersInit }) => {
    new Headers(init.headers).forEach((value, key) => { seen[key] = value; });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    await authedFetch('pw123')('http://x/', {});
    assert.equal(seen.authorization, 'Basic ' + Buffer.from('opencode:pw123').toString('base64'));
  } finally {
    globalThis.fetch = original;
  }
});

test('내장 바이너리 serve·목록·로그인 시작이 동작한다', async (t: any) => {
  const exe = path.join(__dirname, '..', '..', 'vendor', 'opencode', 'opencode.exe');
  if (!fs.existsSync(exe)) { t.skip('vendor 바이너리 없음'); return; }
  const password = crypto.randomBytes(12).toString('base64');
  const proc = spawn(exe, ['serve', '--port', '4299', '--hostname', '127.0.0.1'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, OPENCODE_SERVER_PASSWORD: password } });
  t.after(() => { proc.kill(); });
  const header = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const f = ((input: string, init: Record<string, unknown> = {}) => fetch(input, { ...init, headers: { ...((init.headers as Record<string, string>) || {}), Authorization: header } })) as unknown as typeof fetch;
  let client = null;
  for (let i = 0; i < 20 && !client; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const candidate = await connectOpencode('http://127.0.0.1:4299', f);
      await serverVersion(candidate);
      client = candidate;
    } catch { /* 재시도 */ }
  }
  assert(client, '내장 서버가 뜨지 않았습니다.');
  const version = await serverVersion(client);
  assert.match(version, /opencode/);
  const providers = await listProviders(client);
  assert(providers.length > 0, '공급자가 없습니다.');
  const filtered = await listProviders(client, ['opencode-go']);
  assert.deepEqual(filtered.map((p: { id: string }) => p.id), ['opencode-go']);
  const target = providers.find((p: { methods: { type: string }[] }) => p.methods.some((m: { type: string }) => m.type === 'oauth'));
  assert(target, 'oauth 공급자가 없습니다.');
  const started = await startLogin(client, (target as { id: string }).id);
  assert(started.url.startsWith('https://'), 'authorize URL이 아닙니다.');
  assert(['auto', 'code'].includes(started.method), '방식이 auto/code가 아닙니다.');
});
