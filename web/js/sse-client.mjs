/** Header-authenticated browser SSE reference. No npm dependencies. */
export class StreamError extends Error {
  constructor(message, { status = 0, code = null, fatal = false } = {}) {
    super(message); Object.assign(this, { name: 'StreamError', status, code, fatal });
  }
}

/** Incremental SSE parser: UTF-8, LF/CR/CRLF (including split CRLF), comments. */
export class SSEParser {
  constructor({ maxBufferChars = 1024 * 1024 } = {}) {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.maxBufferChars = maxBufferChars;
    this.buffer = ''; this.skipLF = false; this.reset();
  }
  reset() { this.event = 'message'; this.id = null; this.data = []; this.size = 0; }
  feed(bytes, final = false) {
    this.buffer += this.decoder.decode(bytes, { stream: !final });
    if (this.buffer.length + this.size > this.maxBufferChars) {
      throw new StreamError('SSE frame exceeds buffer limit', { fatal: true });
    }
    const frames = [];
    while (this.buffer.length) {
      if (this.skipLF) {
        if (this.buffer[0] === '\n') this.buffer = this.buffer.slice(1);
        this.skipLF = false;
        if (!this.buffer.length) break;
      }
      const at = this.buffer.search(/[\r\n]/);
      if (at < 0) break;
      const line = this.buffer.slice(0, at), ending = this.buffer[at];
      this.buffer = this.buffer.slice(at + 1); this.skipLF = ending === '\r';
      if (!line) {
        if (this.data.length) frames.push({ event: this.event, id: this.id, data: this.data.join('\n') });
        this.reset(); continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      if (field === 'id' && !value.includes('\0')) this.id = value;
      if (field === 'data') { this.data.push(value); this.size += value.length; }
    }
    // An unterminated frame at EOF is deliberately discarded; reconnect replays it.
    if (final) { this.buffer = ''; this.reset(); }
    return frames;
  }
}

function cursor(value) {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || text.length > 20) {
    throw new StreamError('Invalid event cursor', { fatal: true });
  }
  return BigInt(text);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
    const timer = setTimeout(end, ms); signal.addEventListener('abort', end, { once: true });
  });
}

/** One resource subscription. Awaited callbacks provide browser-side backpressure.
 * Callbacks should atomically replace/upsert UI state; do not perform additive accounting.
 */
export class ResourceSubscription {
  constructor({ baseUrl, projectId, kind, resourceId, getToken, fetchImpl = fetch,
    onSnapshot, onEvent, onError = () => {}, isCurrent = () => true,
    retryMs = 1000, maxRetryMs = 15000, maxRememberedRounds = 512,
    maxBufferChars = 1024 * 1024, sleepImpl = sleep }) {
    if (!['fl', 'mpc', 'psi', 'eval'].includes(kind)) throw new TypeError('Unknown resource kind');
    if (!Number.isInteger(maxRememberedRounds) || maxRememberedRounds < 1) throw new TypeError('Invalid cache limit');
    Object.assign(this, { projectId, kind, resourceId, getToken, fetchImpl, onSnapshot,
      onEvent, onError, isCurrent, retryMs, maxRetryMs, maxRememberedRounds, maxBufferChars, sleepImpl });
    this.base = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/');
    this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
    const segment = { fl: 'fl/jobs', mpc: 'mpc/tasks', psi: 'psi/pipelines', eval: 'fl/evaluations' }[kind];
    this.detailUrl = new URL(`${segment}/${encodeURIComponent(resourceId)}`, this.base);
    this.eventsUrl = new URL(`${segment}/${encodeURIComponent(resourceId)}/events`, this.base);
    this.controller = new AbortController(); this.lastId = 0n;
    this.rounds = new Map(); this.roundRun = null; this.completedRound = 0; this.done = null;
  }
  alive() { return !this.controller.signal.aborted && this.isCurrent(); }
  close() { this.controller.abort(); }
  start() { return this.done ??= this.run(); }
  safeUrl(value) {
    const url = new URL(value, this.base);
    // Never forward Bearer credentials to redirects or an untrusted snapshot URL.
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)
      || url.search || url.hash || url.username || url.password) {
      throw new StreamError('Unsafe resource URL', { fatal: true });
    }
    if (url.pathname !== this.detailUrl.pathname) {
      throw new StreamError('Snapshot belongs to another resource', { fatal: true });
    }
    return url;
  }
  async request(url, eventStream = false) {
    const token = await this.getToken();
    if (!this.alive()) return null;
    const headers = { Authorization: `Bearer ${token}`, Accept: eventStream ? 'text/event-stream' : 'application/json' };
    if (eventStream) headers['Last-Event-ID'] = String(this.lastId);
    return this.fetchImpl.call(globalThis, url, { headers, signal: this.controller.signal, cache: 'no-store', redirect: 'error' });
  }
  async httpError(response) {
    let payload; try { payload = await response.json(); } catch { payload = {}; }
    return new StreamError(payload.message ?? `HTTP ${response.status}`, {
      status: response.status, code: payload.code,
      fatal: response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status),
    });
  }
  async snapshot(url = this.detailUrl) {
    const response = await this.request(this.safeUrl(url));
    if (!response || !this.alive()) return;
    if (!response.ok) throw await this.httpError(response);
    const envelope = await response.json();
    if (!this.alive()) return;
    if (envelope.code !== 0 || !envelope.data) throw new StreamError('Invalid snapshot', { fatal: true });
    await this.applySnapshot(envelope.data);
  }
  async applySnapshot(data) {
    const next = cursor(data.event_cursor);
    const key = { fl: 'job_id', mpc: 'task_id', psi: 'pipeline_id', eval: 'eval_id' }[this.kind];
    if ((data.resource_id != null && data.resource_id !== this.resourceId)
      || (data.resource_kind != null && data.resource_kind !== this.kind)) {
      throw new StreamError('Event resource scope mismatch', { fatal: true });
    }
    if (data[key] !== this.resourceId || (data.project_id != null && data.project_id !== this.projectId)) {
      throw new StreamError('Snapshot scope mismatch', { fatal: true });
    }
    await this.onSnapshot(data, { isCurrent: () => this.alive() });
    if (!this.alive()) return;
    this.lastId = next;
    if (this.kind === 'fl') {
      const run = data.run_id ?? null, baseline = Number.isSafeInteger(data.current_round) ? data.current_round : 0;
      if (run !== this.roundRun) { this.rounds.clear(); this.completedRound = 0; }
      this.roundRun = run; this.completedRound = Math.max(this.completedRound, baseline);
    }
  }
  async dispatch(frame) {
    if (!this.alive()) return;
    const id = cursor(frame.id);
    if (id <= this.lastId) return;
    let data; try { data = JSON.parse(frame.data); } catch { throw new StreamError('Invalid event JSON', { fatal: true }); }
    if (frame.event === 'snapshot') {
      if (cursor(data.event_cursor) !== id) throw new StreamError('Snapshot cursor mismatch', { fatal: true });
      await this.applySnapshot(data); return;
    }
    const key = { fl: 'job_id', mpc: 'task_id', psi: 'pipeline_id', eval: 'eval_id' }[this.kind];
    if (data[key] != null && data[key] !== this.resourceId) throw new StreamError('Event scope mismatch', { fatal: true });
    if ((data.resource_id != null && data.resource_id !== this.resourceId)
      || (data.resource_kind != null && data.resource_kind !== this.kind)) {
      throw new StreamError('Event resource scope mismatch', { fatal: true });
    }
    if (data.project_id != null && data.project_id !== this.projectId) throw new StreamError('Event project mismatch', { fatal: true });
    let roundKey;
    if (frame.event === 'round_completed') {
      if (typeof data.run_id !== 'string' || !Number.isSafeInteger(data.round) || data.round < 1) {
        throw new StreamError('Round lacks stable run/round identity', { fatal: true });
      }
      roundKey = `${data.run_id}:${data.round}`;
      if (this.rounds.has(roundKey) || (data.run_id === this.roundRun && data.round <= this.completedRound)) {
        this.lastId = id; return;
      }
    }
    await this.onEvent(frame.event, data, { id: String(id), projectId: this.projectId,
      resourceId: this.resourceId, kind: this.kind, isCurrent: () => this.alive() });
    if (!this.alive()) return;
    this.lastId = id;
    if (roundKey) {
      this.rounds.set(roundKey, true);
      if (this.rounds.size > this.maxRememberedRounds) this.rounds.delete(this.rounds.keys().next().value);
      if (data.run_id !== this.roundRun) {
        this.rounds.clear(); this.rounds.set(roundKey, true); this.completedRound = 0;
      }
      this.roundRun = data.run_id; this.completedRound = Math.max(this.completedRound, data.round);
    }
  }
  async stream(response) {
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      throw new StreamError('Expected an SSE response', { fatal: true });
    }
    const reader = response.body.getReader(), parser = new SSEParser({ maxBufferChars: this.maxBufferChars });
    try {
      while (this.alive()) {
        const { done, value } = await reader.read();
        if (!this.alive()) break;
        for (const frame of parser.feed(value, done)) { await this.dispatch(frame); if (!this.alive()) break; }
        if (done) break;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async run() {
    let initialized = false, attempts = 0;
    while (this.alive()) {
      try {
        if (!initialized) { await this.snapshot(); initialized = true; }
        if (!this.alive()) break;
        const response = await this.request(this.eventsUrl, true);
        if (!response || !this.alive()) break;
        if (response.status === 410) {
          const envelope = await response.json();
          if (envelope.code !== 41001 || !envelope.data?.snapshot_url) throw new StreamError('Invalid expired-cursor response', { fatal: true });
          await this.snapshot(envelope.data.snapshot_url);
          // Repeated retention expiry is rate limited just like a disconnected stream.
        } else {
          if (!response.ok) throw await this.httpError(response);
          await this.stream(response);
        }
        attempts = 0;
      } catch (error) {
        if (!this.alive() || error.name === 'AbortError') break;
        await this.onError(error);
        if (error.fatal) break;
        attempts = Math.min(attempts + 1, 10);
      }
      if (this.alive()) await this.sleepImpl(Math.min(this.maxRetryMs, this.retryMs * 2 ** attempts), this.controller.signal);
    }
  }
}

/** Each project/module switch aborts old requests and fences late responses. */
export class ProjectSubscriptions {
  constructor() { this.epoch = 0; this.active = new Set(); }
  clear() { this.epoch += 1; for (const item of this.active) item.close(); this.active.clear(); }
  subscribe(options) {
    const epoch = this.epoch, subscription = new ResourceSubscription({ ...options,
      isCurrent: () => this.epoch === epoch && (options.isCurrent?.() ?? true) });
    this.active.add(subscription);
    subscription.start().then(() => this.active.delete(subscription), () => this.active.delete(subscription));
    return subscription;
  }
}
