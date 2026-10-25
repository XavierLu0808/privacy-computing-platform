import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
function client(response, { clickError = false } = {}) {
  const requests = [], saved = [], revoked = [], timers = [], blobs = [];
  class TestURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:compat-test'; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const window = { APP_CONFIG: { apiBase: 'https://api.example.test/api/v1', accessToken: 'synthetic-unit-token' } };
  const document = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'a');
      return { remove() {}, click() { if (clickError) throw Error('click failed'); saved.push({ name: this.download, url: this.href }); } };
    }
  };
  vm.runInNewContext(source, { window, document, URL: TestURL, URLSearchParams, Blob,
    AbortController, setTimeout: callback => { timers.push(callback); },
    fetch: async (url, init) => { requests.push({ url, init }); return typeof response === 'function' ? response() : response; } });
  return { api: window.Api, requests, saved, revoked, blobs, flush: () => timers.forEach(fn => fn()) };
}

test('cross-origin CSV uses Bearer with no cookie or URL token, preserves UTF-8 filename and bytes', async () => {
  const b = client(new Response('\ufeffa,b\r\n1,2\r\n', { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': "attachment; filename=fallback.csv; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.csv"
  } }));
  const abort = new AbortController();
  assert.equal(await b.api.download('/projects/p1/export', { query: { format: 'csv' }, signal: abort.signal }), '报表.csv');
  assert.equal(b.requests[0].url, 'https://api.example.test/api/v1/projects/p1/export?format=csv');
  assert.equal(b.requests[0].init.headers.Authorization, 'Bearer synthetic-unit-token');
  assert.equal(b.requests[0].init.credentials, 'omit');
  assert.equal(b.requests[0].init.redirect, 'error');
  assert.equal(b.requests[0].init.signal.aborted, false);
  assert.deepEqual([...new Uint8Array(await b.blobs[0].arrayBuffer())], [...new TextEncoder().encode('\ufeffa,b\r\n1,2\r\n')]);
  assert.deepEqual(b.saved, [{ name: '报表.csv', url: 'blob:compat-test' }]);
  assert.deepEqual(b.revoked, []); b.flush(); assert.deepEqual(b.revoked, ['blob:compat-test']);
});

test('a real JSON configuration attachment is downloaded, not treated as an API error', async () => {
  const b = client(Response.json({ schema_version: '1.2', timezone: 'UTC+8' }, { headers: {
    'Content-Disposition': 'attachment; filename="project.json"'
  } }));
  assert.equal(await b.api.download('/projects/p1/config/export'), 'project.json');
  assert.equal(JSON.parse(await b.blobs[0].text()).timezone, 'UTC+8');
});

test('binary XLSX bytes and safe filename fallback survive the download', async () => {
  const b = client(new Response(new Uint8Array([80, 75, 0, 255]), { headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="../../report.xlsx"'
  } }));
  assert.equal(await b.api.download('/export'), '.._.._report.xlsx');
  assert.deepEqual([...new Uint8Array(await b.blobs[0].arrayBuffer())], [80, 75, 0, 255]);
});

for (const [status, code] of [[401, 40100], [403, 40300], [409, 40901], [200, 40901]]) {
  test(`JSON error HTTP ${status}/code ${code} never creates a file`, async () => {
    const b = client(Response.json({ code, message: 'cannot export', data: { reason: 'fixture' } }, { status }));
    await assert.rejects(b.api.download('/export'), e => e.code === code && e.status === status && e.data.reason === 'fixture');
    assert.equal(b.saved.length, 0); assert.equal(b.blobs.length, 0);
  });
}

test('HTML gateway error does not become a downloaded report', async () => {
  const b = client(new Response('<h1>upstream failed</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(b.api.download('/export'), e => e.status === 502 && /502/.test(e.message));
  assert.equal(b.saved.length, 0);
});

test('successful API envelope is not mistaken for a file, and missing filename uses its content type', async () => {
  const b = client(Response.json({ code: 0, message: 'ok', data: {} }));
  await assert.rejects(b.api.download('/export'), e => /未返回导出文件/.test(e.message));
  assert.equal(b.saved.length, 0);
  const json = client(Response.json({ schema_version: '1.2' }));
  assert.equal(await json.api.download('/export'), 'download.json');
});

test('object URL is cleaned up even if the browser click fails', async () => {
  const b = client(new Response('x', { headers: { 'Content-Type': 'text/csv' } }), { clickError: true });
  await assert.rejects(b.api.download('/export'), /click failed/);
  b.flush(); assert.deepEqual(b.revoked, ['blob:compat-test']);
});
