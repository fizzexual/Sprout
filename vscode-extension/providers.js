const vscode = require('vscode');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const source = require('./analysis');

const MAX_SOURCE = 1024 * 1024;
const MAX_MODULES = 64;

function range(model, token) {
  const line = token.line ?? model.starts.findLastIndex(offset => offset <= token.start);
  return new vscode.Range(line, token.start - model.starts[line], line, token.end - model.starts[line]);
}
function offset(doc, position) { return doc.offsetAt(position); }
function readSource(file) {
  const open = vscode.workspace.textDocuments.find(d => !d.isClosed && path.resolve(d.fileName) === path.resolve(file));
  if (open) { const text = open.getText(); return text.length <= MAX_SOURCE ? text : null; }
  try { if (fs.statSync(file).size <= MAX_SOURCE) return fs.readFileSync(file, 'utf8'); } catch {}
  return null;
}
function resolveImport(target, cwd) {
  const direct = /[\\/]|\.sprout$/.test(target);
  if (direct) return path.resolve(cwd, target);
  // The runtime resolves imports from the selected project directory.
  const manifest = readSource(path.join(cwd, 'sprout.toml')) || '';
  const include = manifest.match(/\binclude\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
  for (const match of include.matchAll(/"([^"\n]+)"/g)) if (path.basename(match[1].replace(/\\/g, '/'), '.sprout') === target) return path.resolve(cwd, match[1]);
  for (const prefix of ['', 'modules', 'src', 'lib', 'sprout_packages']) {
    const file = path.join(cwd, prefix, `${target}.sprout`);
    if (readSource(file) !== null) return file;
  }
  return null;
}
function project(doc, cwd) {
  const text = doc.getText();
  const entry = source.analyze(text.length <= MAX_SOURCE ? text : '', path.resolve(doc.fileName));
  entry.tooLarge = text.length > MAX_SOURCE;
  const models = new Map([[entry.file, entry]]), moduleMaps = new Map();
  function visit(model) {
    const modules = new Map(); moduleMaps.set(model.file, modules);
    for (const imported of model.imports) {
      if (imported.name === 'system' || source.NAMESPACES[imported.name]) continue;
      const file = resolveImport(imported.target, cwd);
      if (!file) continue;
      let child = models.get(file);
      if (!child && models.size < MAX_MODULES) {
        const text = readSource(file);
        if (text !== null) { child = source.analyze(text, file); models.set(file, child); visit(child); }
      }
      if (child) modules.set(imported.name, child);
    }
  }
  visit(entry);
  return { entry, models, moduleMaps, modules: moduleMaps.get(entry.file) };
}
function markdown(symbol) {
  const docs = [];
  const model = symbol.model;
  if (model) {
    for (let line = symbol.token.line - 1; line >= 0; line--) {
      const text = model.text.slice(model.starts[line], model.starts[line + 1] ?? model.text.length).trim();
      if (!text.startsWith('~')) break;
      docs.unshift(text.replace(/^~\s?/, ''));
    }
  }
  const result = new vscode.MarkdownString();
  result.appendCodeblock(symbol.signature || `${symbol.kind} ${symbol.name}${symbol.typeName ? `: ${symbol.typeName}` : ''}`, 'sprout');
  if (docs.length) result.appendText(docs.join('\n'));
  result.appendText(`\nDefined in ${path.basename(symbol.file)}:${symbol.token.line + 1}`);
  return result;
}
function withModels(index) { for (const model of index.models.values()) for (const symbol of model.symbols) symbol.model = model; return index; }
function providers(projectDirectory, sproutCmd) {
  const index = doc => withModels(project(doc, projectDirectory(doc)));
  const builtinHelp = (model, token) => {
    const i = model.tokens.indexOf(token);
    if (model.tokens[i - 1]?.value === '.') {
      const object = model.resolve(model.tokens[i - 2]?.value, token.start);
      const alias = object?.kind === 'module' && source.NAMESPACES[object.name]?.[token.value];
      return alias ? [source.HELP[alias][0].replace(/^[^(]+/, token.value), source.HELP[alias][1]] : null;
    }
    return source.HELP[token.value];
  };
  const excluded = (model, at) => model.excluded.some(([start, end]) => start <= at && at < end);
  const item = symbol => {
    const kind = ['task', 'method'].includes(symbol.kind) ? vscode.CompletionItemKind.Function : symbol.kind === 'module' ? vscode.CompletionItemKind.Module : ['type', 'interface'].includes(symbol.kind) ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Variable;
    const result = new vscode.CompletionItem(symbol.name, kind);
    result.detail = symbol.signature || `${symbol.kind}${symbol.typeName ? `: ${symbol.typeName}` : ''}`;
    result.documentation = markdown(symbol);
    result.sortText = `0_${symbol.name}`;
    return result;
  };
  const completion = {
    provideCompletionItems(doc, position) {
      const p = index(doc), at = offset(doc, position);
      if (excluded(p.entry, at)) return [];
      const before = p.entry.text.slice(0, at), member = before.match(/([A-Za-z_]\w*)\.[A-Za-z_0-9]*$/);
      if (member) {
        const object = p.entry.resolve(member[1], at);
        if (object?.kind === 'module') {
          const builtin = source.NAMESPACES[object.name];
          if (builtin) return Object.entries(builtin).map(([name, alias]) => { const result = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function); result.detail = source.HELP[alias][0].replace(/^[^(]+/, name); result.documentation = source.HELP[alias][1]; return result; });
          return (p.modules.get(object.name)?.root.symbols || []).filter(s => s.public).map(item);
        }
        const typeName = object?.typeName || object?.constructorName;
        const type = p.entry.root.symbols.find(s => s.kind === 'type' && s.name === typeName);
        const members = new Map(); let current = type;
        const seen = new Set();
        while (current && !seen.has(current.id)) { seen.add(current.id); for (const s of current.body?.symbols || []) if (!members.has(s.name)) members.set(s.name, s); current = p.entry.root.symbols.find(s => s.kind === 'type' && s.name === current.parentName); }
        return [...members.values()].map(item);
      }
      const symbols = source.visibleSymbols(p.entry, at), seen = new Set(symbols.map(s => s.name));
      const result = symbols.map(item);
      for (const name of source.BUILTINS) if (!seen.has(name)) {
        const completion = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        completion.detail = source.HELP[name]?.[0] || 'Sprout built-in task';
        completion.documentation = source.HELP[name]?.[1];
        completion.insertText = new vscode.SnippetString(`${name}($0)`); result.push(completion);
      }
      for (const name of source.KEYWORDS) if (!seen.has(name)) result.push(new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword));
      return result;
    },
  };
  const hover = {
    provideHover(doc, position) {
      const p = index(doc), at = offset(doc, position), symbol = source.symbolAt(p.entry, at, p.modules);
      if (symbol) return new vscode.Hover(markdown(symbol));
      const token = source.tokenAt(p.entry, at), help = token && builtinHelp(p.entry, token);
      if (!help || excluded(p.entry, at)) return null;
      const docs = new vscode.MarkdownString(); docs.appendCodeblock(help[0], 'sprout'); docs.appendText(help[1]);
      return new vscode.Hover(docs);
    },
  };
  const signature = {
    provideSignatureHelp(doc, position) {
      const p = index(doc), at = offset(doc, position);
      if (excluded(p.entry, at)) return null;
      const call = source.callAt(p.entry, at, p.modules); if (!call) return null;
      const params = call.symbol?.params, help = builtinHelp(p.entry, call.token);
      if (!params && !help) return null;
      const visible = call.symbol?.kind === 'method' && params?.[0]?.name === 'self' ? params.slice(1) : params;
      const label = visible ? `${call.name}(${visible.map(p => p.label).join(', ')})` : help[0];
      const signature = new vscode.SignatureInformation(label, call.symbol ? markdown(call.symbol) : help[1]);
      signature.parameters = (visible || label.slice(label.indexOf('(') + 1, label.lastIndexOf(')')).split(',').filter(Boolean).map(p => ({ label: p.trim() }))).map(p => new vscode.ParameterInformation(p.label));
      const result = new vscode.SignatureHelp(); result.signatures = [signature]; result.activeSignature = 0;
      const named = call.argumentName && visible ? visible.findIndex(p => p.name === call.argumentName) : -1;
      result.activeParameter = named >= 0 ? named : Math.min(call.activeParameter, Math.max(0, signature.parameters.length - 1));
      return result;
    },
  };
  const definition = {
    provideDefinition(doc, position) {
      const p = index(doc), symbol = source.symbolAt(p.entry, offset(doc, position), p.modules);
      if (!symbol) return null;
      return new vscode.Location(vscode.Uri.file(symbol.file), range(p.models.get(symbol.file), symbol.token));
    },
  };
  const reference = {
    provideReferences(doc, position, context) {
      const p = index(doc), symbol = source.symbolAt(p.entry, offset(doc, position), p.modules); if (!symbol) return [];
      return source.references([...p.models.values()], symbol, p.moduleMaps).filter(ref => context.includeDeclaration || !(ref.file === symbol.file && ref.token.start === symbol.token.start)).map(ref => new vscode.Location(vscode.Uri.file(ref.file), range(p.models.get(ref.file), ref.token)));
    },
  };
  const rename = {
    prepareRename(doc, position) {
      const p = index(doc), symbol = source.symbolAt(p.entry, offset(doc, position), p.modules);
      // Validate the target using a fresh name, without making any edits.
      if (p.entry.tooLarge) throw new Error('Source analysis is limited to files up to 1 MiB.');
      source.rename(p.entry, symbol, `${symbol?.name || 'name'}_renamed`);
      return { range: range(p.entry, source.tokenAt(p.entry, offset(doc, position))), placeholder: symbol.name };
    },
    provideRenameEdits(doc, position, name) {
      const p = index(doc), symbol = source.symbolAt(p.entry, offset(doc, position), p.modules);
      if (p.entry.tooLarge) throw new Error('Source analysis is limited to files up to 1 MiB.');
      const edits = source.rename(p.entry, symbol, name), result = new vscode.WorkspaceEdit();
      for (const edit of edits) result.replace(doc.uri, range(p.entry, edit.token), name);
      return result;
    },
  };
  const formatting = {
    provideDocumentFormattingEdits(doc, options, token) {
      if (token.isCancellationRequested) return [];
      const text = doc.getText(), version = doc.version;
      return new Promise(resolve => {
        let done = false, cancel;
        const finish = edits => { if (done) return; done = true; cancel?.dispose(); resolve(edits); };
        const child = cp.execFile(sproutCmd(), ['format', doc.fileName, '--stdin'], { cwd: projectDirectory(doc), timeout: 8000, maxBuffer: MAX_SOURCE * 2 }, (error, stdout) => {
          if (error || token.isCancellationRequested || doc.isClosed || doc.version !== version) return finish([]);
          if (stdout === text) return finish([]);
          finish([vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), stdout)]);
        });
        cancel = token.onCancellationRequested(() => { child.kill(); finish([]); });
        child.stdin.on('error', () => {}); child.stdin.end(text);
      });
    },
  };
  return { completion, hover, signature, definition, reference, rename, formatting,
    staticDiagnostics(doc) {
      if (vscode.workspace.getConfiguration('sprout').get('staticDiagnostics', true) === false) return [];
      const p = index(doc);
      return [...p.entry.issues, ...source.callIssues(p.entry, p.modules)].map(issue => {
        const diagnostic = new vscode.Diagnostic(range(p.entry, issue.token), issue.message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Sprout source analysis'; diagnostic.code = issue.code; return diagnostic;
      });
    },
  };
}
module.exports = { providers, project, resolveImport };
