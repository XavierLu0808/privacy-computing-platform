/** 应用外壳：加载公共数据、侧边导航切换、项目切换。接口见 API.md §1。 */
(function () {
  'use strict';
  const $ = UI.$;

  const ctx = { projectId: null };
  let current = 'fed';
  let flMounted = false;
  let dpTimer = null;

  const MODULES = {
    fed: function () { return window.FL; },
    he: function () { return window.HE; },
    mpc: function () { return window.MPC; },
    psi: function () { return window.PSI; },
    dp: function () { return window.DP; }
  };

  /** opts.focusJobId：切到联邦学习时定位到指定任务（PSI「前往训练」用）。 */
  function go(name, opts) {
    if (!MODULES[name]) return;
    opts = opts || {};

    if (current !== name && current !== 'fed') {
      const prev = MODULES[current]();
      if (prev && prev.unmount) prev.unmount();
    }
    current = name;

    Object.keys(MODULES).forEach(function (k) {
      const id = k === 'fed' ? 'screen-fed' : 'screen-' + k;
      $(id).hidden = k !== name;
    });
    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.screen === name);
    });

    if (name === 'fed') {
      if (!flMounted) { window.FL.mount(ctx, opts.focusJobId); flMounted = true; }
      else window.FL.refresh(opts.focusJobId);
    } else {
      MODULES[name]().mount(ctx);
    }

    clearInterval(dpTimer);
    dpTimer = null;
    if (name === 'dp') {
      // 训练在跑时预算与审计每 2 秒刷新一次（DP 的轮次来自任务真实进度）
      dpTimer = setInterval(function () { window.DP.refresh(); }, 2000);
    }
  }

  async function switchProject(projectId) {
    window.FL.unmount();
    flMounted = false;
    ctx.projectId = projectId;
    go(current);
  }

  async function boot() {
    try {
      const results = await Promise.all([
        Api.get('/me'),
        Api.get('/platform/info'),
        Api.get('/projects')
      ]);
      const me = results[0], platform = results[1], projects = results[2];

      $('avatar').textContent = me.avatar_text || me.display_name.slice(0, 1);
      $('brandName').textContent = platform.platform_name + ' 控制台';
      document.title = platform.platform_name + ' · 控制台';
      $('envLabel').textContent = platform.environment_label;
      $('sourceNote').textContent = window.APP_CONFIG.useMock
        ? '当前为内置 mock 数据源（config.js: useMock = true），接口契约与 API.md 一致。'
        : '已连接后端 ' + window.APP_CONFIG.apiBase + '。';

      const sel = $('projSelect');
      UI.clear(sel);
      projects.items.forEach(function (p) {
        const o = document.createElement('option');
        o.value = p.project_id;
        o.textContent = p.name;
        sel.appendChild(o);
      });
      ctx.projectId = projects.items[0].project_id;
      sel.value = ctx.projectId;
      sel.addEventListener('change', function () { switchProject(sel.value); });

      document.querySelectorAll('.nav-item').forEach(function (btn) {
        btn.addEventListener('click', function () { go(btn.dataset.screen); });
      });

      go('fed');
    } catch (e) {
      UI.fail(e);
    }
  }

  window.App = { go: go, ctx: ctx };
  document.addEventListener('DOMContentLoaded', boot);
})();
