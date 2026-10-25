import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag, cls, text = '') { this.tagName = tag; this.className = cls; this.textContent = text; this.children = []; this.listeners = {}; this.attrs = {}; this.value = ''; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() { this.focused = true; }
}
const source = name => readFileSync(new URL('../js/' + name, import.meta.url), 'utf8');
function boot({ saved = '' } = {}) {
  const body = new Element('body'), shell = new Element('div', 'app'); body.appendChild(shell);
  const store = new Map(saved ? [['sfl.access-token', saved]] : []), calls = [];
  let allowed = true, reloads = 0;
  const sandbox = {
    APP_CONFIG: { apiBase: '/api/v1', accessToken: '' },
    document: { body, querySelector: () => shell },
    sessionStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    UI: { el: (tag, cls, text) => new Element(tag, cls, text), inputOf: (id, value, type) => Object.assign(new Element('input'), { id, value, type }) },
    location: { reload() { reloads++; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: allowed ? 200 : 401, json: async () => allowed
        ? { code: 0, data: { user_id: 'user' } } : { code: 40100, message: 'expired' } };
    }, URLSearchParams, AbortController, console
  };
  sandbox.window = sandbox;
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('Tokens must not use localStorage'); } });
  vm.createContext(sandbox);
  vm.runInContext(source('api.js'), sandbox, { filename: 'api.js' });
  vm.runInContext(source('connection.js'), sandbox, { filename: 'connection.js' });
  function form() { return body.children.find(x => x.className === 'connection-gate')?.children[0]; }
  function input() { return form().children.find(x => x.tagName === 'input'); }
  return { sandbox, body, shell, store, calls, form, input, setAllowed(v) { allowed = v; }, get reloads() { return reloads; },
    async submit(value) { input().value = value; await form().listeners.submit({ preventDefault() {} }); } };
}
const token = 'test-token-only-no-real-secret-12345';

test('real backend starts only after Header-authenticated /me and stores token in tab session', async () => {
  const b = boot(); let started = 0;
  await b.sandbox.SflConnection.start(async me => { assert.equal(me.user_id, 'user'); started++; });
  assert.equal(started, 0); assert.equal(b.shell.hidden, true); assert.equal(b.calls.length, 0);
  await b.submit('Bearer ' + token);
  assert.equal(started, 1); assert.equal(b.shell.hidden, false); assert.equal(b.form(), undefined);
  assert.equal(b.calls[0].url, '/api/v1/me');
  assert.equal(b.calls[0].init.headers.Authorization, 'Bearer ' + token);
  assert.equal(b.store.get('sfl.access-token'), token);
  assert.ok(!b.calls[0].url.includes(token));
});

test('rejected or malformed tokens never start the app or remain persisted', async () => {
  const b = boot(); b.setAllowed(false); let started = 0;
  await b.sandbox.SflConnection.start(() => { started++; });
  await b.submit('short'); assert.equal(b.calls.length, 0);
  await b.submit(token);
  assert.equal(started, 0); assert.equal(b.shell.hidden, true);
  assert.equal(b.input().value, ''); assert.equal(b.store.size, 0);
  assert.equal(b.sandbox.APP_CONFIG.accessToken, '');
  assert.match(b.form().children.map(x => x.textContent).join(''), /初始化失败/);
});

test('reload validates the tab token and runtime 401 reconnects without stale app state', async () => {
  const b = boot({ saved: token }); let started = 0;
  await b.sandbox.SflConnection.start(() => { started++; });
  assert.equal(started, 1); assert.equal(b.form(), undefined);
  b.setAllowed(false);
  await assert.rejects(b.sandbox.Api.get('/projects'));
  assert.equal(b.store.size, 0); assert.equal(b.shell.hidden, true); assert.ok(b.form());
  b.setAllowed(true); await b.submit('replacement-token-test-only-456789');
  assert.equal(b.reloads, 0); assert.equal(started, 2);
});

test('expired saved token prompts, while a separate tab has no persisted token', async () => {
  const b = boot({ saved: token }); b.setAllowed(false);
  await b.sandbox.SflConnection.start(() => assert.fail('must not boot'));
  assert.ok(b.form()); assert.equal(b.store.size, 0);
  const other = boot(); await other.sandbox.SflConnection.start(() => assert.fail('other tab must connect'));
  assert.equal(other.calls.length, 0); assert.ok(other.form());
});


test('packaged default is real same-origin backend with no embedded access token', () => {
  const sandbox = { window: {} }; vm.runInNewContext(source('config.js'), sandbox);
  assert.deepEqual(Object.keys(sandbox.window.APP_CONFIG).sort(), ['accessToken', 'apiBase']);
  assert.equal(sandbox.window.APP_CONFIG.apiBase, '/api/v1');
  assert.equal(sandbox.window.APP_CONFIG.accessToken, '');
});

test('bootstrap failure returns to a usable connection form and can retry in the same page', async () => {
  const b = boot({ saved: token }); let attempts = 0;
  await b.sandbox.SflConnection.start(async () => { if (++attempts === 1) throw Error('platform temporarily unavailable'); });
  assert.ok(b.form()); assert.equal(b.shell.hidden, true); assert.equal(b.store.size, 0);
  await b.submit(token);
  assert.equal(attempts, 2); assert.equal(b.form(), undefined); assert.equal(b.shell.hidden, false);
  assert.equal(b.reloads, 0); assert.equal(b.store.get('sfl.access-token'), token);
});
