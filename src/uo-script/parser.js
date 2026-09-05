class ScriptSyntaxError extends Error {
  constructor(message, line, column = 1) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'ScriptSyntaxError';
    this.line = line;
    this.column = column;
  }
}

function tokenize(source, line) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    if (source[index] === '/' && source[index + 1] === '/') break;
    const column = index + 1;
    if (source[index] === "'" || source[index] === '"') {
      const quote = source[index++]; let value = '';
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        value += source[index++];
      }
      if (source[index] !== quote) throw new ScriptSyntaxError('닫히지 않은 문자열', line, column);
      index += 1; tokens.push({ type: 'string', value, column }); continue;
    }
    const operator = source.slice(index).match(/^(<=|>=|==|!=|<>|<|>|=)/)?.[1];
    if (operator) { tokens.push({ type: 'operator', value: operator, column }); index += operator.length; continue; }
    const match = source.slice(index).match(/^[^\s<>=]+/);
    if (!match) throw new ScriptSyntaxError(`해석할 수 없는 문자: ${source[index]}`, line, column);
    const value = match[0]; tokens.push({ type: /^-?\d+(?:\.\d+)?$/.test(value) ? 'number' : 'word', value, column }); index += value.length;
  }
  return tokens;
}

const blockEnd = new Set(['endif', 'else', 'elseif', 'endwhile', 'endfor']);
const comparison = new Set(['<', '<=', '>', '>=', '==', '=', '!=', '<>']);

function value(tokens, line) {
  const token = tokens.shift();
  if (!token) throw new ScriptSyntaxError('값이 필요합니다.', line);
  if (token.type === 'string') return { type: 'literal', value: token.value };
  if (token.type === 'number') return { type: 'literal', value: Number(token.value) };
  return { type: 'identifier', name: token.value };
}

function primary(tokens, line) {
  if (tokens[0]?.value?.toLowerCase() === 'not') { tokens.shift(); return { type: 'not', expression: primary(tokens, line) }; }
  const first = value(tokens, line);
  const args = [];
  while (tokens[0] && !comparison.has(tokens[0].value) && !['and', 'or'].includes(tokens[0].value.toLowerCase())) args.push(value(tokens, line));
  const left = args.length ? { type: 'call', name: first.name, args } : first;
  if (!tokens[0] || !comparison.has(tokens[0].value)) return left;
  const operator = tokens.shift().value;
  return { type: 'compare', operator, left, right: primary(tokens, line) };
}

function expression(tokens, line) {
  let left = primary(tokens, line);
  while (tokens[0] && ['and', 'or'].includes(tokens[0].value.toLowerCase())) {
    const operator = tokens.shift().value.toLowerCase();
    left = { type: operator, left, right: primary(tokens, line) };
  }
  return left;
}

function command(tokens, line) {
  const head = tokens.shift();
  if (!head) throw new ScriptSyntaxError('명령이 필요합니다.', line);
  return { type: 'command', name: head.value.toLowerCase(), args: tokens.map((token) => token.type === 'string' ? token.value : token.type === 'number' ? Number(token.value) : token.value), line };
}

function parseScript(source) {
  if (typeof source !== 'string') throw new TypeError('스크립트는 문자열이어야 합니다.');
  const lines = source.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 })).filter(({ text }) => text.trim() && !text.trim().startsWith('//'));
  let cursor = 0;
  function block(endWords = new Set()) {
    const body = [];
    while (cursor < lines.length) {
      const current = lines[cursor]; const tokens = tokenize(current.text, current.line); const head = tokens[0]?.value.toLowerCase();
      if (!head) { cursor += 1; continue; }
      if (endWords.has(head)) return { body, end: head };
      if (blockEnd.has(head)) throw new ScriptSyntaxError(`예상하지 않은 ${head}`, current.line, tokens[0].column);
      cursor += 1;
      if (head === 'if') {
        const branches = [{ test: expression(tokens.slice(1), current.line), body: null }];
        let marker = block(new Set(['elseif', 'else', 'endif']));
        branches[0].body = marker.body;
        while (marker.end === 'elseif') {
          const branchLine = lines[cursor];
          cursor += 1;
          const branch = block(new Set(['elseif', 'else', 'endif']));
          branches.push({ test: expression(tokenize(branchLine.text, branchLine.line).slice(1), branchLine.line), body: branch.body });
          marker = branch;
        }
        let alternate = [];
        if (marker.end === 'else') { cursor += 1; alternate = block(new Set(['endif'])).body; marker = { end: 'endif' }; }
        if (marker.end !== 'endif') throw new ScriptSyntaxError('if 블록에 endif가 필요합니다.', current.line);
        cursor += 1;
        body.push({ type: 'if', branches, alternate, line: current.line });
      } else if (head === 'while') {
        const nested = block(new Set(['endwhile']));
        if (nested.end !== 'endwhile') throw new ScriptSyntaxError('while 블록에 endwhile가 필요합니다.', current.line);
        cursor += 1; body.push({ type: 'while', test: expression(tokens.slice(1), current.line), body: nested.body, line: current.line });
      } else if (head === 'for') {
        const nested = block(new Set(['endfor']));
        if (nested.end !== 'endfor') throw new ScriptSyntaxError('for 블록에 endfor가 필요합니다.', current.line);
        cursor += 1; body.push({ type: 'for', args: tokens.slice(1).map((token) => token.value), body: nested.body, line: current.line });
      } else body.push(command(tokens, current.line));
    }
    return { body, end: null };
  }
  const result = block();
  if (result.end) throw new ScriptSyntaxError(`닫히지 않은 블록: ${result.end}`, lines[cursor]?.line || lines.at(-1)?.line || 1);
  return { type: 'program', body: result.body, version: 1 };
}

module.exports = { ScriptSyntaxError, tokenize, parseScript };