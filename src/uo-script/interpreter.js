const { parseScript } = require('./parser');

class ScriptRuntimeError extends Error {}
class ScriptBreak extends Error {}
class ScriptContinue extends Error {}
class ScriptStop extends Error {}

function createContext({ adapter = {}, control = null, signal = null, maxIterations = 10000, onLog = () => {} } = {}) {
  return { adapter, control, signal, maxIterations, iterations: 0, variables: {}, aliases: {}, lists: {}, timers: {}, onLog };
}

async function checkpoint(context) {
  if (context.control?.checkpoint) await context.control.checkpoint();
  if (context.signal?.aborted) throw new ScriptRuntimeError('스크립트 실행이 취소되었습니다.');
}

function value(node, context) {
  if (node.type === 'literal') return node.value;
  if (node.type === 'identifier') {
    if (Object.prototype.hasOwnProperty.call(context.variables, node.name)) return context.variables[node.name];
    const lower = node.name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(context.variables, lower)) return context.variables[lower];
    return context.adapter.value ? context.adapter.value(node.name, context) : node.name;
  }
  if (node.type === 'call') return context.adapter.call ? context.adapter.call(node.name, node.args.map((item) => value(item, context)), context) : false;
  if (node.type === 'not') return !truth(value(node.expression, context));
  if (node.type === 'compare') {
    const left = value(node.left, context); const right = value(node.right, context);
    switch (node.operator) {
      case '<': return left < right; case '<=': return left <= right; case '>': return left > right; case '>=': return left >= right;
      case '=': case '==': return left === right; case '!=': case '<>': return left !== right; default: throw new ScriptRuntimeError(`지원하지 않는 비교 연산자: ${node.operator}`);
    }
  }
  if (node.type === 'and') return truth(value(node.left, context)) && truth(value(node.right, context));
  if (node.type === 'or') return truth(value(node.left, context)) || truth(value(node.right, context));
  throw new ScriptRuntimeError(`알 수 없는 표현식: ${node.type}`);
}

function truth(result) { return Boolean(result); }

async function command(node, context) {
  await checkpoint(context);
  const args = node.args;
  switch (node.name) {
    case 'pause': {
      const duration = Number(args[0]);
      if (!Number.isFinite(duration) || duration < 0) throw new ScriptRuntimeError('pause에는 0 이상의 시간이 필요합니다.');
      if (context.control?.wait) await context.control.wait(duration);
      else await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => { if (settled) return; settled = true; context.signal?.removeEventListener('abort', cancel); callback(); };
        const timer = setTimeout(() => finish(resolve), duration);
        const cancel = () => finish(() => { clearTimeout(timer); reject(new ScriptRuntimeError('스크립트 실행이 취소되었습니다.')); });
        if (context.signal) {
          if (context.signal.aborted) cancel();
          else context.signal.addEventListener('abort', cancel, { once: true });
        }
      });
      return;
    }
    case 'stop': throw new ScriptStop('스크립트가 stop 명령으로 중단되었습니다.');
    case 'break': throw new ScriptBreak();
    case 'continue': throw new ScriptContinue();
    case 'set': {
      if (!args[0]) throw new ScriptRuntimeError('set에는 변수 이름이 필요합니다.');
      context.variables[args[0]] = args[1]; return;
    }
    case 'setalias': context.aliases[args[0]] = args[1]; return;
    case 'unsetalias': delete context.aliases[args[0]]; return;
    case 'createlist': context.lists[args[0]] ??= []; return;
    case 'clearlist': context.lists[args[0]] = []; return;
    case 'pushlist': (context.lists[args[0]] ??= []).push(args[1]); return;
    case 'poplist': {
      const list = context.lists[args[0]] ?? [];
      if (args[1] === 'front') list.shift(); else list.pop();
      return;
    }
    case 'createtimer': context.timers[args[0]] = Date.now(); return;
    case 'settimer': context.timers[args[0]] = Date.now() - Number(args[1] || 0); return;
    case 'removetimer': delete context.timers[args[0]]; return;
    default:
      if (typeof context.adapter.command !== 'function') throw new ScriptRuntimeError(`지원하지 않는 명령: ${node.name}`);
      await context.adapter.command(node.name, args, context);
  }
}

async function executeNodes(nodes, context) {
  for (const node of nodes) {
    await checkpoint(context);
    if (++context.iterations > context.maxIterations) throw new ScriptRuntimeError('스크립트 loop 실행 한도를 초과했습니다.');
    if (node.type === 'command') { await command(node, context); continue; }
    if (node.type === 'if') {
      const branch = node.branches.find((item) => truth(value(item.test, context)));
      await executeNodes(branch ? branch.body : node.alternate, context); continue;
    }
    if (node.type === 'while') {
      while (truth(value(node.test, context))) {
        try { await executeNodes(node.body, context); } catch (error) {
          if (error instanceof ScriptBreak) break;
          if (error instanceof ScriptContinue) continue;
          throw error;
        }
      }
      continue;
    }
    if (node.type === 'for') {
      const variable = node.args[1] === 'to' ? '__for_index' : node.args[0];
      const start = node.args[1] === 'to' ? node.args[0] : node.args[1];
      const marker = node.args[1] === 'to' ? node.args[1] : node.args[2];
      const finish = node.args[1] === 'to' ? node.args[2] : node.args[3];
      if (!variable || marker !== 'to' || finish === undefined) throw new ScriptRuntimeError('for 문법은 for 시작 to 끝 또는 for 변수 시작 to 끝 형식이어야 합니다.');
      for (let current = Number(start); current <= Number(finish); current += 1) {
        context.variables[variable] = current;
        try { await executeNodes(node.body, context); } catch (error) {
          if (error instanceof ScriptBreak) break;
          if (error instanceof ScriptContinue) continue;
          throw error;
        }
      }
      continue;
    }
    throw new ScriptRuntimeError(`실행할 수 없는 AST 노드: ${node.type}`);
  }
}

async function runScript(source, options = {}) {
  const ast = parseScript(source);
  const context = options.context || createContext(options);
  await executeNodes(ast.body, context);
  return { ast, context };
}

module.exports = { ScriptRuntimeError, ScriptBreak, ScriptContinue, ScriptStop, createContext, runScript, executeNodes };