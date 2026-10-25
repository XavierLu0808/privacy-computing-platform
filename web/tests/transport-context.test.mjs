import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function boot(fetchImpl) {
  let expired = 0, files = 0;
  const browser = { APP_CONFIG: { apiBase: '/api/v1', accessToken: 'first-session-test-only' },
    App: { ctx: { projectId: 'p1' } }, fetch: fetchImpl, SflConnection: { expired() { expired++; } } };
  const sandbox = { window: browser, URLSearchParams, AbortController, FormData, Blob,
    document: { body: { appendChild() {} }, createElement: () => ({ click() { files++; }, remove() {} }) },
    URL: class extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} }, setTimeout: fn => fn() };
  vm.createContext(sandbox); vm.runInContext(readFileSync(new URL('../js/api.js', import.meta.url), 'utf8'), sandbox);
  return { api: browser.Api, browser, get expired() { return expired; }, get files() { return files; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ok = data => Response.json({ code: 0, data });

test('context change aborts REST and rejects late results even when the server ignores cancellation', async () => {
  const response = deferred(); let signal;
  const b = boot(async (_url, init) => { signal = init.signal; return response.promise; });
  const request = b.api.get('/projects/p1/data'); b.api.invalidateContext();
  assert.equal(signal.aborted, true); response.resolve(ok({ project_id: 'p1' }));
  await assert.rejects(request, error => error.name === 'AbortError' && error.cancelled);
});

test('an old 401 cannot expire a newly authenticated session', async () => {
  const response = deferred(); const b = boot(() => response.promise);
  const request = b.api.get('/projects'); b.api.invalidateContext();
  b.browser.APP_CONFIG.accessToken = 'replacement-session-test-only';
  response.resolve(Response.json({ code: 40100, message: 'old session' }, { status: 401 }));
  await assert.rejects(request, error => error.cancelled);
  assert.equal(b.expired, 0);
});

test('a successful HTTP response with failed business code preserves its error and fields', async () => {
  const b = boot(async () => Response.json({ code: 40003, message: 'out of range', data: { field: 'epsilon', max: 10 } }));
  await assert.rejects(b.api.post('/dp/compose', {}), error => error.code === 40003 && error.data.field === 'epsilon' && error.status === 200);
});

test('REST HTTP failure is never accepted just because its envelope says code zero', async () => {
  const b = boot(async () => Response.json({ code: 0, data: { notAResult: true } }, { status: 503 }));
  await assert.rejects(b.api.get('/projects'), error => error.status === 503);
});

test('multipart upload carries Bearer with no JSON content type and handles non-JSON 401', async () => {
  let init;
  const b = boot(async (_url, options) => { init = options; return new Response('authentication required', { status: 401 }); });
  await assert.rejects(b.api.upload('/files', new Blob(['actual bytes']), { purpose: 'dataset' }), error => error.status === 401);
  assert.equal(init.headers.Authorization, 'Bearer first-session-test-only');
  assert.equal(init.headers['Content-Type'], undefined); assert.equal(init.body.get('purpose'), 'dataset');
  assert.equal(await init.body.get('file').text(), 'actual bytes'); assert.equal(b.expired, 1);
});

test('a context switch during blob reading cannot save the previous project report', async () => {
  const blob = deferred(), entered = deferred();
  const b = boot(async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/csv' }),
    blob() { entered.resolve(); return blob.promise; } }));
  const request = b.api.download('/projects/p1/export'); await entered.promise;
  b.api.invalidateContext(); blob.resolve(new Blob(['old project']));
  await assert.rejects(request, error => error.cancelled); assert.equal(b.files, 0);
});

test('caller AbortSignal is propagated without disabling context cancellation', async () => {
  const response = deferred(); let signal;
  const b = boot(async (_url, init) => { signal = init.signal; return response.promise; });
  const controller = new AbortController();
  const request = b.api.download('/export', { signal: controller.signal }); controller.abort();
  assert.equal(signal.aborted, true); response.resolve(new Response('csv', { headers: { 'Content-Type': 'text/csv' } }));
  await assert.rejects(request, error => error.cancelled); assert.equal(b.files, 0);
});

test('production transport/config/shell and HTML have no simulator branch or script', () => {
  for (const name of ['api.js', 'app.js', 'config.js', 'connection.js']) {
    assert.doesNotMatch(readFileSync(new URL('../js/' + name, import.meta.url), 'utf8'), /MockServer|useMock|mockLatencyMs/);
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /js\/mock|mock-server/);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (!match[1].startsWith('http')) assert.match(match[1], /\?v=1\.2\.9$/);
  }
});
