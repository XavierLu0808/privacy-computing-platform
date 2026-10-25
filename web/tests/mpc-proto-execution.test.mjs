import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Small DOM + real UI/FL scripts. API responses are independent controlled
// promises; no production mock server or private renderer exports are used.
class TextNode {
  constructor(text) { this.textContent = text; this.parentNode = null; this.nodeType = 3; }
  remove() { this.parentNode?.removeChild(this); }
}
class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.nodeType = 1; this.children = []; this.attrs = {};
    this.style = {}; this.dataset = {}; this.listeners = {}; this.parentNode = null;
    this.classList = { toggle: (name, on) => { const items = this.className.split(/\s+/).filter(x => x !== name); if (on) items.push(name); this.className = items.join(' '); }, add: (...xs) => { this.className = [...new Set(this.className.split(/\s+/).concat(xs))].join(' '); } };
  }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get id() { return this.attrs.id; }
  set id(value) { this.attrs.id = value; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; }
  get textContent() { return this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this.children.forEach(x => { x.parentNode = null; }); this.children = [new TextNode(String(value))]; this.children[0].parentNode = this; }
  appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; return node; }
  remove() { this.parentNode?.removeChild(this); }
  insertBefore(node, before) { node.remove(); node.parentNode = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); return node; }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'value') this.value = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(key, fn) { (this.listeners[key] ||= []).push(fn); }
  matches(selector) {
    const attr = selector.match(/\[([^\]]+)\]/);
    if (attr && !(attr[1] in this.attrs)) return false;
    const plain = selector.replace(/\[[^\]]+\]/g, '');
    const tag = plain.match(/^[\w-]+/), id = plain.match(/#([\w-]+)/);
    return (!tag || this.tagName === tag[0]) && (!id || this.id === id[1]) &&
      [...plain.matchAll(/\.([\w-]+)/g)].every(x => this.className.split(/\s+/).includes(x[1]));
  }
  closest(selector) { for (let x = this; x; x = x.parentNode) if (x.matches(selector)) return x; return null; }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/), results = [];
    const visit = node => {
      for (const child of node.children || []) {
        if (child.nodeType !== 1) continue;
        if (child.matches(parts.at(-1))) {
          let ancestor = child.parentNode, index = parts.length - 2;
          while (ancestor && index >= 0) { if (ancestor.matches(parts[index])) index--; ancestor = ancestor.parentNode; }
          if (index < 0) results.push(child);
        }
        visit(child);
      }
    };
    visit(this); return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function documentOf(html) {
  const root = new Element('document'), stack = [root];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const text = token[0];
    if (text.startsWith('<!--') || text.startsWith('<!')) continue;
    if (text.startsWith('</')) { stack.pop(); continue; }
    if (text.startsWith('<')) {
      const tag = text.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const node = new Element(tag);
      for (const m of text.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(m[1], m[2]);
      stack.at(-1).appendChild(node);
      if (!['input', 'br', 'hr', 'img', 'meta', 'link'].includes(tag) && !text.endsWith('/>')) stack.push(node);
    } else stack.at(-1).appendChild(new TextNode(text));
  }
  root.getElementById = id => root.querySelector('#' + id);
  root.createElement = tag => new Element(tag);
  root.createElementNS = (_, tag) => new Element(tag);
  root.createTextNode = text => new TextNode(text);
  return root;
}

Object.defineProperties(Element.prototype, {
  innerHTML: { set(html) { this.children.slice().forEach(x => x.remove()); const fragment = documentOf(html); for (const child of [...fragment.children]) this.appendChild(child); } },
  isConnected: { get() { let root = this; while (root.parentNode) root = root.parentNode; return root.tagName === 'document'; } },
  value: { get() { return this._value ?? (this.tagName === 'select' ? this.children.find(x => x.tagName === 'option')?.value ?? '' : ''); }, set(value) { this._value = value; } }
});
Element.prototype.replaceChild = function (node, prior) { this.insertBefore(node, prior); this.removeChild(prior); return prior; };
Element.prototype.fire = function (name) { return Promise.all((this.listeners[name] || []).map(fn => fn({ target: this, key: '', preventDefault() {} }))); };
Element.prototype.matches = function (selector) {
  const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  if (attrs.some(([, key, value]) => !(key in this.attrs) || (value !== undefined && this.attrs[key] !== value))) return false;
  if (selector.includes(':checked') && !this.checked) return false;
  const plain = selector.replace(/\[[^\]]+\]|:checked/g, '');
  const tag = plain.match(/^[\w-]+/), id = plain.match(/#([\w-]+)/);
  return (!tag || this.tagName === tag[0]) && (!id || this.id === id[1]) &&
    [...plain.matchAll(/\.([\w-]+)/g)].every(x => this.className.split(/\s+/).includes(x[1]));
};
const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function estimate(body, label = 'current estimate') { return { est_compute_sec: 1, est_comm_sec: 2, est_comm_bytes: 20, rounds: 3,
  comm_breakdown: { transfer_sec: 1, latency_sec: 1 }, steps: [], formula: { compute: label, comm_volume: 'volume', comm_time: 'time' },
  party_count: 3, data_rows: body.data_rows, assumptions: { bandwidth_mbps: body.bandwidth_mbps, rtt_ms: body.rtt_ms, kappa_bits: 128 } }; }
function dry() { return { dataset_note: 'actual inputs', inputs: [], steps: [], result: { type: 'scalar', value: 1, revealed_to_names: ['output'] },
  stats: { comm_bytes: 1, rounds: 1, compute_sec: .1 }, warnings: [] }; }
function boot() {
  const document = documentOf(source('index.html')), queues = new Map(), calls = [], failures = [], navigations = [], timers = new Map();
  const catalog = { protocols: ['ss', 'gc', 'ot'].map(protocol => ({ protocol, name: protocol.toUpperCase(), full_name: protocol, principle: 'native protocol', rounds_note: 'measured', params_schema: [], operators: [], security_models: [] })),
    value_types: ['parties', 'vector', 'scalar', 'bool'].map(key => ({ key, name: key })),
    operators: [
      { key: 'secure_sum', name: 'sum', protocols: ['ss'], io: { parties: 'vector', vector: 'scalar' } },
      { key: 'secure_mean', name: 'mean', protocols: ['ss'], io: { parties: 'vector', vector: 'scalar' } },
      { key: 'secure_compare', name: 'compare', protocols: ['gc'], io: { parties: 'bool', scalar: 'bool' } }
    ] };
  let timerId = 0;
  const sandbox = { document, Node: Element, console, setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    App: { go(...args) { navigations.push(args); } },
    Api: {
      async get(path) {
        if (path === '/mpc/protocols') return catalog;
        if (path.endsWith('/mpc/params')) return { items: ['ss', 'gc', 'ot'].map(protocol => ({ protocol, params: {} })) };
        if (path.endsWith('/mpc/parties')) return { items: [
          { party_id: 'one', name: 'One', default_roles: ['input', 'compute'] },
          { party_id: 'two', name: 'Two', default_roles: ['input', 'compute'] },
          { party_id: 'three', name: 'Three', default_roles: ['compute', 'output'] }
        ] };
        throw new Error('Unexpected GET ' + path);
      },
      async post(path, body) {
        calls.push({ path, body: clone(body) }); const pending = queues.get(path); if (pending?.length) return pending.shift();
        if (path.endsWith('/estimate')) return estimate(body);
        if (path.endsWith('/dry-run')) return dry();
        if (path.endsWith('/tasks')) return { task_id: 'new-task' };
        throw new Error('Unexpected POST ' + path);
      }
    } };
  sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(source('js/ui.js'), sandbox);
  sandbox.UI.fail = e => failures.push(e); sandbox.UI.toast = () => {};
  vm.runInContext(source('js/mpc-proto.js'), sandbox);
  const $ = id => document.getElementById(id);
  return { sandbox, document, $, calls, failures, navigations,
    async mount(projectId = 'p1') { await sandbox.MPCP.mount({ projectId }, $('screen-mpc-proto')); assert.deepEqual(failures, []); },
    queue(path, promise) { if (!queues.has(path)) queues.set(path, []); queues.get(path).push(promise); },
    async tick() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) await fn(); await flush(); },
    mixed() { return $('mpcpFlowBody').querySelectorAll('button').find(x => x.textContent === '各方求和 → 求均值 → 与阈值比较').fire('click'); }
  };
}

test('execution omits estimated row count, default SS sum→mean, estimate still uses assumptions', async () => {
  const b = boot(); await b.mount(); await flush();
  b.$('mpcpRows').value = '37'; await b.$('mpcpRows').fire('change'); await b.tick();
  const assumption = b.calls.filter(x => x.path.endsWith('/estimate')).at(-1);
  assert.equal(assumption.body.data_rows, 37);
  await b.$('mpcpCreate').fire('click');
  const execution = b.calls.find(x => x.path.endsWith('/tasks'));
  assert.ok(!('data_rows' in execution.body), 'server derives execution rows from registered inputs');
  assert.deepEqual(execution.body.steps.map(x => [x.operator, x.protocol]), [['secure_sum', 'ss'], ['secure_mean', 'ss']]);
  assert.match(b.$('mpcpEstBody').textContent, /预估数据规模/);
  assert.match(b.$('mpcpEstBody').textContent, /执行行数由服务端计算/);
  assert.equal(b.navigations[0][1].taskId, 'new-task'); assert.deepEqual(b.failures, []);
  b.sandbox.MPCP.unmount();
});

test('late estimate is ignored as soon as inputs change, before the debounced replacement starts', async () => {
  const b = boot(), late = deferred(); b.queue('/projects/p1/mpc/estimate', late.promise);
  await b.mount(); await flush();
  b.$('mpcpRows').value = '23'; await b.$('mpcpRows').fire('change');
  late.resolve(estimate({ data_rows: 1200000 }, 'STALE ESTIMATE')); await flush();
  assert.doesNotMatch(b.$('mpcpEstOut').textContent, /STALE/);
  await b.tick(); assert.match(b.$('mpcpEstOut').textContent, /current estimate/);
  assert.equal(b.calls.filter(x => x.path.endsWith('/estimate')).at(-1).body.data_rows, 23);
  assert.deepEqual(b.failures, []); b.sandbox.MPCP.unmount();
});

test('old dry run cannot display after flow edits, project remount or unmount', async () => {
  const b = boot(); await b.mount(); const late = deferred(); b.queue('/projects/p1/mpc/flows/dry-run', late.promise);
  const running = b.$('mpcpDryRun').fire('click'); await b.mixed();
  late.resolve(dry()); await running; assert.equal(b.$('mpcpDry').hidden, true);
  const next = deferred(); b.queue('/projects/p1/mpc/flows/dry-run', next.promise);
  const crossing = b.$('mpcpDryRun').fire('click'); await b.mount('p2');
  next.resolve(dry()); await crossing; assert.equal(b.$('mpcpDry').hidden, true);
  const last = deferred(); b.queue('/projects/p2/mpc/flows/dry-run', last.promise);
  const abandoned = b.$('mpcpDryRun').fire('click'); b.sandbox.MPCP.unmount(); last.resolve(dry()); await abandoned;
  assert.equal(b.$('mpcpDry').hidden, true); assert.deepEqual(b.failures, []);
});

test('create responses do not navigate after execution inputs change or project switches', async () => {
  const b = boot(); await b.mount(); const late = deferred(); b.queue('/projects/p1/mpc/tasks', late.promise);
  const creating = b.$('mpcpCreate').fire('click'); b.$('mpcpName').value = 'changed draft';
  late.resolve({ task_id: 'old-draft' }); await creating; assert.equal(b.navigations.length, 0);
  assert.equal(b.$('mpcpCreate').disabled, false);
  const crossing = deferred(); b.queue('/projects/p1/mpc/tasks', crossing.promise);
  const pending = b.$('mpcpCreate').fire('click'); await b.mount('p2');
  crossing.resolve({ task_id: 'old-project' }); await pending;
  assert.equal(b.navigations.length, 0); assert.equal(Boolean(b.$('mpcpCreate').disabled), false);
  assert.deepEqual(b.failures, []); b.sandbox.MPCP.unmount();
});

test('mixed template remains available and backend capability rejection is preserved', async () => {
  const b = boot(); await b.mount(); await b.mixed();
  b.queue('/projects/p1/mpc/tasks', Promise.reject(new Error('mixed protocol provider unavailable')));
  await b.$('mpcpCreate').fire('click');
  const execution = b.calls.find(x => x.path.endsWith('/tasks'));
  assert.equal(execution.body.steps.at(-1).protocol, 'gc'); assert.ok(!('data_rows' in execution.body));
  assert.equal(b.failures[0].message, 'mixed protocol provider unavailable'); assert.equal(b.navigations.length, 0);
  b.sandbox.MPCP.unmount();
});
