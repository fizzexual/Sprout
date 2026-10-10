const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const SproutTrace = require('../web/trace');

function harness() {
  class Element {
    constructor() {
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
      this.children = []; this.handlers = {}; this.style = {}; this.dataset = {};
      this.selectionStart = this.selectionEnd = 0; this.scrollTop = this.scrollLeft = 0;
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, state) { if (state === undefined) state = !classes.has(name); if (state) classes.add(name); else classes.delete(name); } };
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = children; }
    getBoundingClientRect() { return { width: 150, height: 500 }; }
    focus() {} remove() {} scrollIntoView() {}
    querySelectorAll(selector) {
      if (selector === '[data-line]') return [...(this.innerHTML || '').matchAll(/data-line="(\d+)"/g)].map(match => { const element = new Element(); element.dataset.line = match[1]; return element; });
      return [];
    }
    querySelector() { return null; }
  }
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const workers = [], timers = new Map(); let timerId = 0;
  class Worker {
    constructor(file) { assert.equal(file, 'worker.js'); this.sent = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.sent.push(data); }
    terminate() { this.terminated = true; }
    message(data) { this.onmessage({ data }); }
  }
  const document = { getElementById: id => elements.get(id), createElement: () => new Element(), querySelectorAll: () => [], querySelector: () => new Element(), body: new Element() };
  const sandbox = { document, SproutTrace, Worker, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) };
  const context = vm.createContext(sandbox);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInContext(script, context);
  return { elements, workers, timers, context, evaluate: code => vm.runInContext(code, context) };
}
const step = (line, variables = {}) => ({type:'step',sequence:line,file:'/program.sprout',line,variables,stack:[]});

test('recorded UI enables bounded playback after completion and renders values safely', () => {
  const h = harness(), get = id => h.elements.get(id);
  h.workers[0].message({type:'ready'});
  get('debugTop').onclick();
  assert.equal(h.workers[0].sent[0].trace, true);
  assert.equal(get('traceNext').disabled, true);
  h.workers[0].message({type:'trace',events:[step(3),step(4,{name:'<img src=x onerror=alert(1)>'})]});
  h.workers[0].message({type:'done',output:'Hello\n',exitCode:0,traceTruncated:false});
  assert.equal(get('traceNext').disabled, false);
  get('traceNext').onclick();
  assert.equal(h.evaluate('recordedTrace.cursor'), 1);
  assert.equal(get('traceVariables').children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(get('traceHighlight').style.top, '68px');
  assert.match(get('traceNote').textContent, /does not execute/);
  get('traceBack').onclick(); assert.equal(h.evaluate('recordedTrace.cursor'), 0);
});

test('editing captured source invalidates playback and hides the old line highlight', () => {
  const h = harness(), get = id => h.elements.get(id);
  h.workers[0].message({type:'ready'}); get('debugTop').onclick();
  h.workers[0].message({type:'trace',events:[step(3),step(4)]});
  h.workers[0].message({type:'done',output:'',exitCode:0});
  get('code').value += '\nshow 42'; h.evaluate('onEdit()');
  assert.equal(get('traceNext').disabled, true); assert.equal(get('traceHighlight').hidden, true);
  assert.match(get('traceNote').textContent, /Source changed/);
});

test('gutter breakpoint marks seek through the recorded timeline', () => {
  const h = harness(), get = id => h.elements.get(id);
  h.workers[0].message({type:'ready'}); get('debugTop').onclick();
  h.workers[0].message({type:'trace',events:[step(3),step(4),step(4)]});
  h.workers[0].message({type:'done',output:'',exitCode:0});
  h.evaluate('recordedTrace.toggleBreakpoint(4);renderTrace()');
  assert.equal(get('traceContinue').disabled, false);
  get('traceContinue').onclick(); assert.equal(h.evaluate('recordedTrace.cursor'), 1);
  get('traceContinue').onclick(); assert.equal(h.evaluate('recordedTrace.cursor'), 2);
  get('traceContinue').onclick(); assert.match(get('traceNote').textContent, /No later/);
});

test('time-limited recordings retain streamed steps and identify incomplete execution', () => {
  const h = harness(), get = id => h.elements.get(id);
  h.workers[0].message({type:'ready'}); get('debugTop').onclick();
  h.workers[0].message({type:'trace',events:[step(3),step(4)]});
  [...h.timers.values()].find(t => t.delay === 5000).fn();
  assert.equal(h.workers[0].terminated, true); assert.equal(get('traceNext').disabled, false);
  assert.match(get('traceNote').textContent, /incomplete/); assert.match(get('console').textContent, /time limit/);
});

test('ordinary runs remain ordinary and missing trace support is explained', () => {
  const h = harness(), get = id => h.elements.get(id);
  h.workers[0].message({type:'ready'}); get('runTop').onclick();
  assert.equal(h.workers[0].sent[0].trace, false);
  assert.equal(get('tracePane').hidden, true);
  h.workers[0].message({type:'done',output:'',exitCode:0});
  h.workers[1].message({type:'ready'}); get('debugTop').onclick();
  h.workers[1].message({type:'done',output:'',exitCode:1});
  assert.match(get('traceNote').textContent, /may need rebuilding/);
});
