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

function base(script) {
  const document = documentOf(source('index.html')), queues = new Map(), calls = [], failures = [], subscriptions = [], modals = [], uploads = [];
  const sandbox = { document, Node: Element, console, setTimeout, clearTimeout, Event: class {},
    Api: { subscribe(path, handlers) { const item = { path, handlers, closed: false, close() { this.closed = true; } }; subscriptions.push(item); return item; },
      upload(path, file, fields) { const d = deferred(); uploads.push({ file, fields, ...d }); return d.promise; } } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(source('js/ui.js'), sandbox); sandbox.UI.fail = error => failures.push(error); sandbox.UI.toast = () => {};
  sandbox.UI.modal = opts => { const node = new Element('div'); document.appendChild(node); node.appendChild(opts.body);
    const modal = { opts, close() { node.remove(); }, async submit() { const result = await opts.onSubmit(); if (result !== false) this.close(); } }; modals.push(modal); return modal; };
  vm.runInContext(source('js/' + script + '.js'), sandbox);
  return { sandbox, document, calls, failures, subscriptions, modals, uploads,
    $: id => document.getElementById(id),
    queue(path, promise) { if (!queues.has(path)) queues.set(path, []); queues.get(path).push(promise); },
    queued(method, path, body) { calls.push({ method, path, body }); const q = queues.get(path); return q?.length ? { promise: q.shift() } : null; } };
}
function mpcTask(id) { return { task_id: id, name: 'MPC-' + id, flow: 'flow', protocols: ['ss'], status: 'running',
  steps: [], parties: [], progress_pct: 10, data_rows: 100, estimate: { est_compute_sec: 1, est_comm_sec: 1, est_comm_mb: 1, rounds: 2 },
  alarms: [], anomaly_rule: { threshold_pct: 50, description: 'measured' }, summary: { total_comm_bytes: 20, mean_comm_bytes: 10,
    max_compute_sec: .2, mean_compute_sec: .1, interaction_rounds: 1, abnormal_parties: 0 } }; }
function mpcBoot() {
  const b = base('mpc'), db = { A: mpcTask('A'), B: mpcTask('B'), C: mpcTask('C') };
  b.sandbox.Api.get = async (path, query) => {
    const pending = b.queued('GET', path, query); if (pending) return pending.promise;
    if (/\/projects\/[^/]+\/mpc\/tasks$/.test(path)) return { total: 0, items: query?.status === 'all' ? (path.includes('/p2/') ? [db.C] : [db.A, db.B]) : [] };
    const id = /^\/mpc\/tasks\/([^/]+)$/.exec(path)?.[1]; if (id) return clone(db[id]);
    throw new Error('Unexpected MPC path ' + path);
  };
  b.sandbox.Api.post = async (path, body) => { const pending = b.queued('POST', path, body); return pending ? pending.promise : clone(db.A); };
  return Object.assign(b, { db, mount: projectId => b.sandbox.MPC.mount({ projectId: projectId || 'p1' }, b.$('screen-mpc-ops')),
    select(id) { b.$('mpcTaskSel').value = id; return b.$('mpcTaskSel').fire('change'); } });
}
function pipe(id) { return { pipeline_id: id, protocol: 'ecdh', status: 'running',
  stages: ['intersect', 'align', 'train'].map((stage, index) => ({ stage, name: id + '-' + stage, status: index ? 'pending' : 'running', progress_pct: index ? 0 : 10, duration_sec: null, stats: {} })) }; }
function dataset(id, party) { return { dataset_id: id, name: 'Dataset-' + id, party_id: party, party_name: party,
  source_type: 'file', source: { file_name: id + '.csv', row_count_basis: 'parsed' }, status: 'ready', row_count: 2,
  feature_count: 1, columns: [{ name: 'id', type: 'string' }], id_column: 'id', preview: [], created_at: '2026-10-25T00:00:00Z' }; }
function psiBoot() {
  const b = base('psi'), pipelines = { p1: pipe('P1'), p2: pipe('P2') };
  b.sandbox.Api.get = async path => {
    const pending = b.queued('GET', path); if (pending) return pending.promise;
    if (path === '/psi/protocols') return { items: [{ protocol: 'ecdh', name: 'ECDH', params: [], security: { security_bits: 128 } }] };
    if (path === '/psi/parties') return { items: [{ party_id: 'left', party_name: 'Left' }, { party_id: 'right', party_name: 'Right' }] };
    if (path.endsWith('/datasets')) return { items: [dataset(path.includes('/p2/') ? 'C' : 'A', 'left'), dataset('B', 'right')] };
    if (path.endsWith('/psi/config')) return { protocol: 'ecdh', params: {} };
    if (path.endsWith('/psi/templates')) return { items: [] };
    if (path.endsWith('/psi/pipelines')) return { items: [clone(pipelines[path.includes('/p2/') ? 'p2' : 'p1'])] };
    if (path.startsWith('/psi/pipelines/')) return clone(Object.values(pipelines).find(x => x.pipeline_id === path.split('/').at(-1)));
    if (path.endsWith('/nodes')) return { items: [] };
    throw new Error('Unexpected PSI path ' + path);
  };
  b.sandbox.Api.post = async (path, body) => { const pending = b.queued('POST', path, body); if (pending) return pending.promise;
    if (path.endsWith('/datasets')) return { dataset_id: 'created', name: body.name };
    throw new Error('Unexpected PSI POST ' + path); };
  return Object.assign(b, { pipelines,
    mount: (projectId = 'p1', sub = 'pipe') => b.sandbox.PSI.mount({ projectId }, b.$('screen-psi-' + sub), { sub }),
    async openImport() { await b.$('dsNew').fire('click'); return b.modals.at(-1); } });
}

test('MPC same-project A→B late detail and action cannot replace B or subscribe A', async () => {
  const b = mpcBoot(), detail = deferred(); b.queue('/mpc/tasks/A', detail.promise);
  const mounting = b.mount(); await flush(); await b.select('B'); await flush();
  assert.match(b.$('mpcSummary').textContent, /MPC-B/);
  detail.resolve(clone(b.db.A)); await mounting;
  assert.doesNotMatch(b.$('mpcSummary').textContent, /MPC-A/);
  assert.deepEqual(b.subscriptions.map(x => x.path), ['/mpc/tasks/B/events']);
  const action = deferred(); b.queue('/mpc/tasks/B/actions', action.promise); const stopping = b.$('mpcRun').fire('click');
  await b.select('A'); await flush(); action.resolve({ ...b.db.B, name: 'STALE ACTION' }); await stopping;
  assert.match(b.$('mpcSummary').textContent, /MPC-A/); assert.doesNotMatch(b.$('mpcSummary').textContent, /STALE/);
  assert.deepEqual(b.failures, []);
});

test('MPC finished refetch, old SSE and unmounted callbacks stay in their original selection', async () => {
  const b = mpcBoot(); await b.mount(); const old = b.subscriptions[0], late = deferred();
  b.queue('/mpc/tasks/A', late.promise); const finished = old.handlers.status_changed({ status: 'finished' });
  await b.select('B'); await flush(); late.resolve(clone(b.db.A)); await finished;
  await old.handlers.snapshot({ ...b.db.A, name: 'OLD SNAPSHOT' }); old.handlers.metrics({}); old.handlers.alarm_raised({});
  assert.match(b.$('mpcSummary').textContent, /MPC-B/); assert.deepEqual(b.failures, []);
  b.sandbox.MPC.unmount(); await b.mount('p2');
  await old.handlers.status_changed({ status: 'finished' }); assert.match(b.$('mpcSummary').textContent, /MPC-C/);
});

test('PSI late dataset load, cancel and SSE do not overwrite a new project pipeline', async () => {
  const b = psiBoot(), datasets = deferred(); b.queue('/projects/p1/datasets', datasets.promise);
  const oldMount = b.mount(); await flush(); await b.mount('p2');
  datasets.resolve({ items: [dataset('STALE', 'left')] }); await oldMount;
  assert.match(b.$('dsList').textContent, /Dataset-C/); assert.doesNotMatch(b.$('dsList').textContent, /STALE/);
  await b.mount('p1'); const old = b.subscriptions.at(-1), cancellation = deferred();
  b.queue('/psi/pipelines/P1/cancel', cancellation.promise); const canceling = b.$('psiPipeReset').fire('click');
  await b.mount('p2'); cancellation.resolve({ ...b.pipelines.p1, status: 'canceled' }); await canceling;
  await old.handlers.snapshot(b.pipelines.p1); old.handlers.stage_progress({ stage: 'intersect', name: 'STALE stage', progress_pct: 100 });
  old.handlers.pipeline_finished({ status: 'failed', error: 'STALE ERROR' });
  assert.match(b.$('psiStages').textContent, /P2-intersect/); assert.doesNotMatch(b.$('psiStages').textContent, /P1|STALE/);
  assert.deepEqual(b.failures, []);
});

test('PSI unmount fences pending pipeline recovery and same-ID callbacks from a prior visit', async () => {
  const b = psiBoot(); await b.mount(); const old = b.subscriptions[0], late = deferred();
  b.queue('/psi/pipelines/P1', late.promise); const mounting = b.mount(); await flush(); b.sandbox.PSI.unmount();
  late.resolve({ ...b.pipelines.p1, stages: [{ ...b.pipelines.p1.stages[0], name: 'STALE RECOVERY' }] }); await mounting;
  await b.mount(); old.handlers.stage_progress({ stage: 'intersect', name: 'STALE EVENT', progress_pct: 100 });
  assert.match(b.$('psiStages').textContent, /P1-intersect/); assert.doesNotMatch(b.$('psiStages').textContent, /STALE/);
  assert.deepEqual(b.failures, []);
});

test('PSI uploads bind current file and submit server-parsed CSV without browser guesses', async () => {
  const b = psiBoot(); await b.mount('p1', 'data'); const modal = await b.openImport(), input = b.$('diFile');
  b.$('diSrc').value = 'file'; b.$('diName').value = 'quoted CSV'; b.$('diKey').value = 'id';
  const a = { name: 'old.csv', size: 10, text() { assert.fail('browser must not parse CSV'); } };
  const current = { name: 'quoted.csv', size: 40, text() { return 'id,note\na,"comma, here"\nb,"multi\nline"\n'; } };
  input.files = [a]; const first = input.fire('change'); input.files = [current]; const second = input.fire('change');
  b.uploads[1].resolve({ file_id: 'current-file', file_name: 'quoted.csv', size_bytes: 40 }); await second;
  b.uploads[0].resolve({ file_id: 'old-file', file_name: 'old.csv', size_bytes: 10 }); await first;
  await modal.submit(); const call = b.calls.find(x => x.method === 'POST');
  assert.equal(call.path, '/projects/p1/datasets'); assert.equal(call.body.source.file_id, 'current-file');
  for (const key of ['row_count', 'columns', 'sample_rows']) assert.ok(!(key in call.body), key);
  assert.deepEqual(b.failures, []);
});

test('PSI closed/cleared/cross-project import uploads cannot be adopted, and backend errors stay visible', async () => {
  const b = psiBoot(); await b.mount('p1', 'data'); const modal = await b.openImport(), input = b.$('diFile');
  b.$('diSrc').value = 'file'; input.files = [{ name: 'parquet.parquet' }];
  const failed = input.fire('change'); b.uploads[0].reject(new Error('Parquet provider is unavailable')); await failed;
  assert.match(modal.opts.body.textContent, /Parquet provider is unavailable/);
  input.files = [{ name: 'A.csv' }]; const old = input.fire('change'); input.files = []; await input.fire('change');
  b.uploads[1].resolve({ file_id: 'cleared', file_name: 'cleared.csv', size_bytes: 20 }); await old;
  await assert.rejects(modal.submit(), /当前文件上传成功/);
  input.files = [{ name: 'A.csv' }]; const crossing = input.fire('change'); await b.mount('p2', 'data');
  b.uploads[2].resolve({ file_id: 'crossing', file_name: 'crossing.csv', size_bytes: 20 }); await crossing;
  await assert.rejects(modal.submit(), /项目上下文已变更/);
  const next = await b.openImport(), newFile = b.$('diFile'); newFile.files = [{ name: 'closed.csv' }]; const closed = newFile.fire('change'); next.close();
  b.uploads[3].resolve({ file_id: 'closed', file_name: 'closed.csv', size_bytes: 20 }); await closed;
  assert.doesNotMatch(next.opts.body.textContent, /已上传 closed/);
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0); assert.deepEqual(b.failures, []);
});


test('PSI pipeline delegates aligned training topology to backend registered defaults', async () => {
  const b = psiBoot(); await b.mount();
  b.queue('/projects/p1/psi/pipelines', Promise.resolve(pipe('created')));
  await b.$('psiRun').fire('click');
  const request = b.calls.find(x => x.method === 'POST' && x.path === '/projects/p1/psi/pipelines');
  assert.ok(request);
  assert.deepEqual(clone(request.body.training), { auto_start: false });
  assert.equal(request.body.parties.length, 2);
  assert.equal(Object.hasOwn(request.body.training, 'fl_job_config'), false);
  assert.equal(b.calls.some(x => x.path === '/projects/p1/nodes'), false);
  assert.equal(b.failures.length, 0);
});

test('native MPC DTO without step names or abnormal_parties renders recorded metrics and honest scopes', async () => {
  const b = mpcBoot();
  const actual = {
    ...b.db.A, status: 'finished', data_rows: 12, progress_pct: 100, provider: 'mpyc',
    steps: [{ operator: 'secure_sum', protocol: 'ss', operand: {}, in_type: 'parties', out_type: 'vector' },
      { operator: 'secure_mean', protocol: 'ss', operand: {}, in_type: 'vector', out_type: 'scalar' }],
    flow: '安全求和 → 安全求均值', party_count: 3, total_comm_bytes: 2556, total_duration_sec: .12, alarm_count: 0,
    duration_scope: 'sum_of_measured_attempt_wall_seconds_unknown_interrupted_time_excluded',
    measurement_scope: { compute_sec: 'per_party_execution_wall_seconds_including_wait' },
    summary: { total_comm_bytes: 2556, mean_comm_bytes: 852, max_compute_sec: .04, mean_compute_sec: .04,
      total_duration_sec: .12, interaction_rounds: 5, alarm_count: 0 },
    parties: ['first', 'second', 'third'].map(party_id => ({ party_id, name: party_id, tag: party_id,
      node_id: party_id, ip: '127.0.0.1', roles: ['compute'], status: 'finished', comm_bytes: 852,
      compute_sec: .04, interaction_rounds: 5, comm_deviation_pct: 0, compute_deviation_pct: 0 })),
    alarms: []
  };
  b.db.A = actual;
  b.queue('/projects/p1/mpc/tasks', Promise.resolve({ items: [clone(actual)], total: 1 }));
  b.queue('/projects/p1/mpc/tasks', Promise.resolve({ items: [clone(actual)], total: 1 }));
  await b.sandbox.MPC.mount({ projectId: 'p1' }, b.$('screen-mpc-ops'), { taskId: 'A' }); await flush();
  assert.match(b.$('mpcSummary').textContent, /安全求和.*安全求均值/);
  assert.match(b.$('mpcSummary').textContent, /12 行/);
  assert.match(b.$('mpcMetrics').textContent, /0 \/ 3 方/);
  assert.match(b.$('mpcMetrics').textContent, /5 轮/);
  assert.match(b.$('mpcMetrics').textContent, /墙钟时间.*包含等待.*未拆分纯计算与通信/);
  assert.match(b.$('mpcHistCount').textContent, /已测量尝试的墙钟时间之和/);
  assert.doesNotMatch(b.$('mpcHistCount').textContent, /最慢一方.*通信耗时/);
  assert.doesNotMatch(b.$('screen-mpc-ops').textContent, /undefined|NaN/);
  assert.deepEqual(b.failures, []);
  // Two distinct alarms for one party count as one affected node, not two.
  // Finished details intentionally do not subscribe. Reopen a running snapshot.
  b.db.A = { ...actual, status: 'running' };
  b.$('mpcTaskSel').value = 'A'; await b.$('mpcTaskSel').fire('change'); await flush();
  const current = b.subscriptions.at(-1);
  current.handlers.snapshot({ ...b.db.A, alarms: [
    { party_id: 'first', type: 'comm_anomaly', message: 'comm', raised_at: null },
    { party_id: 'first', type: 'compute_anomaly', message: 'compute', raised_at: null }
  ] });
  assert.match(b.$('mpcMetrics').textContent, /1 \/ 3 方/);
  current.handlers.snapshot({ ...b.db.A, summary: { ...actual.summary, max_compute_sec: null, mean_compute_sec: null },
    parties: [], alarms: [] });
  assert.match(b.$('mpcMetrics').textContent, /最长执行耗时—/);
  assert.doesNotMatch(b.$('mpcMetrics').textContent, /undefined|NaN/);
  assert.deepEqual(b.failures, []); b.sandbox.MPC.unmount();
});

test('PSI empty project cannot start a pipeline without two ready parties and keys', async () => {
  const b = psiBoot(); b.queue('/projects/p1/datasets', Promise.resolve({ items: [] }));
  await b.mount(); assert.equal(b.$('psiRun').disabled, true);
  await b.$('psiRun').fire('click'); assert.equal(b.calls.filter(call => call.method === 'POST').length, 0);
  assert.match(b.$('psiDsNote').textContent, /两方都需要选择已就绪的数据集/);
  assert.deepEqual(b.failures, []); b.sandbox.PSI.unmount();
});
