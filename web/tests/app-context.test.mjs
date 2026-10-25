import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.textContent = text; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.hidden = false; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  focus() {}
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
}
function boot(items = [], savedEntries = []) {
  const ids = new Map(), events = {}, mounts = [], failures = [], store = new Map(savedEntries);
  const main = new Element('main', 'main'), state = { items, invalidations: 0, response: null };
  const element = id => { if (!ids.has(id)) ids.set(id, Object.assign(new Element('div'), { id })); return ids.get(id); };
  const screens = ['fed-orch', 'fed-proc', 'he-algo'].map(name => element('screen-' + name));
  const sandbox = { console, Object, Set, location: { hash: '' }, history: { replaceState(_a, _b, hash) { sandbox.location.hash = hash; } },
    APP_CONFIG: { apiBase: '/api/v1', accessToken: 'session-test-only' },
    UI: { $: element, el: (tag, cls, text) => new Element(tag, cls, text), clear: node => { node.children = []; }, fail: error => failures.push(error) },
    document: { title: '', createElement: tag => new Element(tag), addEventListener: (key, callback) => { events[key] = callback; },
      querySelector: selector => selector === 'main.main' ? main : null,
      querySelectorAll: selector => selector === 'main .screen' ? screens : [] },
    localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    setInterval: () => 1, clearInterval() {}, addEventListener: (key, callback) => { events[key] = callback; },
    Api: { invalidateContext() { state.invalidations++; }, async get(path) {
      if (path === '/platform/info') return { platform_name: 'Real platform', environment_label: 'test' };
      assert.equal(path, '/projects?page_size=100');
      return state.response ? state.response() : { items: state.items };
    } },
    SflConnection: { start(callback) { state.start = callback; } }
  };
  for (const name of ['FL', 'FLO', 'HEA']) sandbox[name] = { mount(ctx) { mounts.push([name, ctx]); }, refresh() {}, unmount() {} };
  sandbox.FLO.createProject = () => { state.createCalled = true; };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'), sandbox);
  events.DOMContentLoaded();
  return { App: sandbox.App, state, main, ids, mounts, failures, store,
    async start() { return state.start({ user_id: 'u', display_name: 'operator' }); } };
}

test('zero accessible projects shows an honest empty state and makes no null-project module requests', async () => {
  const b = boot(); await b.start();
  assert.equal(b.App.ctx.projectId, null); assert.equal(b.mounts.length, 0);
  const empty = b.main.children.find(node => node.id === 'app-project-empty');
  assert.ok(empty && !empty.hidden); assert.equal(b.ids.get('projSelect').disabled, true);
  assert.match(empty.children.map(node => node.textContent).join(''), /暂无可访问项目/);
  await empty.children.find(node => node.textContent === '新建项目').listeners.click();
  assert.equal(b.state.createCalled, true);
  b.state.items = [{ project_id: 'p-created', name: 'Actual project' }];
  await empty.children.find(node => node.textContent === '刷新项目列表').listeners.click();
  assert.equal(b.App.ctx.projectId, 'p-created'); assert.equal(b.mounts.at(-1)[1].projectId, 'p-created');
  assert.equal(empty.hidden, true);
});

test('unknown selected or remembered IDs never fabricate a project; each mount receives a stable project context', async () => {
  const b = boot([{ project_id: 'p1', name: 'one' }, { project_id: 'p2', name: 'two' }]);
  b.store.set('privacy-console.project', 'not-authorized'); await b.start();
  const old = b.App.ctx; assert.equal(old.projectId, 'p1');
  b.App.switchProject('p2'); assert.equal(old.projectId, 'p1'); assert.equal(b.App.ctx.projectId, 'p2');
  assert.notEqual(old, b.App.ctx); assert.ok(b.state.invalidations >= 2);
  await b.App.reloadProjects('not-authorized'); assert.equal(b.App.ctx.projectId, 'p2');
});

test('a slower old project-list response cannot replace the latest selection', async () => {
  const b = boot([{ project_id: 'p1', name: 'one' }]); await b.start();
  let deliver; b.state.response = () => new Promise(resolve => { deliver = resolve; });
  const old = b.App.reloadProjects();
  b.state.response = null; b.state.items = [{ project_id: 'p2', name: 'two' }];
  await b.App.reloadProjects('p2'); deliver({ items: [{ project_id: 'old', name: 'late' }] });
  await assert.rejects(old, error => error.cancelled === true);
  assert.equal(b.App.ctx.projectId, 'p2'); assert.equal(b.ids.get('projSelect').value, 'p2');
});

test('bootstrap rejects real server failure and remains retryable without duplicate listeners', async () => {
  const b = boot(); b.state.response = async () => { throw Error('backend unavailable'); };
  await assert.rejects(b.start(), /backend unavailable/); assert.equal(b.App.ctx.projectId, null);
  b.state.response = null; b.state.items = [{ project_id: 'p1', name: 'one' }];
  await b.start(); assert.equal(b.App.ctx.projectId, 'p1'); assert.equal(b.failures.length, 0);
});


test('startup removes only the retired data key and preserves remembered project and unrelated state', async () => {
  const b = boot([{ project_id: 'p1', name: 'one' }], [
    ['privacy-console.mockdb.v1', 'old local fixture'], ['privacy-console.project', 'p1'], ['unrelated-app', 'preserve']]);
  assert.equal(b.store.has('privacy-console.mockdb.v1'), false);
  assert.equal(b.store.get('privacy-console.project'), 'p1'); assert.equal(b.store.get('unrelated-app'), 'preserve');
  await b.start(); assert.equal(b.App.ctx.projectId, 'p1');
});
