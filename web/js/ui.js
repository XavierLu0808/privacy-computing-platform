/**
 * DOM 与格式化工具。后端只返回原始数值，全部展示格式化在这里做（见 API.md §0.1）。
 */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function toast(message, isError) {
    const wrap = $('toasts');
    const t = el('div', 'toast' + (isError ? ' err' : ''), message);
    wrap.appendChild(t);
    setTimeout(function () { t.remove(); }, 3600);
  }

  /** 统一错误提示：ApiError 直接显示后端 message。 */
  function fail(err) {
    if (err && (err.name === 'AbortError' || err.cancelled)) return;
    console.error(err);
    toast((err && err.message) || '请求失败', true);
  }

  function fixed(v, n) {
    return (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(n);
  }

  /** 秒 → "1 分 12 秒" */
  function duration(sec) {
    if (sec === null || sec === undefined) return '—';
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    if (m === 0) return r + ' 秒';
    return m + ' 分 ' + (r < 10 ? '0' + r : r) + ' 秒';
  }

  /** 字节 → "184.6 MB" */
  function bytes(n) {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /** 条数 → "120.0 万" */
  function rows(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
    return String(n);
  }

  /** ISO 时间 → "2026-09-18 16:42"（按 +08:00 展示） */
  function datetime(iso) {
    if (!iso) return '—';
    // 固定按 UTC+8 展示，不依赖浏览器本地时区
    const d = new Date(new Date(iso).getTime() + 8 * 3600000);
    const p = function (x) { return String(x).padStart(2, '0'); };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  /**
   * 把 [{x, y}] 折线点映射成 SVG polyline 的 points 串。
   * ymin/ymax 为纵轴量纲；xmax 为横轴最大值。
   */
  function polyline(points, opts) {
    if (!points || points.length < 2) return '';
    const W = opts.w, H = opts.h, PL = opts.pl, PR = opts.pr, PT = opts.pt, PB = opts.pb;
    return points.map(function (p) {
      const x = PL + ((p.x - 1) / (opts.xmax - 1)) * (W - PL - PR);
      let v = p.y;
      if (v > opts.ymax) v = opts.ymax;
      if (v < opts.ymin) v = opts.ymin;
      const y = PT + (1 - (v - opts.ymin) / (opts.ymax - opts.ymin)) * (H - PT - PB);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /**
   * 模态表单。opts = { title, body: Node, submitText, onSubmit: async () => boolean }
   * onSubmit 返回 false（或抛错）时弹窗保持打开，错误显示在弹窗底部。
   */
  function modal(opts) {
    const mask = el('div', 'modal-mask');
    const box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (opts.width) box.style.width = opts.width + 'px';

    const head = el('div', 'modal-head');
    head.appendChild(el('span', 'card-title', opts.title));
    const x = el('button', 'modal-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '关闭');
    head.appendChild(x);
    box.appendChild(head);

    const body = el('div', 'modal-body');
    body.appendChild(opts.body);
    box.appendChild(body);

    const errEl = el('div', 'modal-err');
    errEl.hidden = true;
    box.appendChild(errEl);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    const submit = el('button', 'btn-primary', opts.submitText || '确定');
    submit.type = 'button';
    foot.appendChild(cancel);
    foot.appendChild(submit);
    box.appendChild(foot);

    mask.appendChild(box);
    document.body.appendChild(mask);

    function close() { mask.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    x.addEventListener('click', close);
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    submit.addEventListener('click', async function () {
      errEl.hidden = true;
      submit.disabled = true;
      try {
        const res = await opts.onSubmit();
        if (res !== false) close();
      } catch (e) {
        errEl.textContent = (e && e.message) || '提交失败';
        errEl.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    const first = body.querySelector('input, select');
    if (first) first.focus();
    return { close: close, showError: function (m) { errEl.textContent = m; errEl.hidden = false; } };
  }

  /** 表单行：label + 控件 + 可选提示。 */
  function formRow(label, control, hint) {
    const row = el('div', 'field-col');
    const lb = el('label', null, label);
    if (control.id) lb.htmlFor = control.id;
    row.appendChild(lb);
    row.appendChild(control);
    if (hint) row.appendChild(el('span', 'hint', hint));
    return row;
  }

  function selectOf(id, options, value) {
    const s = el('select', 'select select-lg');
    s.id = id;
    options.forEach(function (o) {
      const op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      s.appendChild(op);
    });
    if (value !== undefined) s.value = value;
    return s;
  }

  function inputOf(id, value, type) {
    const i = el('input', 'input');
    i.id = id;
    i.type = type || 'text';
    if (value !== undefined && value !== null) i.value = value;
    return i;
  }

  window.UI = {
    modal: modal, formRow: formRow, selectOf: selectOf, inputOf: inputOf,
    $: $, el: el, clear: clear, toast: toast, fail: fail,
    fixed: fixed, duration: duration, bytes: bytes, rows: rows, datetime: datetime,
    polyline: polyline, svgEl: svgEl, debounce: debounce
  };
})();
