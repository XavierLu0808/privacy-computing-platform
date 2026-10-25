/** Operator-issued Bearer token, stored only in this tab's session. */
(function () {
  'use strict';
  const KEY = 'sfl.access-token';
  let checking = false, waiting = false, startApp = null;
  const shell = function () { return document.querySelector('.app'); };
  function remember(token) {
    window.APP_CONFIG.accessToken = token;
    try { if (token) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); }
    catch (error) { /* Blocked storage falls back to memory. */ }
  }
  function suspend() { if (window.App && window.App.suspend) window.App.suspend(); if (shell()) shell().hidden = true; }
  function promptConnection(message) {
    if (waiting) return;
    waiting = true; suspend();
    const gate = UI.el('main', 'connection-gate'), form = UI.el('form', 'connection-card');
    form.setAttribute('aria-labelledby', 'connection-title');
    const title = UI.el('h1', null, '连接隐私计算平台'); title.id = 'connection-title'; form.appendChild(title);
    form.appendChild(UI.el('p', 'connection-hint', '输入运维签发的访问令牌。令牌只保存在当前标签页会话中。'));
    const label = UI.el('label', 'field-label', 'Bearer 访问令牌'); label.htmlFor = 'connection-token'; form.appendChild(label);
    const input = UI.inputOf('connection-token', '', 'password'); input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
    input.setAttribute('autocapitalize', 'off'); input.setAttribute('aria-describedby', 'connection-status'); form.appendChild(input);
    const status = UI.el('p', 'connection-status', message || ''); status.id = 'connection-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.appendChild(status);
    const submit = UI.el('button', 'btn-primary', '连接'); submit.type = 'submit'; form.appendChild(submit);
    gate.appendChild(form); document.body.appendChild(gate); input.focus();
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); if (checking) return;
      const token = input.value.trim().replace(/^Bearer\s+/i, '');
      if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) { status.textContent = '请输入有效的运维访问令牌。'; return; }
      checking = true; submit.disabled = true; status.textContent = '正在校验连接…';
      window.APP_CONFIG.accessToken = token;
      try {
        const me = await Api.get('/me');
        remember(token); input.value = '';
        await startApp(me);
        waiting = false; gate.remove(); if (shell()) shell().hidden = false;
      } catch (error) {
        remember(''); suspend(); input.value = '';
        status.textContent = '连接或页面初始化失败，请核对访问令牌、项目权限及服务状态后重试。'; input.focus();
      } finally { checking = false; submit.disabled = false; }
    });
  }
  async function start(callback) {
    startApp = callback; suspend();
    let saved = '';
    try { saved = sessionStorage.getItem(KEY) || ''; } catch (error) { /* Ask when storage is unavailable. */ }
    if (saved) {
      checking = true; window.APP_CONFIG.accessToken = saved;
      try {
        const me = await Api.get('/me');
        await callback(me);
        if (shell()) shell().hidden = false;
        return;
      } catch (error) { remember(''); suspend(); }
      finally { checking = false; }
    }
    promptConnection(saved ? '连接或页面初始化失败，请重新连接。' : '');
  }
  function expired() {
    if (checking || waiting) return;
    remember(''); promptConnection('会话已失效，请重新输入访问令牌。');
  }
  window.SflConnection = { start: start, expired: expired };
})();
