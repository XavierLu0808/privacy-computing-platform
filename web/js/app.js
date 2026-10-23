/**
 * 应用外壳：加载公共数据、侧边二级导航（下拉菜单）、子页面路由、项目切换。接口见 API.md §1。
 *
 * 导航结构与《自研功能清单 V5》一级 / 二级功能一一对应：一级功能 = 侧边栏分组，
 * 二级功能 = 下拉出的子页面，每个子页面是一个 <section id="screen-{mod}-{sub}">，
 * 由一个独立的页面模块（window[module]）负责渲染。
 *
 * 页面模块约定：window.X = { mount(ctx, el, opts), unmount() }，可选 refresh(opts)。
 *   ctx  = { projectId }；el = 该子页面的 <section>；opts = { sub, ...路由参数 }
 */
(function () {
  'use strict';
  const $ = UI.$;

  const ICONS = {
    fed: '<circle cx="12" cy="5" r="2.6"></circle><circle cx="5" cy="18" r="2.6"></circle><circle cx="19" cy="18" r="2.6"></circle><path d="M10.6 7.2 6.4 15.6M13.4 7.2l4.2 8.4M7.6 18h8.8"></path>',
    he: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"></rect><path d="M8 10.5V7.4A4 4 0 0 1 16 7.4v3.1M12 14.4v2.8"></path>',
    mpc: '<circle cx="12" cy="12" r="3"></circle><circle cx="4.6" cy="6.4" r="2.2"></circle><circle cx="19.4" cy="6.4" r="2.2"></circle><circle cx="12" cy="21" r="2.2"></circle><path d="M6.4 7.7 9.8 10.2M17.6 7.7 14.2 10.2M12 15v3.8"></path>',
    psi: '<circle cx="9" cy="12" r="6"></circle><circle cx="15" cy="12" r="6"></circle>',
    dp: '<path d="M3 15c2.2 0 2.2-6 4.4-6s2.2 6 4.4 6 2.2-6 4.4-6 2.2 6 4.4 6"></path><path d="M3 19.5h18"></path>'
  };

  /** 一级 / 二级功能树。第一个 sub 是点击一级分组时的默认页。 */
  const NAV = [
    { mod: 'fed', label: '联邦学习', subs: [
      { sub: 'orch', label: '任务编排', module: 'FLO' },
      { sub: 'proc', label: '过程管控', module: 'FL' },
      { sub: 'agg', label: '聚合与安全', module: 'FLA' },
      { sub: 'eval', label: '技术指标验证', module: 'FLE' }
    ] },
    { mod: 'he', label: '同态加密', subs: [
      { sub: 'algo', label: '算法管理', module: 'HEA' },
      { sub: 'app', label: '应用集成', module: 'HE' }
    ] },
    { mod: 'mpc', label: '多方安全计算', subs: [
      { sub: 'proto', label: '协议管理', module: 'MPCP' },
      { sub: 'ops', label: '运维监控', module: 'MPC' }
    ] },
    { mod: 'psi', label: '隐私求交', subs: [
      { sub: 'data', label: '数据接入', module: 'PSI' },
      { sub: 'algo', label: '算法配置', module: 'PSIA' },
      { sub: 'pipe', label: '平台集成', module: 'PSI' }
    ] },
    { mod: 'dp', label: '差分隐私', subs: [
      { sub: 'mech', label: '隐私机制', module: 'DPM' },
      { sub: 'eval', label: '效果评估', module: 'DP' },
      { sub: 'fw', label: '框架集成', module: 'DPF' }
    ] }
  ];
  // 旧调用 App.go('fed') 等未指定 sub 时的落点（保持 v1.1 行为）
  const LEGACY_SUB = { fed: 'proc', he: 'app', mpc: 'ops', psi: 'data', dp: 'eval' };

  const ctx = { projectId: null };
  let current = null;          // { mod, sub, module }
  let flMounted = false;
  let dpTimer = null;
  const open = {};             // mod -> 分组是否展开

  function findSub(mod, sub) {
    const g = NAV.filter(function (x) { return x.mod === mod; })[0];
    if (!g) return null;
    return g.subs.filter(function (x) { return x.sub === sub; })[0] || null;
  }

  function moduleOf(entry) { return window[entry.module]; }

  /* ---------- 侧边栏 ---------- */

  function renderNav() {
    const tree = $('navTree');
    UI.clear(tree);
    NAV.forEach(function (g) {
      const isCur = current && current.mod === g.mod;
      const group = UI.el('div', 'nav-group' + (open[g.mod] ? ' open' : ''));
      const head = UI.el('button', 'nav-item' + (isCur ? ' active' : ''));
      head.type = 'button';
      head.dataset.mod = g.mod;
      head.setAttribute('aria-expanded', open[g.mod] ? 'true' : 'false');
      head.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="1.7" aria-hidden="true">' + ICONS[g.mod] + '</svg>';
      head.appendChild(UI.el('span', null, g.label));
      const chev = UI.el('i', 'nav-chev');
      chev.setAttribute('aria-hidden', 'true');
      head.appendChild(chev);
      head.addEventListener('click', function () {
        open[g.mod] = !open[g.mod];
        if (open[g.mod] && !isCur) go(g.mod, { sub: g.subs[0].sub });
        else renderNav();
      });
      group.appendChild(head);

      const list = UI.el('div', 'nav-sub');
      g.subs.forEach(function (s) {
        const b = UI.el('button', 'nav-sub-item' + (isCur && current.sub === s.sub ? ' active' : ''), s.label);
        b.type = 'button';
        b.dataset.screen = g.mod + '-' + s.sub;
        b.addEventListener('click', function () { go(g.mod, { sub: s.sub }); });
        list.appendChild(b);
      });
      group.appendChild(list);
      tree.appendChild(group);
    });
  }

  /* ---------- 路由 ---------- */

  function placeholder(el, entry) {
    if (el.childElementCount) return;
    el.appendChild(UI.el('div', 'card card-lg', '「' + entry.label + '」页面模块 ' + entry.module + ' 尚未加载。'));
  }

  function leave(next) {
    if (!current) return;
    if (current.module === 'FL') return;   // 训练监控保持 SSE（差分隐私页读取实时轮次）
    if (next && next.module === current.module) return;
    const m = window[current.module];
    if (m && m.unmount) m.unmount();
  }

  /**
   * go(mod, opts)：opts.sub 指定二级页面；opts.focusJobId 等其余字段原样传给页面模块。
   * 兼容 v1.1 的 App.go('fed', { focusJobId })。
   */
  function go(mod, opts) {
    opts = Object.assign({}, opts || {});
    const sub = opts.sub || LEGACY_SUB[mod];
    const entry = findSub(mod, sub);
    if (!entry) return;
    opts.sub = sub;
    const next = { mod: mod, sub: sub, module: entry.module };

    leave(next);
    current = next;
    open[mod] = true;

    document.querySelectorAll('main .screen').forEach(function (s) { s.hidden = s.id !== 'screen-' + mod + '-' + sub; });
    renderNav();
    const hash = '#/' + mod + '/' + sub;
    if (location.hash !== hash) history.replaceState(null, '', hash);

    const el = $('screen-' + mod + '-' + sub);
    const m = moduleOf(entry);
    if (!m) { placeholder(el, entry); return; }

    if (entry.module === 'FL') {
      if (!flMounted) { m.mount(ctx, opts.focusJobId); flMounted = true; }
      else m.refresh(opts.focusJobId);
    } else {
      m.mount(ctx, el, opts);
    }

    clearInterval(dpTimer);
    dpTimer = null;
    if (entry.module === 'DP') {
      // 训练在跑时预算与审计每 2 秒刷新一次（DP 的轮次来自任务真实进度）
      dpTimer = setInterval(function () { window.DP.refresh(); }, 2000);
    }
  }

  function parseHash() {
    const m = /^#\/(\w+)\/(\w+)/.exec(location.hash || '');
    return m && findSub(m[1], m[2]) ? { mod: m[1], sub: m[2] } : null;
  }

  /* ---------- 项目 ---------- */

  function switchProject(projectId) {
    if (window.FL) window.FL.unmount();
    flMounted = false;
    if (current && current.module !== 'FL') {
      const m = window[current.module];
      if (m && m.unmount) m.unmount();
    }
    ctx.projectId = projectId;
    if (current) go(current.mod, { sub: current.sub });
  }

  /** 重新拉取项目列表（任务编排页新建项目后调用）；selectId 给出时切到该项目。 */
  async function reloadProjects(selectId) {
    const projects = await Api.get('/projects?page_size=100');
    const sel = $('projSelect');
    UI.clear(sel);
    projects.items.forEach(function (p) {
      const o = document.createElement('option');
      o.value = p.project_id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    const target = selectId || ctx.projectId || projects.items[0].project_id;
    sel.value = target;
    if (target !== ctx.projectId) switchProject(target);
    return projects.items;
  }

  async function boot() {
    try {
      const results = await Promise.all([Api.get('/me'), Api.get('/platform/info')]);
      const me = results[0], platform = results[1];

      $('avatar').textContent = me.avatar_text || me.display_name.slice(0, 1);
      $('brandName').textContent = platform.platform_name + ' 控制台';
      document.title = platform.platform_name + ' · 控制台';
      $('envLabel').textContent = platform.environment_label;
      $('sourceNote').textContent = window.APP_CONFIG.useMock
        ? '当前为内置 mock 数据源（config.js: useMock = true），接口契约与 API.md 一致。'
        : '已连接后端 ' + window.APP_CONFIG.apiBase + '。';

      const items = await reloadProjects();
      ctx.projectId = $('projSelect').value || items[0].project_id;
      $('projSelect').addEventListener('change', function () { switchProject($('projSelect').value); });

      window.addEventListener('hashchange', function () {
        const h = parseHash();
        if (h && (!current || h.mod !== current.mod || h.sub !== current.sub)) go(h.mod, { sub: h.sub });
      });

      const h = parseHash() || { mod: 'fed', sub: 'proc' };
      go(h.mod, { sub: h.sub });
    } catch (e) {
      UI.fail(e);
    }
  }

  window.App = { go: go, ctx: ctx, reloadProjects: reloadProjects, NAV: NAV };
  document.addEventListener('DOMContentLoaded', boot);
})();
