import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const apiPath = new URL('../js/api.js', import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));
function boot(fetchImpl, extra = {}) {
  const state = { expired: 0 };
  const sandbox = { APP_CONFIG: { apiBase: '/api/v1', accessToken: 'test-secret-only' },
    App: { ctx: { projectId: 'p' } }, URLSearchParams, AbortController, fetch: fetchImpl,
    SflConnection: { expired() { state.expired++; } }, ...extra };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(readFileSync(apiPath, 'utf8'), sandbox, { filename: fileURLToPath(apiPath),
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { Api: sandbox.Api, state };
}
const snapshot = (id = 'j') => Response.json({ code: 0, data: { job_id: id, project_id: 'p', event_cursor: '0' } });

test('close before lazy helper load prevents all network calls and callbacks', async () => {
  let requests = 0;
  const { Api } = boot(() => { requests++; throw new Error('must not fetch'); });
  const sub = Api.subscribe('/fl/jobs/j/events', { snapshot: () => assert.fail('closed callback') });
  sub.close(); await flush(); await flush();
  assert.equal(requests, 0);
});

test('adapter sends Bearer headers, awaits callbacks, routes typed events and close cancels reader', async () => {
  const calls = [], applied = []; let sub, cancelled = false;
  const done = new Promise((resolve, reject) => {
    const { Api } = boot(async (url, init) => {
      calls.push([url, init]);
      assert.ok(!String(url).includes('test-secret-only')); assert.equal(new URL(url).search, '');
      assert.equal(init.headers.Authorization, 'Bearer test-secret-only'); assert.equal(init.redirect, 'error');
      if (String(url).endsWith('/j')) return snapshot();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\nevent: status_changed\ndata: {"job_id":"j","project_id":"p","status":"Paused"}\n\n'));
      }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    sub = Api.subscribe('/fl/jobs/j/events', {
      snapshot: async value => { await flush(); applied.push(value.job_id); },
      status_changed: value => { applied.push(value.status); sub.close(); resolve(); }, error: reject
    });
  });
  await done; await flush();
  assert.deepEqual(applied, ['j', 'Paused']); assert.equal(calls.length, 2);
  assert.equal(calls[1][1].headers['Last-Event-ID'], '0'); assert.equal(cancelled, true);
});

test('closed subscription fences an in-flight detail response that ignores AbortSignal', async () => {
  let deliver, sub;
  const requested = new Promise(resolve => {
    const { Api } = boot(async () => { resolve(); return new Promise(r => { deliver = r; }); });
    sub = Api.subscribe('/fl/jobs/j/events', { snapshot: () => assert.fail('late snapshot'), error: () => assert.fail('late error') });
  });
  await requested; sub.close(); deliver(snapshot()); await flush(); await flush();
});

test('evaluation snapshot uses original finished callback and can synchronously close', async () => {
  let requests = 0, sub;
  const finished = new Promise((resolve, reject) => {
    const { Api } = boot(async url => {
      requests++; assert.equal(new URL(url).pathname, '/api/v1/fl/evaluations/e');
      return Response.json({ code: 0, data: { eval_id: 'e', project_id: 'p', resource_kind: 'eval',
        status: 'finished', event_cursor: '12', result: { measured: true } } });
    });
    sub = Api.subscribe('/fl/evaluations/e/events', { finished(value) { sub.close(); resolve(value); }, error: reject });
  });
  assert.equal((await finished).result.measured, true); assert.equal(requests, 1);
});

test('SSE authentication rejection opens reconnection gate and stops subscription', async () => {
  let sub, requests = 0, state;
  const rejected = new Promise(resolve => {
    const b = boot(async () => { requests++; return Response.json({ code: 40100, message: 'expired' }, { status: 401 }); });
    state = b.state;
    sub = b.Api.subscribe('/fl/jobs/j/events', { error: resolve });
  });
  assert.equal((await rejected).status, 401); await flush(); sub.close();
  assert.equal(state.expired, 1); assert.equal(requests, 1);
});


test('browser adapter preserves the Window.fetch receiver for REST snapshot and SSE', async () => {
  let sub, calls = 0, browser;
  const done = new Promise((resolve, reject) => {
    const fetchImpl = async function (url, init) {
      assert.equal(this, browser, 'native browser fetch must be invoked on its window');
      assert.equal(init.headers.Authorization, 'Bearer test-secret-only'); calls++;
      if (String(url).endsWith('/j')) return snapshot();
      sub.close(); resolve();
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    };
    // vm globals are contextified; an explicit browser object gives the native
    // method fake an exact receiver identity just like the WebIDL requirement.
    browser = { APP_CONFIG: { apiBase: '/api/v1', accessToken: 'test-secret-only' },
      App: { ctx: { projectId: 'p' } }, fetch: fetchImpl };
    const sandbox = { window: browser, fetch: fetchImpl, URLSearchParams };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(apiPath, 'utf8'), sandbox, { filename: fileURLToPath(apiPath),
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    sub = browser.Api.subscribe('/fl/jobs/j/events', { error: reject });
  });
  await done; assert.equal(calls, 2);
});
