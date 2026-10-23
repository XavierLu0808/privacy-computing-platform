/**
 * 差分隐私 · 框架集成（window.DPF）。接口见 docs/api/dp.md。
 * 隐语集成适配层（DP-FW-01）、训练引擎 DP hook 链（DP-FW-02）、框架内部 DP 指标（DP-FW-03）、
 * 联邦差分隐私端到端工作流向导（DP-FW-04）。
 */
(function () {
  'use strict';
  const D = window.DPC;
  const el = UI.el;
  const C = D.COLORS;

  let ctx = null;
  let root = null;
  let jobs = [];
  let jobId = null;
  let providers = null;
  let timer = null;
  let seq = 0;
  const dom = {};
  const wiz = {};   // projectId -> { step, jobId, mode }

  function jobOf(id) { return jobs.filter(function (j) { return j.job_id === id; })[0]; }
  function noId(n, id) { if (!id) n.removeAttribute('id'); return n; }
  function grid(cls, cells, head) {
    const r = el('div', (head ? 'table-head ' : 'table-row ') + cls);
    cells.forEach(function (c) {
      if (c instanceof Node) r.appendChild(c);
      else r.appendChild(el('span', head ? null : 'cell-muted', c));
    });
    return r;
  }
  function metric(name, value, sub) {
    const m = el('div', 'metric');
    m.appendChild(el('span', 'metric-name', name));
    m.appendChild(el('span', 'metric-value dp-metric-sm', value));
    if (sub) m.appendChild(el('span', 'metric-sub', sub));
    return m;
  }
  function icon(pass) {
    const s = UI.svgEl('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'stroke-width': 2, 'aria-hidden': 'true' });
    s.style.stroke = pass ? 'var(--success)' : 'var(--danger)';
    s.appendChild(UI.svgEl('path', { d: pass ? 'M5 12.5l4.5 4.5L19 7.5' : 'M6 6l12 12M18 6L6 18' }));
    return s;
  }

  /* ================= 骨架 ================= */

  function skeleton(sec) {
    root = sec;
    UI.clear(sec);
    const head = el('div', 'page-head');
    const ht = el('div', 'page-head-text');
    ht.appendChild(el('span', 'crumb', '差分隐私 / 框架集成'));
    ht.appendChild(el('h1', null, '隐语 DP 框架集成与端到端工作流'));
    head.appendChild(ht);
    dom.jobSlot = el('div', 'field');
    head.appendChild(dom.jobSlot);
    head.appendChild(D.btn('btn-link', '查看效果评估', function () { App.go('dp', { sub: 'eval' }); }));
    sec.appendChild(head);

    dom.provider = el('div', 'card card-lg');
    dom.provider.setAttribute('data-acc', 'DP-FW-01');
    dom.wizard = el('div', 'card card-lg');
    dom.wizard.setAttribute('data-acc', 'DP-FW-04');
    dom.hooks = el('div', 'card card-lg');
    dom.hooks.setAttribute('data-acc', 'DP-FW-02');
    dom.metrics = el('div', 'card card-lg');
    dom.metrics.setAttribute('data-acc', 'DP-FW-03');
    [dom.provider, dom.wizard, dom.hooks, dom.metrics].forEach(function (n) { sec.appendChild(n); });
  }

  /* ================= DP-FW-01 适配层 ================= */

  function renderProvider() {
    const card = dom.provider;
    UI.clear(card);
    const cur = providers.items.filter(function (p) { return p.provider === providers.current; })[0];
    const s = noId(UI.selectOf('dpfProv', providers.items.map(function (p) { return { value: p.provider, label: p.name }; }), providers.current), 'dpfProv');
    s.className = 'select';
    s.setAttribute('aria-label', '差分隐私实现');
    const sw = D.btn('btn-primary', '切换实现', async function () {
      try {
        const r = await Api.put('/dp/provider', { provider: s.value });
        providers.current = r.current;
        UI.toast('已切换为 ' + s.options[s.selectedIndex].textContent + '：' + r.affected_jobs + ' 个未运行任务改用新实现' +
          (r.kept_running.length ? '，' + r.kept_running.length + ' 个运行中任务沿用原实现直到本次训练结束' : ''));
        renderProvider();
        await loadHooks(seq);
      } catch (e) { UI.fail(e); }
    });
    card.appendChild(D.cardHead('隐语集成 · DP 适配层', '平台只依赖右侧「平台接口」，底层实现可替换', [el('span', 'field-label', '实现'), s, sw]));
    const info = el('div', 'dpf-prov');
    info.appendChild(el('span', 'dp-enabled', '当前：' + cur.name));
    info.appendChild(el('span', 'hint', cur.version_note));
    info.appendChild(el('span', 'hint', '支持机制：' + cur.mechanisms.map(function (m) { return D.MECH_CN[m]; }).join('、') +
      '；会计方式：' + cur.accountants.map(function (a) { return D.ACC_CN[a]; }).join('、')));
    card.appendChild(info);
    const table = el('div');
    card.appendChild(table);
    function drawMap(id) {
      const p = providers.items.filter(function (x) { return x.provider === id; })[0];
      UI.clear(table);
      table.appendChild(el('span', 'section-label', (id === providers.current ? '接口映射（当前实现）' : '接口映射预览：' + p.name + '（尚未切换）')));
      table.appendChild(grid('dpf-map-grid', ['平台接口', '实现类 / 函数', '来源', '说明'], true));
      p.mapping.forEach(function (m) {
        table.appendChild(grid('dpf-map-grid', [
          el('code', 'dpf-code', m.iface), el('code', 'dpf-code', m.impl),
          el('span', 'tag ' + (m.source === 'native' ? 'tag-cls' : 'tag-ts'), m.source === 'native' ? '框架原生' : '平台适配器'), m.note
        ]));
      });
    }
    s.addEventListener('change', function () { drawMap(s.value); });
    drawMap(providers.current);
    card.appendChild(el('span', 'hint', '「框架原生」为对应框架自带的类，类路径以部署环境安装的版本为准；「平台适配器」为本平台按统一接口补齐的实现，可整体替换。可替换实现：' +
      providers.items.map(function (p) { return p.name; }).join('、') + '。'));
  }

  /* ================= DP-FW-02 hook 链 ================= */

  const ST = {
    active: ['运行中', 'dpf-st-active'], done: ['已调用', 'dpf-st-done'], pending: ['待调用', 'dpf-st-pending'], skipped: ['未启用', 'dpf-st-skip']
  };

  async function loadHooks(my) {
    if (!jobId) return;
    const h = await Api.get('/fl/jobs/' + jobId + '/dp/hooks');
    if (my !== seq) return;
    const card = dom.hooks;
    UI.clear(card);
    card.appendChild(D.cardHead('DP 初始化与 hook 链', '训练引擎在每轮梯度聚合前（before_aggregate）依次调用'));
    const job = jobOf(jobId);
    const st = el('div', 'dpf-prov');
    st.appendChild(el('span', h.initialized ? 'dp-enabled' : 'tag', h.initialized ? 'DP 已在训练引擎中初始化' : (h.dp_enabled ? 'DP 已启用，启动训练时初始化' : '任务未启用 DP')));
    st.appendChild(el('span', 'hint', (job ? job.name : jobId) + ' · ' + (D.STATUS_CN[h.job_status] || h.job_status) + ' · 已完成 ' + h.rounds_completed + ' 轮 · ' +
      h.trainers + ' 个训练参与方 · 实现：' + h.provider_name + (h.initialized_at ? ' · 初始化于 ' + UI.datetime(h.initialized_at) : '')));
    card.appendChild(st);
    const chain = el('div', 'dpf-chain');
    h.steps.forEach(function (s, i) {
      if (i) {
        const ar = UI.svgEl('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'stroke-width': 1.8, 'aria-hidden': 'true', class: 'dpf-arrow' });
        ar.appendChild(UI.svgEl('path', { d: 'M9 6l6 6-6 6' }));
        chain.appendChild(ar);
      }
      const n = el('div', 'dpf-node ' + ST[s.status][1] + (s.dp ? ' dpf-node-dp' : ''));
      n.appendChild(el('span', 'cell-strong', (i + 1) + '. ' + s.name));
      n.appendChild(el('span', 'dpf-st', ST[s.status][0]));
      n.appendChild(el('code', 'dpf-code', s.impl));
      n.appendChild(el('span', 'dpf-calls', '调用 ' + s.calls + ' 次' + (s.last_called_at ? ' · 最近 ' + UI.datetime(s.last_called_at) : '')));
      n.appendChild(el('span', 'hint', s.detail));
      chain.appendChild(n);
    });
    card.appendChild(chain);
    card.appendChild(el('span', 'hint', '调用次数：数据加载、本地训练、裁剪、加噪按「轮数 × 参与方数」计，安全聚合与预算记账按轮计。标为 DP 的三步在任务未启用 DP 时跳过。'));
  }

  /* ================= DP-FW-03 指标 ================= */

  async function loadMetrics(my) {
    if (!jobId) return;
    const m = await Api.get('/fl/jobs/' + jobId + '/dp/metrics', { bins: 21 });
    if (my !== seq) return;
    const card = dom.metrics;
    UI.clear(card);
    card.appendChild(D.cardHead('框架内部 DP 指标', '由训练引擎在加噪 hook 内逐轮上报'));
    if (!m.summary) {
      card.appendChild(el('div', 'table-empty', '该任务尚无启用 DP 的训练轮次；启动训练后这里逐轮出现裁剪比例、噪声范数与信噪比'));
      return;
    }
    const s = m.summary;
    const mg = el('div', 'metric-grid');
    mg.appendChild(metric('平均裁剪比例', D.pct(s.clip_ratio_avg), '被裁剪的参与方更新占比，按 ' + m.rounds.length + ' 轮平均'));
    mg.appendChild(metric('末轮噪声 L2 范数', s.noise_l2_last.toLocaleString('zh-CN'), '聚合后噪声向量 ‖n‖₂，' + (s.mechanism === 'gaussian' ? 'σ' : 'b') + ' = ' + s.noise_scale.toFixed(3) + '，模型维度 d = ' + s.model_dim.toLocaleString('zh-CN')));
    mg.appendChild(metric('末轮信噪比', s.snr_db_last.toFixed(1) + ' dB', '‖Σ 裁剪后更新‖₂ / ‖n‖₂ = ' + s.snr_last.toExponential(2) + '（' + s.trainers + ' 个参与方，信号取上界）'));
    mg.appendChild(metric('噪声分布抽样', m.histogram_samples + ' 个', '末轮噪声坐标抽样，以 ' + (s.mechanism === 'gaussian' ? 'σ' : 'b') + ' 为单位'));
    card.appendChild(mg);

    const row = el('div', 'dpf-two');
    const T = m.rounds[m.rounds.length - 1].round;
    const x0 = m.rounds[0].round;
    const xt = D.ticks(x0, Math.max(T, x0 + 1), Math.min(5, Math.max(1, T - x0))).map(Math.round);
    const w1 = el('div', 'dp-chart-wrap');
    w1.appendChild(el('span', 'card-label', '每轮裁剪比例'));
    w1.appendChild(D.chart({
      w: 400, h: 170, xmin: x0, xmax: Math.max(T, x0 + 1), ymin: 0, ymax: 1, xTicks: xt, yTicks: [0, 0.25, 0.5, 0.75, 1],
      yFmt: function (v) { return (v * 100).toFixed(0) + '%'; }, xLabel: '轮次', aria: '每轮被裁剪更新占比',
      series: [{ color: C.amber, dots: m.rounds.length < 25, points: m.rounds.map(function (r) { return { x: r.round, y: r.clip_ratio }; }) }]
    }));
    row.appendChild(w1);
    const snr = m.rounds.map(function (r) { return { x: r.round, y: 10 * Math.log10(r.snr * r.snr) }; });
    const lo = Math.floor(Math.min.apply(null, snr.map(function (p) { return p.y; })) / 5) * 5 - 5;
    const hi = Math.ceil(Math.max.apply(null, snr.map(function (p) { return p.y; })) / 5) * 5 + 5;
    const w2 = el('div', 'dp-chart-wrap');
    w2.appendChild(el('span', 'card-label', '每轮信噪比（dB）'));
    w2.appendChild(D.chart({
      w: 400, h: 170, xmin: x0, xmax: Math.max(T, x0 + 1), ymin: lo, ymax: hi, xTicks: xt, yTicks: D.niceTicks(lo, hi, 4),
      yFmt: function (v) { return v.toFixed(0); }, xLabel: '轮次', aria: '每轮信噪比',
      series: [{ color: C.primary, dots: m.rounds.length < 25, points: snr }]
    }));
    row.appendChild(w2);
    const w3 = el('div', 'dp-chart-wrap');
    w3.appendChild(el('span', 'card-label', '噪声分布直方图（实际抽样 vs 理论密度）'));
    const bw = 6 / m.histogram.length;
    w3.appendChild(D.chart({
      w: 400, h: 170, xmin: -3, xmax: 3, ymin: 0, ymax: 1.08, xTicks: [-3, -2, -1, 0, 1, 2, 3], yTicks: [0, 0.5, 1],
      xFmt: function (v) { return v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v) + (s.mechanism === 'gaussian' ? 'σ' : 'b'); }, yFmt: function (v) { return v.toFixed(1); },
      aria: '噪声分布直方图',
      bars: m.histogram.map(function (h) { return { x0: h.x - bw / 2, x1: h.x + bw / 2, y: h.density, color: 'var(--primary-lt)' }; }),
      series: [{ color: C.amber, width: 1.8, points: m.histogram.map(function (h) { return { x: h.x, y: h.theory }; }) }]
    }));
    w3.appendChild(D.legend([{ color: 'var(--primary-lt)', label: '抽样频数（峰值归一）' }, { color: C.amber, label: '理论密度（峰值归一）' }]));
    row.appendChild(w3);
    card.appendChild(row);
  }

  /* ================= DP-FW-04 工作流向导 ================= */

  const STEPS = ['选择训练任务', '机制与参数', '初始化检查', '启动训练', '查看预算'];

  function W() {
    if (!wiz[ctx.projectId]) wiz[ctx.projectId] = { step: 1, jobId: jobId, mode: 'manual', checks: null };
    return wiz[ctx.projectId];
  }

  function renderWizard() {
    const w = W();
    if (!jobOf(w.jobId)) w.jobId = jobId;
    const card = dom.wizard;
    UI.clear(card);
    card.appendChild(D.cardHead('联邦差分隐私端到端工作流', '配置 → 初始化 → 裁剪加噪 → 安全聚合 → 预算记账，按步骤完成', [
      D.btn('btn-sm', '从头开始', function () { wiz[ctx.projectId] = null; renderWizard(); })
    ]));
    const bar = el('ol', 'dpf-steps');
    STEPS.forEach(function (t, i) {
      const li = el('li', 'dpf-step' + (i + 1 === w.step ? ' on' : (i + 1 < w.step ? ' done' : '')));
      li.appendChild(el('span', 'dpf-step-no', String(i + 1)));
      li.appendChild(el('span', null, t));
      if (i + 1 === w.step) li.setAttribute('aria-current', 'step');
      bar.appendChild(li);
    });
    card.appendChild(bar);
    const body = el('div', 'dp-col');
    card.appendChild(body);
    const fn = [null, wStep1, wStep2, wStep3, wStep4, wStep5][w.step];
    Promise.resolve(fn(body, w)).catch(UI.fail);
  }

  function go(step) { W().step = step; renderWizard(); }

  function nav(body, prev, next) {
    const a = el('div', 'dp-actions');
    if (prev) a.appendChild(D.btn('btn', '上一步', prev));
    a.appendChild(el('span', 'spacer'));
    if (next) a.appendChild(next);
    body.appendChild(a);
    return a;
  }

  function wStep1(body, w) {
    body.appendChild(el('span', 'hint', '选择要启用差分隐私的联邦训练任务。只有「待启动 / 失败 / 已终止」的任务可以直接启动，已完成任务需先在「过程管控」重置。'));
    body.appendChild(grid('dpf-job-grid', ['', '任务', '状态', '轮数', '聚合方式', 'DP'], true));
    jobs.forEach(function (j) {
      const r = el('label', 'table-row dpf-job-grid clickable' + (j.job_id === w.jobId ? ' current' : ''));
      const rb = el('input');
      rb.type = 'radio'; rb.name = 'dpfWizJob'; rb.value = j.job_id; rb.checked = j.job_id === w.jobId;
      rb.addEventListener('change', function () { w.jobId = j.job_id; renderWizard(); });
      r.appendChild(rb);
      r.appendChild(el('span', 'cell-strong', j.name));
      r.appendChild(el('span', 'cell-muted', D.STATUS_CN[j.status] || j.status));
      r.appendChild(el('span', 'cell-muted', j.current_round + ' / ' + j.total_rounds));
      r.appendChild(el('span', 'cell-muted', j.aggregation === 'he' ? '同态加密聚合' : '秘密共享聚合'));
      r.appendChild(el('span', 'cell-muted', j.dp_enabled ? '已启用' : '未启用'));
      body.appendChild(r);
    });
    nav(body, null, D.btn('btn-primary', '下一步', function () {
      if (!w.jobId) { UI.toast('请先选择任务', true); return; }
      setJob(w.jobId);
      go(2);
    }));
  }

  async function wStep2(body, w) {
    const my = seq;
    const res = await Promise.all([Api.get('/fl/jobs/' + w.jobId + '/dp'), Api.get('/projects/' + ctx.projectId + '/dp/policies')]);
    if (my !== seq) return;
    const cfg = res[0];
    const pols = res[1].items.filter(function (p) {
      return p.dimensions.some(function (d) { return d.kind === 'training' && d.job_id === w.jobId; });
    });
    const job = jobOf(w.jobId);
    const ms = D.seg([{ value: 'manual', label: '手动设置参数' }, { value: 'policy', label: '选用已编排策略' }], w.mode, function (v) { w.mode = v; renderWizard(); }, '参数来源');
    const hd = el('div', 'dp-card-head');
    hd.appendChild(el('span', 'cell-strong', '任务：' + job.name + '（' + cfg.total_rounds + ' 轮）'));
    hd.appendChild(el('span', 'spacer'));
    hd.appendChild(ms.el);
    body.appendChild(hd);
    const err = el('div', 'banner banner-err');
    err.hidden = true;
    function showErr(e) { err.textContent = e.message + (e.code ? '（错误码 ' + e.code + '）' : ''); err.hidden = false; }

    if (w.mode === 'manual') {
      let mech = cfg.mechanism;
      const mseg = D.seg([{ value: 'gaussian', label: '高斯机制' }, { value: 'laplace', label: '拉普拉斯机制' }], mech, function (v) { mech = v; dRow.hidden = v !== 'gaussian'; }, '机制');
      const eps = D.numInput('dpfEps', cfg.epsilon_total, 0.2, 10, 0.1);
      const delta = UI.selectOf('dpfDelta', ['1e-4', '1e-5', '1e-6'].map(function (d) { return { value: d, label: d }; }), cfg.delta);
      const clip = D.numInput('dpfClip', cfg.clip_norm, 0.2, 4, 0.1);
      const acc = UI.selectOf('dpfAcc', [{ value: 'basic', label: '基础组合' }, { value: 'advanced', label: '高级组合' }, { value: 'rdp', label: 'RDP 会计' }], cfg.accountant || 'basic');
      const g = el('div', 'form-3col');
      const mr = el('div', 'field-col');
      mr.appendChild(el('label', null, '机制'));
      mr.appendChild(mseg.el);
      g.appendChild(mr);
      g.appendChild(UI.formRow('总隐私预算 ε（累计）', eps, '0.2 – 10'));
      const dRow = UI.formRow('松弛参数 δ', delta);
      dRow.hidden = mech !== 'gaussian';
      g.appendChild(dRow);
      g.appendChild(UI.formRow('裁剪阈值 C', clip, '0.2 – 4'));
      g.appendChild(UI.formRow('会计方式', acc));
      body.appendChild(g);
      body.appendChild(err);
      nav(body, function () { go(1); }, D.btn('btn-primary', '保存并下一步', async function () {
        err.hidden = true;
        try {
          await Api.put('/fl/jobs/' + w.jobId + '/dp', {
            enabled: true, mechanism: mech, epsilon_total: Number(eps.value), clip_norm: Number(clip.value),
            delta: delta.value, accountant: acc.value, clip_mode: cfg.clip_mode || 'fixed'
          });
          await reloadJobs();
          go(3);
        } catch (e) { showErr(e); }
      }));
    } else {
      if (!pols.length) {
        const n = el('div', 'banner-note');
        n.appendChild(document.createTextNode('还没有绑定该任务的策略。'));
        n.appendChild(D.btn('btn-link', '去「隐私机制 → 策略动态编排」新建', function () { App.go('dp', { sub: 'mech' }); }));
        body.appendChild(n);
        nav(body, function () { go(1); }, null);
        return;
      }
      const s = UI.selectOf('dpfPol', pols.map(function (p) {
        const d = p.dimensions.filter(function (x) { return x.kind === 'training' && x.job_id === w.jobId; })[0];
        return { value: p.policy_id, label: p.name + ' · ' + D.ACC_CN[p.accountant] + ' · 分到 ε = ' + d.epsilon.toFixed(3) };
      }));
      body.appendChild(UI.formRow('策略', s, '下发会把该策略所有训练维度写入各自绑定的任务'));
      body.appendChild(err);
      nav(body, function () { go(1); }, D.btn('btn-primary', '下发并下一步', async function () {
        err.hidden = true;
        try {
          await Api.post('/dp/policies/' + s.value + '/apply', {});
          await reloadJobs();
          go(3);
        } catch (e) { showErr(e); }
      }));
    }
  }

  async function wStep3(body, w) {
    const my = seq;
    const r = await Api.post('/fl/jobs/' + w.jobId + '/dp/init-check');
    if (my !== seq) return;
    w.checks = r;
    body.appendChild(el('span', 'hint', '训练引擎启动前的 DP 初始化检查（' + UI.datetime(r.checked_at) + '）：'));
    const list = el('div', 'dpf-checks');
    r.checks.forEach(function (c) {
      const row = el('div', 'dpf-check');
      row.appendChild(icon(c.pass));
      row.appendChild(el('span', 'cell-strong', c.name));
      row.appendChild(el('span', 'cell-muted', c.detail));
      list.appendChild(row);
    });
    body.appendChild(list);
    const statusFail = r.checks.some(function (c) { return c.key === 'status' && !c.pass; });
    const a = nav(body, function () { go(2); }, (function () {
      const b = D.btn('btn-primary', '下一步', function () { go(4); });
      b.disabled = !r.ok;
      return b;
    })());
    a.insertBefore(D.btn('btn', '重新检查', function () { renderWizard(); }), a.lastChild);
    if (statusFail) {
      a.insertBefore(D.btn('btn-kill btn', '重置任务（清空本任务历史轮次）', function () {
        UI.modal({
          title: '重置任务', submitText: '确认重置',
          body: el('div', 'hint', '重置会清空该任务已完成的轮次、指标曲线和本次运行的 DP 审计记录，任务回到「待启动」。'),
          onSubmit: async function () {
            await Api.post('/fl/jobs/' + w.jobId + '/actions', { action: 'reset' });
            await reloadJobs();
            renderWizard();
          }
        });
      }), a.lastChild);
    }
  }

  function wStep4(body, w) {
    const job = jobOf(w.jobId);
    body.appendChild(el('span', 'hint', '启动后训练引擎初始化 DP 机制，每轮按「本地训练 → 梯度裁剪 → 加噪 → 安全聚合 → 预算记账」执行；页面会跳到「联邦学习 / 过程管控」查看实时曲线。'));
    nav(body, function () { go(3); }, D.btn('btn-primary', '启动训练并前往过程管控', async function () {
      try {
        await Api.post('/fl/jobs/' + w.jobId + '/actions', { action: 'start' });
        w.step = 5;
        setJob(w.jobId);
        UI.toast('任务「' + job.name + '」已启动');
        App.go('fed', { sub: 'proc', focusJobId: w.jobId });
      } catch (e) { UI.fail(e); }
    }));
  }

  async function wStep5(body, w) {
    const my = seq;
    const b = await Api.get('/fl/jobs/' + w.jobId + '/dp/budget');
    if (my !== seq) return;
    const job = jobOf(w.jobId);
    const mg = el('div', 'metric-grid-3');
    mg.appendChild(metric('已完成轮次', b.rounds_completed + ' / ' + b.total_rounds, job ? job.name : w.jobId));
    mg.appendChild(metric('已消耗隐私预算', 'ε = ' + b.epsilon_used.toFixed(3), '占总预算 ε = ' + b.epsilon_total.toFixed(2) + ' 的 ' + b.used_pct + '%（' + D.ACC_CN[b.accountant] + '累计）'));
    mg.appendChild(metric('预算状态', b.exhausted ? '已用完' : '可继续', b.exhausted ? '训练轮次已达上限，预算全部消耗' : '剩余 ε = ' + (b.epsilon_total - b.epsilon_used).toFixed(3)));
    body.appendChild(mg);
    nav(body, function () { go(4); }, D.btn('btn-primary', '前往效果评估查看预算与效用', function () {
      setJob(w.jobId);
      App.go('dp', { sub: 'eval' });
    }));
  }

  /* ================= 数据与生命周期 ================= */

  function setJob(id) {
    jobId = id;
    D.setJob(ctx.projectId, id);
    renderJobSlot();
    tick();
  }

  async function reloadJobs() {
    jobs = await D.listJobs(ctx.projectId);
    renderJobSlot();
  }

  function renderJobSlot() {
    UI.clear(dom.jobSlot);
    if (!jobs.length) return;
    const f = D.jobField('dpfJobSel', jobs, jobId, function (v) { jobId = v; D.setJob(ctx.projectId, v); tick(); });
    dom.jobSlot.appendChild(f.wrap);
  }

  function tick() {
    const my = seq;
    return Promise.all([loadHooks(my), loadMetrics(my)]).catch(function (e) { if (my === seq) UI.fail(e); });
  }

  async function mount(c, sec) {
    ctx = c;
    const my = ++seq;
    clearInterval(timer);
    if (!root || root !== sec || !sec.childElementCount) skeleton(sec);
    try {
      const res = await Promise.all([D.listJobs(ctx.projectId), Api.get('/dp/providers')]);
      if (my !== seq) return;
      jobs = res[0]; providers = res[1];
      jobId = D.pickJob(ctx.projectId, jobs);
      renderJobSlot();
      renderProvider();
      renderWizard();
      await tick();
      // 训练推进时 hook 调用次数与指标逐轮变化，2 秒刷新一次
      timer = setInterval(async function () {
        const j = jobOf(jobId);
        if (!j) return;
        try {
          const fresh = await Api.get('/fl/jobs/' + jobId);
          if (my !== seq) return;
          const changed = fresh.status !== j.status || fresh.current_round !== j.current_round;
          Object.assign(j, fresh);
          if (changed) {
            tick();
            if (W().step === 5 && W().jobId === jobId) renderWizard();
          }
        } catch (e) { /* 忽略后台刷新失败 */ }
      }, 2000);
    } catch (e) { UI.fail(e); }
  }

  function unmount() {
    seq++;
    clearInterval(timer);
    timer = null;
  }

  window.DPF = { mount: mount, unmount: unmount };
})();
