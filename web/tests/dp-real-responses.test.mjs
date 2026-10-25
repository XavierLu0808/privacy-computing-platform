import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Minimal DOM supports the production UI.js + DP.mount path, including real SVG
// attributes. No source rewriting or test-only globals expose private renderers.
class TextNode {
  constructor(text) { this.textContent = text; this.parentNode = null; this.nodeType = 3; }
  remove() { this.parentNode?.removeChild(this); }
}
class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.nodeType = 1; this.children = []; this.attrs = {};
    this.style = {}; this.dataset = {}; this.listeners = {}; this.parentNode = null;
    this.classList = { add: (...xs) => { this.className = [...new Set(this.className.split(/\s+/).concat(xs))].join(' '); } };
  }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get id() { return this.attrs.id; }
  set id(value) { this.attrs.id = value; }
  get childElementCount() { return this.children.filter(node => node.nodeType === 1).length; }
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
const source = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function boot() {
  const html = source('index.html').match(/<section[^>]*id="screen-dp-eval"[\s\S]*?<\/section>/)[0];
  const document = documentOf(html);
  const cfg = { enabled: true, mechanism: 'gaussian', accountant: 'rdp', epsilon_total: 2, clip_norm: 1,
    delta: 1e-5, total_rounds: 5, provider: 'secretflow-native' };
  const state = {
    estimate: { available: false, reason: '没有经验证的效用预测器', task_type: 'classification',
      noise_scale: 1.2, noise_multiplier: 1.2, epsilon_per_round: .4, accountant: 'rdp',
      estimated_accuracy: null, baseline_accuracy: null, accuracy_loss: null, metrics: [],
      curve: Array.from({ length: 5 }, (_, i) => ({ round: i + 1, cumulative_epsilon: (i + 1) * .4, estimated_accuracy: null })),
      histogram: [{ x: 0, density: 1 }] },
    tradeoff: { available: false, reason: '没有效用曲线，不能推荐预算', task_type: 'classification',
      metric: { label: 'Accuracy', baseline: null }, points: [{ epsilon_total: 1, metric_value: null }], recommended_epsilon: null },
    failures: []
  };
  const sandbox = { document, Node: Element, console, setTimeout, clearTimeout, setInterval, clearInterval,
    Api: {
      async get(path) {
        if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'j1', name: '真实任务', status: 'Success' }] };
        if (path.endsWith('/dp/budget')) return { rounds_completed: 2, total_rounds: 5, epsilon_used: .8,
          epsilon_total: 2, used_pct: 40, accountant: 'rdp', dp_active: true };
        if (path.endsWith('/dp/audit')) return { items: [], total: 0 };
        return cfg;
      },
      async post(path) { return path === '/dp/estimate' ? state.estimate : state.tradeoff; }
    } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('js/ui.js'), sandbox, { filename: 'ui.js' });
  sandbox.UI.fail = e => state.failures.push(e);
  vm.runInContext(source('js/dp.js'), sandbox, { filename: 'dp.js' });
  return { ...state, state, sandbox, document, mount: () => sandbox.DP.mount({ projectId: 'p1' }),
    $: id => document.getElementById(id), section: document.querySelector('#screen-dp-eval') };
}

test('unavailable utility renders reason while calibrated noise, budget and accounting stay visible', async () => {
  const b = boot(); await b.mount();
  assert.deepEqual(b.state.failures, []);
  assert.equal(b.$('dpUtil').textContent, '—');
  assert.match(b.$('dpUtil').parentNode.textContent, /没有经验证的效用预测器/);
  assert.match(b.$('dpNoiseText').textContent, /σ = 1.200/);
  assert.match(b.section.textContent, /RDP 会计/);
  assert.equal(b.$('dpUsed').textContent, '0.800');
  assert.equal(b.$('dpPerRound').textContent, '0.4000');
  assert.equal(b.$('dpHist').children.length, 1);
  assert.notEqual(b.$('dpEpsLine').getAttribute('points'), '');
  assert.equal(b.$('dpUtilLine').getAttribute('points'), '');
  assert.match(b.section.textContent, /没有效用曲线，不能推荐预算/);
  assert.doesNotMatch(b.section.textContent, /达不到/);
});

test('classification and timeseries utilText reject null/nonfinite fields but preserve actual zero', () => {
  const { sandbox: { DPC } } = boot();
  assert.equal(DPC.pct(null), '—'); assert.equal(DPC.pct(Infinity), '—');
  assert.equal(DPC.pct(0), '0.0%');
  for (const task_type of ['classification', 'timeseries']) {
    for (const invalid of [null, undefined, NaN, Infinity, -Infinity]) {
      const result = DPC.utilText({ task_type, estimated_accuracy: invalid,
        metrics: [{ estimated: invalid }], reason: '没有数据' });
      assert.equal(result.value, '—'); assert.match(result.short, /没有数据/);
    }
  }
  assert.equal(DPC.utilText({ estimated_accuracy: 0, baseline_accuracy: null, accuracy_loss: null }).value, '0.0%');
  const ts = DPC.utilText({ task_type: 'timeseries', metrics: [
    { key: 'rmse', label: 'RMSE', estimated: 0, baseline: null, change_pct: null },
    { label: 'MAE', estimated: null, baseline: null }] });
  assert.equal(ts.value, '0.0000'); assert.match(ts.sub, /MAE —/); assert.doesNotMatch(ts.sub, /NaN|Infinity/);
  assert.equal(DPC.utilText({ available: false, estimated_accuracy: 0, reason: '禁用效用' }).value, '—');
  // dp-mech.js uses the same production public formatter in its preview.
  assert.match(source('js/dp-mech.js'), /D\.utilText\(r\)\.short/);
});

test('utility curves split at missing rounds and a later unavailable response clears every segment and tradeoff', async () => {
  const b = boot();
  b.state.estimate.available = true;
  b.state.estimate.estimated_accuracy = .75;
  b.state.estimate.curve.forEach((p, i) => { p.estimated_accuracy = [0, .5, null, .7, .8][i]; });
  b.state.tradeoff = { available: true, task_type: 'classification', metric: { baseline: .9, label: 'Accuracy' },
    points: [{ epsilon_total: 1, metric_value: 0 }, { epsilon_total: 2, metric_value: null },
      { epsilon_total: 3, metric_value: .8 }], recommended_epsilon: 3, accountant: 'rdp', rule: '可用要求' };
  await b.mount();
  assert.deepEqual(b.state.failures, []);
  assert.equal(b.$('dpUtilLine').getAttribute('points').split(' ').length, 2);
  const extra = b.$('dpUtilLine').parentNode.querySelectorAll('[data-dp-util-segment]');
  assert.equal(extra.length, 1); assert.equal(extra[0].getAttribute('points').split(' ').length, 2);
  const trade = b.section.querySelectorAll('.dp-chart-wrap')[0];
  assert.ok(trade.querySelector('svg'));
  const plotted = trade.querySelectorAll('polyline');
  assert.equal(plotted.length, 3); // baseline and two separated utility points
  assert.equal(plotted[1].getAttribute('points').split(' ').length, 1);
  b.state.estimate.available = false;
  b.state.tradeoff.available = false; b.state.tradeoff.recommended_epsilon = null; b.state.tradeoff.reason = '暂无预测器';
  await b.mount();
  assert.deepEqual(b.state.failures, []);
  assert.equal(b.$('dpUtilLine').getAttribute('points'), '');
  assert.equal(b.$('dpUtilLine').parentNode.querySelectorAll('[data-dp-util-segment]').length, 0);
  assert.equal(trade.querySelector('svg'), null);
  assert.match(b.section.textContent, /暂无预测器/); assert.doesNotMatch(b.section.textContent, /达不到/);
});

test('timeseries payload with no metrics renders safely and leaves finite noise visible', async () => {
  const b = boot(); b.state.estimate.task_type = 'timeseries'; b.state.estimate.metrics = [];
  await b.mount();
  assert.deepEqual(b.state.failures, []); assert.equal(b.$('dpUtil').textContent, '—');
  assert.match(b.$('dpNoiseText').textContent, /1.200/);
});

test('framework private-metric empty state renders the server reason', async () => {
  const b = boot(), prior = b.sandbox.Api.get;
  b.sandbox.Api.get = async path => {
    if (path === '/dp/providers') return { current: 'native', items: [{ provider: 'native', name: '真实实现',
      mechanisms: ['gaussian'], accountants: ['rdp'], mapping: [], version_note: '已部署' }] };
    if (path.endsWith('/dp/hooks')) return { initialized: false, dp_enabled: true, job_status: 'Created',
      rounds_completed: 0, trainers: 2, provider_name: '真实实现', steps: [] };
    if (path.endsWith('/dp/metrics')) return { available: false, summary: null, reason: '私有梯度统计尚未获得独立发布保证' };
    return prior(path);
  };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-fw.js'), b.sandbox, { filename: 'dp-fw.js' });
  try {
    await b.sandbox.DPF.mount({ projectId: 'p1' }, sec);
    assert.deepEqual(b.state.failures, []);
    assert.match(sec.textContent, /私有梯度统计尚未获得独立发布保证/);
    assert.doesNotMatch(sec.textContent, /该任务尚无启用 DP 的训练轮次/);
  } finally { b.sandbox.DPF.unmount(); }
});

test('mechanism preview sends only estimate fields while configuration save keeps enabled', async () => {
  const b = boot(), prior = b.sandbox.Api.get, requests = [];
  b.sandbox.UI.debounce = fn => fn;
  b.sandbox.UI.toast = () => {};
  b.sandbox.Api.get = async path => {
    if (path === '/dp/mechanisms' || path.endsWith('/datasets')) return { items: [] };
    return prior(path);
  };
  b.sandbox.Api.post = async (path, body) => {
    assert.equal(path, '/dp/estimate');
    const payload = JSON.parse(JSON.stringify(body)); requests.push(payload);
    assert.deepEqual(Object.keys(payload).sort(), ['accountant', 'baseline_job_id', 'clip_mode', 'clip_norm',
      'delta', 'epsilon_total', 'mechanism', 'total_rounds'].sort());
    assert.equal(payload.baseline_job_id, 'j1'); assert.equal(payload.total_rounds, 5);
    assert.ok(!('enabled' in payload));
    return { ...b.state.estimate, delta_total: 1e-5 };
  };
  let saved = null;
  b.sandbox.Api.put = async (path, body) => {
    assert.equal(path, '/fl/jobs/j1/dp'); saved = JSON.parse(JSON.stringify(body));
    return { ...body, total_rounds: 5 };
  };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox, { filename: 'dp-mech.js' });
  await b.sandbox.DPM.mount({ projectId: 'p1' }, sec);
  assert.deepEqual(b.state.failures, []); assert.equal(requests.length, 1);
  b.$('dpmEnabled').checked = false;
  const save = sec.querySelectorAll('button').find(node => node.textContent === '保存到任务');
  await save.listeners.click[0]();
  assert.equal(saved.enabled, false, 'enabled is still part of the PUT configuration contract');
  assert.deepEqual(b.state.failures, []);
  b.sandbox.DPM.unmount();
});

test('framework implementation marked unavailable remains a preview and cannot be switched', async () => {
  const b = boot(), prior = b.sandbox.Api.get;
  let writes = 0;
  b.sandbox.Api.put = async () => { writes++; assert.fail('unavailable implementation must not be selected'); };
  b.sandbox.Api.get = async path => {
    if (path === '/dp/providers') return { current: 'native', items: [
      { provider: 'native', name: '已部署实现', available: true, mechanisms: ['gaussian'], accountants: ['rdp'], mapping: [], version_note: '已部署' },
      { provider: 'other', name: '未部署实现', available: false, unavailable_reason: '该框架适配器尚未部署', mechanisms: ['gaussian'], accountants: ['rdp'], mapping: [], version_note: '' }
    ] };
    if (path.endsWith('/dp/hooks')) return { initialized: false, dp_enabled: true, job_status: 'Created', rounds_completed: 0, trainers: 2, provider_name: '已部署实现', steps: [] };
    if (path.endsWith('/dp/metrics')) return { available: false, summary: null, reason: '无私有指标发布能力' };
    return prior(path);
  };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-fw.js'), b.sandbox, { filename: 'dp-fw.js' });
  try {
    await b.sandbox.DPF.mount({ projectId: 'p1' }, sec);
    const select = sec.querySelector('#dpfProv');
    select.value = 'other'; await select.listeners.change[0]();
    const change = sec.querySelectorAll('button').find(node => node.textContent === '切换实现');
    assert.equal(change.disabled, true); assert.match(sec.textContent, /该框架适配器尚未部署/);
    await change.listeners.click[0](); assert.equal(writes, 0);
    select.value = 'native'; await select.listeners.change[0](); assert.equal(change.disabled, false);
    assert.deepEqual(b.state.failures, []);
  } finally { b.sandbox.DPF.unmount(); }
});

test('late DP budget and audit responses cannot overwrite the newly selected task', async () => {
  const b = boot(), original = b.sandbox.Api.get;
  let releaseBudget, releaseAudit;
  const oldBudget = new Promise(resolve => { releaseBudget = resolve; }), oldAudit = new Promise(resolve => { releaseAudit = resolve; });
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'j1', name: 'First', status: 'Success' }, { job_id: 'j2', name: 'Second', status: 'Success' }] };
    if (path === '/fl/jobs/j1/dp/budget') return oldBudget;
    if (path === '/fl/jobs/j1/dp/audit') return oldAudit;
    if (path === '/fl/jobs/j2/dp/budget') return { rounds_completed: 3, total_rounds: 5, epsilon_used: 1.4, epsilon_total: 2, used_pct: 70, accountant: 'rdp', dp_active: true };
    return original(path);
  };
  const initial = b.mount(); await new Promise(resolve => setImmediate(resolve));
  b.$('dpJobSel').value = 'j2'; b.$('dpJobSel').listeners.change[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.$('dpUsed').textContent, '1.400');
  releaseBudget({ rounds_completed: 1, total_rounds: 5, epsilon_used: .1, epsilon_total: 2, used_pct: 5, accountant: 'rdp' });
  releaseAudit({ total: 1, items: [{ round: 999, epsilon_spent: .1, epsilon_cumulative: .1, noise_scale: 1, clip_norm: 1, mechanism: 'gaussian' }] });
  await initial;
  assert.equal(b.$('dpUsed').textContent, '1.400'); assert.doesNotMatch(b.$('dpAudit').textContent, /999/);
  assert.deepEqual(b.state.failures, []); b.sandbox.DP.unmount();
});

test('DP estimate input edits reject a late response before the debounced replacement request', async () => {
  const b = boot(), original = b.sandbox.Api.post; let finish; let requests = 0;
  b.sandbox.Api.post = async (path, body) => {
    if (path === '/dp/estimate' && ++requests === 1) return new Promise(resolve => { finish = resolve; });
    return original(path, body);
  };
  const initial = b.mount(); await new Promise(resolve => setImmediate(resolve));
  b.$('dpClip').value = '2'; b.$('dpClip').listeners.input[0]();
  finish({ ...b.state.estimate, noise_scale: 999 }); await initial;
  assert.doesNotMatch(b.$('dpNoiseText').textContent, /999/);
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.match(b.$('dpNoiseText').textContent, /C = 2\.0/); assert.deepEqual(b.state.failures, []);
  b.sandbox.DP.unmount();
});

test('entering an empty DP project clears old task data and disables configuration controls', async () => {
  const b = boot(); await b.mount(); const original = b.sandbox.Api.get;
  b.sandbox.Api.get = async path => path === '/projects/empty/fl/jobs' ? { items: [] } : original(path);
  b.sandbox.UI.toast = () => {};
  await b.sandbox.DP.mount({ projectId: 'empty' });
  for (const id of ['dpUsed', 'dpUtil', 'dpPerRound', 'dpNoiseText']) assert.equal(b.$(id).textContent, '—');
  assert.equal(b.$('dpAudit').textContent, ''); assert.equal(b.$('dpEpsLine').getAttribute('points'), '');
  assert.equal(b.$('dpEps').disabled, true); assert.equal(b.$('dpGauss').disabled, true);
  assert.deepEqual(b.state.failures, []); b.sandbox.DP.unmount();
});

test('empty DP framework project replaces old hook, private metrics and workflow with explicit empty states', async () => {
  const b = boot(), prior = b.sandbox.Api.get; let empty = false;
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs') && empty) return { items: [] };
    if (path === '/dp/providers') return { current: 'native', items: [{ provider: 'native', name: '平台实现', available: true,
      mechanisms: ['gaussian'], accountants: ['rdp'], mapping: [], version_note: '已部署' }] };
    if (path.endsWith('/dp/hooks')) return { initialized: true, dp_enabled: true, job_status: 'Success', rounds_completed: 10,
      trainers: 2, provider_name: 'OLD HOOK', steps: [] };
    if (path.endsWith('/dp/metrics')) return { summary: null, reason: 'OLD PRIVATE METRICS' };
    return prior(path);
  };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-fw.js'), b.sandbox);
  try {
    await b.sandbox.DPF.mount({ projectId: 'p1' }, sec); assert.match(sec.textContent, /OLD HOOK/);
    empty = true; await b.sandbox.DPF.mount({ projectId: 'empty' }, sec);
    assert.doesNotMatch(sec.textContent, /OLD|undefined|NaN|真实任务/);
    for (const acc of ['DP-FW-02', 'DP-FW-03', 'DP-FW-04']) {
      const card = sec.children.find(node => node.attrs['data-acc'] === acc);
      assert.match(card.textContent, /当前项目没有训练任务/); assert.equal(card.querySelectorAll('button').length, 0);
    }
    assert.deepEqual(b.state.failures, []);
  } finally { b.sandbox.DPF.unmount(); }
});

test('mechanism task selection rejects out-of-order configuration and old save responses', async () => {
  const b = boot(), prior = b.sandbox.Api.get; let oldConfig, oldSave;
  const baseCfg = { enabled: true, mechanism: 'gaussian', accountant: 'rdp', epsilon_total: 2, clip_norm: 1,
    delta: 1e-5, total_rounds: 5, provider: 'secretflow-native' };
  b.sandbox.UI.debounce = fn => fn; b.sandbox.UI.toast = () => {};
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'j1', name: '任务 A', status: 'Success' }, { job_id: 'j2', name: '任务 B', status: 'Success' }] };
    if (path === '/dp/mechanisms' || path.endsWith('/datasets')) return { items: [] };
    if (path === '/fl/jobs/j1/dp' && oldConfig) return oldConfig.promise;
    if (path === '/fl/jobs/j2/dp') return { ...baseCfg, epsilon_total: 8 };
    return prior(path);
  };
  b.sandbox.Api.put = async () => new Promise(resolve => { oldSave = resolve; });
  b.sandbox.Api.post = async () => ({ ...b.state.estimate, delta_total: 1e-5 });
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox, { filename: 'dp-mech.js' });
  await b.sandbox.DPM.mount({ projectId: 'p1' }, sec);
  const save = sec.querySelectorAll('button').find(node => node.textContent === '保存到任务');
  const saving = save.listeners.click[0]();
  const select = b.$('dpmJobSel'); select.value = 'j2'; select.listeners.change[0](); await new Promise(resolve => setImmediate(resolve));
  oldSave({ ...baseCfg, epsilon_total: 999 }); await saving;
  assert.equal(Number(b.$('dpmEps').value), 8);
  let finish; oldConfig = { promise: new Promise(resolve => { finish = resolve; }) };
  select.value = 'j1'; const selectingA = select.listeners.change[0]();
  select.value = 'j2'; select.listeners.change[0](); await new Promise(resolve => setImmediate(resolve)); finish({ ...baseCfg, epsilon_total: 777 }); await selectingA; await new Promise(resolve => setImmediate(resolve));
  assert.equal(Number(b.$('dpmEps').value), 8); assert.match(sec.textContent, /任务 B/);
  assert.doesNotMatch(sec.textContent, /777|999/); assert.deepEqual(b.state.failures, []);
  b.sandbox.DPM.unmount();
});

test('statistical release real DTO without label or unit uses its column in toast and history', async () => {
  const b = boot(), prior = b.sandbox.Api.get, toasts = [], writes = [];
  const release = { release_id: 'real-shape-release', noisy_value: 2.5, clip_lower: -5, clip_upper: 5,
    sensitivity: .5, noise_scale: 1, expected_rmse: 1.414, epsilon_spent: .5, group_size: 20,
    source: 'participant_csv_os_entropy_dp', mechanism: 'laplace', epsilon: .5, delta: '0',
    dataset_id: 'registered', column: 'x0', query: 'mean', clip_mode: 'fixed', status: 'released',
    released_at: '2026-10-25T00:00:00Z' };
  b.sandbox.UI.debounce = fn => fn; b.sandbox.UI.toast = text => toasts.push(text);
  b.sandbox.Api.get = async path => {
    if (path === '/dp/mechanisms') return { items: [] };
    if (path.endsWith('/datasets')) return { items: [{ dataset_id: 'registered', name: 'Actual CSV', party_name: 'A', columns: [{ name: 'x0', type: 'float' }] }] };
    if (path.endsWith('/dp/query-config')) return { mechanism: 'laplace', epsilon: .5, delta: '0', dataset_id: 'registered', column: 'x0', query: 'mean', clip_mode: 'fixed' };
    if (path.endsWith('/dp/queries')) return { items: [release], total: 1, epsilon_spent_total: .5 };
    return prior(path);
  };
  b.sandbox.Api.post = async (path, body) => { writes.push({ path, body }); return path.endsWith('/dp/query') ? release : { ...b.state.estimate, delta_total: 1e-5 }; };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox, { filename: 'dp-mech.js' });
  await b.sandbox.DPM.mount({ projectId: 'p1' }, sec);
  const queryTab = sec.querySelectorAll('button').find(node => node.textContent === '统计查询（数据集字段）');
  queryTab.listeners.click[0](); await new Promise(resolve => setImmediate(resolve));
  assert.match(sec.textContent, /x0 · 全量均值/); assert.doesNotMatch(sec.textContent, /undefined|NaN/);
  const execute = sec.querySelectorAll('button').find(node => node.textContent === '执行一次加噪查询');
  await execute.listeners.click[0]();
  assert.equal(writes.filter(x => x.path.endsWith('/dp/query')).length, 1, 'one fixture publish only; no backend or native query is executed');
  assert.equal(toasts.at(-1), 'x0：加噪结果 3');
  assert.match(sec.textContent, /x0 · 全量均值/); assert.doesNotMatch(sec.textContent, /undefined|NaN/);
  assert.deepEqual(b.state.failures, []); b.sandbox.DPM.unmount();
});


for (const accountant of ['zcdp_plus_pure_dp_adaptive_composition', 'future_backend_ledger']) {
  test('actual release-accounting budget identifies its backend ledger: ' + accountant, async () => {
    const b = boot(), previous = b.sandbox.Api.get;
    b.sandbox.Api.get = async path => {
      const result = await previous(path);
      return path.endsWith('/dp/budget') ? { ...result, accountant, scope: 'all job runs including uncertain reserved releases' } : result;
    };
    await b.mount();
    assert.doesNotMatch(b.document.textContent, /undefined|NaN/);
    assert.match(b.document.textContent, accountant.startsWith('zcdp') ? /zCDP \+ 纯 DP 自适应组合累计/ : /future_backend_ledger累计/);
    assert.equal(b.$('dpUsed').textContent, '0.800');
    assert.deepEqual(b.state.failures, []); b.sandbox.DP.unmount();
  });
}


test('actual hook DTO uses selected job metadata and provider catalog without invented fields', async () => {
  const b = boot(), previous = b.sandbox.Api.get;
  const provider = 'backend_client_update_dp_v1_os_csprng';
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'j1', name: '真实任务', status: 'Created', current_round: 0, total_rounds: 3, aggregation: 'ss', dp_enabled: true }] };
    if (path === '/dp/providers') return { current: provider, items: [{ provider, name: '真实更新级 DP', available: true, mechanisms: ['gaussian'], accountants: ['rdp'], mapping: [], version_note: '系统熵' }] };
    if (path.endsWith('/dp/hooks')) return { initialized: false, initialized_at: null, initialization_state: 'not_yet_attested', hook_point: 'before_aggregate', provider, trainers: 2, steps: [], job_id: 'j1', committed_release_count: 0 };
    if (path.endsWith('/dp/metrics')) return { available: false, summary: null, reason: '私有统计未发布' };
    return previous(path);
  };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-fw.js'), b.sandbox);
  try {
    await b.sandbox.DPF.mount({ projectId: 'p1' }, sec);
    assert.doesNotMatch(sec.textContent, /undefined|NaN/);
    assert.match(sec.textContent, /待启动.*已完成 0 轮.*2 个训练参与方.*真实更新级 DP/);
    assert.match(sec.textContent, /等待执行回执确认初始化/);
    assert.deepEqual(b.state.failures, []);
  } finally { b.sandbox.DPF.unmount(); }
});

test('actual policy DTO float multipliers and missing application metadata render without invented state', async () => {
  const b = boot(), prior = b.sandbox.Api.get, calls = [];
  b.sandbox.UI.debounce = () => () => {}; b.sandbox.UI.toast = () => {};
  const training = { key: 't', label: '训练维度', kind: 'training', job_id: 'j1', sensitivity: 1, steps: 3,
    share_pct: 75, epsilon: 3, steps_used: 0, noise_by_accountant: { basic: 1.25, advanced: 2.5, rdp: 3.75 } };
  const query = { key: 'q', label: '真实字段均值', kind: 'query', dataset_id: 'actual-csv', column: 'x_int', query: 'mean',
    steps: 12, steps_used: 0, share_pct: 25, epsilon: 1,
    noise_by_accountant: { basic: { noise_multiplier: 4 }, advanced: { noise_multiplier: 5 }, rdp: { noise_multiplier: 6 } } };
  const policy = (policy_id, dimensions) => ({ policy_id, name: policy_id, mechanism: 'gaussian', accountant: 'rdp',
    epsilon_total: 4, delta_total: 2e-5, dimensions });
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'finished', name: '已完成任务', status: 'Success', total_rounds: 9 }, { job_id: 'j1', name: '真实待启动任务', status: 'Created', total_rounds: 3 }] };
    if (path === '/dp/mechanisms') return { items: [] };
    if (path.endsWith('/datasets')) return { items: [{ dataset_id: 'text-only', name: '文本数据', party_name: 'A', columns: [{ name: 'text', type: 'string' }] },
      { dataset_id: 'actual-csv', name: '真实 CSV', party_name: 'B', columns: [{ name: 'x_int', type: 'int' }, { name: 'x_float', type: 'float' }] }] };
    if (path.endsWith('/dp/policies')) return { items: [policy('mixed-real-policy', [training, query]), policy('query-only-policy', [query]),
      policy('deleted-job-policy', [{ ...training, job_id: 'actual-old-job-id' }])], total: 3 };
    return prior(path);
  };
  b.sandbox.Api.post = async (path, body) => { calls.push({ path, body: JSON.parse(JSON.stringify(body)) }); return { name: body.name }; };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox);
  await b.sandbox.DPM.mount({ projectId: 'p1' }, sec);
  sec.querySelectorAll('button').find(x => x.textContent === '策略动态编排').listeners.click[0](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(b.state.failures, []); assert.doesNotMatch(sec.textContent, /undefined|NaN/);
  assert.match(sec.textContent, /1\.25 \/ 2\.50 \/ 3\.75/); assert.match(sec.textContent, /4\.00 \/ 5\.00 \/ 6\.00/);
  assert.match(sec.textContent, /训练 · 真实待启动任务/); assert.match(sec.textContent, /训练 · actual-old-job-id/);
  assert.match(sec.textContent, /下发状态未提供/); assert.doesNotMatch(sec.textContent, /待下发|；未下发/);
  const queryPolicy = sec.querySelectorAll('.dpm-policy').find(x => x.textContent.includes('query-only-policy'));
  const apply = queryPolicy.querySelectorAll('button').find(x => x.textContent === '下发到训练任务');
  assert.equal(apply.disabled, true); await apply.listeners.click[0](); assert.equal(calls.length, 0);
  const generate = sec.querySelectorAll('button').find(x => x.textContent === '生成策略'); await generate.listeners.click[0]();
  assert.equal(calls.length, 1); const body = calls[0].body;
  assert.equal(calls[0].path, '/projects/p1/dp/policies'); assert.equal(body.dimensions.length, 2);
  assert.deepEqual(body.dimensions.map(x => [x.kind, x.job_id || x.dataset_id, x.column || null]),
    [['training', 'j1', null], ['query', 'actual-csv', 'x_int']]);
  assert.equal(body.dimensions[0].label, '真实待启动任务'); assert.equal(body.dimensions[1].label, 'x_int 全量均值');
  assert.doesNotMatch(JSON.stringify(body), /ree_price|nd2o3|ceo2|Nd₂O₃|CeO₂/);
  assert.equal(calls.some(x => x.path.endsWith('/dp/query')), false); assert.deepEqual(b.state.failures, []);
  b.sandbox.DPM.unmount();
});

test('policy form without tasks or numeric datasets creates no phantom default dimensions', async () => {
  const b = boot(), prior = b.sandbox.Api.get;
  b.sandbox.UI.debounce = () => () => {};
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs') || path === '/dp/mechanisms' || path.endsWith('/datasets') || path.endsWith('/dp/policies')) return { items: [], total: 0 };
    return prior(path);
  };
  b.sandbox.Api.post = async () => { throw Error('empty policy must not submit'); };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox);
  await b.sandbox.DPM.mount({ projectId: 'empty' }, sec);
  sec.querySelectorAll('button').find(x => x.textContent === '策略动态编排').listeners.click[0](); await new Promise(resolve => setImmediate(resolve));
  for (const text of ['生成策略', '添加维度']) assert.equal(sec.querySelectorAll('button').find(x => x.textContent === text).disabled, true);
  assert.match(sec.textContent, /没有可配置的训练任务或包含数值字段的就绪数据集/);
  assert.equal(sec.querySelectorAll('.table-row.dpm-dim-grid').length, 0); assert.deepEqual(b.state.failures, []);
  b.sandbox.DPM.unmount();
});

test('initial delayed task configuration gates policy editing until mount completes', async () => {
  const b = boot(), prior = b.sandbox.Api.get, calls = []; let finishConfig;
  b.sandbox.UI.debounce = () => () => {}; b.sandbox.UI.toast = () => {};
  const pending = new Promise(resolve => { finishConfig = resolve; });
  b.sandbox.Api.get = async path => {
    if (path.endsWith('/fl/jobs')) return { items: [{ job_id: 'j1', name: '真实待启动任务', status: 'Created', total_rounds: 3 }] };
    if (path === '/fl/jobs/j1/dp') return pending;
    if (path === '/dp/mechanisms') return { items: [] };
    if (path.endsWith('/datasets')) return { items: [{ dataset_id: 'actual-data', name: 'Actual CSV', party_name: 'A', columns: [{ name: 'x0', type: 'float' }] }] };
    if (path.endsWith('/dp/policies')) return { items: [], total: 0 };
    return prior(path);
  };
  b.sandbox.Api.post = async (path, body) => { calls.push({ path, body: JSON.parse(JSON.stringify(body)) }); return { name: body.name }; };
  const sec = new Element('section'); b.document.appendChild(sec);
  vm.runInContext(source('js/dp-mech.js'), b.sandbox);
  const mounting = b.sandbox.DPM.mount({ projectId: 'p1' }, sec); await new Promise(resolve => setImmediate(resolve));
  const policyTab = sec.querySelectorAll('button').find(x => x.textContent === '策略动态编排');
  assert.equal(policyTab.disabled, true); policyTab.listeners.click[0]();
  assert.equal(b.$('dpmPName'), null, 'no editable policy form exists while initial cfg is pending');
  assert.match(sec.textContent, /正在加载任务与数据集配置/);
  finishConfig({ enabled: true, mechanism: 'gaussian', accountant: 'rdp', epsilon_total: 2, clip_norm: 1, delta: 1e-5, total_rounds: 3 }); await mounting;
  assert.equal(policyTab.disabled, false); policyTab.listeners.click[0](); await new Promise(resolve => setImmediate(resolve));
  b.$('dpmPName').value = '真实查询策略验证-20261026';
  const trainingRow = sec.querySelectorAll('.table-row.dpm-dim-grid').find(x => x.querySelectorAll('select').some(s => s.value === 'training'));
  trainingRow.querySelectorAll('button').find(x => x.textContent === '删除').listeners.click[0]();
  sec.querySelectorAll('button').find(x => x.textContent === '生成策略').listeners.click[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.name, '真实查询策略验证-20261026');
  assert.deepEqual(calls[0].body.dimensions.map(x => [x.kind, x.dataset_id, x.column]), [['query', 'actual-data', 'x0']]);
  assert.deepEqual(b.state.failures, []); b.sandbox.DPM.unmount();
});
