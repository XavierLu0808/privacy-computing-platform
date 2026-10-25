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
  value: { get() { return this._value ?? (this.tagName === 'select' ? this.children.find(x => x.tagName === 'option')?.value ?? '' : ''); }, set(value) { this._value = String(value); } }
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
  const document = documentOf(source('index.html')), calls = [], failures = [], modals = [], queues = new Map();
  const sandbox = { document, Node: Element, Event: class {}, console, setTimeout, clearTimeout, App: { go() {}, reloadProjects: async () => {} }, Api: {} };
  sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(source('js/ui.js'), sandbox);
  sandbox.UI.fail = error => failures.push(error); sandbox.UI.toast = () => {};
  sandbox.UI.modal = opts => { const node = new Element('div'); document.appendChild(node); node.appendChild(opts.body);
    const modal = { opts, close() { node.remove(); }, showError() {}, async submit() { const value = await opts.onSubmit(); if (value !== false) this.close(); } }; modals.push(modal); return modal; };
  vm.runInContext(source('js/' + script + '.js'), sandbox);
  return { sandbox, document, calls, failures, modals, $: id => document.getElementById(id),
    queue(path, promise) { if (!queues.has(path)) queues.set(path, []); queues.get(path).push(promise); },
    pending(method, path, body) { calls.push({ method, path, body }); const queue = queues.get(path); return queue?.length ? { promise: queue.shift() } : null; } };
}
function heBoot() {
  const b = base('he');
  b.sandbox.Api.get = async path => {
    const pending = b.pending('GET', path); if (pending) return pending.promise;
    if (path === '/he/schemes') return { items: ['paillier', 'ckks', 'bgv'].map(scheme => ({ scheme, name: scheme, library: 'provider', description: scheme })) };
    if (path.endsWith('/nodes') || path.endsWith('/fl/jobs')) return { items: [] };
    if (path === '/he/keys') return { items: [], policy: { enabled: true, period_days: 30 } };
    if (path.endsWith('/he/logs')) return { refs: [], summary: [], total: 1, items: [{ source: 'session', ref_name: 'native log shape', ref_id: 'key', round: null, stage_label: '加密', elapsed_ms: 1, ciphertext_kb: 2, ciphertext_count: 1, recorded_at: '2026-10-25T00:00:00Z', party: null }] };
    throw new Error('Unexpected HE GET ' + path);
  };
  b.sandbox.Api.del = async path => { b.pending('DELETE', path); return {}; };
  b.sandbox.Api.post = async (path, body) => {
    const pending = b.pending('POST', path, body); if (pending) return pending.promise;
    if (path === '/he/keys') return { key_id: 'key', key_params: { poly_modulus_degree: 8192 }, public_key_preview: 'public', elapsed_ms: 1 };
    if (path === '/he/encrypt') return { elapsed_ms: 1, scale_exponent: 2, ciphertexts: [{ ciphertext_id: 'a', preview: 'cipher-A', size_kb: 2 }, { ciphertext_id: 'b', preview: 'cipher-B', size_kb: 2 }] };
    if (path === '/he/evaluate') return { result_ciphertext_id: 'result', preview: 'cipher-result', expression: 'A+B', size_kb: 2, elapsed_ms: 1, noise_budget_remaining: null };
    if (path === '/he/decrypt') return { elapsed_ms: 1, plaintext: '3', verification: { matched: false, expected: '4', abs_error: '1' }, session_summary: { total_elapsed_ms: 4, total_ciphertext_kb: 6, logged: true } };
    throw new Error('Unexpected HE POST ' + path);
  };
  return Object.assign(b, { async mount(projectId = 'p1') { await b.sandbox.HE.mount({ projectId }); await flush(); assert.deepEqual(b.failures, []); } });
}
function project(id) { return { project_id: id, name: 'Project-' + id, type: 'production', description: '',
  base_algorithm: 'lr', base_algorithm_name: 'LR', model_version: '1.0.0', total_rounds: 10,
  target: { task_type: 'classification', metric: 'accuracy', value: .9 }, node_count: 1, job_count: 0, revision: 1, updated_by: 'operator' }; }
function orchBoot() {
  const b = base('fl-orch');
  b.sandbox.Api.get = async (path, query) => {
    const pending = b.pending('GET', path, query); if (pending) return pending.promise;
    if (path === '/projects') return { items: [], total: 0 };
    if (/^\/projects\/[^/]+$/.test(path)) return project(path.split('/')[2]);
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'new-xgb', name: '真实 XGB', current_round: 2 }, { job_id: 'actual-lr', name: '实际 LR', current_round: 1 }, { job_id: 'not-started', name: '待启动', current_round: 0 }] };
    if (path.endsWith('/nodes')) return { items: [{ node_id: 'shared-node-id', ip: '127.0.0.1', port: 1234, role: 'trainer', data_partition: 'partition', data_dir: '/data/local', online: true }] };
    if (path.endsWith('/isolation')) return { policy: { dir_rule: 'server policy', channel_rule: 'server channel' }, data_dirs: [], matrix: [], payload_allowed: [], payload_forbidden: [], checks: [] };
    if (path === '/fl/algorithms') return { items: query ? [] : [{ algo_id: 'lr', kind: 'builtin', name: 'LR', task_types: ['classification'], current_version: '1.0.0' }] };
    if (path === '/fl/algorithms/lr') return { algo_id: 'lr', task_types: ['classification'], current_version: '1.0.0', versions: [{ version: '1.0.0', is_current: true, note: '' }] };
    throw new Error('Unexpected orch GET ' + path);
  };
  b.sandbox.Api.post = b.sandbox.Api.patch = b.sandbox.Api.del = async (path, body) => { const pending = b.pending('WRITE', path, body); return pending ? pending.promise : {}; };
  b.sandbox.Api.upload = async (path, file, body) => { const pending = b.pending('UPLOAD', path, { file, ...body }); return pending ? pending.promise : { file_id: 'file' }; };
  return Object.assign(b, { async mount(projectId = 'p1') { b.sandbox.FLO.mount({ projectId }, b.$('screen-fed-orch')); await flush(); assert.deepEqual(b.failures, []); } });
}

test('HE mismatch uses the backend matched flag and log scopes never display missing-field text', async () => {
  const b = heBoot(); await b.mount();
  for (const id of ['heKeygen', 'heEnc', 'heCalc', 'heDec']) await b.$(id).fire('click'); await flush();
  assert.match(b.$('heVerifyText').textContent, /不一致/); assert.match(b.$('heVerify').className, /banner-err/);
  assert.match(b.$('heLogs').textContent, /密态运算阶段不解密输入/);
  assert.doesNotMatch(b.$('heLogList').textContent, /undefined|NaN/);
  assert.deepEqual(b.failures, []); b.sandbox.HE.unmount();
});

test('HE input edits and project/unmount transitions invalidate pending crypto responses', async () => {
  const b = heBoot(); await b.mount(); await b.$('heKeygen').fire('click');
  const stale = deferred(); b.queue('/he/encrypt', stale.promise); const encrypting = b.$('heEnc').fire('click');
  b.$('heA').value = '9'; await b.$('heA').fire('input');
  stale.resolve({ elapsed_ms: 99, ciphertexts: [{ preview: 'STALE CIPHER' }, {}] }); await encrypting;
  assert.equal(b.$('heCalc').disabled, true); assert.doesNotMatch(b.$('heLogs').textContent, /STALE/);
  const oldKey = deferred(); b.queue('/he/keys', oldKey.promise); const generating = b.$('heKeygen').fire('click'); await flush();
  b.sandbox.HE.unmount(); await b.mount('p2'); oldKey.resolve({ key_id: 'STALE KEY' }); await generating;
  assert.equal(b.$('heEnc').disabled, true); assert.doesNotMatch(b.$('heLogs').textContent, /STALE/); assert.deepEqual(b.failures, []);
});

test('HE old generation modal cannot create a key under the newly selected project', async () => {
  const b = heBoot(); await b.mount(); await b.$('heKeyNew').fire('click'); const modal = b.modals.at(-1);
  b.sandbox.HE.unmount(); await b.mount('p2'); await assert.rejects(modal.submit(), /项目上下文已变更/);
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0);
});

test('old project node add/edit/delete dialogs cannot write to a new project URL', async () => {
  const b = orchBoot(); await b.mount();
  await b.$('floAddNode').fire('click'); const adding = b.modals.at(-1);
  await b.mount('p2'); await assert.rejects(adding.submit(), /项目上下文已变更/);
  const edit = b.$('floNodes').querySelectorAll('button').find(x => x.textContent === '编辑'); await edit.fire('click');
  const editing = b.modals.at(-1); b.$('fnIp').value = '127.0.0.2';
  await b.mount('p1'); await assert.rejects(editing.submit(), /项目上下文已变更/);
  const del = b.$('floNodes').querySelectorAll('button').find(x => x.textContent === '删除'); await del.fire('click'); const deleting = b.modals.at(-1);
  b.sandbox.FLO.unmount(); await assert.rejects(deleting.submit(), /项目上下文已变更/);
  assert.equal(b.calls.filter(x => x.method === 'WRITE').length, 0); assert.deepEqual(b.failures, []);
});

test('old project configuration and in-flight model upload cannot target the replacement project', async () => {
  const b = orchBoot(); await b.mount(); await b.$('floEdit').fire('click'); await flush(); const editing = b.modals.at(-1);
  await b.mount('p2'); await assert.rejects(editing.submit(), /项目上下文已变更/);
  await b.$('floUpload').fire('click'); const uploading = b.modals.at(-1), input = b.$('fuFile');
  input.files = [{ name: 'model.pt' }]; await input.fire('change');
  const response = deferred(); b.queue('/files', response.promise); const submitted = uploading.submit();
  await b.mount('p1'); response.resolve({ file_id: 'old-project-file' }); await submitted;
  assert.equal(b.calls.filter(x => x.method === 'WRITE').length, 0);
  assert.equal(b.calls.find(x => x.method === 'UPLOAD').body.project_id, 'p2'); assert.deepEqual(b.failures, []);
});

function aggregationView(projectId) {
  const ss = { parties: 2, threshold: 2, dropout_tolerance: 0, field_bits: 16, mask_rotation_rounds: 5 };
  const he = { scheme: 'paillier', key_size_bits: 2048, precision_bits: 24, batch_size: 16, poly_modulus_degree: 8192, coeff_modulus_bits: 218, scale_bits: 40 };
  const sparsification = { enabled: true, topk_ratio: .15, error_feedback: true, quant_bits: 8 };
  return { project_id: projectId, project_name: 'Project-' + projectId, strategy: 'ss', ss, he, sparsification,
    defaults: { he }, saved: false, trainer_count: 2,
    recommended: { ss, he: { paillier: he, ckks: he }, sparsification } };
}
function aggregationBoot() {
  const b = base('fl-agg');
  b.sandbox.Api.get = async path => { const p = b.pending('GET', path); if (p) return p.promise;
    return path.endsWith('/keys') ? { items: [] } : aggregationView(path.split('/')[2]); };
  b.sandbox.Api.post = async (path, body) => { const p = b.pending('POST', path, body); if (p) return p.promise;
    return { strategy: 'ss', ciphertext_count: 0, kept: 10, client_count: 2, ours_bytes: 400, fedavg_bytes: 2000, ratio: 5,
      upload_bytes_per_client: 20, model: 'model', model_params: 100, rho: .15, index_bits: 7, meets_contract: false }; };
  b.sandbox.Api.put = async (path, body) => { const p = b.pending('PUT', path, body); if (p) return p.promise; return aggregationView(path.split('/')[2]); };
  return Object.assign(b, { async mount(projectId = 'p1') { b.sandbox.FLA.mount({ projectId }, b.$('screen-fed-agg')); await flush(); assert.deepEqual(b.failures, []); } });
}

test('aggregation reset modal and pending save keep their original project generation', async () => {
  const b = aggregationBoot(); await b.mount(); await b.$('flaReset').fire('click'); const modal = b.modals.at(-1);
  b.sandbox.FLA.unmount(); await b.mount('p2'); await assert.rejects(modal.submit(), /项目上下文已变更/);
  assert.equal(b.calls.filter(x => x.path.endsWith('/reset')).length, 0);
  const save = deferred(); b.queue('/projects/p2/fl/aggregation', save.promise); const saving = b.$('flaSave').fire('click');
  await b.mount('p1'); save.resolve(aggregationView('STALE')); await saving;
  assert.match(b.$('flaSaved').textContent, /Project-p1/); assert.doesNotMatch(b.$('flaSaved').textContent, /STALE/);
  assert.deepEqual(b.failures, []); b.sandbox.FLA.unmount();
});

test('evaluation late start and old SSE events cannot mutate a remounted evaluation page', async () => {
  const b = base('fl-eval'), subscriptions = [];
  const defaults = {
    gradient_attack: { sample_count: 20, max_iterations: 50, target_client: 'all', seed: 0 },
    compression: { rounds: 5, topk_ratio: .15, quant_bits: 8, error_feedback: true, field_bits: 16 },
    accuracy: { rounds: 10, local_epochs: 1, partition: 'iid', seed: 0 }
  };
  let running = true;
  b.sandbox.Api.get = async path => { const p = b.pending('GET', path); if (p) return p.promise;
    return path.endsWith('/defaults') ? clone(defaults) : { items: running ? [{ eval_id: 'old-eval', kind: 'compression', status: 'running', progress: 10, config: defaults.compression }] : [] }; };
  b.sandbox.Api.post = async (path, body) => { const p = b.pending('POST', path, body); return p ? p.promise : {}; };
  b.sandbox.Api.subscribe = (path, handlers) => { const subscription = { path, handlers, closed: false, close() { this.closed = true; } }; subscriptions.push(subscription); return subscription; };
  const mount = async pid => { b.sandbox.FLE.mount({ projectId: pid }, b.$('screen-fed-eval')); await flush(); };
  await mount('p1'); const stale = subscriptions.at(-1); assert.ok(stale);
  const response = deferred(); b.queue('/projects/p1/fl/evaluations', response.promise);
  const starting = b.$('fleRun_accuracy').fire('click');
  b.sandbox.FLE.unmount(); running = false; await mount('p2');
  assert.equal(stale.closed, true);
  stale.handlers.progress({ progress: 99, stage: 'STALE' });
  stale.handlers.finished({ eval_id: 'old-eval', kind: 'compression', status: 'finished' });
  response.resolve({ eval_id: 'late-start', kind: 'accuracy', status: 'running', progress: 1 }); await starting;
  assert.equal(subscriptions.length, 1); assert.equal(!!b.$('fleRun_compression').disabled, false);
  assert.match(b.$('fleRes_compression').textContent, /尚未评估/); assert.doesNotMatch(b.$('screen-fed-eval').textContent, /STALE/);
  assert.deepEqual(b.failures, []); b.sandbox.FLE.unmount();
});

test('actual isolation audit renders encoder metadata and measured uplink without invented sparsity or downlink bytes', async () => {
  const b = orchBoot(); await b.mount();
  const receipt = { type: 'payload', result: 'passed', at: '2026-10-26T00:00:00Z', job_id: 'actual-lr', job_name: '实际 LR', round: 1, model_params: 24,
    detail: '核对已提交编码器字段与实测字节；不读取原始梯度，不表示形式化证明', basis: 'encoder_schema_and_measured_bytes',
    scope_note: 'uplink serialized encoder bytes; no packet capture or raw gradient values', nodes: [
      { node_id: 'trainer-a', direction: 'uplink', fields: [{ field: 'weights_delta', kind: 'gradient', dtype: 'secret_share', elements: 24 }],
        wire_fields: ['SPUIO.meta', 'SPUIO.io_info', 'SPUIO.secret_share_chunks'], wire_bytes: 200, wire_bytes_measured: true, logical_source: 'encoded_model_update' },
      { node_id: 'aggregator', direction: 'downlink', fields: [{ field: 'global_weights', kind: 'model_param', dtype: 'torch_state_in_process', elements: 24 }],
        wire_fields: [], wire_bytes: null, wire_bytes_measured: false, logical_source: 'shared_process_state_assignment_no_network_measurement' }
    ] };
  b.$('floAuditJob').value = 'actual-lr';
  b.queue('/projects/p1/isolation/checks', Promise.resolve(receipt)); await b.$('floCheckPayload').fire('click');
  assert.deepEqual(clone(b.calls.filter(x => x.method === 'WRITE').at(-1).body), { type: 'payload', job_id: 'actual-lr' });
  const text = b.$('floIsoLogs').textContent;
  assert.match(text, /weights_delta.*secret_share.*24 个元素/); assert.match(text, /编码器序列化实测 200 B/);
  assert.match(text, /SPUIO\.secret_share_chunks/); assert.match(text, /下行未独立测量/);
  assert.match(text, /encoder_schema_and_measured_bytes/); assert.match(text, /no packet capture or raw gradient values/);
  assert.doesNotMatch(text, /undefined|NaN|明文 float32|单条明文|链路合计|Top-k|未做稀疏化|参数来自/);
  const old = deferred(); b.queue('/projects/p1/isolation/checks', old.promise); const checking = b.$('floCheckPayload').fire('click');
  await b.mount('p2'); old.resolve({ ...receipt, job_name: 'STALE AUDIT' }); await checking;
  assert.doesNotMatch(b.$('floIsoLogs').textContent, /STALE AUDIT/); assert.match(b.$('floIsoLogs').textContent, /暂无检测记录/);
  assert.deepEqual(b.failures, []); b.sandbox.FLO.unmount();
});

test('audit task selector uses only trained project jobs and clears during empty-project transition or late list responses', async () => {
  const b = orchBoot(); await b.mount();
  const select = b.$('floAuditJob');
  assert.deepEqual(select.children.map(x => x.value), ['new-xgb', 'actual-lr']);
  assert.match(select.textContent, /真实 XGB.*new-xgb.*实际 LR.*actual-lr/);
  assert.equal(b.$('floCheckPayload').disabled, false);
  const oldList = deferred(); b.queue('/projects/p2/fl/jobs', oldList.promise);
  b.sandbox.FLO.mount({ projectId: 'p2' }, b.$('screen-fed-orch'));
  assert.equal(select.children.length, 0); assert.equal(b.$('floCheckPayload').disabled, true);
  b.queue('/projects/empty/fl/jobs', Promise.resolve({ items: [] }));
  b.queue('/projects/empty/nodes', Promise.resolve({ items: [] }));
  await b.mount('empty');
  oldList.resolve({ items: [{ job_id: 'stale-other-project', name: 'STALE', current_round: 9 }] }); await flush();
  assert.equal(select.children.length, 0); assert.equal(select.value, ''); assert.equal(select.disabled, true);
  assert.equal(b.$('floCheckPayload').disabled, true); assert.equal(b.$('floCheckDir').disabled, true);
  const writes = b.calls.filter(x => x.method === 'WRITE').length; await b.$('floCheckPayload').fire('click');
  assert.equal(b.calls.filter(x => x.method === 'WRITE').length, writes);
  assert.doesNotMatch(select.textContent, /STALE/); assert.deepEqual(b.failures, []); b.sandbox.FLO.unmount();
});
