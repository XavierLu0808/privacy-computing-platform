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
const metricsSpec = [{ key: 'loss', label: 'Loss', digits: 4, y_min: 0, y_max: 1, better: 'lower' },
  { key: 'accuracy', label: 'Accuracy', digits: 4, y_min: 0, y_max: 1, better: 'higher' }];
function detail(id, project = 'p1') {
  return { job_id: id, project_id: project, name: 'Task ' + id, task_type: 'classification', algorithm: 'lr', aggregation: 'ss',
    node_ids: [id + '-trainer', id + '-other', id + '-agg'], status: 'Running', total_rounds: 10, current_round: 3,
    allowed_actions: ['pause', 'terminate'], global_metrics: { loss: .25, accuracy: .75 }, global_metrics_prev: null,
    progress_pct: 30, eta_sec: 7, elapsed_sec: 3, eta: { alpha: .3, ema_round_sec: 1 }, metrics_spec: metricsSpec,
    aggregation_info: { type: 'ss', threshold: 2, share_count: 3 }, runtime: { workers: [], shared_executor: true },
    checkpoint: null, created_at: '2026-10-25T00:00:00Z', state_history: [] };
}
function metrics(id, value = .25) { return { series: [{ key: 'global', label: 'metrics-' + id,
  points: [{ round: 1, loss: value, accuracy: .75 }] }] }; }
function nodeItems(id) { return { items: [{ node_id: id + '-trainer', ip: '127.0.0.1', port: 1234, role: 'trainer',
  role_label: '训练', data_partition: 'part', round_upload_kb: null, status: 'pending' }] }; }
function boot() {
  const html = source('index.html').match(/<section[^>]*id="screen-fed-proc"[\s\S]*?<\/section>/)[0];
  const document = documentOf(html); document.documentElement = document;
  const queues = new Map(), calls = [], subscriptions = [], charts = [], modals = [], failures = [], uploads = [];
  const db = { A: detail('A'), B: detail('B'), C: detail('C', 'p2') };
  const lists = { p1: ['A', 'B'], p2: ['C'], empty: [] };
  const sandbox = { document, Node: Element, console, setTimeout, clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    echarts: { init() { const c = { option: null, clears: 0, clear() { this.option = null; this.clears++; },
      setOption(o) { this.option = o; }, dispose() { this.option = null; }, dispatchAction() {}, resize() {} }; charts.push(c); return c; } },
    Api: {
      async get(path, query) {
        calls.push({ method: 'GET', path, query });
        const queue = queues.get(path); if (queue?.length) return queue.shift();
        if (path === '/fl/task-types') return { items: [{ task_type: 'classification', name: '分类', algorithms: ['lr', 'custom'], requires_timeseries: false, metrics: metricsSpec, description: '分类任务' }] };
        const list = /^\/projects\/([^/]+)\/fl\/jobs$/.exec(path);
        if (list) return { items: (lists[list[1]] || []).map(id => clone(db[id])) };
        const job = /^\/fl\/jobs\/([^/]+)(?:\/(.+))?$/.exec(path);
        if (job) {
          if (job[2] === 'nodes') return nodeItems(job[1]);
          if (job[2] === 'metrics') return metrics(job[1]);
          return clone(db[job[1]]);
        }
        if (path === '/fl/metrics') return { total: 1, job_count: 1, items: [{ job_id: 'A', job_name: 'old-history-A', round: 1, series: 'global', loss: .2, recorded_at: '2026-10-25T00:00:00Z' }] };
        if (/\/projects\/[^/]+\/nodes$/.test(path)) return { items: [{ node_id: 'trainer', role: 'trainer', role_label: '训练' }] };
        if (path.endsWith('/datasets') || path.endsWith('/psi/pipelines')) return { items: [] };
        if (/^\/projects\/[^/]+$/.test(path)) return { target: { task_type: 'classification' }, base_algorithm: 'lr', total_rounds: 10, aggregation_default: 'ss' };
        if (path === '/fl/algorithms') return { items: [] };
        if (path.endsWith('/templates')) return { items: [] };
        if (path === '/fl/algorithms/lr') return { params_schema: {} };
        throw new Error('Unexpected GET ' + path);
      },
      async post(path, body) { calls.push({ method: 'POST', path, body: clone(body) }); return clone(db.B); },
      subscribe(path, handlers) { const sub = { path, handlers, closed: false, close() { this.closed = true; } }; subscriptions.push(sub); return sub; },
      upload(path, file, fields) { const d = deferred(); uploads.push({ path, file, fields, ...d }); return d.promise; }
    }
  };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(source('js/ui.js'), sandbox, { filename: 'ui.js' });
  sandbox.UI.fail = e => failures.push(e);
  sandbox.UI.toast = () => {};
  sandbox.FLO = { paramEditor() { return { el: new Element('div'), read: () => ({}), set() {} }; } };
  sandbox.UI.modal = opts => { const overlay = new Element('div'); document.appendChild(overlay); overlay.appendChild(opts.body);
    const modal = { opts, close() { overlay.remove(); }, async submit() { const result = await opts.onSubmit(); if (result !== false) this.close(); } }; modals.push(modal); return modal; };
  vm.runInContext(source('js/fl.js'), sandbox, { filename: 'fl.js' });
  const $ = id => document.getElementById(id);
  return { sandbox, document, $, db, lists, calls, charts, subscriptions, modals, failures, uploads,
    queue(path, promise) { if (!queues.has(path)) queues.set(path, []); queues.get(path).push(promise); },
    mount: (projectId = 'p1') => sandbox.FL.mount({ projectId }),
    select(id) { return $('flJobs').querySelectorAll('.table-row').find(row => row.dataset.jobId === id).fire('click'); },
    async openCreate() { await $('flNewJob').fire('click'); await flush(); return modals.at(-1); }
  };
}
function assertSelected(b, id) {
  assert.equal(b.sandbox.FL.currentJobId(), id);
  assert.equal(b.$('flJobName').textContent, 'Task ' + id);
  assert.match(b.$('flNodes').textContent, new RegExp(id + '-trainer'));
  assert.equal(b.charts.at(-1).option.series[0].name, 'metrics-' + id);
  assert.deepEqual(b.failures, []);
}

test('switching to an empty project clears details, real chart state, metrics, nodes and history', async () => {
  const b = boot(); await b.mount(); assertSelected(b, 'A');
  await b.$('flHqRun').fire('click'); assert.match(b.$('flHqRows').textContent, /old-history-A/);
  const old = b.subscriptions[0];
  await b.mount('empty');
  assert.equal(b.sandbox.FL.currentJobId(), null); assert.equal(old.closed, true);
  assert.match(b.$('flJobName').textContent, /暂无训练任务/);
  for (const id of ['flJobMeta', 'flJobType', 'flNodes', 'flWorkers', 'flCkpt', 'flStateInfo', 'flHqRows', 'flHqCount', 'flLegend']) assert.equal(b.$(id).textContent, '', id);
  for (const id of ['flLoss', 'flAcc', 'flLossPrev', 'flAccPrev', 'flEta', 'flElapsed']) assert.equal(b.$(id).textContent, '—', id);
  for (const id of ['flStart', 'flPause', 'flResume', 'flKill', 'flReset', 'flAlgo', 'flAgg', 'flExport', 'flView', 'flViewKey', 'flHqRun', 'flHqExport']) assert.equal(b.$(id).disabled, true, id);
  assert.ok(b.charts.every(chart => chart.option === null && chart.clears > 0));
  await old.handlers.snapshot(b.db.A); old.handlers.round_completed({}); await old.handlers.status_changed();
  assert.equal(b.sandbox.FL.currentJobId(), null); assert.equal(b.$('flNodes').textContent, '');
  assert.deepEqual(b.failures, []);
});

test('a real 900ms late A detail cannot replace the last B selection or create A SSE', async () => {
  const b = boot(); const delayed = new Promise(resolve => setTimeout(() => resolve(clone(b.db.A)), 900));
  b.queue('/fl/jobs/A', delayed);
  const mounting = b.mount(); await flush(); await b.select('B'); await flush(); assertSelected(b, 'B');
  await mounting; assertSelected(b, 'B');
  assert.deepEqual(b.subscriptions.map(x => x.path), ['/fl/jobs/B/events']);
});

for (const resource of ['nodes', 'metrics']) test(`out-of-order ${resource} from A cannot overwrite B`, async () => {
  const b = boot(), late = deferred(); b.queue('/fl/jobs/A/' + resource, late.promise);
  const mounting = b.mount(); await flush(); await b.select('B'); await flush(); assertSelected(b, 'B');
  late.resolve(resource === 'nodes' ? nodeItems('A') : metrics('A', .99)); await mounting;
  assertSelected(b, 'B'); assert.deepEqual(b.subscriptions.map(x => x.path), ['/fl/jobs/B/events']);
});

test('late status response and old SSE callbacks are fenced after selection and project changes', async () => {
  const b = boot(); await b.mount(); const old = b.subscriptions[0], late = deferred();
  b.queue('/fl/jobs/A', late.promise); const status = old.handlers.status_changed();
  await b.select('B'); await flush(); assertSelected(b, 'B');
  late.resolve(clone(b.db.A)); await status; assertSelected(b, 'B');
  const second = b.subscriptions.at(-1), history = deferred(); b.queue('/fl/metrics', history.promise);
  const query = b.$('flHqRun').fire('click');
  await b.mount('p2'); assertSelected(b, 'C');
  await old.handlers.snapshot(b.db.A); old.handlers.round_completed({});
  await second.handlers.snapshot(b.db.B); second.handlers.round_completed({}); await second.handlers.status_changed();
  history.resolve({ total: 1, job_count: 1, items: [{ job_name: 'stale-history' }] }); await query;
  assertSelected(b, 'C'); assert.equal(b.$('flHqRows').textContent, '');
});

test('shared App context mutation and unmount invalidate in-flight requests', async () => {
  const b = boot(), pending = deferred(), shared = { projectId: 'p1' };
  b.queue('/fl/jobs/A', pending.promise); const loading = b.sandbox.FL.mount(shared); await flush();
  shared.projectId = 'p2'; await b.sandbox.FL.mount(shared); assertSelected(b, 'C');
  pending.resolve(clone(b.db.A)); await loading; assertSelected(b, 'C');
  const later = deferred(); b.queue('/fl/jobs/A', later.promise); const loadingAgain = b.mount(); await flush();
  // Start another selection, then unmount before its nodes have returned.
  const nodes = deferred(); b.queue('/fl/jobs/B/nodes', nodes.promise); await b.select('B'); await flush();
  b.sandbox.FL.unmount(); nodes.resolve(nodeItems('B')); later.resolve(clone(b.db.A)); await loadingAgain; await flush();
  assert.equal(b.sandbox.FL.currentJobId(), null); assert.equal(b.$('flNodes').textContent, '');
  assert.ok(b.subscriptions.every(x => x.closed)); assert.deepEqual(b.failures, []);
});

test('custom model upload binds only the current file, clear selection and project/dialog lifetime', async () => {
  const b = boot(); await b.mount(); const modal = await b.openCreate();
  const file = b.$('njModel'); b.$('njAlgo').value = 'custom'; await b.$('njAlgo').fire('change');
  const a = { name: 'A.pt' }, c = { name: 'B.pt' };
  file.files = [a]; const first = file.fire('change'); file.files = [c]; const second = file.fire('change');
  b.uploads[1].resolve({ file_id: 'file-B', file_name: 'B.pt', size_bytes: 20 }); await second;
  b.uploads[0].resolve({ file_id: 'file-A', file_name: 'A.pt', size_bytes: 10 }); await first;
  assert.match(modal.opts.body.textContent, /已上传 B.pt/); assert.doesNotMatch(modal.opts.body.textContent, /已上传 A.pt/);
  await modal.submit();
  const created = b.calls.find(call => call.method === 'POST'); assert.equal(created.body.model_file_id, 'file-B');
  const next = await b.openCreate(), input = b.$('njModel'); b.$('njAlgo').value = 'custom';
  input.files = [a]; const upload = input.fire('change'); input.files = []; await input.fire('change');
  b.uploads[2].resolve({ file_id: 'stale', file_name: 'stale.pt', size_bytes: 30 }); await upload;
  assert.doesNotMatch(next.opts.body.textContent, /已上传 stale/);
  input.files = [a]; const abandoned = input.fire('change'); await b.mount('p2');
  b.uploads[3].resolve({ file_id: 'wrong-project', file_name: 'wrong-project.pt', size_bytes: 30 }); await abandoned;
  assert.doesNotMatch(next.opts.body.textContent, /已上传 wrong-project/);
  await assert.rejects(next.submit(), /项目上下文已变更/); assert.equal(b.calls.filter(x => x.method === 'POST').length, 1);
  assert.deepEqual(b.failures, []);
});

test('unmount is safe before the first mount and canceled view requests do not report stale errors', async () => {
  const b = boot(); b.sandbox.FL.unmount(); assert.equal(b.sandbox.FL.currentJobId(), null);
  await b.mount();
  const late = deferred(); b.queue('/fl/jobs/A/metrics', late.promise);
  const changing = b.$('flView').fire('change'); await flush();
  await b.select('B'); await flush(); late.reject(new Error('old request failed')); await changing;
  assertSelected(b, 'B');
});

test('late callbacks from a previous visit cannot update the same job ID after remount', async () => {
  const b = boot(); await b.mount(); const old = b.subscriptions[0];
  b.sandbox.FL.unmount(); await b.mount(); assertSelected(b, 'A'); const before = b.calls.length;
  await old.handlers.snapshot({ ...b.db.A, name: 'stale same-ID visit' });
  old.handlers.round_completed({ round: 9, global_metrics: { loss: .99, accuracy: .01 }, elapsed_sec: 999, eta_sec: 999, node_metrics: [] });
  await old.handlers.status_changed(); assertSelected(b, 'A'); assert.equal(b.$('flRound').textContent, '3');
  assert.equal(b.calls.length, before);
});

test('closing a model dialog invalidates its in-flight upload and submission', async () => {
  const b = boot(); await b.mount(); const modal = await b.openCreate(), file = b.$('njModel');
  b.$('njAlgo').value = 'custom'; file.files = [{ name: 'abandoned.pt' }]; const uploading = file.fire('change');
  modal.close(); b.uploads[0].resolve({ file_id: 'abandoned', file_name: 'abandoned.pt', size_bytes: 100 }); await uploading;
  assert.doesNotMatch(modal.opts.body.textContent, /已上传 abandoned/);
  await assert.rejects(modal.submit(), /项目上下文已变更/);
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0);
});

test('new task defaults to one source per party and compatible time columns without fixed IDs', async () => {
  const b = boot();
  const types = [
    { task_type: 'classification', name: '分类', algorithms: ['lr', 'custom'], metrics: metricsSpec, description: '分类' },
    { task_type: 'timeseries', name: '时序', algorithms: ['lr', 'custom'], metrics: metricsSpec, description: '时序', requires_timeseries: true }
  ];
  b.queue('/fl/task-types', Promise.resolve({ items: types }));
  await b.mount();
  const ds = (id, party, time) => ({ dataset_id: id, party_id: party, party_name: party,
    name: id, row_count: 200, time_column: time, columns: [] });
  b.queue('/projects/p1/datasets', Promise.resolve({ items: [
    ds('first-x', 'tenant-x', 'private_clock'), ds('shared-x', 'tenant-x', 'recorded_at'),
    ds('shared-y', 'tenant-y', 'recorded_at'), ds('other-y', 'tenant-y', 'private_other_clock'),
    ds('second-shared-y', 'tenant-y', 'recorded_at')
  ] }));
  const modal = await b.openCreate();
  const checked = () => modal.opts.body.querySelectorAll('input:checked').filter(node => node.name === 'njDs').map(node => node.value);
  assert.deepEqual(checked(), ['first-x', 'shared-y'], 'classification picks API-first source of each party');
  const ts = modal.opts.body.querySelectorAll('button').find(node => node.dataset.type === 'timeseries');
  await ts.fire('click'); await flush();
  assert.deepEqual(checked(), ['shared-x', 'shared-y'], 'timeseries selects two parties with one shared column');
  assert.deepEqual(b.$('njTimeCol').children.map(node => node.value), ['recorded_at']);
  const manual = modal.opts.body.querySelectorAll('input').find(node => node.value === 'second-shared-y');
  manual.checked = true; await manual.fire('change');
  assert.ok(checked().includes('second-shared-y'), 'manual changes remain possible');
  assert.deepEqual(b.failures, []);
});

test('aggregation status reflects actual backend key readiness and never renders null SS thresholds', async () => {
  const b = boot();
  b.db.A.aggregation = 'he'; b.db.A.aggregation_info = { type: 'he', he_key_ready: false, he_public_key_id: null };
  await b.mount();
  assert.match(b.$('flAggNote').textContent, /待后端绑定/);
  assert.equal(b.$('flViewKey').disabled, true);
  b.db.A.aggregation_info = { type: 'he', he_key_ready: true, he_public_key_id: 'actual-key' };
  await b.select('B'); await flush(); await b.select('A'); await flush();
  assert.match(b.$('flAggNote').textContent, /已就绪/); assert.equal(b.$('flViewKey').disabled, false);
  b.db.B.aggregation_info = { type: 'ss', threshold: null, share_count: null, protection_applied: false };
  await b.select('B'); await flush(); assert.doesNotMatch(b.$('flAggNote').textContent, /null/);
  assert.match(b.$('flAggNote').textContent, /等待执行器/);
  assert.deepEqual(b.failures, []);
});
