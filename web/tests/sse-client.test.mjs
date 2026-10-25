import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, ResourceSubscription, ProjectSubscriptions } from '../js/sse-client.mjs';

const encoder = new TextEncoder();
const json = (data, status = 200) => Response.json(data, { status });
const snapshot = (event_cursor = '0', extra = {}) => json({ code: 0, data: { job_id: 'j', project_id: 'p', event_cursor, ...extra } });
const frame = (id, event = 'status_changed', data = { job_id: 'j', status: 'Running' }) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const stream = (text, chunk = 7) => {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(c) {
    for (let at = 0; at < bytes.length; at += chunk) c.enqueue(bytes.slice(at, at + chunk));
    c.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
};
const options = (overrides = {}) => ({ baseUrl: 'https://api.example/api/v1', projectId: 'p',
  kind: 'fl', resourceId: 'j', getToken: () => 'test-secret', onSnapshot: () => {},
  onEvent: () => {}, retryMs: 0, sleepImpl: async () => {}, ...overrides });

test('UTF-8 Chinese, CRLF split at every byte, comments and multiline JSON', () => {
  const bytes = encoder.encode(': ping\r\nevent: status_changed\r\nid: 12\r\ndata: {"name":\r\ndata: "中文"}\r\n\r\n');
  const parser = new SSEParser(); let got = [];
  for (const byte of bytes) got.push(...parser.feed(Uint8Array.of(byte)));
  got.push(...parser.feed(undefined, true));
  assert.deepEqual(got, [{ event: 'status_changed', id: '12', data: '{"name":\n"中文"}' }]);
});
test('bare CR lines, unknown fields, EOF incomplete event is not delivered', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.feed(encoder.encode('retry: 1\rid: 1\rdata: x\r\rdata: lost'), true), [{ event: 'message', id: '1', data: 'x' }]);
});
test('bounded partial line and bounded accumulated data', () => {
  assert.throws(() => new SSEParser({ maxBufferChars: 12 }).feed(encoder.encode('data: '.repeat(5))), /buffer limit/);
  const parser = new SSEParser({ maxBufferChars: 36 });
  parser.feed(encoder.encode('data: 1234567890\n'));
  parser.feed(encoder.encode('data: 1234567890\n'));
  assert.throws(() => parser.feed(encoder.encode('data: 1234567890\n')), /buffer limit/);
});
test('malformed UTF-8 fails rather than corrupting JSON', () => {
  assert.throws(() => new SSEParser().feed(Uint8Array.of(0xff)), /encoded data/);
});
test('header-only auth, snapshot first, large IDs preserved, reconnect Last-Event-ID', async () => {
  const calls = [], applied = []; let s;
  s = new ResourceSubscription(options({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return snapshot('9007199254740993');
    if (calls.length === 2) return stream(frame('9007199254740994'));
    s.close(); return stream('');
  }, onEvent: (_event, data) => applied.push(data) }));
  await s.start();
  assert.equal(applied.length, 1);
  assert.equal(calls[1].init.headers['Last-Event-ID'], '9007199254740993');
  assert.equal(calls[2].init.headers['Last-Event-ID'], '9007199254740994');
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer test-secret');
    assert.equal(call.init.redirect, 'error'); assert.ok(!call.url.includes('test-secret'));
    assert.ok(!call.url.includes('access_token'));
  }
});
test('duplicate IDs and duplicate same-run rounds are ignored; new runs start at round 1', async () => {
  const got = []; const s = new ResourceSubscription(options({ onEvent: (_e, d) => got.push(`${d.run_id}:${d.round}`) }));
  const d = (run_id, round) => ({ job_id: 'j', run_id, round });
  for (const [id, run, n] of [['1', 'a', 1], ['1', 'a', 1], ['2', 'a', 1], ['3', 'b', 1]]) {
    await s.dispatch({ id, event: 'round_completed', data: JSON.stringify(d(run, n)) });
  }
  assert.deepEqual(got, ['a:1', 'b:1']); assert.equal(s.lastId, 3n);
});
test('round cache stays bounded and callback is awaited before consuming next frame', async () => {
  const calls = []; let concurrent = 0;
  const s = new ResourceSubscription(options({ maxRememberedRounds: 2, onEvent: async (_e, d) => {
    assert.equal(concurrent++, 0); await Promise.resolve(); calls.push(d.round); concurrent--;
  } }));
  await s.stream(stream([1, 2, 3].map((round) => frame(round, 'round_completed', { job_id: 'j', run_id: 'r', round })).join('')));
  assert.deepEqual(calls, [1, 2, 3]); assert.equal(s.rounds.size, 2);
});
test('410 retrieves scoped snapshot before replay, uses snapshot cursor not error latest ID', async () => {
  let s; const calls = [], received = [];
  s = new ResourceSubscription(options({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return snapshot('1');
    if (calls.length === 2) return json({ code: 41001, data: { snapshot_url: '/api/v1/fl/jobs/j', latest_event_id: '10' } }, 410);
    if (calls.length === 3) return snapshot('11');
    if (calls.length === 4) return stream(frame('12'));
    s.close(); return stream('');
  }, onSnapshot: (data) => received.push(data.event_cursor) }));
  await s.start();
  assert.deepEqual(received, ['1', '11']);
  assert.equal(calls[3].init.headers['Last-Event-ID'], '11');
});
test('snapshot event atomically replaces same public resource and advances cursor', async () => {
  const got = []; const s = new ResourceSubscription(options({ onSnapshot: (data) => got.push(data) }));
  await s.dispatch({ id: '8', event: 'snapshot', data: JSON.stringify({ job_id: 'j', project_id: 'p', event_cursor: '8' }) });
  assert.equal(got.length, 1); assert.equal(s.lastId, 8n);
  await assert.rejects(s.dispatch({ id: '9', event: 'snapshot', data: '{"event_cursor":"10"}' }), /cursor mismatch/);
});
for (const status of [401, 403, 400, 404]) {
  test(`HTTP ${status} stops without reconnecting`, async () => {
    let calls = 0; const errors = [];
    const s = new ResourceSubscription(options({ fetchImpl: async () => {
      calls++; return calls === 1 ? snapshot() : json({ code: status * 100 }, status);
    }, onError: (e) => errors.push(e) }));
    await s.start(); assert.equal(calls, 2); assert.equal(errors.length, 1); assert.equal(errors[0].fatal, true);
  });
}
test('transient disconnect retries with last successfully applied cursor', async () => {
  let calls = 0, s; const errors = [], ids = [];
  s = new ResourceSubscription(options({ fetchImpl: async (_url, init) => {
    calls++; if (calls === 1) return snapshot();
    ids.push(init.headers['Last-Event-ID']);
    if (calls === 2) throw new TypeError('Network offline');
    if (calls === 3) return stream(frame('1'));
    s.close(); return stream('');
  }, onError: (e) => errors.push(e) }));
  await s.start(); assert.equal(errors.length, 1); assert.deepEqual(ids, ['0', '0', '1']);
});
test('project switch aborts old fetch and fences late snapshot despite fetch ignoring abort', async () => {
  const manager = new ProjectSubscriptions(); let resolve; const got = [];
  const old = manager.subscribe(options({ fetchImpl: () => new Promise((r) => { resolve = r; }), onSnapshot: () => got.push('old') }));
  await Promise.resolve(); manager.clear();
  resolve(snapshot()); await old.done;
  assert.ok(old.controller.signal.aborted); assert.deepEqual(got, []);
});
test('late stream chunks from old context cannot update new project', async () => {
  let current = true, release; const got = [];
  const response = new Response(new ReadableStream({ start(c) { release = () => { c.enqueue(encoder.encode(frame('1'))); c.close(); }; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const s = new ResourceSubscription(options({ isCurrent: () => current, onEvent: () => got.push(1) }));
  const work = s.stream(response); current = false; release(); await work;
  assert.deepEqual(got, []);
});
test('snapshot URLs cannot leak token across origin, resource, query or redirect', () => {
  const s = new ResourceSubscription(options());
  for (const url of ['https://evil.example/api/v1/fl/jobs/j', '/api/v1/fl/jobs/other', '/api/v1/fl/jobs/j?access_token=x', '/outside']) {
    assert.throws(() => s.safeUrl(url), /Unsafe|another resource/);
  }
});
test('resource, project and missing stable round identity fail closed', async () => {
  const s = new ResourceSubscription(options());
  for (const data of [{ job_id: 'other' }, { project_id: 'other' }, { round: 1 }]) {
    await assert.rejects(s.dispatch({ id: '1', event: 'round_completed', data: JSON.stringify(data) }), /scope|project|identity/);
  }
});
test('MPC and PSI use original endpoints and scoped snapshot identities', async () => {
  for (const [kind, segment, key] of [['mpc', 'mpc/tasks', 'task_id'], ['psi', 'psi/pipelines', 'pipeline_id']]) {
    let s; const calls = [], got = [];
    s = new ResourceSubscription(options({ kind, resourceId: 'resource', fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return json({ code: 0, data: { [key]: 'resource', project_id: 'p', event_cursor: '3' } });
      s.close(); return stream('');
    }, onSnapshot: (data) => got.push(data) }));
    await s.start(); assert.equal(got.length, 1);
    assert.equal(calls[1], `https://api.example/api/v1/${segment}/resource/events`);
  }
});
test('reader error after completed frame replays only unacknowledged next frame', async () => {
  let reads = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(encoder.encode(frame('1')));
    else controller.error(new TypeError('connection reset'));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const got = []; const s = new ResourceSubscription(options({ onEvent: (_e, _d, meta) => got.push(meta.id) }));
  await assert.rejects(s.stream(response), /connection reset/);
  assert.equal(s.lastId, 1n);
  await s.stream(stream(frame('1') + frame('2')));
  assert.deepEqual(got, ['1', '2']);
});
test('async UI callback can use isCurrent after its own await', async () => {
  let current = true, resolve, guard; const got = [];
  const s = new ResourceSubscription(options({ isCurrent: () => current, onEvent: async (_e, _data, meta) => {
    guard = meta.isCurrent; await new Promise((r) => { resolve = r; });
    if (meta.isCurrent()) got.push(1);
  } }));
  const dispatch = s.dispatch({ id: '1', event: 'status_changed', data: '{}' });
  current = false; resolve(); await dispatch;
  assert.equal(guard(), false); assert.deepEqual(got, []); assert.equal(s.lastId, 0n);
});
test('same-run high watermark suppresses old round after bounded duplicate cache evicts it', async () => {
  const got = []; const s = new ResourceSubscription(options({ maxRememberedRounds: 2, onEvent: (_e, d) => got.push(d.round) }));
  for (const [id, round] of [[1, 1], [2, 2], [3, 3], [4, 1]]) {
    await s.dispatch({ id: String(id), event: 'round_completed', data: JSON.stringify({ job_id: 'j', run_id: 'r', round }) });
  }
  assert.deepEqual(got, [1, 2, 3]); assert.equal(s.lastId, 4n); assert.equal(s.rounds.size, 2);
  assert.equal(s.roundRun, 'r'); assert.equal(s.completedRound, 3);
});
test('same-run snapshot keeps high watermark, initial REST round is baseline, new run resets it', async () => {
  const got = []; const s = new ResourceSubscription(options({ onEvent: (_e, d) => got.push(`${d.run_id}:${d.round}`) }));
  await s.applySnapshot({ job_id: 'j', project_id: 'p', run_id: 'r', current_round: 1, event_cursor: '5' });
  const send = async (id, run_id, round) => s.dispatch({ id: String(id), event: 'round_completed', data: JSON.stringify({ job_id: 'j', run_id, round }) });
  await send(6, 'r', 1);
  await s.applySnapshot({ job_id: 'j', project_id: 'p', run_id: 'r', current_round: 1, event_cursor: '7' });
  await send(8, 'r', 2); await send(9, 'r', 1);
  await s.applySnapshot({ job_id: 'j', project_id: 'p', run_id: 'new', current_round: 0, event_cursor: '10' });
  await send(11, 'new', 1);
  assert.deepEqual(got, ['r:2', 'new:1']); assert.equal(s.roundRun, 'new'); assert.equal(s.completedRound, 1);
});

test('native-style default fetch keeps the global receiver instead of the subscription', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async function (url, init) {
    assert.equal(this, globalThis, 'Window.fetch rejects a ResourceSubscription receiver');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(new URL(url).search, ''); calls++;
    return snapshot();
  };
  try {
    const subscription = new ResourceSubscription(options());
    await subscription.snapshot();
    assert.equal(calls, 1);
    subscription.close();
  } finally { globalThis.fetch = original; }
});
