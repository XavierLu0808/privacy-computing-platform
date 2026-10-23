/**
 * 差分隐私 · 隐私机制（window.DPM）。接口见 docs/api/dp.md。
 * 三个页签：机制与参数（DP-MECH-01/02）、自适应噪声（DP-MECH-03）、策略编排（DP-MECH-04）。
 * 训练任务的 DP 参数一律读写 GET/PUT /fl/jobs/{id}/dp，与「效果评估」页同源。
 */
(function () {
  'use strict';
  const D = window.DPC;
  const el = UI.el;
  const C = D.COLORS;
  const DELTAS = ['1e-4', '1e-5', '1e-6'];

  let ctx = null;
  let root = null;
  let jobs = [];
  let jobId = null;
  let cfg = null;
  let mechs = [];
  let datasets = [];
  let tab = 'param';
  let seq = 0;
  const panes = {};
  const tabBtns = {};

  /* ---------- 通用小件 ---------- */

  /** UI.selectOf / inputOf 会把 null 写成 id="null"，无 id 的控件去掉该属性。 */
  function noId(n, id) { if (!id) n.removeAttribute('id'); return n; }
  function sel(id, opts, value) { return noId(UI.selectOf(id, opts, value), id); }
  function inp(id, value, type) { return noId(UI.inputOf(id, value, type), id); }

  function jobOf(id) { return jobs.filter(function (j) { return j.job_id === id; })[0]; }
  function isRunning(j) { return j && (j.status === 'Running' || j.status === 'Paused'); }

  function deltaSelect(id, value) {
    return sel(id, DELTAS.map(function (d) { return { value: d, label: d }; }), value || '1e-5');
  }
  function accSelect(id, value) {
    return sel(id, [
      { value: 'basic', label: '基础组合（ε 逐轮累加）' },
      { value: 'advanced', label: '高级组合（Dwork–Rothblum–Vadhan）' },
      { value: 'rdp', label: 'RDP 会计（Moments Accountant）' }
    ], value || 'rdp');
  }
  function mechSeg(value, onChange) {
    return D.seg([{ value: 'gaussian', label: '高斯机制' }, { value: 'laplace', label: '拉普拉斯机制' }], value, onChange, '差分隐私机制');
  }
  function datasetSelect(id, value) {
    return sel(id, datasets.map(function (d) { return { value: d.dataset_id, label: d.name + '（' + d.party_name + '）' }; }), value);
  }
  function floatCols(dsId) {
    const ds = datasets.filter(function (d) { return d.dataset_id === dsId; })[0];
    return ds ? ds.columns.filter(function (c) { return c.type === 'float'; }) : [];
  }
  function columnSelect(id, dsId, value) {
    const cols = floatCols(dsId);
    const s = sel(id, cols.map(function (c) { return { value: c.name, label: c.name }; }));
    s.value = cols.some(function (c) { return c.name === value; }) ? value : (cols[0] ? cols[0].name : '');
    return s;
  }
  function querySelect(id, value) {
    return sel(id, [
      { value: 'mean', label: '全量均值（全部记录）' },
      { value: 'group_mean', label: '月度均价（每组 21 个交易日）' }
    ], value || 'mean');
  }
  /** 数据集变化时重建字段下拉。 */
  function linkColumns(dsSel, colSel, onChange) {
    dsSel.addEventListener('change', function () {
      const cols = floatCols(dsSel.value);
      UI.clear(colSel);
      cols.forEach(function (c) {
        const o = document.createElement('option');
        o.value = c.name; o.textContent = c.name;
        colSel.appendChild(o);
      });
      if (onChange) onChange();
    });
  }
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

  /* ================= 骨架 ================= */

  function skeleton(sec) {
    root = sec;
    UI.clear(sec);
    const head = el('div', 'page-head');
    const ht = el('div', 'page-head-text');
    ht.appendChild(el('span', 'crumb', '差分隐私 / 隐私机制'));
    ht.appendChild(el('h1', null, '差分隐私机制与策略编排'));
    head.appendChild(ht);
    const slot = el('div', 'field');
    slot.id = 'dpmJobSlot';
    head.appendChild(slot);
    head.appendChild(D.btn('btn-link', '查看效果评估', function () { App.go('dp', { sub: 'eval' }); }));
    sec.appendChild(head);

    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    [['param', '机制与参数'], ['adapt', '自适应噪声注入'], ['policy', '策略动态编排']].forEach(function (t) {
      const b = D.btn('tab', t[1], function () { showTab(t[0]); });
      b.setAttribute('role', 'tab');
      b.dataset.tab = t[0];
      tabBtns[t[0]] = b;
      tabs.appendChild(b);
      const p = el('div', 'dp-pane');
      p.setAttribute('role', 'tabpanel');
      panes[t[0]] = p;
    });
    sec.appendChild(tabs);
    ['param', 'adapt', 'policy'].forEach(function (k) { sec.appendChild(panes[k]); });
  }

  function showTab(t) {
    tab = t;
    Object.keys(panes).forEach(function (k) {
      panes[k].hidden = k !== t;
      tabBtns[k].className = 'tab' + (k === t ? ' on' : '');
      tabBtns[k].setAttribute('aria-selected', k === t ? 'true' : 'false');
    });
    render();
  }

  function render() {
    const my = seq;
    const fn = { param: renderParam, adapt: renderAdapt, policy: renderPolicy }[tab];
    Promise.resolve(fn(my)).catch(UI.fail);
  }

  /* ================= 页签 1：机制与参数 ================= */

  function renderParam(my) {
    const p = panes.param;
    UI.clear(p);
    p.appendChild(mechCatalog());
    const card = el('div', 'card card-lg');
    card.setAttribute('data-acc', 'DP-MECH-02');
    p.appendChild(card);
    let target = 'gradient';
    const body = el('div', 'dp-col');
    const tseg = D.seg([{ value: 'gradient', label: '梯度（联邦训练任务）' }, { value: 'query', label: '统计查询（数据集字段）' }], target, function (v) {
      target = v; fill();
    }, '作用对象');
    card.appendChild(D.cardHead('参数配置', '为所选机制配置核心参数并写入作用对象', [el('span', 'field-label', '作用对象'), tseg.el]));
    card.appendChild(body);
    function fill() {
      UI.clear(body);
      if (target === 'gradient') gradientForm(body, my);
      else queryForm(body, my).catch(UI.fail);
    }
    fill();
  }

  function mechCatalog() {
    const card = el('div', 'card card-lg');
    card.setAttribute('data-acc', 'DP-MECH-01');
    card.appendChild(D.cardHead('差分隐私机制', '平台内置 ' + mechs.length + ' 种机制，可在下方为训练任务或统计查询选用'));
    const row = el('div', 'dpm-mech-cards');
    mechs.forEach(function (m) {
      const c = el('div', 'dpm-mech-card' + (cfg && cfg.mechanism === m.mechanism ? ' on' : ''));
      const h = el('div', 'dp-card-head');
      h.appendChild(el('span', 'card-title', m.name));
      h.appendChild(el('span', 'tag tag-cls', m.guarantee));
      if (cfg && cfg.mechanism === m.mechanism) {
        h.appendChild(el('span', 'spacer'));
        h.appendChild(el('span', 'dp-enabled', '当前任务在用'));
      }
      c.appendChild(h);
      [['定义', m.definition], ['噪声分布', m.noise], ['敏感度', m.sensitivity]].forEach(function (kv) {
        const r = el('div', 'dpm-kv');
        r.appendChild(el('span', 'dpm-k', kv[0]));
        r.appendChild(el('span', 'dpm-v', kv[1]));
        c.appendChild(r);
      });
      const r = el('div', 'dpm-kv');
      r.appendChild(el('span', 'dpm-k', '适用场景'));
      const ul = el('ul', 'dpm-list');
      m.scenarios.forEach(function (s) { ul.appendChild(el('li', null, s)); });
      r.appendChild(ul);
      c.appendChild(r);
      const pr = el('div', 'dpm-kv');
      pr.appendChild(el('span', 'dpm-k', '核心参数'));
      pr.appendChild(el('span', 'dpm-v', m.params.map(function (x) {
        return x.name + (x.min !== undefined ? '（' + x.min + ' – ' + x.max + '）' : '');
      }).join('；')));
      c.appendChild(pr);
      row.appendChild(c);
    });
    card.appendChild(row);

    // 同方差（单位方差）下两种噪声密度对比
    const pts = function (f) { const a = []; for (let x = -4; x <= 4.0001; x += 0.1) a.push({ x: x, y: f(x) }); return a; };
    const wrap = el('div', 'dp-chart-wrap');
    wrap.appendChild(D.legend([
      { color: C.primary, label: '高斯 N(0, 1)' },
      { color: C.amber, label: '拉普拉斯 Lap(0, 1/√2)（同为单位方差）' }
    ]));
    wrap.appendChild(D.chart({
      w: 820, h: 170, xmin: -4, xmax: 4, ymin: 0, ymax: 0.75,
      xTicks: [-4, -3, -2, -1, 0, 1, 2, 3, 4], yTicks: [0, 0.25, 0.5, 0.75],
      xFmt: function (v) { return v.toFixed(0); }, yFmt: function (v) { return v.toFixed(2); },
      xLabel: '噪声取值（以标准差为单位）', yLabel: '概率密度', aria: '高斯与拉普拉斯噪声概率密度对比',
      series: [
        { color: C.primary, points: pts(function (x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }) },
        { color: C.amber, points: pts(function (x) { return Math.exp(-Math.SQRT2 * Math.abs(x)) / Math.SQRT2; }) }
      ]
    }));
    wrap.appendChild(el('span', 'hint', '同样方差下拉普拉斯噪声峰更尖、尾更厚：低维计数 / 求和查询用拉普拉斯可得到 δ = 0 的纯 ε-DP；高维梯度用高斯配合 RDP 会计，多轮累计 ε 更低。'));
    card.appendChild(wrap);
    return card;
  }

  function gradientForm(body, my) {
    const job = jobOf(jobId);
    if (!cfg || !job) { body.appendChild(el('div', 'table-empty', '当前项目没有训练任务')); return; }
    const note = el('div', 'banner-note');
    note.textContent = isRunning(job)
      ? '任务「' + job.name + '」' + D.STATUS_CN[job.status] + '，DP 配置只读：已消耗的预算不可回退，保存会被拒绝（错误码 40901）。'
      : '写入任务「' + job.name + '」（' + D.STATUS_CN[job.status] + '，共 ' + cfg.total_rounds + ' 轮）。下次启动训练时由训练引擎初始化 DP 并在梯度聚合前调用。' +
        (cfg.policy_id ? ' 当前参数来自策略 ' + cfg.policy_id + ' 的维度 ' + cfg.policy_dimension + '，手动修改后脱离策略。' : '');
    body.appendChild(note);

    const f = { mechanism: cfg.mechanism };
    const ms = mechSeg(cfg.mechanism, function (v) { f.mechanism = v; deltaRow.hidden = v !== 'gaussian'; preview(); });
    const eps = D.numInput('dpmEps', cfg.epsilon_total, 0.2, 10, 0.1);
    const delta = deltaSelect('dpmDelta', cfg.delta);
    const clip = D.numInput('dpmClip', cfg.clip_norm, 0.2, 4, 0.1);
    const cm = D.seg([{ value: 'fixed', label: '固定裁剪' }, { value: 'adaptive', label: '自适应裁剪' }], cfg.clip_mode || 'fixed', function () { preview(); }, '裁剪方式');
    const acc = accSelect('dpmAcc', cfg.accountant);
    const en = el('input');
    en.type = 'checkbox'; en.id = 'dpmEnabled'; en.checked = !!cfg.enabled;
    const enLb = el('label', 'check-item');
    enLb.appendChild(en);
    enLb.appendChild(document.createTextNode('对该任务启用差分隐私'));

    const g = el('div', 'form-3col');
    const mechRow = el('div', 'field-col');
    mechRow.appendChild(el('label', null, '机制'));
    mechRow.appendChild(ms.el);
    g.appendChild(mechRow);
    g.appendChild(UI.formRow('总隐私预算 ε（全部轮次累计）', eps, '0.2 – 10，越小隐私越强'));
    const deltaRow = UI.formRow('松弛参数 δ', delta, '仅高斯机制；建议小于 1 / 样本数');
    deltaRow.hidden = cfg.mechanism !== 'gaussian';
    g.appendChild(deltaRow);
    g.appendChild(UI.formRow('裁剪阈值 C（梯度 L2 敏感度）', clip, '0.2 – 4；单个样本梯度的 L2 范数上限'));
    const cmRow = el('div', 'field-col');
    cmRow.appendChild(el('label', null, '裁剪方式'));
    cmRow.appendChild(cm.el);
    cmRow.appendChild(el('span', 'hint', '自适应：每轮取上一轮样本梯度范数中位数作为 C'));
    g.appendChild(cmRow);
    g.appendChild(UI.formRow('预算会计方式', acc, '决定同一总 ε 下每轮可加多少噪声'));
    body.appendChild(g);
    body.appendChild(enLb);

    const box = el('div', 'dp-noise');
    box.appendChild(el('span', 'dp-noise-title', '按当前参数预估（未保存也会实时计算）'));
    const t1 = el('span', 'dp-noise-text', '—');
    const t2 = el('span', 'dp-noise-formula', '—');
    box.appendChild(t1);
    box.appendChild(t2);
    body.appendChild(box);

    const err = el('div', 'banner banner-err');
    err.hidden = true;
    body.appendChild(err);

    const actions = el('div', 'dp-actions');
    actions.appendChild(D.btn('btn-primary', '保存到任务', save));
    actions.appendChild(D.btn('btn', '恢复为已保存', function () { render(); }));
    body.appendChild(actions);

    function form() {
      return {
        enabled: en.checked, mechanism: f.mechanism, epsilon_total: Number(eps.value), clip_norm: Number(clip.value),
        delta: delta.value, accountant: acc.value, clip_mode: cm.get()
      };
    }
    const preview = UI.debounce(async function () {
      const b = form();
      if (!(b.epsilon_total > 0 && b.clip_norm > 0)) { t1.textContent = '请输入有效的 ε 与 C'; return; }
      try {
        const r = await Api.post('/dp/estimate', Object.assign({ total_rounds: cfg.total_rounds, baseline_job_id: jobId }, b));
        if (my !== seq) return;
        const g = b.mechanism === 'gaussian';
        t1.textContent = '每轮噪声 ' + (g ? 'σ' : 'b') + ' = ' + r.noise_scale.toFixed(3) + '（噪声倍数 z = ' + (g ? 'σ' : 'b') + ' / C = ' + r.noise_multiplier.toFixed(3) +
          '）；单轮机制 ε = ' + r.epsilon_per_round.toFixed(4) + '；' + cfg.total_rounds + ' 轮累计 ε = ' + r.curve[r.curve.length - 1].cumulative_epsilon.toFixed(3) +
          '，累计 δ = ' + D.fmtDelta(r.delta_total) + '；预估' + D.utilText(r).short;
        t2.textContent = b.accountant === 'basic' ? r.formula + '，ε_每轮 = ε_总 / 轮数'
          : D.ACC_CN[b.accountant] + '：二分求解噪声倍数 z，使 ' + cfg.total_rounds + ' 轮累计 ε 等于 ε_总；' + (g ? 'σ' : 'b') + ' = z · C';
      } catch (e) { t1.textContent = e.message; }
    }, 300);
    [eps, clip, delta, acc].forEach(function (x) { x.addEventListener('input', preview); x.addEventListener('change', preview); });
    preview();

    async function save() {
      err.hidden = true;
      try {
        cfg = await Api.put('/fl/jobs/' + jobId + '/dp', form());
        UI.toast('已写入任务「' + job.name + '」的 DP 配置');
        render();
      } catch (e) {
        err.textContent = (e.code === 40901 ? '保存被拒绝：' : '保存失败：') + e.message + (e.code ? '（错误码 ' + e.code + '）' : '');
        err.hidden = false;
        UI.fail(e);
      }
    }
  }

  async function queryForm(body, my) {
    const res = await Promise.all([
      Api.get('/projects/' + ctx.projectId + '/dp/query-config'),
      Api.get('/projects/' + ctx.projectId + '/dp/queries')
    ]);
    if (my !== seq) return;
    const qc = res[0];
    body.appendChild(el('div', 'banner-note', '统计查询按「裁剪 → 求均值 → 加噪」发布，原始记录与真实结果不出域；每次发布消耗一次单次查询 ε，项目内按基础组合累计。'));
    const f = { mechanism: qc.mechanism, clip_mode: qc.clip_mode };
    const ds = datasetSelect('dpmQDs', qc.dataset_id);
    const col = columnSelect('dpmQCol', ds.value, qc.column);
    linkColumns(ds, col);
    const qs = querySelect('dpmQType', qc.query);
    const ms = mechSeg(qc.mechanism, function (v) { f.mechanism = v; deltaRow.hidden = v !== 'gaussian'; });
    const eps = D.numInput('dpmQEps', qc.epsilon, 0.05, 10, 0.05);
    const delta = deltaSelect('dpmQDelta', qc.delta);
    const cm = D.seg([{ value: 'fixed', label: '固定（公开取值范围）' }, { value: 'adaptive', label: '自适应（分位数裁剪）' }], qc.clip_mode, function (v) { f.clip_mode = v; }, '裁剪方式');

    const g = el('div', 'form-3col');
    g.appendChild(UI.formRow('数据集', ds));
    g.appendChild(UI.formRow('字段', col));
    g.appendChild(UI.formRow('查询', qs));
    const mr = el('div', 'field-col');
    mr.appendChild(el('label', null, '机制'));
    mr.appendChild(ms.el);
    g.appendChild(mr);
    g.appendChild(UI.formRow('单次查询 ε', eps, '0.05 – 10'));
    const deltaRow = UI.formRow('松弛参数 δ', delta);
    deltaRow.hidden = qc.mechanism !== 'gaussian';
    g.appendChild(deltaRow);
    const cr = el('div', 'field-col');
    cr.appendChild(el('label', null, '裁剪方式（敏感度 Δ 来源）'));
    cr.appendChild(cm.el);
    g.appendChild(cr);
    body.appendChild(g);

    function form() {
      return { mechanism: f.mechanism, epsilon: Number(eps.value), delta: delta.value, dataset_id: ds.value, column: col.value, query: qs.value, clip_mode: f.clip_mode };
    }
    const actions = el('div', 'dp-actions');
    actions.appendChild(D.btn('btn-primary', '保存查询配置', async function () {
      try { await Api.put('/projects/' + ctx.projectId + '/dp/query-config', form()); UI.toast('统计查询 DP 配置已保存'); } catch (e) { UI.fail(e); }
    }));
    actions.appendChild(D.btn('btn', '执行一次加噪查询', async function () {
      try {
        const r = await Api.post('/projects/' + ctx.projectId + '/dp/query', form());
        UI.toast(r.label + '：加噪结果 ' + D.money(r.noisy_value) + ' ' + r.unit);
        await loadReleases();
      } catch (e) { UI.fail(e); }
    }));
    actions.appendChild(D.btn('btn-link', '查看敏感度与噪声对比', function () { showTab('adapt'); }));
    body.appendChild(actions);

    const list = el('div');
    body.appendChild(list);
    async function loadReleases(pre) {
      const r = pre || await Api.get('/projects/' + ctx.projectId + '/dp/queries');
      UI.clear(list);
      list.appendChild(el('span', 'section-label', '发布记录 · 共 ' + r.total + ' 次，项目统计查询累计 ε = ' + r.epsilon_spent_total.toFixed(3) + '（基础组合）'));
      list.appendChild(grid('dpm-rel-grid', ['时间', '字段 · 查询', '机制 · 单次 ε', '裁剪区间', '加噪结果', '预期误差 RMSE'], true));
      if (!r.items.length) { list.appendChild(el('div', 'table-empty', '尚未发布，点击「执行一次加噪查询」')); return; }
      r.items.slice(0, 8).forEach(function (x) {
        list.appendChild(grid('dpm-rel-grid', [
          UI.datetime(x.released_at), x.label + ' · ' + (x.query === 'mean' ? '全量均值' : '月度均价'),
          D.MECH_CN[x.mechanism] + ' · ε = ' + x.epsilon_spent.toFixed(3) + (x.policy_id ? '（策略 ' + x.policy_id + '）' : ''),
          D.money(x.clip_lower) + ' – ' + D.money(x.clip_upper) + ' ' + x.unit,
          D.money(x.noisy_value) + ' ' + x.unit, '± ' + D.money(x.expected_rmse) + ' ' + x.unit
        ]));
      });
    }
    await loadReleases(res[1]);
  }

  /* ================= 页签 2：自适应噪声 ================= */

  let adaptMode = 'field';
  function renderAdapt(my) {
    const p = panes.adapt;
    UI.clear(p);
    const card = el('div', 'card card-lg');
    card.setAttribute('data-acc', 'DP-MECH-03');
    const ms = D.seg([{ value: 'field', label: '数据集字段（统计查询）' }, { value: 'gradient', label: '训练梯度（联邦任务）' }], adaptMode, function (v) {
      adaptMode = v; renderAdapt(my);
    }, '分析对象');
    card.appendChild(D.cardHead('自适应噪声注入', '按数据分布特征（取值范围、分位数、敏感度）确定噪声尺度', [ms.el]));
    p.appendChild(card);
    if (adaptMode === 'field') adaptField(card, my);
    else adaptGradient(card, my).catch(UI.fail);
  }

  function adaptField(card, my) {
    const ds = datasetSelect('dpmADs', 'ds_' + ctx.projectId + '_ree_price');
    const col = columnSelect('dpmACol', ds.value, 'ceo2_price');
    const qs = querySelect('dpmAQ', 'group_mean');
    let mech = 'laplace';
    const ms = mechSeg(mech, function (v) { mech = v; deltaRow.hidden = v !== 'gaussian'; run(); });
    const eps = D.numInput('dpmAEps', 0.5, 0.05, 10, 0.05);
    const delta = deltaSelect('dpmADelta', '1e-5');
    const g = el('div', 'form-3col');
    g.appendChild(UI.formRow('数据集', ds));
    g.appendChild(UI.formRow('字段', col));
    g.appendChild(UI.formRow('查询', qs));
    const mr = el('div', 'field-col');
    mr.appendChild(el('label', null, '机制'));
    mr.appendChild(ms.el);
    g.appendChild(mr);
    g.appendChild(UI.formRow('单次查询 ε', eps, '0.05 – 10'));
    const deltaRow = UI.formRow('松弛参数 δ', delta);
    deltaRow.hidden = true;
    g.appendChild(deltaRow);
    card.appendChild(g);
    const out = el('div', 'dp-col');
    card.appendChild(out);

    const run = UI.debounce(async function () {
      try {
        const r = await Api.post('/dp/adaptive-noise', {
          target: 'field', dataset_id: ds.value, column: col.value, query: qs.value, mechanism: mech, epsilon: Number(eps.value), delta: delta.value
        });
        if (my !== seq) return;
        drawField(out, r);
      } catch (e) { UI.clear(out); out.appendChild(el('div', 'banner banner-err', e.message)); }
    }, 250);
    linkColumns(ds, col, run);
    [col, qs, eps, delta].forEach(function (x) { x.addEventListener('change', run); });
    run();
  }

  function drawField(out, r) {
    UI.clear(out);
    const u = ' ' + r.unit;
    const s = r.stats;
    const mg = el('div', 'metric-grid');
    mg.appendChild(metric('中位数', D.money(s.median) + u, '对数正态拟合，对数标准差 s = ' + s.log_sd));
    mg.appendChild(metric('均值', D.money(s.mean) + u, '共 ' + UI.rows(r.rows) + ' 条记录，每次查询覆盖 ' + r.group_size + ' 条'));
    mg.appendChild(metric('P5 – P95', D.money(s.p05) + ' – ' + D.money(s.p95), '单位' + u + '；P1 – P99：' + D.money(s.p01) + ' – ' + D.money(s.p99)));
    mg.appendChild(metric('公开取值范围', '0 – ' + D.money(s.public_upper), '单位' + u + '；业务规则给定，不看数据即可确定'));
    out.appendChild(mg);

    // 分布与裁剪区间
    const mu = Math.log(s.median), sd = s.log_sd;
    const xmax = Math.min(s.public_upper, s.p99 * 1.25);
    const pts = [];
    let peak = 0;
    for (let i = 1; i <= 120; i++) {
      const x = xmax * i / 120;
      const y = Math.exp(-Math.pow(Math.log(x) - mu, 2) / (2 * sd * sd)) / (x * sd * Math.sqrt(2 * Math.PI));
      peak = Math.max(peak, y);
      pts.push({ x: x, y: y });
    }
    pts.forEach(function (p) { p.y = p.y / peak; });
    const wrap = el('div', 'dp-chart-wrap');
    wrap.appendChild(D.legend([
      { color: C.primary, label: r.label + ' 分布（归一化密度）' },
      { color: C.teal, label: '自适应裁剪区间 P' + (r.adaptive.q_low * 100) + ' – P' + (r.adaptive.q_high * 100) },
      { color: C.amber, label: '固定裁剪上界（公开范围 ' + D.money(s.public_upper) + u + (s.public_upper > xmax ? '，在图右侧之外' : '') + '）' }
    ]));
    const markers = [
      { x: r.adaptive.lower, color: C.teal, label: 'P' + (r.adaptive.q_low * 100) },
      { x: r.adaptive.upper, color: C.teal, label: 'P' + (r.adaptive.q_high * 100) }
    ];
    if (s.public_upper <= xmax) markers.push({ x: s.public_upper, color: C.amber, label: '公开上界' });
    wrap.appendChild(D.chart({
      w: 820, h: 180, xmin: 0, xmax: xmax, ymin: 0, ymax: 1.05,
      xTicks: D.niceTicks(0, xmax, 5), yTicks: [0, 0.5, 1],
      xFmt: function (v) { return D.money(v); }, yFmt: function (v) { return v.toFixed(1); },
      xLabel: r.unit, aria: '字段取值分布与裁剪区间', series: [{ color: C.primary, points: pts }], markers: markers
    }));
    out.appendChild(wrap);

    // 固定 vs 自适应
    const g = r.mechanism === 'gaussian';
    out.appendChild(el('span', 'section-label', '固定裁剪 vs 自适应裁剪（' + (r.query === 'mean' ? '全量均值' : '月度均价') + '，' + D.MECH_CN[r.mechanism] + '，单次 ε = ' + r.epsilon + '）'));
    out.appendChild(grid('dpm-cmp-grid', ['方案', '裁剪区间' + u, '敏感度 Δ' + u, '加噪所用 ε', '噪声尺度 ' + (g ? 'σ' : 'b') + u, '噪声标准差' + u, '裁剪偏差' + u, 'RMSE' + u + '（相对误差）'], true));
    function row(name, x, cls) {
      const n = el('span', 'cell-strong', name);
      const rr = grid('dpm-cmp-grid', [n, D.money(x.lower) + ' – ' + D.money(x.upper), x.sensitivity.toFixed(2), x.epsilon_used.toFixed(3),
        D.money(x.noise_scale), D.money(x.noise_std), D.money(x.bias), D.money(x.rmse) + '（' + x.rel_error_pct.toFixed(2) + '%）']);
      if (cls) rr.classList.add(cls);
      return rr;
    }
    out.appendChild(row('固定裁剪（公开取值范围）', r.fixed, r.recommended === 'fixed' ? 'current' : null));
    out.appendChild(row('自适应裁剪 P' + (r.adaptive.q_low * 100) + ' – P' + (r.adaptive.q_high * 100), r.adaptive, r.recommended === 'adaptive' ? 'current' : null));
    r.candidates.filter(function (c) { return c.q_low !== r.adaptive.q_low; }).forEach(function (c) {
      const rr = row('候选 P' + (c.q_low * 100) + ' – P' + (c.q_high * 100), c);
      rr.classList.add('dp-row-dim');
      out.appendChild(rr);
    });
    const ban = el('div', r.recommended === 'adaptive' ? 'banner banner-ok' : 'banner-note');
    ban.textContent = r.recommended === 'adaptive'
      ? '推荐自适应裁剪：按 RMSE 最小选出 P' + (r.adaptive.q_low * 100) + ' – P' + (r.adaptive.q_high * 100) + '，噪声标准差降低 ' + r.noise_reduction_pct.toFixed(1) +
        '%，总误差 RMSE 降低 ' + r.rmse_reduction_pct.toFixed(1) + '%。其中 ' + (QS * 100) + '% 预算（ε = ' + r.adaptive.epsilon_quantile + '）用于差分隐私分位数估计。'
      : '推荐固定裁剪：该查询覆盖 ' + r.group_size + ' 条记录，敏感度已很小，自适应裁剪引入的裁剪偏差（' + D.money(r.adaptive.bias) + u + '）大于它节省的噪声。';
    out.appendChild(ban);
    out.appendChild(el('span', 'hint', '敏感度 Δ = (裁剪上界 − 裁剪下界) / 每次查询覆盖的记录数；拉普拉斯 b = Δ / ε，噪声标准差 √2·b；高斯 σ = Δ·√(2 ln(1.25/δ)) / ε；RMSE = √(噪声方差 + 裁剪偏差²)。'));
    const act = el('div', 'dp-actions');
    act.appendChild(D.btn('btn-primary', '用作统计查询配置', async function () {
      try {
        await Api.put('/projects/' + ctx.projectId + '/dp/query-config', {
          mechanism: r.mechanism, epsilon: r.epsilon, delta: r.delta || '1e-5', dataset_id: r.dataset_id, column: r.column, query: r.query, clip_mode: r.recommended
        });
        UI.toast('已保存为统计查询配置（' + (r.recommended === 'adaptive' ? '自适应裁剪' : '固定裁剪') + '）');
      } catch (e) { UI.fail(e); }
    }));
    out.appendChild(act);
  }
  const QS = 0.1;

  async function adaptGradient(card, my) {
    const job = jobOf(jobId);
    if (!job) { card.appendChild(el('div', 'table-empty', '当前项目没有训练任务')); return; }
    const r = await Api.post('/dp/adaptive-noise', { target: 'gradient', job_id: jobId });
    if (my !== seq) return;
    card.appendChild(el('div', 'banner-note', '任务「' + job.name + '」：样本梯度的 L2 范数随训练下降。固定裁剪基准 C = ' + r.fixed_clip_norm +
      (r.clip_mode === 'adaptive' ? '（启用自适应前的固定 C）' : '') + '，自适应初始 C = ' + r.initial_clip_norm +
      '；自适应裁剪每轮把 C 设为上一轮样本梯度范数的中位数（目标分位 0.5，Andrew 等 2021），噪声 σ = z · C 随之下降，z = ' + r.noise_multiplier.toFixed(3) + '（' + D.ACC_CN[r.accountant] + '）。'));
    const mg = el('div', 'metric-grid');
    mg.appendChild(metric('平均裁剪比例 · 固定', D.pct(r.summary.clip_ratio_fixed_avg), '被裁剪的样本梯度占比，越高偏差越大'));
    mg.appendChild(metric('平均裁剪比例 · 自适应', D.pct(r.summary.clip_ratio_adaptive_avg), '稳定在目标分位 50% 附近'));
    mg.appendChild(metric('平均每轮噪声 σ', r.summary.noise_fixed_avg.toFixed(2) + ' → ' + r.summary.noise_adaptive_avg.toFixed(2), '固定 → 自适应，按 ' + r.series.length + ' 轮平均'));
    const red = r.summary.noise_reduction_pct;
    mg.appendChild(red >= 0
      ? metric('噪声降低', red.toFixed(1) + '%', '相同 ε 下自适应裁剪注入的噪声总量更少')
      : metric('噪声增加', (-red).toFixed(1) + '%', '自适应 C（样本梯度范数中位数）高于固定 C = ' + r.fixed_clip_norm + '，本配置下自适应不占优，建议保持固定裁剪'));
    card.appendChild(mg);
    const T = r.series.length;
    const maxC = Math.max(cfg.clip_norm, r.series[0].update_norm_median) * 1.15;
    const w1 = el('div', 'dp-chart-wrap');
    w1.appendChild(D.legend([
      { color: C.primary, label: '样本梯度范数中位数' }, { color: C.amber, label: '固定 C' }, { color: C.teal, label: '自适应 C' }
    ]));
    w1.appendChild(D.chart({
      w: 820, h: 180, xmin: 1, xmax: T, ymin: 0, ymax: maxC, xTicks: D.ticks(1, T, Math.min(6, T - 1)).map(Math.round), yTicks: D.niceTicks(0, maxC, 4),
      yFmt: function (v) { return v.toFixed(2); }, xLabel: '轮次', yLabel: 'L2 范数', aria: '每轮样本梯度范数与裁剪阈值',
      series: [
        { color: C.primary, points: r.series.map(function (x) { return { x: x.round, y: x.update_norm_median }; }) },
        { color: C.amber, dash: '5 4', points: r.series.map(function (x) { return { x: x.round, y: x.clip_fixed }; }) },
        { color: C.teal, points: r.series.map(function (x) { return { x: x.round, y: x.clip_adaptive }; }) }
      ]
    }));
    card.appendChild(w1);
    const w2 = el('div', 'dp-chart-wrap');
    w2.appendChild(D.legend([{ color: C.amber, label: '固定裁剪 · 被裁剪样本梯度占比' }, { color: C.teal, label: '自适应裁剪 · 被裁剪样本梯度占比' }]));
    w2.appendChild(D.chart({
      w: 820, h: 150, xmin: 1, xmax: T, ymin: 0, ymax: 1, xTicks: D.ticks(1, T, Math.min(6, T - 1)).map(Math.round), yTicks: [0, 0.25, 0.5, 0.75, 1],
      yFmt: function (v) { return (v * 100).toFixed(0) + '%'; }, xLabel: '轮次', aria: '每轮裁剪比例',
      series: [
        { color: C.amber, points: r.series.map(function (x) { return { x: x.round, y: x.clip_ratio_fixed }; }) },
        { color: C.teal, points: r.series.map(function (x) { return { x: x.round, y: x.clip_ratio_adaptive }; }) }
      ]
    }));
    card.appendChild(w2);
    const act = el('div', 'dp-actions');
    const b = D.btn('btn-primary', '对任务启用自适应裁剪（初始 C = ' + r.recommended_clip_norm.toFixed(1) + '）', async function () {
      try {
        cfg = await Api.put('/fl/jobs/' + jobId + '/dp', {
          enabled: cfg.enabled, mechanism: cfg.mechanism, epsilon_total: cfg.epsilon_total, clip_norm: r.recommended_clip_norm,
          delta: cfg.delta, accountant: cfg.accountant, clip_mode: 'adaptive'
        });
        UI.toast('任务「' + job.name + '」已改为自适应裁剪');
        render();
      } catch (e) { UI.fail(e); }
    });
    act.appendChild(b);
    if (cfg.clip_mode === 'adaptive') act.appendChild(el('span', 'dp-enabled', '该任务已启用自适应裁剪'));
    card.appendChild(act);
  }

  /* ================= 页签 3：策略编排 ================= */

  async function renderPolicy(my) {
    const p = panes.policy;
    UI.clear(p);
    p.appendChild(composeCard(my));
    p.appendChild(policyForm(my));
    const listCard = el('div', 'card card-lg');
    listCard.setAttribute('data-acc', 'DP-MECH-04');
    p.appendChild(listCard);
    await loadPolicies(listCard, my);
  }

  function composeCard(my) {
    const card = el('div', 'card card-lg');
    card.setAttribute('data-acc', 'DP-MECH-04');
    card.appendChild(D.cardHead('组合定理对比', '同一单步机制重复 T 次（多轮训练 / 多次查询），三种会计方式给出的累计 ε'));
    const T0 = cfg ? cfg.total_rounds : 30;
    const e0 = cfg ? Math.round(cfg.epsilon_total / T0 * 10000) / 10000 : 0.1;
    let mech = cfg ? cfg.mechanism : 'gaussian';
    const ms = mechSeg(mech, function (v) { mech = v; run(); });
    const eps0 = D.numInput('dpmCEps', e0, 0.001, 5, 0.001);
    const delta = deltaSelect('dpmCDelta', cfg ? cfg.delta : '1e-5');
    const T = D.numInput('dpmCT', T0, 1, 1000, 1);
    const g = el('div', 'form-4col');
    const mr = el('div', 'field-col');
    mr.appendChild(el('label', null, '单步机制'));
    mr.appendChild(ms.el);
    g.appendChild(mr);
    g.appendChild(UI.formRow('单步 ε₀', eps0, '默认 = 当前任务 ε_总 / 轮数'));
    g.appendChild(UI.formRow('δ（单步 / 转换用）', delta));
    g.appendChild(UI.formRow('步数 T', T, '1 – 1000'));
    card.appendChild(g);
    const out = el('div', 'dp-col');
    card.appendChild(out);
    const f = el('div', 'dpm-formula');
    [
      '基础组合：ε_总 = T · ε₀；高斯时 δ_总 = T · δ（拉普拉斯 δ_总 = 0）。',
      '高级组合（Dwork–Rothblum–Vadhan 2010）：ε_总 = ε₀ · √(2T · ln(1/δ′)) + T · ε₀ · (e^ε₀ − 1)，δ_总 = T · δ + δ′；平台取 δ′ = δ，结果劣于基础组合时取基础组合。',
      'RDP 会计（Mironov 2017，Moments Accountant 的 Rényi 形式）：高斯单步 ε(α) = α / (2z²)，z = σ / Δ = √(2 ln(1.25/δ)) / ε₀；拉普拉斯单步 ε(α) = 1/(α−1) · ln[α/(2α−1) · e^((α−1)/λ) + (α−1)/(2α−1) · e^(−α/λ)]，λ = b / Δ = 1/ε₀。T 步后 ε_总 = min_α [T · ε(α) + ln(1/δ) / (α−1)]，α 在 1.25 – 256 共 22 档中取最优；δ_总 = δ。未计入子采样放大。'
    ].forEach(function (t) { f.appendChild(el('div', null, t)); });
    card.appendChild(f);

    const run = UI.debounce(async function () {
      try {
        const r = await Api.post('/dp/compose', { mechanism: mech, epsilon_per_step: Number(eps0.value), delta: delta.value, rounds: Math.round(Number(T.value)) });
        if (my !== seq) return;
        UI.clear(out);
        const mg = el('div', 'metric-grid-3');
        [['basic', C.amber], ['advanced', C.primary], ['rdp', C.teal]].forEach(function (a) {
          const x = r.results[a[0]];
          mg.appendChild(metric(D.ACC_CN[a[0]] + ' · ' + r.rounds + ' 步累计 ε', x.epsilon.toFixed(3),
            '累计 δ = ' + D.fmtDelta(x.delta_total) + (a[0] === 'rdp' ? '，最优阶 α = ' + x.alpha : '') +
            (a[0] !== 'basic' ? '；为基础组合的 ' + (x.epsilon / r.results.basic.epsilon * 100).toFixed(1) + '%' : '')));
        });
        out.appendChild(mg);
        const ymax = Math.max(r.results.basic.epsilon, 0.01) * 1.08;
        const wrap = el('div', 'dp-chart-wrap');
        wrap.appendChild(D.legend([{ color: C.amber, label: '基础组合' }, { color: C.primary, label: '高级组合' }, { color: C.teal, label: 'RDP 会计' }]));
        const xs = r.curve.map(function (c) { return c.t; });
        wrap.appendChild(D.chart({
          w: 820, h: 190, xmin: 1, xmax: r.rounds, ymin: 0, ymax: ymax,
          xTicks: D.ticks(1, r.rounds, Math.min(6, Math.max(1, r.rounds - 1))).map(Math.round), yTicks: D.niceTicks(0, ymax, 4),
          yFmt: function (v) { return v.toFixed(2); }, xLabel: '步数 t', yLabel: '累计 ε', aria: '三种会计方式累计 ε 随步数变化',
          series: ['basic', 'advanced', 'rdp'].map(function (k2, i) {
            return { color: [C.amber, C.primary, C.teal][i], points: r.curve.map(function (c, j) { return { x: xs[j], y: c[k2] }; }) };
          })
        }));
        out.appendChild(wrap);
        out.appendChild(el('span', 'hint', '单步噪声倍数 ' + (mech === 'gaussian' ? 'z = σ/Δ' : 'λ = b/Δ') + ' = ' + r.noise_multiplier.toFixed(3) + '。同样的噪声，RDP 给出的累计 ε 最紧；反过来，同样的总预算下 RDP 允许每轮加更少的噪声。'));
      } catch (e) { UI.clear(out); out.appendChild(el('div', 'banner banner-err', e.message + (e.code ? '（错误码 ' + e.code + '）' : ''))); }
    }, 250);
    [eps0, delta, T].forEach(function (x) { x.addEventListener('change', run); x.addEventListener('input', run); });
    run();
    return card;
  }

  function policyForm(my) {
    const card = el('div', 'card card-lg');
    card.setAttribute('data-acc', 'DP-MECH-04');
    card.appendChild(D.cardHead('新建 DP 策略', '把总预算按权重分到多个分析维度（训练任务 / 字段查询），按所选会计方式反解每步噪声'));
    const name = inp('dpmPName', '稀土价格多维分析 · ' + new Date().toISOString().slice(5, 10));
    const tot = D.numInput('dpmPEps', 4, 0.2, 50, 0.1);
    const delta = deltaSelect('dpmPDelta', '1e-5');
    let mech = 'gaussian';
    const ms = mechSeg(mech, function (v) { mech = v; });
    const acc = accSelect('dpmPAcc', 'rdp');
    const g = el('div', 'form-3col');
    g.appendChild(UI.formRow('策略名称', name));
    g.appendChild(UI.formRow('策略总预算 ε（各维度之和）', tot, '0.2 – 50，各维度按顺序组合相加'));
    g.appendChild(UI.formRow('δ（每个维度）', delta));
    const mr = el('div', 'field-col');
    mr.appendChild(el('label', null, '机制'));
    mr.appendChild(ms.el);
    g.appendChild(mr);
    g.appendChild(UI.formRow('会计方式（维度内多步组合）', acc));
    card.appendChild(g);

    const dimsWrap = el('div', 'dp-col');
    card.appendChild(el('span', 'section-label', '分析维度'));
    card.appendChild(grid('dpm-dim-grid', ['名称', '类型', '绑定对象', '权重', '步数', '裁剪阈值 C', '分到的 ε', ''], true));
    card.appendChild(dimsWrap);
    const dsId = 'ds_' + ctx.projectId + '_ree_price';
    const rows = [];
    const startJob = jobs.filter(function (j) { return !isRunning(j); })[0] || jobOf(jobId);
    function addRow(d) {
      const r = { kind: d.kind };
      const line = el('div', 'table-row dpm-dim-grid');
      r.label = inp(null, d.label);
      r.label.setAttribute('aria-label', '维度名称');
      const kind = sel(null, [{ value: 'training', label: '训练任务' }, { value: 'query', label: '字段查询' }], d.kind);
      kind.className = 'select select-sm';
      kind.setAttribute('aria-label', '维度类型');
      const bind = el('div', 'dpm-bind');
      r.weight = D.numInput(null, d.weight, 0.1, 100, 0.5);
      r.weight.setAttribute('aria-label', '权重');
      r.steps = D.numInput(null, d.steps || 12, 1, 1000, 1);
      r.steps.setAttribute('aria-label', '步数');
      r.clip = D.numInput(null, d.clip || 1, 0.2, 4, 0.1);
      r.clip.setAttribute('aria-label', '裁剪阈值 C');
      r.share = el('span', 'cell-muted', '—');
      const del = D.btn('btn-sm', '删除', function () { rows.splice(rows.indexOf(r), 1); line.remove(); shares(); });
      function fillBind() {
        UI.clear(bind);
        r.kind = kind.value;
        if (r.kind === 'training') {
          r.job = sel(null, jobs.map(function (j) { return { value: j.job_id, label: j.name + '（' + j.total_rounds + ' 轮）' }; }), d.job_id || (startJob && startJob.job_id));
          r.job.className = 'select select-sm';
          r.job.setAttribute('aria-label', '绑定训练任务');
          r.job.addEventListener('change', syncSteps);
          bind.appendChild(r.job);
          r.steps.disabled = true;
          r.clip.disabled = false;
          syncSteps();
        } else {
          r.ds = datasetSelect(null, d.dataset_id || dsId);
          r.ds.className = 'select select-sm';
          r.ds.setAttribute('aria-label', '数据集');
          r.col = columnSelect(null, r.ds.value, d.column || 'nd2o3_price');
          r.col.className = 'select select-sm';
          r.col.setAttribute('aria-label', '字段');
          linkColumns(r.ds, r.col);
          r.q = querySelect(null, d.query || 'mean');
          r.q.className = 'select select-sm';
          r.q.setAttribute('aria-label', '查询');
          bind.appendChild(r.ds); bind.appendChild(r.col); bind.appendChild(r.q);
          r.steps.disabled = false;
          r.clip.disabled = true;
        }
      }
      function syncSteps() { const j = jobOf(r.job.value); if (j) r.steps.value = j.total_rounds; }
      kind.addEventListener('change', fillBind);
      r.weight.addEventListener('input', shares);
      fillBind();
      [r.label, kind, bind, r.weight, r.steps, r.clip, r.share, del].forEach(function (n) { line.appendChild(n); });
      dimsWrap.appendChild(line);
      rows.push(r);
      shares();
    }
    function shares() {
      const W = rows.reduce(function (s, r) { return s + (Number(r.weight.value) || 0); }, 0) || 1;
      rows.forEach(function (r) {
        const sh = (Number(r.weight.value) || 0) / W;
        r.share.textContent = D.pct(sh) + ' · ε = ' + (Number(tot.value) * sh).toFixed(3);
      });
    }
    tot.addEventListener('input', shares);
    addRow({ label: '联合训练', kind: 'training', weight: 3, clip: cfg ? cfg.clip_norm : 1 });
    addRow({ label: 'Nd₂O₃ 全量均价', kind: 'query', weight: 1, steps: 12, dataset_id: dsId, column: 'nd2o3_price', query: 'mean' });
    addRow({ label: 'CeO₂ 月度均价', kind: 'query', weight: 1, steps: 12, dataset_id: dsId, column: 'ceo2_price', query: 'group_mean' });

    const err = el('div', 'banner banner-err');
    err.hidden = true;
    const act = el('div', 'dp-actions');
    act.appendChild(D.btn('btn-sm', '添加维度', function () { addRow({ label: '维度 ' + (rows.length + 1), kind: 'query', weight: 1, steps: 10 }); }));
    act.appendChild(el('span', 'spacer'));
    act.appendChild(D.btn('btn-primary', '生成策略', async function () {
      err.hidden = true;
      try {
        const body = {
          name: name.value.trim(), epsilon_total: Number(tot.value), delta: delta.value, mechanism: mech, accountant: acc.value,
          dimensions: rows.map(function (r, i) {
            const d = { key: 'd' + (i + 1), label: r.label.value.trim(), kind: r.kind, weight: Number(r.weight.value) };
            if (r.kind === 'training') { d.job_id = r.job.value; d.sensitivity = Number(r.clip.value); }
            else { d.dataset_id = r.ds.value; d.column = r.col.value; d.query = r.q.value; d.steps = Math.round(Number(r.steps.value)); d.clip_mode = 'adaptive'; }
            return d;
          })
        };
        const pol = await Api.post('/projects/' + ctx.projectId + '/dp/policies', body);
        UI.toast('已生成策略「' + pol.name + '」，可在下方下发到训练任务');
        name.value = name.value.replace(/( · \d+)?$/, ' · ' + Math.floor(Math.random() * 90 + 10));
        const listCard = panes.policy.querySelector('.dpm-policy-list');
        if (listCard) await loadPolicies(listCard.parentNode, my);
      } catch (e) {
        err.textContent = e.message + (e.code ? '（错误码 ' + e.code + '）' : '');
        err.hidden = false;
      }
    }));
    card.appendChild(act);
    card.appendChild(err);
    return card;
  }

  async function loadPolicies(card, my) {
    const res = await Api.get('/projects/' + ctx.projectId + '/dp/policies');
    if (my !== seq) return;
    UI.clear(card);
    card.appendChild(D.cardHead('已编排策略', '共 ' + res.total + ' 个；训练维度可一键下发到绑定任务，查询维度按次发布并扣减次数'));
    const list = el('div', 'dpm-policy-list dp-col');
    card.appendChild(list);
    if (!res.items.length) { list.appendChild(el('div', 'table-empty', '尚未生成策略')); return; }
    res.items.forEach(function (pol) {
      const box = el('div', 'dpm-policy');
      const h = el('div', 'dp-card-head');
      h.appendChild(el('span', 'cell-strong', pol.name));
      h.appendChild(el('span', 'tag', pol.policy_id));
      h.appendChild(el('span', 'tag tag-cls', D.MECH_CN[pol.mechanism] + ' · ' + D.ACC_CN[pol.accountant]));
      h.appendChild(el('span', 'hint', '总预算 ε = ' + pol.epsilon_total.toFixed(2) + '（各维度相加），累计 δ = ' + D.fmtDelta(pol.delta_total) +
        (pol.applied_at ? '；' + UI.datetime(pol.applied_at) + ' 已下发 ' + pol.applied.length + ' 个任务' : '；未下发')));
      h.appendChild(el('span', 'spacer'));
      h.appendChild(D.btn('btn-primary', '下发到训练任务', async function () {
        try {
          const r = await Api.post('/dp/policies/' + pol.policy_id + '/apply', {});
          UI.toast('已下发：' + r.applied.map(function (a) { return a.job_name + '（ε = ' + a.epsilon_total.toFixed(3) + '）'; }).join('、'));
          await refreshCfg();
          await loadPolicies(card, seq);
        } catch (e) { UI.fail(e); }
      }));
      box.appendChild(h);
      box.appendChild(grid('dpm-pol-grid', ['维度', '绑定对象', '权重占比', '分到的 ε', '步数', '每步噪声倍数 z（基础 / 高级 / RDP）', '状态'], true));
      pol.dimensions.forEach(function (d) {
        const nb = d.noise_by_accountant;
        let state;
        if (d.kind === 'training') {
          const done = pol.applied.some(function (a) { return a.dimension_key === d.key; });
          state = el('span', done ? 'st-ready' : 'cell-muted', done ? '已下发' : '待下发');
        } else {
          state = D.btn('btn-sm', '发布一次（' + d.steps_used + ' / ' + d.steps + '）', async function () {
            try {
              const r = await Api.post('/projects/' + ctx.projectId + '/dp/query', { policy_id: pol.policy_id, dimension_key: d.key });
              UI.toast(d.label + '：加噪结果 ' + D.money(r.noisy_value) + ' ' + r.unit + '（单次 ε = ' + r.epsilon_spent.toFixed(4) + '，剩余 ' + (r.steps - r.steps_used) + ' 次）');
              await loadPolicies(card, seq);
            } catch (e) { UI.fail(e); }
          });
        }
        box.appendChild(grid('dpm-pol-grid', [
          el('span', 'cell-strong', d.label),
          d.kind === 'training' ? '训练 · ' + d.job_name + '，C = ' + d.sensitivity : '查询 · ' + d.column + '（' + (d.query === 'mean' ? '全量均值' : '月度均价') + '）',
          d.share_pct.toFixed(1) + '%', d.epsilon.toFixed(3), d.steps + (d.kind === 'training' ? ' 轮' : ' 次'),
          nb.basic.noise_multiplier.toFixed(2) + ' / ' + nb.advanced.noise_multiplier.toFixed(2) + ' / ' + nb.rdp.noise_multiplier.toFixed(2),
          state
        ]));
      });
      list.appendChild(box);
    });
  }

  async function refreshCfg() {
    jobs = await D.listJobs(ctx.projectId);
    if (jobId) cfg = await Api.get('/fl/jobs/' + jobId + '/dp');
  }

  /* ================= 生命周期 ================= */

  function renderJobSlot() {
    const slot = UI.$('dpmJobSlot');
    UI.clear(slot);
    if (!jobs.length) return;
    const f = D.jobField('dpmJobSel', jobs, jobId, async function (v) {
      jobId = v;
      D.setJob(ctx.projectId, v);
      try { cfg = await Api.get('/fl/jobs/' + v + '/dp'); render(); } catch (e) { UI.fail(e); }
    });
    slot.appendChild(f.wrap);
  }

  async function mount(c, sec) {
    ctx = c;
    const my = ++seq;
    if (!root || root !== sec || !sec.childElementCount) skeleton(sec);
    try {
      const res = await Promise.all([
        D.listJobs(ctx.projectId),
        mechs.length ? Promise.resolve({ items: mechs }) : Api.get('/dp/mechanisms'),
        Api.get('/projects/' + ctx.projectId + '/datasets', { status: 'ready' })
      ]);
      if (my !== seq) return;
      jobs = res[0]; mechs = res[1].items; datasets = res[2].items;
      jobId = D.pickJob(ctx.projectId, jobs);
      cfg = jobId ? await Api.get('/fl/jobs/' + jobId + '/dp') : null;
      if (my !== seq) return;
      renderJobSlot();
      showTab(tab);
    } catch (e) { UI.fail(e); }
  }

  function unmount() { seq++; }

  window.DPM = { mount: mount, unmount: unmount };
})();
