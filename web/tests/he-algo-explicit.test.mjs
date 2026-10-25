/** DOM/transport tests only; fixtures are not measurements of a cryptographic engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this._text = text ?? ''; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attrs = {}; this._value = ''; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  appendChild(child) { this.children.push(child); child.parentNode = this; if (this.tagName === 'select' && this.children.length === 1) this.value = child.value; return child; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(key, callback) { (this.listeners[key] ||= []).push(callback); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === '[data-preset]') return this.dataset.preset !== undefined;
    const option = /^option\[value="([^"]+)"\]$/.exec(selector);
    return !!option && this.tagName === 'option' && this.value === option[1];
  }
  querySelectorAll(selector) { const out = []; for (const child of this.children) { if (child.matches(selector)) out.push(child); out.push(...child.querySelectorAll(selector)); } return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function verification(label = 'verified fixture') { return { mode: 'ckks_native',
  steps: [{ stage: 'keygen', label: 'keygen', elapsed_ms: 1, size_kb: 0, detail: label }], rows: [],
  scale_exponent_a: 4, scale_exponent_b: 4, result_scale_exponent: 8, ckks_scale_bits: 40,
  max_abs_error: 0, total_elapsed_ms: 1, source: 'actual_he_provider' }; }

function optimization(label = 'optimization fixture') { return { source: 'parameter_estimate',
  recommended: { poly_modulus_degree: 8192, slots: 4096, coeff_modulus_bits: [60, 40, 60], total_modulus_bits: 160,
    max_modulus_bits: 218, scale_bits: 40, integer_bits: 20, est_add_ms: 1, est_mul_ms: 1, ciphertext_kb: 1 },
  candidates: [], rules: [label], security_table: [] }; }
function boot() {
  const root = new Element('section'), calls = [], failures = [];
  const state = { verify: async () => verification(), optimize: async () => optimization(), encode: async body => ({ converted: true, note: 'analytical encoding fixture', plaintext_space: null, overflow: false,
        mode: 'fixed_point', scale_exponent: body.precision, scale_factor: 10000, items: [], sweep: [] }),
    config: async project => ({ scheme: project === 'p2' ? 'paillier' : 'ckks', library: project === 'p2' ? 'phe' : 'seal', precision: project === 'p2' ? 2 : 4 }) };
  const schemes = ['paillier', 'ckks', 'bgv'];
  const algorithms = schemes.map(scheme => ({ scheme, name: scheme, family: scheme === 'paillier' ? 'phe' : 'fhe', family_label: 'test catalog',
    supported_ops: scheme === 'paillier' ? ['add_ct_ct', 'mul_ct_pt'] : ['add_ct_ct', 'mul_ct_pt', 'mul_ct_ct'],
    plaintext_label: 'numeric', security_bits: 128, security_note: 'catalog fixture', libraries: [scheme === 'paillier' ? 'phe' : 'seal'],
    default_library: scheme === 'paillier' ? 'phe' : 'seal', typical_params: 'catalog fixture' }));
  const sandbox = { Node: Element, console, document: { createElement: tag => new Element(tag), createTextNode: text => new Element('text', '', text) },
    UI: { el: (tag, cls, text) => new Element(tag, cls, text), clear(node) { node.children = []; node._text = ''; if (node.tagName === 'select') node._value = ''; },
      inputOf: (id, value) => Object.assign(new Element('input'), { id, value }),
      selectOf(id, options, value) { const select = Object.assign(new Element('select'), { id }); for (const option of options) select.appendChild(Object.assign(new Element('option', '', option.label), { value: option.value })); if (value !== undefined) select.value = value; return select; },
      formRow(label, control) { const row = new Element('label', '', label); row.appendChild(control); return row; },
      datetime: value => value, debounce: fn => fn, toast() {}, fail: error => failures.push(error) },
    Api: { async get(path) {
      calls.push(['GET', path]);
      if (path === '/he/algorithms') return { items: clone(algorithms) };
      if (path === '/he/libraries') return { schemes, items: [
        { library: 'seal', name: 'seal', language: 'C++', matrix: { paillier: false, ckks: true, bgv: true }, note: 'fixture' },
        { library: 'phe', name: 'phe', language: 'Python', matrix: { paillier: true, ckks: false, bgv: false }, note: 'fixture' }] };
      return state.config(path.split('/')[2]);
    }, async post(path, body) {
      calls.push(['POST', path, clone(body)]);
      if (path === '/he/verify') return state.verify(body);
      if (path === '/he/param-optimize') return state.optimize(body);
      assert.equal(path, '/he/encode');
      return state.encode(body);
    } } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../js/he-algo.js', import.meta.url), 'utf8'), sandbox);
  const $ = id => root.querySelector('#'+id);
  async function fire(id, event = 'click') { await Promise.all(($(id).listeners[event] || []).map(callback => callback())); }
  return { root, state, calls, failures, $, fire, HEA: sandbox.HEA,
    count: path => calls.filter(call => call[0] === 'POST' && call[1] === path).length,
    mount: project => sandbox.HEA.mount({ projectId: project || 'p1' }, root) };
}

test('mount, scheme, precision, operands and presets never start expensive verification or optimization', async () => {
  const b = boot(); await b.mount();
  assert.equal(b.count('/he/verify'), 0); assert.equal(b.count('/he/param-optimize'), 0);
  assert.equal(b.count('/he/encode'), 1, 'lightweight encoding remains available automatically');
  b.$('heaVScheme').value = 'paillier'; await b.fire('heaVScheme', 'change');
  assert.equal(b.$('heaVOp').value, 'mul_plain');
  b.$('heaVPrec').value = 2; await b.fire('heaVPrec', 'input');
  b.$('heaVA').value = '1, 2'; await b.fire('heaVA', 'input');
  for (const preset of b.root.querySelectorAll('[data-preset]')) for (const callback of preset.listeners.click) callback();
  b.$('heaODepth').value = 5; await b.fire('heaODepth', 'input');
  assert.equal(b.count('/he/verify'), 0); assert.equal(b.count('/he/param-optimize'), 0);
  assert.match(b.$('heaVOut').textContent, /点击.*运行验证/); assert.equal(b.failures.length, 0);
});

test('only explicit click submits verification and duplicate clicks are fenced while it is pending', async () => {
  const b = boot(); await b.mount(); const response = deferred(); b.state.verify = () => response.promise;
  const pending = b.fire('heaVRun'); await b.fire('heaVRun');
  assert.equal(b.count('/he/verify'), 1); assert.equal(b.$('heaVRun').disabled, true);
  assert.equal(b.calls.find(call => call[1] === '/he/verify')[2].project_id, 'p1');
  response.resolve(verification('current verified result')); await pending;
  assert.equal(b.$('heaVRun').disabled, false); assert.match(b.$('heaVOut').textContent, /current verified result/);
  b.$('heaVPrec').value = 6; await b.fire('heaVPrec', 'input');
  assert.doesNotMatch(b.$('heaVOut').textContent, /current verified result/);
});

test('input changes clear results and an older pending verification cannot repaint them', async () => {
  const b = boot(); await b.mount(); const response = deferred(); b.state.verify = () => response.promise;
  const pending = b.fire('heaVRun'); b.$('heaVScheme').value = 'paillier'; await b.fire('heaVScheme', 'change');
  response.resolve(verification('obsolete result')); await pending;
  assert.doesNotMatch(b.$('heaVOut').textContent, /obsolete result/);
  assert.equal(b.$('heaVRun').disabled, false); assert.equal(b.count('/he/verify'), 1);
});

test('a project remount discards old native results and does not automatically create another verification', async () => {
  const b = boot(); await b.mount(); const response = deferred(); b.state.verify = () => response.promise;
  const pending = b.fire('heaVRun'); b.HEA.unmount(); await b.mount('p2');
  response.resolve(verification('other project result')); await pending;
  assert.equal(b.$('heaVScheme').value, 'paillier');
  assert.doesNotMatch(b.$('heaVOut').textContent, /other project result/); assert.equal(b.count('/he/verify'), 1);
});

test('optimization is explicit, rejects duplicate submission and discards results after parameter edits', async () => {
  const b = boot(); await b.mount(); const response = deferred(); b.state.optimize = () => response.promise;
  assert.equal(b.count('/he/param-optimize'), 0);
  const pending = b.fire('heaORun'); await b.fire('heaORun');
  assert.equal(b.count('/he/param-optimize'), 1); assert.equal(b.$('heaORun').disabled, true);
  b.$('heaODepth').value = 8; await b.fire('heaODepth', 'input');
  response.resolve(optimization('obsolete recommendation')); await pending;
  assert.doesNotMatch(b.$('heaOOut').textContent, /obsolete recommendation/); assert.equal(b.$('heaORun').disabled, false);
  b.state.optimize = async () => optimization('current recommendation'); await b.fire('heaORun');
  assert.match(b.$('heaOOut').textContent, /current recommendation/);
});

test('a late configuration response cannot reset a newly mounted project', async () => {
  const b = boot(), first = deferred(), entered = deferred();
  b.state.config = async project => { if (project === 'p1') { entered.resolve(); return first.promise; } return { scheme: 'paillier', library: 'phe', precision: 2 }; };
  const old = b.mount('p1'); await entered.promise; b.HEA.unmount(); await b.mount('p2');
  first.resolve({ scheme: 'ckks', library: 'seal', precision: 7 }); await old; await flush();
  assert.equal(b.$('heaVScheme').value, 'paillier'); assert.equal(b.$('heaVPrec').value, '2');
  assert.equal(b.count('/he/verify'), 0); assert.equal(b.count('/he/param-optimize'), 0);
});

test('failed verification shows its error, releases the button and can be explicitly retried', async () => {
  const b = boot(); await b.mount(); b.state.verify = async () => { throw Error('native provider unavailable'); };
  await b.fire('heaVRun'); assert.match(b.$('heaVOut').textContent, /native provider unavailable/);
  assert.equal(b.$('heaVRun').disabled, false);
  b.state.verify = async () => verification('successful retry'); await b.fire('heaVRun');
  assert.match(b.$('heaVOut').textContent, /successful retry/); assert.equal(b.count('/he/verify'), 2);
});

for (const scheme of ['ckks', 'paillier']) {
  test('actual backend verify shape without invented metadata renders safely: '+scheme, async () => {
    const b = boot(); await b.mount();
    b.$('heaVScheme').value = scheme; await b.fire('heaVScheme', 'change');
    b.$('heaVA').value = '1.25'; b.$('heaVB').value = '2';
    b.$('heaVOp').value = 'mul_plain'; b.$('heaVPrec').value = 2;
    b.state.verify = async request => {
      assert.equal(Object.isFrozen(request), true);
      // Exact service response structure: deliberately no scheme/library/op label,
      // per-ciphertext metadata or synthesized measurement/formula fields.
      return { mode: scheme === 'ckks' ? 'ckks_native' : 'fixed_point', scale_exponent_a: 2, scale_exponent_b: 2,
        result_scale_exponent: 2, ckks_scale_bits: scheme === 'ckks' ? 40 : null,
        rows: [{ index: 0, a: '1.25', b: '2', expected: 2.5, decrypted: 2.5001, abs_error: .0001,
          encoded_a: scheme === 'ckks' ? null : '125', encoded_b: null, encoded_result: null }],
        steps: [
          { stage: 'keygen', label: 'keygen', elapsed_ms: 2.5, size_kb: 0, detail: '真实加密引擎运行测量' },
          { stage: 'encrypt', label: 'encrypt', elapsed_ms: 6.25, size_kb: 4, detail: '真实加密引擎运行测量' },
          { stage: 'evaluate', label: 'evaluate', elapsed_ms: 5, size_kb: 2, detail: '真实加密引擎运行测量' },
          { stage: 'decrypt', label: 'decrypt', elapsed_ms: 5, size_kb: 0, detail: '真实加密引擎运行测量' }],
        total_elapsed_ms: 18.75, max_abs_error: .0001, source: 'actual_he_provider' };
    };
    await b.fire('heaVRun');
    const text = b.$('heaVOut').textContent;
    assert.doesNotMatch(text, /undefined|null|TypeError|未能完成/);
    assert.match(text, new RegExp(scheme)); assert.match(text, /明文数乘/);
    assert.match(text, /18\.75 ms/); assert.match(text, /1\.00e-4/); assert.match(text, /6\.25 ms/);
    assert.match(text, /单条密文大小 —（后端未提供）/);
    assert.match(text, /密文大小公式 —（后端未提供）/);
    if (scheme === 'paillier') assert.match(text, /125, — → —/);
  });
}

test('malformed verification shape produces a clear response error instead of a TypeError', async () => {
  const b = boot(); await b.mount(); b.state.verify = async () => ({ steps: [], rows: null });
  await b.fire('heaVRun');
  assert.match(b.$('heaVOut').textContent, /响应格式不正确/);
  assert.doesNotMatch(b.$('heaVOut').textContent, /TypeError|undefined|null/);
  assert.equal(b.$('heaVRun').disabled, false);
});

const actualShapes = JSON.parse(readFileSync(new URL('./fixtures/he-actual-responses.json', import.meta.url), 'utf8'));
for (const scheme of ['paillier', 'ckks', 'bgv']) {
  test('actual encoding shape uses immutable request labels, not absent response metadata: '+scheme, async () => {
    const b = boot(); await b.mount(); const fixture = actualShapes.encoding[scheme];
    b.state.encode = async request => { assert.equal(Object.isFrozen(request), true); return clone(fixture.response); };
    b.$('heaEScheme').value = scheme; b.$('heaEVals').value = '1.25'; b.$('heaEPrec').value = '2';
    await b.fire('heaEScheme', 'change');
    const text = b.$('heaEOut').textContent;
    assert.doesNotMatch(text, /undefined|null|TypeError|未能完成/); assert.match(text, /后端编码结果/);
    if (scheme !== 'ckks') { assert.match(text, /请求精度：保留 2 位/); assert.match(text, new RegExp(scheme)); assert.match(text, /125/); }
    assert.equal(b.count('/he/verify'), 0); assert.equal(b.count('/he/param-optimize'), 0);
  });
}

test('actual optimization shape uses the submitted constraints and labels performance as estimates', async () => {
  const b = boot(); await b.mount();
  const fixture = actualShapes.optimization;
  for (const [id, key] of [['heaOSec','security_bits'],['heaODepth','mult_depth'],['heaODigits','precision_digits'],['heaOBatch','batch_size']]) {
    b.$(id).value = fixture.request[key];
  }
  b.state.optimize = async request => { assert.equal(Object.isFrozen(request), true); return clone(fixture.response); };
  await b.fire('heaORun');
  const text = b.$('heaOOut').textContent;
  assert.doesNotMatch(text, /undefined|null|TypeError|未能完成|与运算验证同一公式/);
  assert.match(text, /批大小 512/); assert.match(text, /192 位安全/); assert.match(text, /小数精度 5 位/);
  assert.match(text, /估算/); assert.match(text, /不代表真实序列化字节/);
  assert.match(text, new RegExp(String(fixture.response.recommended.total_modulus_bits)));
});
