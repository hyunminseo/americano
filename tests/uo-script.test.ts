import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, ScriptSyntaxError } from '../src/uo-script/parser.js';
import type { AstNode } from '../src/uo-script/parser.js';
import { createContext, runScript, ScriptStop, ScriptRuntimeError } from '../src/uo-script/interpreter.js';

test('parses Americano Script conditions, elseif, while, and commands', () => {
  const ast = parseScript(`
    if skill 'magery' < 100
      while mana < maxmana
        pause 1
      endwhile
    elseif @injournal 'complete'
      stop
    else
      pause 2
    endif
  `);
  assert.equal(ast.body[0].type, 'if');
  const first = ast.body[0] as Extract<AstNode, { type: 'if' }>;
  assert.equal(first.branches.length, 2);
  assert.equal((first.branches[0].body[0] as Extract<AstNode, { type: 'while' }>).type, 'while');
  assert.equal((first.alternate[0] as Extract<AstNode, { type: 'command' }>).name, 'pause');
  const compound = parseScript("if not @findobject 'a' and not @findobject 'b'\n  stop\nendif");
  const compoundIf = compound.body[0] as unknown as { branches: { test: { type: string } }[] };
  assert.equal(compoundIf.branches[0].test.type, 'and');
});

test('runs state expressions, lists, and bounded loops through an adapter', async () => {
  const calls: any[] = [];
  const context = createContext({
    adapter: {
      value: (name: string) => ({ mana: 0, maxmana: 2 }[name]),
      call: (name: string, args: any) => name === 'skill' && args[0] === 'magery' ? 50 : false,
      command: async (name: string, args: any): Promise<void> => { calls.push([name, args]); },
    },
    maxIterations: 20,
  });
  await runScript(`
    set total 0
    createlist 'steps'
    pushlist 'steps' 'ready'
    for 1 to 2
      set total 2
    endfor
    if skill 'magery' < 100
      pause 0
    endif
  `, { context });
  assert.equal(context.variables.total, 2);
  assert.deepEqual(context.lists.steps, ['ready']);
  assert.deepEqual(calls, []);
});

test('rejects unclosed blocks and unsupported runtime commands', async () => {
  assert.throws(() => parseScript('if mana < maxmana\n  pause 1'), ScriptSyntaxError);
  await assert.rejects(() => runScript('unknown_command', { context: createContext() }), ScriptRuntimeError);
  await assert.rejects(() => runScript('stop', { context: createContext() }), ScriptStop);
});

test('bounds unchanged while loops and aborts standalone pauses', async () => {
  await assert.rejects(() => runScript('while true\n  pause 0\nendwhile', { maxIterations: 8 }), /loop 실행 한도/);
  const controller = new AbortController();
  const running = runScript('pause 60000', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => running, /취소되었습니다/);
});
