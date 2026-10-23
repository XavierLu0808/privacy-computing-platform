/**
 * API 客户端。严格按 API.md 的统一响应包 { code, message, data, request_id } 解析。
 * useMock 时转发给 window.MockServer，否则 fetch 真实后端。
 */
(function () {
  'use strict';

  function ApiError(code, message, data) {
    const e = new Error(message || '请求失败');
    e.name = 'ApiError';
    e.code = code;
    e.data = data;
    return e;
  }

  function buildQuery(params) {
    if (!params) return '';
    const usp = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      usp.append(k, String(v));
    });
    const s = usp.toString();
    return s ? '?' + s : '';
  }

  async function request(method, path, opts) {
    opts = opts || {};
    const url = path + buildQuery(opts.query);

    let envelope;
    if (window.APP_CONFIG.useMock) {
      envelope = await window.MockServer.handle(method, url, opts.body);
    } else {
      const res = await fetch(window.APP_CONFIG.apiBase + url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + window.APP_CONFIG.accessToken
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      envelope = await res.json();
    }

    if (!envelope || envelope.code !== 0) {
      throw ApiError(
        envelope ? envelope.code : -1,
        envelope ? envelope.message : '响应格式错误',
        envelope ? envelope.data : null
      );
    }
    return envelope.data;
  }

  /**
   * 订阅 SSE。handlers = { eventName: fn, ... }
   * 返回 { close() }。
   */
  function subscribe(path, handlers) {
    if (window.APP_CONFIG.useMock) {
      return window.MockServer.subscribe(path, handlers);
    }
    const es = new EventSource(
      window.APP_CONFIG.apiBase + path + '?access_token=' + encodeURIComponent(window.APP_CONFIG.accessToken)
    );
    Object.keys(handlers).forEach(function (name) {
      es.addEventListener(name, function (ev) {
        handlers[name](JSON.parse(ev.data));
      });
    });
    return { close: function () { es.close(); } };
  }

  /** 文件下载：mock 时由前端合成 Blob，真后端时走 URL 直下。 */
  async function download(path, opts) {
    opts = opts || {};
    const url = path + buildQuery(opts.query);
    if (window.APP_CONFIG.useMock) {
      const file = await window.MockServer.download(url);
      const blob = new Blob([file.content], { type: file.contentType });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      return file.fileName;
    }
    window.open(window.APP_CONFIG.apiBase + url, '_blank');
    return null;
  }

  /** multipart 上传（API.md §1.4）。fields 里除 file 外都按字符串表单字段发送。 */
  async function upload(path, file, fields) {
    let envelope;
    if (window.APP_CONFIG.useMock) {
      envelope = await window.MockServer.handle('POST', path,
        Object.assign({ file: { name: file.name, size: file.size } }, fields));
    } else {
      const fd = new FormData();
      fd.append('file', file);
      Object.keys(fields || {}).forEach(function (k) { fd.append(k, fields[k]); });
      const res = await fetch(window.APP_CONFIG.apiBase + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + window.APP_CONFIG.accessToken },
        body: fd
      });
      envelope = await res.json();
    }
    if (!envelope || envelope.code !== 0) {
      throw ApiError(envelope ? envelope.code : -1, envelope ? envelope.message : '响应格式错误', envelope ? envelope.data : null);
    }
    return envelope.data;
  }

  window.Api = {
    upload: upload,
    get: function (path, query) { return request('GET', path, { query: query }); },
    post: function (path, body, query) { return request('POST', path, { body: body, query: query }); },
    put: function (path, body) { return request('PUT', path, { body: body }); },
    patch: function (path, body) { return request('PATCH', path, { body: body }); },
    del: function (path) { return request('DELETE', path); },
    subscribe: subscribe,
    download: download
  };
})();
