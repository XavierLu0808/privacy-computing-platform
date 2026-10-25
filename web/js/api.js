/** Real backend transport. Credentials stay in headers; project changes fence late responses. */
(function () {
  'use strict';
  let epoch = 0;
  const requests = new Set(), streams = new Set();
  function ApiError(code, message, data, status) {
    return Object.assign(new Error(message || '请求失败'), { name: 'ApiError', code: code, data: data, status: status });
  }
  function cancelled() { return Object.assign(new Error('页面上下文已变更，请求已取消'), { name: 'AbortError', cancelled: true }); }
  function invalidateContext() {
    epoch += 1;
    requests.forEach(function (controller) { controller.abort(); });
    streams.forEach(function (stream) { stream.close(); });
    requests.clear(); streams.clear();
  }
  function checkAuth(status, envelope, token) {
    if (token === window.APP_CONFIG.accessToken && (status === 401 || (envelope && envelope.code === 40100)) && window.SflConnection) {
      window.SflConnection.expired();
    }
  }
  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') usp.append(key, String(value));
    });
    return usp.toString() ? '?' + usp : '';
  }
  async function operation(callback, signal) {
    const version = epoch, token = window.APP_CONFIG.accessToken;
    const controller = new AbortController();
    const abort = function () { controller.abort(); };
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    const ensureCurrent = function () {
      if (controller.signal.aborted || version !== epoch || token !== window.APP_CONFIG.accessToken) throw cancelled();
    };
    requests.add(controller);
    try {
      ensureCurrent();
      return await callback({ token: token, signal: controller.signal, ensureCurrent: ensureCurrent });
    } catch (error) {
      if (version !== epoch || controller.signal.aborted || token !== window.APP_CONFIG.accessToken) {
        // Keep an actual authentication error available to the connection gate.
        if (error && (error.status === 401 || error.code === 40100)) throw error;
        throw cancelled();
      }
      throw error;
    } finally {
      requests.delete(controller);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  function fetchResponse(url, options) {
    // Native browser fetch must retain its Window receiver.
    return window.fetch ? window.fetch(url, options) : fetch(url, options);
  }
  async function request(method, path, opts) {
    opts = opts || {};
    return operation(async function (context) {
      const response = await fetchResponse(window.APP_CONFIG.apiBase + path + buildQuery(opts.query), {
        method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + context.token },
        credentials: 'omit', redirect: 'error', signal: context.signal,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
      context.ensureCurrent();
      let envelope;
      try { envelope = await response.json(); }
      catch (error) { context.ensureCurrent(); checkAuth(response.status, null, context.token); throw ApiError(-1, '服务未返回有效 JSON（HTTP ' + response.status + '）', null, response.status); }
      context.ensureCurrent(); checkAuth(response.status, envelope, context.token);
      if ((!response.ok && response.ok !== undefined) || !envelope || envelope.code !== 0) {
        throw ApiError(envelope && envelope.code !== 0 ? envelope.code : -1,
          envelope && envelope.message || '请求失败（HTTP ' + response.status + '）', envelope && envelope.data, response.status);
      }
      return envelope.data;
    }, opts.signal);
  }
  function subscribe(path, handlers) {
    handlers = handlers || {};
    const match = /^\/(fl\/jobs|mpc\/tasks|psi\/pipelines|fl\/evaluations)\/([^/?#]+)\/events$/.exec(path);
    if (!match) throw ApiError(40000, '不支持的事件订阅路径');
    let closed = false, subscription = null;
    const version = epoch, token = window.APP_CONFIG.accessToken;
    const projectId = window.App.ctx.projectId;
    const kind = { 'fl/jobs': 'fl', 'mpc/tasks': 'mpc', 'psi/pipelines': 'psi', 'fl/evaluations': 'eval' }[match[1]];
    const current = function () { return !closed && version === epoch && token === window.APP_CONFIG.accessToken && window.App.ctx.projectId === projectId; };
    const handle = { close: function () { closed = true; if (subscription) subscription.close(); streams.delete(handle); } };
    streams.add(handle);
    import('./sse-client.mjs?v=1.2.9').then(function (module) {
      if (!current()) return;
      subscription = new module.ResourceSubscription({
        baseUrl: window.APP_CONFIG.apiBase, kind: kind, resourceId: decodeURIComponent(match[2]), projectId: projectId,
        fetchImpl: function (url, options) { return fetchResponse(url, options); },
        getToken: function () { return window.APP_CONFIG.accessToken; }, isCurrent: current,
        onSnapshot: function (data) {
          if (!current()) return;
          if (handlers.snapshot) return handlers.snapshot(data);
          if (kind === 'eval') { const callback = handlers[data.status === 'finished' ? 'finished' : 'progress']; if (callback) return callback(data); }
        },
        onEvent: function (name, data) { if (current() && handlers[name]) return handlers[name](data); },
        onError: function (error) {
          if (!current()) return;
          checkAuth(error.status, { code: error.code }, token);
          if (handlers.error) return handlers.error(error);
        }
      });
      return subscription.start();
    }).catch(function (error) { if (current() && handlers.error) handlers.error(error); }).finally(function () { streams.delete(handle); });
    return handle;
  }
  function downloadFilename(header, fallback) {
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
    const plain = /filename=(?:"([^"]+)"|([^;]+))/i.exec(header || '');
    let name = plain ? (plain[1] || plain[2].trim()) : fallback;
    if (utf8) { try { name = decodeURIComponent(utf8[1]); } catch (error) { /* Use the ordinary filename. */ } }
    return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/^\.+$/, '_') || fallback;
  }
  async function download(path, opts) {
    opts = opts || {};
    return operation(async function (context) {
      const response = await fetchResponse(window.APP_CONFIG.apiBase + path + buildQuery(opts.query), {
        headers: { Authorization: 'Bearer ' + context.token }, credentials: 'omit', redirect: 'error', signal: context.signal
      });
      context.ensureCurrent();
      const type = (response.headers.get('content-type') || '').toLowerCase();
      let envelope = null;
      if (type.includes('application/json') || type.includes('+json')) {
        try { envelope = await response.clone().json(); } catch (error) { /* Check HTTP status below. */ }
      }
      context.ensureCurrent(); checkAuth(response.status, envelope, context.token);
      const isEnvelope = envelope && typeof envelope.code === 'number' && ('message' in envelope || 'request_id' in envelope);
      if (!response.ok || isEnvelope) {
        throw ApiError(isEnvelope && envelope.code !== 0 ? envelope.code : -1,
          isEnvelope ? (envelope.code !== 0 ? envelope.message : '接口未返回导出文件') : '下载失败（HTTP ' + response.status + '）',
          isEnvelope ? envelope.data : null, response.status);
      }
      const suffix = type.includes('csv') ? '.csv' : type.includes('json') ? '.json' : type.includes('spreadsheetml') ? '.xlsx' : '';
      const name = downloadFilename(response.headers.get('content-disposition'), 'download' + suffix);
      const blob = await response.blob(); context.ensureCurrent();
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = name; document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
      return name;
    }, opts.signal);
  }
  async function upload(path, file, fields) {
    return operation(async function (context) {
      const body = new FormData(); body.append('file', file);
      Object.keys(fields || {}).forEach(function (key) { body.append(key, fields[key]); });
      const response = await fetchResponse(window.APP_CONFIG.apiBase + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + context.token }, body: body,
        credentials: 'omit', redirect: 'error', signal: context.signal
      });
      context.ensureCurrent();
      let envelope;
      try { envelope = await response.json(); } catch (error) { context.ensureCurrent(); checkAuth(response.status, null, context.token); throw ApiError(-1, '上传服务未返回有效 JSON', null, response.status); }
      context.ensureCurrent(); checkAuth(response.status, envelope, context.token);
      if ((!response.ok && response.ok !== undefined) || !envelope || envelope.code !== 0) throw ApiError(envelope && envelope.code !== 0 ? envelope.code : -1,
        envelope && envelope.message || '上传失败', envelope && envelope.data, response.status);
      return envelope.data;
    });
  }
  window.Api = { upload: upload, get: function (path, query) { return request('GET', path, { query: query }); },
    post: function (path, body, query) { return request('POST', path, { body: body, query: query }); },
    put: function (path, body) { return request('PUT', path, { body: body }); },
    patch: function (path, body) { return request('PATCH', path, { body: body }); },
    del: function (path) { return request('DELETE', path); }, subscribe: subscribe, download: download,
    invalidateContext: invalidateContext };
})();
