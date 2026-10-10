// A conservative source index, independent of VS Code and the interpreter.
// This is lexical analysis, not a second implementation of Sprout's type checker.
const path = require('node:path');

const KEYWORDS = new Set(('make set show when orwhen otherwise for each in repeat while times task give type interface does from match is try caught fail use and or else not stop skip public private yes no nothing test expect error learn on off').split(' '));
const BUILTINS = ('range length add remove insert sort sort_by reverse index_of map filter reduce group_by min_by max_by partition chunk sum count unique zip flatten slice keys values contains first last copy kind_of is_a round format floor ceil abs sqrt pow min max clamp sign random number is_number upper lower trim replace split join starts_with ends_with words lines title pad_start pad_end code char matches find find_all captures ask args env exit now today time seed sin cos tan log exp pi days hours minutes time_parts time_make time_format wait read write append exists remember recall forget get json explore color').split(' ');
const HELP = {
  length: ['length(value)', 'Count items in a list, keys in a map, or characters in text.'],
  range: ['range(start, end, step = 1)', 'Create a list of numbers up to the exclusive end.'],
  show: ['show value, ...', 'Print values separated by spaces.'],
  map: ['map(items, transform)', 'Return a list containing the result of calling transform for each item.'],
  filter: ['filter(items, predicate)', 'Return items for which predicate is true.'],
  reduce: ['reduce(items, combine, initial)', 'Combine a list into one value.'],
  read: ['read(path)', 'Read a text file.'],
  write: ['write(path, text)', 'Write text to a file.'],
  get: ['get(url)', 'Fetch a URL as text. Prefer the http namespace for response metadata.'],
  json: ['json(text)', 'Parse JSON text into Sprout values; malformed input gives nothing.'],
  remember: ['remember(key, value)', 'Persist a value under a key.'],
  recall: ['recall(key)', 'Read a remembered value; an absent key gives nothing.'],
  integer: ['integer(value)', 'Convert a value to an exact signed 64-bit integer.'],
  decimal: ['decimal(value)', 'Construct an exact decimal value from text or an integer.'],
  decimal_div: ['decimal_div(left, right, places)', 'Divide exact decimals using an explicit number of decimal places.'],
  json_encode: ['json_encode(value)', 'Serialize a Sprout value as JSON text.'],
  json_decode: ['json_decode(text)', 'Decode JSON text into a Sprout value.'],
  read_input: ['read_input()', 'Read standard input as text.'],
  request: ['request(url, options = {})', 'HTTP request returning {ok, error, code, status, body, headers, timed_out}. Options: method, headers, body, timeout_ms, max_bytes.'],
  process: ['process(argv, options = {})', 'Run an argument list without a shell. Returns {ok, error, code, exit, stdout, stderr, timed_out, truncated}. Options: cwd, stdin, timeout_ms, max_output.'],
  file_read: ['file_read(path, options = {})', 'Read a file with a checked result. Options may set a byte limit.'],
  file_write: ['file_write(path, text)', 'Write text and return a checked I/O result.'],
  file_info: ['file_info(path)', 'Read filesystem metadata as a checked I/O result.'],
  file_list: ['file_list(path)', 'List a directory as a checked I/O result.'],
  file_mkdir: ['file_mkdir(path)', 'Create a directory and return a checked I/O result.'],
  file_remove: ['file_remove(path)', 'Remove a filesystem entry and return a checked I/O result.'],
  file_move: ['file_move(from, to)', 'Move a filesystem entry and return a checked I/O result.'],
  csv_parse: ['csv_parse(text, delimiter = ",")', 'Parse CSV text into a list of rows.'],
  csv_write: ['csv_write(rows, delimiter = ",")', 'Encode rows as CSV text.'],
  sql_open: ['sql_open(path, options = {})', 'Open SQLite and return a checked result.'],
  sql_execute: ['sql_execute(handle, sql, params = [], options = {})', 'Execute parameterized SQL. Options: timeout_ms, max_rows, max_bytes. Returns a checked result.'],
  sql_transaction: ['sql_transaction(handle, statements, options = {})', 'Execute a list of statements in one transaction and return a checked result.'],
  sql_close: ['sql_close(handle)', 'Close SQLite and return a checked result.'],
};
for (const name of Object.keys(HELP)) if (name !== 'show' && !BUILTINS.includes(name)) BUILTINS.push(name);
const NAMESPACES = {
  http: { request: 'request' },
  process: { run: 'process' },
  files: { read: 'file_read', write: 'file_write', info: 'file_info', list: 'file_list', mkdir: 'file_mkdir', remove: 'file_remove', move: 'file_move' },
  csv: { parse: 'csv_parse', write: 'csv_write' },
  sqlite: { open: 'sql_open', execute: 'sql_execute', transaction: 'sql_transaction', close: 'sql_close' },
  data: { json_encode: 'json_encode', json_decode: 'json_decode', read_input: 'read_input' },
  numbers: { integer: 'integer', decimal: 'decimal', decimal_div: 'decimal_div' },
};

function tokenize(text) {
  const tokens = [], excluded = [], interpolations = [];
  let i = 0;
  function scan(stopBrace = false) {
    let braces = 0;
    while (i < text.length) {
      const c = text[i];
      if (stopBrace && c === '}' && braces === 0) { i++; return; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '~' || c === '#') {
        const start = i;
        while (i < text.length && text[i] !== '\n') i++;
        excluded.push([start, i]); continue;
      }
      const formatted = c === 'f' && text[i + 1] === '"';
      if (c === '"' || c === "'" || formatted) {
        const start = i, triple = !formatted && text.slice(i, i + 3) === '"""', quote = formatted ? '"' : c;
        i += formatted ? 2 : triple ? 3 : 1;
        let literalStart = start;
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; continue; }
          if (triple ? text.slice(i, i + 3) === '"""' : text[i] === quote) { i += triple ? 3 : 1; break; }
          if (formatted && text[i] === '{') {
            excluded.push([literalStart, i + 1]);
            const expressionStart = ++i;
            scan(true);
            interpolations.push([expressionStart, i - 1]);
            literalStart = i - 1; continue;
          }
          i++;
        }
        excluded.push([literalStart, i]);
        tokens.push({ kind: 'string', value: text.slice(start, i), content: text.slice(start + (formatted ? 2 : triple ? 3 : 1), i - (triple ? 3 : 1)), start, end: i });
        continue;
      }
      const start = i;
      if (/[A-Za-z_]/.test(c)) {
        while (i < text.length && /[A-Za-z_0-9]/.test(text[i])) i++;
        const value = text.slice(start, i);
        tokens.push({ kind: 'name', value, start, end: i }); continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < text.length && /[0-9.eE]/.test(text[i])) i++;
        tokens.push({ kind: 'number', value: text.slice(start, i), start, end: i }); continue;
      }
      if (c === '{') braces++;
      if (c === '}') braces--;
      const pair = text.slice(i, i + 2);
      i += ['->', '|>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%='].includes(pair) ? 2 : 1;
      tokens.push({ kind: 'punct', value: text.slice(start, i), start, end: i });
    }
  }
  scan();
  tokens.sort((a, b) => a.start - b.start);
  for (const token of tokens) token.interpolation = interpolations.find(([start, end]) => start <= token.start && token.start < end);
  return { tokens, excluded, interpolations };
}

function analyze(text, file = 'untitled.sprout') {
  const lex = tokenize(text), { tokens } = lex;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = offset => { let lo = 0, hi = starts.length; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid; } return lo; };
  for (const token of tokens) { token.line = lineAt(token.start); token.column = token.start - starts[token.line]; }
  const root = { start: 0, end: text.length + 1, parent: null, kind: 'file', symbols: [], children: [] };
  const scopes = [root], symbols = [], imports = [], issues = [], declarationTokens = new Set(), ignored = new Set();
  const addScope = (parent, start, end, kind) => { const scope = { parent, start, end, kind, symbols: [], children: [] }; parent.children.push(scope); scopes.push(scope); return scope; };
  const declare = (token, scope, kind, extra = {}) => {
    if (!token || token.kind !== 'name') return null;
    const symbol = { name: token.value, token, scope, kind, file, id: `${file}:${token.start}`, ...extra };
    scope.symbols.push(symbol); symbols.push(symbol); declarationTokens.add(token); return symbol;
  };
  function splitParams(list) {
    const parts = []; let start = 0, depth = 0;
    for (let i = 0; i <= list.length; i++) {
      const v = list[i]?.value;
      if (i === list.length || (v === ',' && depth === 0)) { if (i > start) parts.push(list.slice(start, i)); start = i + 1; }
      if (['(', '[', '{'].includes(v)) depth++;
      if ([')', ']', '}'].includes(v)) depth--;
    }
    return parts;
  }
  const byLine = starts.map(() => []);
  for (const token of tokens) byLine[token.line].push(token);
  // Parenthesized headers and expressions are one logical statement.
  for (let line = 0; line < byLine.length; line++) {
    let depth = 0;
    for (const token of byLine[line]) { if (['(', '[', '{'].includes(token.value)) depth++; if ([')', ']', '}'].includes(token.value)) depth--; }
    let end = line + 1;
    while (depth > 0 && end < byLine.length) {
      for (const token of byLine[end]) { if (['(', '[', '{'].includes(token.value)) depth++; if ([')', ']', '}'].includes(token.value)) depth--; }
      byLine[line].push(...byLine[end]); byLine[end] = []; end++;
    }
  }
  const stack = [{ indent: -1, scope: root }];
  let bracketDepth = 0, continuation = false;
  for (let line = 0; line < starts.length; line++) {
    const ts = byLine[line]; if (!ts.length) continue;
    const indent = (text.slice(starts[line], ts[0].start).match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
    if (!continuation) while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop().scope.end = starts[line];
    }
    const scope = stack[stack.length - 1].scope;
    for (const token of ts) token.scope = scope;
    let p = ['public', 'private'].includes(ts[0].value) ? 1 : 0;
    const head = ts[p]?.value, isPublic = p === 1 && ts[0].value === 'public';
    let owner;
    if (!continuation && ['task', 'type', 'interface'].includes(head) && ts[p + 1]?.kind === 'name') {
      owner = declare(ts[p + 1], scope, head === 'task' && scope.kind === 'type' ? 'method' : head, { public: isPublic, hoisted: true });
      if (head === 'type') owner.parentName = ts.find(t => t.value === 'from') && ts[ts.findIndex(t => t.value === 'from') + 1]?.value;
    }
    let body;
    if (!continuation && ts[ts.length - 1]?.value === ':' && !['make', 'set'].includes(head)) {
      body = addScope(scope, (starts[ts[ts.length - 1].line + 1] ?? text.length), text.length + 1, owner?.kind === 'task' || owner?.kind === 'method' ? 'task' : head === 'type' ? 'type' : head === 'interface' ? 'interface' : 'block');
      body.owner = owner; if (owner) owner.body = body;
      stack.push({ indent, scope: body });
    }
    if (head === 'task' && owner) {
      const open = ts.findIndex(t => t.value === '('), close = ts.findLastIndex(t => t.value === ')');
      const parts = open >= 0 && close > open ? splitParams(ts.slice(open + 1, close)) : [];
      owner.params = parts.map(part => ({ name: part[0].value, label: text.slice(part[0].start, part[part.length - 1].end), optional: part.some(t => t.value === '=') }));
      owner.signature = text.slice(ts[p].start, ts[ts.length - 1].start).trim();
      for (const part of parts) {
        const parameter = declare(part[0], body || scope, 'parameter', { hoisted: true, typeName: part[1]?.value === ':' ? part[2]?.value : undefined });
        if (parameter && part[0].value === 'self' && scope.kind === 'type') parameter.typeName = scope.owner?.name;
        if (part[1]?.value === ':' && part[2]) ignored.add(part[2]);
      }
    }
    if (head === 'make') {
      const eq = ts.findIndex(t => t.value === '='), limit = eq < 0 ? ts.length : eq;
      for (let k = p + 1; k < limit; k++) {
        if (ts[k].kind !== 'name') continue;
        if (ts[k - 1]?.value === ':') { ignored.add(ts[k]); continue; }
        declare(ts[k], isPublic ? root : scope, scope.kind === 'type' ? 'field' : 'variable', {
          public: isPublic, typeName: ts[k + 1]?.value === ':' ? ts[k + 2]?.value : undefined,
          constructorName: eq >= 0 && ts[eq + 1]?.kind === 'name' && ts[eq + 2]?.value === '(' ? ts[eq + 1].value : undefined,
        });
      }
    }
    if (head === 'for' && ts[p + 1]?.value === 'each') {
      for (let k = p + 2; k < ts.length && ts[k].value !== 'in'; k++) if (ts[k].kind === 'name') declare(ts[k], body || scope, 'variable', { hoisted: true });
    }
    if (head === 'caught' && ts[p + 1]?.kind === 'name') declare(ts[p + 1], body || scope, 'variable', { hoisted: true });
    if (head === 'is' && ['[', '{'].includes(ts[p + 1]?.value) && !ts.slice(p + 2, -2).some(t => t.kind !== 'name' && t.value !== ',')) {
      for (const token of ts.slice(p + 2, -2)) if (token.kind === 'name') declare(token, body || scope, 'variable', { hoisted: true });
    }
    if (head === 'use' && ts[p + 1]) {
      const target = ts[p + 1]; ignored.add(target);
      const importName = target.kind === 'string' ? target.content.replace(/\\([\\"])/g, '$1') : target.value;
      const name = path.basename(importName.replace(/\\/g, '/'), '.sprout');
      const symbol = declare({ ...target, kind: 'name', value: name }, scope, 'module', { hoisted: true, importToken: target });
      imports.push({ name, target: importName, symbol, token: target });
    }
    if (scope.kind === 'interface') for (const t of ts) ignored.add(t);
    for (const t of ts) { if (['(', '[', '{'].includes(t.value)) bracketDepth++; if ([')', ']', '}'].includes(t.value)) bracketDepth--; }
    continuation = bracketDepth > 0;
  }
  function scopeAt(offset) {
    return scopes.filter(scope => scope.start <= offset && offset < scope.end).sort((a, b) => b.start - a.start || a.end - b.end)[0] || root;
  }
  // Inline lambdas have expression scope, ending at the containing delimiter.
  for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'task' && tokens[i + 1]?.value === '(') {
    let close = i + 2, depth = 1;
    while (close < tokens.length && depth) { if (tokens[close].value === '(') depth++; if (tokens[close].value === ')') depth--; if (depth) close++; }
    if (tokens[close + 1]?.value !== ':') continue;
    let end = close + 2, nested = 0;
    while (end < tokens.length) {
      const v = tokens[end].value;
      if (!nested && (tokens[end].line > tokens[i].line || [',', ')', ']', '}'].includes(v))) break;
      if (['(', '[', '{'].includes(v)) nested++;
      if ([')', ']', '}'].includes(v)) nested--;
      end++;
    }
    const body = addScope(scopeAt(tokens[i].start), tokens[close + 2]?.start ?? tokens[close].end, tokens[end]?.start ?? text.length + 1, 'lambda');
    for (const part of splitParams(tokens.slice(i + 2, close))) declare(part[0], body, 'parameter', { hoisted: true });
  }
  // A comprehension binds its iteration name in the entire list expression.
  for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'for' && tokens[i + 1]?.value === 'each' && !declarationTokens.has(tokens[i + 2])) {
    let open = i - 1, depth = 0;
    for (; open >= 0; open--) { if (tokens[open].value === ']') depth++; if (tokens[open].value === '[' && depth-- === 0) break; }
    if (open < 0) continue;
    let end = i + 1; depth = 1;
    while (end < tokens.length && depth) { if (tokens[end].value === '[') depth++; if (tokens[end].value === ']') depth--; end++; }
    const body = addScope(scopeAt(tokens[open].start), tokens[open].start, tokens[end - 1]?.end ?? text.length, 'comprehension');
    declare(tokens[i + 2], body, 'variable', { hoisted: true });
  }
  function resolve(name, offset, override) {
    let scope = scopeAt(offset); const delayed = ['task', 'lambda'].some(kind => { let s = scope; while (s) { if (s.kind === kind) return true; s = s.parent; } return false; });
    while (scope) {
      const candidates = scope.symbols.filter(s => (override?.symbol === s ? override.name : s.name) === name && (s.hoisted || s.token.start <= offset || (scope === root && delayed)));
      if (candidates.length) return candidates[candidates.length - 1];
      scope = scope.parent;
    }
    return null;
  }
  const model = { text, file, tokens, symbols, imports, issues, root, scopes, starts, ...lex, scopeAt, resolve, declarationTokens, ignored };
  // Duplicate bindings and definitely unbound assignment targets are safe checks.
  for (const scope of scopes) {
    const seen = new Map();
    for (const symbol of scope.symbols) {
      if (seen.has(symbol.name) && symbol.kind !== 'module' && !symbol.public) issues.push({ token: symbol.token, message: `'${symbol.name}' is already declared in this scope.`, code: 'duplicate-name' });
      seen.set(symbol.name, symbol);
    }
  }
  for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'set' && tokens[i + 1]?.kind === 'name' && ['=', '+=', '-=', '*=', '/=', '%='].includes(tokens[i + 2]?.value)) {
    if (!resolve(tokens[i + 1].value, tokens[i + 1].start)) issues.push({ token: tokens[i + 1], message: `No visible declaration of '${tokens[i + 1].value}'. Use make to create it.`, code: 'unbound-assignment' });
  }
  return model;
}

function tokenAt(model, offset) { return model.tokens.find(t => t.kind === 'name' && t.start <= offset && offset <= t.end); }
function isReference(model, token) {
  const i = model.tokens.indexOf(token), prev = model.tokens[i - 1], next = model.tokens[i + 1];
  return token.kind === 'name' && !KEYWORDS.has(token.value) && !model.ignored.has(token) && !model.declarationTokens.has(token) && !(next?.value === ':' && ['{', ',', '('].includes(prev?.value));
}
function symbolAt(model, offset, modules = new Map()) {
  const token = tokenAt(model, offset); if (!token) return null;
  const declaration = model.symbols.find(s => s.token.start === token.start); if (declaration) return declaration;
  const i = model.tokens.indexOf(token);
  if (model.tokens[i + 1]?.value === ':' && ['(', ','].includes(model.tokens[i - 1]?.value)) {
    const call = callAt(model, token.start, modules);
    return call?.symbol?.body?.symbols.find(s => s.kind === 'parameter' && s.name === token.value) || null;
  }
  if (model.tokens[i - 1]?.value === '.') {
    const receiver = model.tokens[i - 2], object = receiver && model.resolve(receiver.value, receiver.start);
    if (object?.kind === 'module') return modules.get(object.name)?.symbols.find(s => s.scope.kind === 'file' && s.public && s.name === token.value) || null;
    const typeName = object?.typeName || object?.constructorName;
    const type = typeName && model.symbols.find(s => s.kind === 'type' && s.name === typeName);
    return type?.body?.symbols.find(s => s.name === token.value) || null;
  }
  if (!isReference(model, token)) return null;
  return model.resolve(token.value, token.start);
}
function visibleSymbols(model, offset) {
  const visible = new Map(); let scope = model.scopeAt(offset);
  while (scope) { for (const symbol of scope.symbols) if (!visible.has(symbol.name) && model.resolve(symbol.name, offset) === symbol && !['field', 'method'].includes(symbol.kind)) visible.set(symbol.name, symbol); scope = scope.parent; }
  return [...visible.values()];
}
function references(models, symbol, moduleMaps = new Map()) {
  const result = [];
  for (const model of models) for (const token of model.tokens) {
    if (token.kind === 'name' && symbolAt(model, token.start, moduleMaps.get(model.file))?.id === symbol.id) result.push({ file: model.file, token });
  }
  return result;
}
function rename(model, symbol, newName) {
  if (!symbol || ['field', 'method', 'type', 'interface', 'module'].includes(symbol.kind) || symbol.public) throw new Error('Rename supports private lexical variables, parameters, and tasks. Exported names and members require a project-wide semantic index.');
  if (symbol.kind === 'parameter' && (symbol.scope.owner?.public || symbol.scope.owner?.kind === 'method')) throw new Error('Parameters in exported tasks or methods may be named by external callers; rename requires a project-wide index.');
  if (symbol.kind === 'parameter' && symbol.scope.owner) {
    const task = symbol.scope.owner;
    for (const ref of references([model], task)) {
      const i = model.tokens.indexOf(ref.token);
      if (ref.token.start !== task.token.start && model.tokens[i + 1]?.value !== '(' && model.tokens[i - 1]?.value !== '|>') throw new Error('This task is passed as a value; parameter rename cannot safely locate named callers.');
    }
  }
  if (BUILTINS.includes(symbol.name) || model.symbols.some(s => s !== symbol && s.name === symbol.name && ['task', 'type'].includes(s.kind))) throw new Error('This name also belongs to a callable namespace; rename cannot safely disambiguate it.');
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(newName) || KEYWORDS.has(newName) || BUILTINS.includes(newName)) throw new Error('Choose a valid name that is not a keyword or built-in task.');
  if (newName === symbol.name) return [];
  const refs = references([model], symbol);
  const override = { symbol, name: newName };
  for (const scope of model.scopes) if (scope.symbols.some(s => s !== symbol && s.scope === symbol.scope && s.name === newName)) throw new Error('That name is already declared in this scope.');
  for (const ref of refs) if (ref.token.start !== symbol.token.start && isReference(model, ref.token) && model.resolve(newName, ref.token.start, override) !== symbol) throw new Error('This rename would bind a reference to another declaration.');
  for (const token of model.tokens) if (token.value === newName && isReference(model, token) && model.tokens[model.tokens.indexOf(token) - 1]?.value !== '.') {
    if (model.resolve(newName, token.start) !== model.resolve(newName, token.start, override)) throw new Error('This rename would capture another reference.');
  }
  return refs;
}
function callAt(model, offset, modules = new Map()) {
  const interpolation = model.interpolations.find(([start, end]) => start <= offset && offset <= end);
  const before = model.tokens.filter(t => t.start < offset && (interpolation ? t.interpolation === interpolation : !t.interpolation)), stack = [];
  for (let i = 0; i < before.length; i++) {
    const t = before[i];
    if (['(', '[', '{'].includes(t.value)) stack.push({ token: t, index: i, commas: 0, argumentStart: i + 1 });
    else if ([')', ']', '}'].includes(t.value)) stack.pop();
    else if (t.value === ',' && stack.length) { stack[stack.length - 1].commas++; stack[stack.length - 1].argumentStart = i + 1; }
  }
  const frame = stack[stack.length - 1]; if (!frame || frame.token.value !== '(') return null;
  const name = before[frame.index - 1]; if (!name || name.kind !== 'name' || model.declarationTokens.has(name)) return null;
  const argument = before[frame.argumentStart];
  return { name: name.value, symbol: symbolAt(model, name.start, modules), activeParameter: frame.commas, argumentName: argument?.kind === 'name' && before[frame.argumentStart + 1]?.value === ':' ? argument.value : null, token: name };
}
function callIssues(model, modules = new Map()) {
  const issues = [];
  for (let i = 1; i < model.tokens.length; i++) if (model.tokens[i].value === '(') {
    const name = model.tokens[i - 1]; if (name.kind !== 'name' || model.declarationTokens.has(name)) continue;
    const symbol = symbolAt(model, name.start, modules); if (!symbol?.params || !['task', 'method'].includes(symbol.kind)) continue;
    let depth = 1, end = i + 1, count = 0, content = false, part = [], parts = [];
    for (; end < model.tokens.length; end++) {
      if (model.tokens[end].interpolation !== name.interpolation) continue;
      const v = model.tokens[end].value;
      if (['(', '[', '{'].includes(v)) depth++;
      if ([')', ']', '}'].includes(v)) depth--;
      if (!depth) break;
      if (v === ',' && depth === 1) { count++; content = false; parts.push(part); part = []; } else { content = true; part.push(model.tokens[end]); }
    }
    if (depth) continue;
    count += content ? 1 : 0;
    if (part.length) parts.push(part);
    // Pipeline calls receive the left-hand value as an additional first argument.
    if (model.tokens[i - 2]?.value === '|>' || (model.tokens[i - 2]?.value === '.' && model.tokens[i - 4]?.value === '|>')) count++;
    const params = symbol.kind === 'method' && symbol.params[0]?.name === 'self' ? symbol.params.slice(1) : symbol.params;
    const required = params.filter(p => !p.optional).length;
    if (count < required || count > params.length) { issues.push({ token: name, code: 'task-arity', message: `'${name.value}' expects ${required === params.length ? required : `${required}–${params.length}`} arguments; this call has ${count}.` }); continue; }
    if (parts.some(part => part[0]?.kind === 'name' && part[1]?.value === ':')) {
      const supplied = new Set(); let positional = count - parts.length, named = false, problem;
      for (let j = 0; j < positional; j++) if (params[j]) supplied.add(params[j].name);
      for (const part of parts) {
        let parameter;
        if (part[0]?.kind === 'name' && part[1]?.value === ':') { named = true; parameter = params.find(p => p.name === part[0].value); if (!parameter) { problem = `Unknown named argument '${part[0].value}' for '${name.value}'.`; break; } }
        else { if (named) { problem = 'Positional arguments must precede named arguments.'; break; } parameter = params[positional++]; }
        if (parameter && supplied.has(parameter.name)) { problem = `Argument '${parameter.name}' is supplied more than once.`; break; }
        if (parameter) supplied.add(parameter.name);
      }
      const missing = params.find(p => !p.optional && !supplied.has(p.name));
      if (!problem && missing) problem = `Required argument '${missing.name}' is missing from '${name.value}'.`;
      if (problem) issues.push({ token: name, code: 'task-arguments', message: problem });
    }
  }
  return issues;
}

module.exports = { analyze, tokenize, tokenAt, symbolAt, visibleSymbols, references, rename, callAt, callIssues, KEYWORDS, BUILTINS, HELP, NAMESPACES };
