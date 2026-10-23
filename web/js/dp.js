/**
 * 差分隐私 · 效果评估（window.DP）+ 三个 DP 页面共用的工具（window.DPC）。接口见 API.md §6、docs/api/dp.md。
 * DP 配置挂在联邦训练任务上；三个页面共用同一个「当前任务」（按项目记忆），数据都以后端 GET /fl/jobs/{id}/dp 为准。
 */
(function () {
  'use strict';
  const $ = UI.$;

  /* ================= 共用工具 DPC ================= */

  const MECH_CN = { gaussian: '高斯机制', laplace: '拉普拉斯机制' };
  const ACC_CN = { basic: '基础组合', advanced: '高级组合', rdp: 'RDP 会计' };
  const STATUS_CN = { Created: '待启动', Running: '训练中', Paused: '已暂停', Success: '已完成', Failed: '失败', Terminated: '已终止' };
  const COLORS = { primary: 'var(--primary)', amber: 'var(--amber)', teal: 'var(--teal)', danger: 'var(--danger)', muted: 'var(--muted-2)' };
  const picked = {};   // projectId -> jobId

  async function listJobs(projectId) {
    return (await Api.get('/projects/' + projectId + '/fl/jobs')).items;
  }

  /** 三个页面共用的任务选择：先用本模块记住的，再用联邦学习页当前任务，最后取最新任务。 */
  function pickJob(projectId, jobs) {
    const has = function (id) { return id && jobs.some(function (j) { return j.job_id === id; }); };
    if (has(picked[projectId])) return picked[projectId];
    const fl = window.FL && window.FL.currentJobId();
    if (has(fl)) return (picked[projectId] = fl);
    return (picked[projectId] = jobs.length ? jobs[0].job_id : null);
  }
  function setJob(projectId, jobId) { picked[projectId] = jobId; }

  function jobSelect(id, jobs, value, onChange) {
    const s = UI.selectOf(id, jobs.map(function (j) {
      return { value: j.job_id, label: j.name + ' · ' + (STATUS_CN[j.status] || j.status) };
    }), value);
    s.className = 'select dp-job-select';
    s.setAttribute('aria-label', '训练任务');
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  /** 顶部工具条：「训练任务」下拉。返回 select。 */
  function jobField(id, jobs, value, onChange) {
    const f = UI.el('div', 'field');
    const lb = UI.el('label', 'field-label', '训练任务');
    lb.htmlFor = id;
    f.appendChild(lb);
    const s = jobSelect(id, jobs, value, onChange);
    f.appendChild(s);
    return { wrap: f, select: s };
  }

  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  function fmtDelta(d) {
    if (d === null || d === undefined) return '—';
    if (d === 0) return '0';
    const e = Math.floor(Math.log10(d));
    const m = d / Math.pow(10, e);
    const sup = String(e).split('').map(function (ch) { return SUP[ch]; }).join('');
    return (Math.abs(m - 1) < 1e-9 ? '' : m.toFixed(1) + ' × ') + '10' + sup;
  }
  function pct(v, n) { return (v * 100).toFixed(n === undefined ? 1 : n) + '%'; }
  function money(v) { return Math.round(v).toLocaleString('zh-CN'); }

  /**
   * 轻量 SVG 折线 / 柱图。opts = { w, h, xmin, xmax, ymin, ymax, xTicks, yTicks, xFmt, yFmt, xLabel, yLabel,
   *   series: [{ color, points:[{x,y}], dash, width }], bars: [{ x0, x1, y, color }], markers: [{ x, color, label }], aria }
   */
  function chart(opts) {
    const W = opts.w || 760, H = opts.h || 220, PL = opts.pl || 56, PR = opts.pr || 16, PB = opts.pb || 38;
    const PT = opts.pt || (opts.yLabel ? 26 : 14);
    const X = function (x) { return PL + (x - opts.xmin) / ((opts.xmax - opts.xmin) || 1) * (W - PL - PR); };
    const Y = function (y) {
      const v = Math.max(opts.ymin, Math.min(opts.ymax, y));
      return PT + (1 - (v - opts.ymin) / ((opts.ymax - opts.ymin) || 1)) * (H - PT - PB);
    };
    const svg = UI.svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': opts.aria || '' });
    svg.classList.add('dp-chart');
    const xf = opts.xFmt || String, yf = opts.yFmt || String;
    (opts.yTicks || []).forEach(function (t) {
      svg.appendChild(UI.svgEl('line', { x1: PL, x2: W - PR, y1: Y(t), y2: Y(t), class: 'dp-grid' }));
      const tx = UI.svgEl('text', { x: PL - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'dp-tick' });
      tx.textContent = yf(t);
      svg.appendChild(tx);
    });
    svg.appendChild(UI.svgEl('line', { x1: PL, x2: W - PR, y1: H - PB, y2: H - PB, class: 'dp-axis' }));
    (opts.xTicks || []).forEach(function (t) {
      const tx = UI.svgEl('text', { x: X(t), y: H - PB + 15, 'text-anchor': 'middle', class: 'dp-tick' });
      tx.textContent = xf(t);
      svg.appendChild(tx);
    });
    if (opts.xLabel) {
      const tx = UI.svgEl('text', { x: W - PR, y: H - 4, 'text-anchor': 'end', class: 'dp-tick' });
      tx.textContent = opts.xLabel;
      svg.appendChild(tx);
    }
    if (opts.yLabel) {
      const tx = UI.svgEl('text', { x: 4, y: 11, class: 'dp-tick' });
      tx.textContent = opts.yLabel;
      svg.appendChild(tx);
    }
    (opts.bars || []).forEach(function (b) {
      const x0 = X(b.x0), x1 = X(b.x1);
      const r = UI.svgEl('rect', { x: x0 + 1, width: Math.max(1, x1 - x0 - 2), y: Y(b.y), height: Math.max(0, H - PB - Y(b.y)) });
      r.style.fill = b.color || 'var(--primary-lt)';
      svg.appendChild(r);
    });
    (opts.series || []).forEach(function (s) {
      if (!s.points.length) return;
      const pl = UI.svgEl('polyline', {
        points: s.points.map(function (p) { return X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' '),
        fill: 'none', 'stroke-width': s.width || 2.2, 'stroke-linejoin': 'round'
      });
      pl.style.stroke = s.color;
      if (s.dash) pl.setAttribute('stroke-dasharray', s.dash);
      svg.appendChild(pl);
      if (s.dots) {
        s.points.forEach(function (p) {
          const c = UI.svgEl('circle', { cx: X(p.x), cy: Y(p.y), r: 3 });
          c.style.fill = s.color;
          svg.appendChild(c);
        });
      }
    });
    (opts.markers || []).forEach(function (m) {
      const ln = UI.svgEl('line', { x1: X(m.x), x2: X(m.x), y1: PT, y2: H - PB, 'stroke-dasharray': '3 3', 'stroke-width': 1 });
      ln.style.stroke = m.color || 'var(--ink)';
      svg.appendChild(ln);
      if (m.label) {
        const tx = UI.svgEl('text', { x: X(m.x) + 4, y: PT + 10, class: 'dp-tick' });
        tx.style.fill = m.color || 'var(--ink)';
        tx.textContent = m.label;
        svg.appendChild(tx);
      }
    });
    return svg;
  }

  function legend(items) {
    const w = UI.el('div', 'legend');
    items.forEach(function (it) {
      const li = UI.el('span', 'legend-item');
      const i = UI.el('i');
      i.style.background = it.color;
      li.appendChild(i);
      li.appendChild(document.createTextNode(it.label));
      w.appendChild(li);
    });
    return w;
  }

  function ticks(lo, hi, n) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(lo + (hi - lo) * i / n);
    return out;
  }

  /** 取整到 1 / 2 / 5 × 10^k 的刻度。 */
  function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(function (m) { return m * p; }).filter(function (s) { return s >= raw; })[0];
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
    return out;
  }

  /** 卡片标题行：标题 + 可选提示 + 右侧控件。 */
  function cardHead(title, hint, right) {
    const h = UI.el('div', 'dp-card-head');
    h.appendChild(UI.el('span', 'card-title', title));
    if (hint) h.appendChild(UI.el('span', 'hint', hint));
    h.appendChild(UI.el('span', 'spacer'));
    (right || []).forEach(function (n) { h.appendChild(n); });
    return h;
  }

  function btn(cls, text, onClick) {
    const b = UI.el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /** 分段按钮。items = [{ value, label }]；返回 { el, set(v), get() }。 */
  function seg(items, value, onChange, label) {
    const el = UI.el('div', 'seg');
    el.setAttribute('role', 'group');
    if (label) el.setAttribute('aria-label', label);
    let cur = value;
    const bs = items.map(function (it) {
      const b = btn('', it.label, function () { set(it.value); if (onChange) onChange(it.value); });
      b.dataset.value = it.value;
      el.appendChild(b);
      return b;
    });
    function set(v) {
      cur = v;
      bs.forEach(function (b) {
        const on = b.dataset.value === v;
        b.className = on ? 'on' : '';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    set(value);
    return { el: el, set: set, get: function () { return cur; } };
  }

  function numInput(id, value, min, max, step) {
    const i = UI.inputOf(id, value, 'number');
    if (!id) i.removeAttribute('id');
    i.min = min; i.max = max; i.step = step;
    return i;
  }

  window.DPC = {
    MECH_CN: MECH_CN, ACC_CN: ACC_CN, STATUS_CN: STATUS_CN, COLORS: COLORS,
    listJobs: listJobs, pickJob: pickJob, setJob: setJob, jobField: jobField,
    fmtDelta: fmtDelta, pct: pct, money: money, chart: chart, legend: legend, ticks: ticks, niceTicks: niceTicks,
    cardHead: cardHead, btn: btn, seg: seg, numInput: numInput
  };

  /* ================= 效果评估页 DP ================= */

  const CHART = { w: 820, h: 188, pl: 44, pr: 10, pt: 16, pb: 26 };

  let ctx = null;
  let jobId = null;
  let jobs = [];
  let cfg = null;         // 后端权威配置，GET /fl/jobs/{id}/dp 的返回，本地绝不直接改
  let mech = 'gaussian';  // 界面上选中的机制（可能尚未被后端接受）
  let budget = null;
  let booted = false;
  let seq = 0;            // 防止换任务 / 换项目时旧请求覆盖新结果
  const dom = {};

  const estimateDebounced = UI.debounce(function () { estimate(); tradeoff(); }, 300);

  function bindOnce() {
    if (booted) return;
    booted = true;
    $('dpGauss').addEventListener('click', function () { setMech('gaussian'); });
    $('dpLap').addEventListener('click', function () { setMech('laplace'); });
    $('dpEps').addEventListener('input', function () {
      $('dpEpsVal').textContent = Number($('dpEps').value).toFixed(2);
      estimateDebounced();
    });
    $('dpClip').addEventListener('input', function () {
      $('dpClipVal').textContent = Number($('dpClip').value).toFixed(1);
      estimateDebounced();
    });
    $('dpEps').addEventListener('change', save);
    $('dpClip').addEventListener('change', save);
    $('dpDelta').addEventListener('change', function () { estimate(); tradeoff(); save(); });
    enhanceDom();
  }

  /** index.html 里的静态骨架只读，这里在运行时补齐：顶部任务选择、data-acc、平衡分析卡、审计操作。 */
  function enhanceDom() {
    const sec = $('screen-dp-eval');
    const headText = sec.querySelector('.page-head-text');
    const head = UI.el('div', 'page-head');
    sec.insertBefore(head, headText);
    head.appendChild(headText);
    dom.jobSlot = UI.el('div', 'field');
    head.appendChild(dom.jobSlot);
    head.appendChild(btn('btn-link', '调整机制与会计方式', function () { App.go('dp', { sub: 'mech' }); }));

    sec.querySelector('.dp-config').setAttribute('data-acc', 'DP-EVAL-01');
    sec.querySelector('.dp-right .metric-grid-3').setAttribute('data-acc', 'DP-EVAL-01');
    const metricNames = sec.querySelectorAll('.dp-right .metric-grid-3 .metric-name');
    metricNames[0].textContent = '已消耗隐私预算（累计 ε）';
    metricNames[1].textContent = '模型效用（预估 Accuracy）';
    dom.perRoundName = metricNames[2];
    dom.usedSub = $('dpUsedPct').parentNode;

    const trend = $('dpEpsLine').closest('.card');
    trend.setAttribute('data-acc', 'DP-EVAL-02');
    const trendHint = trend.querySelector('.hint');
    trendHint.textContent = '横轴为迭代轮次；两条曲线按各自量纲归一化绘制，虚线为当前已完成轮次';
    dom.trendMax = Array.prototype.filter.call(trend.querySelectorAll('text'), function (t) { return t.textContent === '30'; })[0];

    // 效用-隐私平衡分析
    const tr = UI.el('div', 'card card-lg');
    tr.setAttribute('data-acc', 'DP-EVAL-02');
    tr.appendChild(cardHead('效用-隐私平衡分析', '同一机制、裁剪阈值与会计方式下，不同总预算 ε 对应的预估模型效用'));
    dom.tradeChart = UI.el('div', 'dp-chart-wrap');
    tr.appendChild(dom.tradeChart);
    dom.tradeNote = UI.el('div', 'banner-note');
    tr.appendChild(dom.tradeNote);
    trend.parentNode.insertBefore(tr, trend.nextSibling);

    // 审计记录：表头、查看全部、导出
    const audit = $('dpAudit').closest('.card');
    audit.setAttribute('data-acc', 'DP-EVAL-03');
    const ah = audit.querySelector('.hint');
    dom.auditHint = ah;
    const all = btn('btn-sm', '查看全部', showAllAudit);
    const exp = btn('btn-sm', '导出 CSV', exportAudit);
    ah.parentNode.appendChild(all);
    ah.parentNode.appendChild(exp);
    const th = audit.querySelector('.table-head');
    UI.clear(th);
    ['轮次', '本轮 ε 增量', '累计 ε', '噪声添加详情', '裁剪阈值 C'].forEach(function (t) { th.appendChild(UI.el('span', null, t)); });

    $('dpHist').closest('.card').setAttribute('data-acc', 'DP-EVAL-01');
    dom.histTitle = $('dpHist').closest('.card').querySelector('.card-title');
    dom.histTitle.textContent = '噪声分布（理论密度）';

    dom.accLine = UI.el('span', 'dp-noise-formula');
    $('dpFormula').parentNode.appendChild(dom.accLine);
    const chipRow = $('dpEnabledChip').parentNode;
    dom.providerText = chipRow.querySelector('span[style]');
  }

  function setMech(m) {
    mech = m;
    renderMech();
    estimate();
    tradeoff();
    save();
  }

  function renderMech() {
    $('dpGauss').className = 'dp-mech' + (mech === 'gaussian' ? ' on' : '');
    $('dpLap').className = 'dp-mech' + (mech === 'laplace' ? ' on' : '');
    $('dpGauss').setAttribute('aria-pressed', mech === 'gaussian' ? 'true' : 'false');
    $('dpLap').setAttribute('aria-pressed', mech === 'laplace' ? 'true' : 'false');
    $('dpDeltaWrap').hidden = mech !== 'gaussian';
  }

  function currentConfig() {
    return {
      enabled: cfg.enabled,
      mechanism: mech,
      epsilon_total: Number($('dpEps').value),
      clip_norm: Number($('dpClip').value),
      delta: $('dpDelta').value,
      total_rounds: cfg.total_rounds
    };
  }

  async function save() {
    try {
      cfg = await Api.put('/fl/jobs/' + jobId + '/dp', currentConfig());
      mech = cfg.mechanism;
      renderAccLine();
    } catch (e) {
      // 运行中不允许改配置（40901）：整个界面回滚到后端权威值
      UI.fail(e);
      applyConfig();
      estimate();
      tradeoff();
    }
  }

  async function estimate() {
    const my = seq;
    try {
      const body = currentConfig();
      const res = await Api.post('/dp/estimate', {
        mechanism: body.mechanism,
        epsilon_total: body.epsilon_total,
        clip_norm: body.clip_norm,
        delta: body.delta,
        total_rounds: body.total_rounds,
        accountant: cfg.accountant || 'basic',
        baseline_job_id: jobId,
        histogram_bins: 13
      });
      if (my === seq) renderEstimate(res, body);
    } catch (e) { UI.fail(e); }
  }

  function renderEstimate(res, body) {
    const isG = body.mechanism === 'gaussian';
    const acc = res.accountant || 'basic';
    $('dpNoiseText').textContent = (isG ? 'σ = ' : 'b = ') + res.noise_scale.toFixed(3) +
      '（噪声倍数 z = ' + res.noise_multiplier.toFixed(3) + '，单轮机制 ε = ' + res.epsilon_per_round.toFixed(4) +
      (isG ? '，δ = ' + body.delta : '') + '，C = ' + body.clip_norm.toFixed(1) + '）';
    $('dpFormula').textContent = acc === 'basic' ? res.formula
      : '按' + ACC_CN[acc] + '反解：使 ' + body.total_rounds + ' 轮累计 ε 恰为 ' + body.epsilon_total.toFixed(2) + ' 的噪声倍数 z，σ = z · C';

    $('dpUtil').textContent = pct(res.estimated_accuracy);
    $('dpBaseline').textContent = pct(res.baseline_accuracy);
    $('dpUtilLoss').textContent = (res.accuracy_loss * 100).toFixed(1) + ' 个百分点';
    dom.perRoundName.textContent = acc === 'basic' ? '每轮 ε 消耗（ε_总 / 轮数）' : '单轮机制 ε（单独看一轮）';
    $('dpPerRound').textContent = res.epsilon_per_round.toFixed(4);
    $('dpMechName').textContent = MECH_CN[body.mechanism] + ' · ' + ACC_CN[acc];
    $('dpClipEcho').textContent = body.clip_norm.toFixed(1);
    if (dom.trendMax) dom.trendMax.textContent = String(body.total_rounds);

    // 两条曲线各自归一化到 0–1
    const maxEps = res.curve[res.curve.length - 1].cumulative_epsilon || 1;
    const accs = res.curve.map(function (p) { return p.estimated_accuracy; });
    const lo = Math.min.apply(null, accs), hi = Math.max.apply(null, accs);
    const span = (hi - lo) || 1;

    $('dpEpsLine').setAttribute('points', UI.polyline(
      res.curve.map(function (p) { return { x: p.round, y: p.cumulative_epsilon / maxEps }; }),
      Object.assign({ ymin: 0, ymax: 1, xmax: body.total_rounds }, CHART)));
    $('dpUtilLine').setAttribute('points', UI.polyline(
      res.curve.map(function (p) { return { x: p.round, y: (p.estimated_accuracy - lo) / span }; }),
      Object.assign({ ymin: 0, ymax: 1, xmax: body.total_rounds }, CHART)));

    const hist = $('dpHist');
    UI.clear(hist);
    res.histogram.forEach(function (h) {
      const bar = UI.el('i');
      bar.style.height = Math.max(3, Math.round(h.density * 112)) + 'px';
      hist.appendChild(bar);
    });
    $('dpHistNote').textContent = isG
      ? '高斯噪声按 N(0, σ²) 采样后加入裁剪梯度；横轴以 σ 为单位，柱高为归一化概率密度。框架实际采样分布见「框架集成」页。'
      : '拉普拉斯噪声按 Lap(0, b) 采样后加入裁剪梯度；横轴以 b 为单位，柱高为归一化概率密度。框架实际采样分布见「框架集成」页。';
  }

  async function tradeoff() {
    const my = seq;
    try {
      const body = currentConfig();
      const res = await Api.post('/dp/tradeoff', {
        mechanism: body.mechanism, clip_norm: body.clip_norm, delta: body.delta,
        total_rounds: body.total_rounds, accountant: cfg.accountant || 'basic'
      });
      if (my === seq) renderTradeoff(res, body);
    } catch (e) { UI.fail(e); }
  }

  function renderTradeoff(res, body) {
    const pts = res.points;
    const accs = pts.map(function (p) { return p.estimated_accuracy; });
    const lo = Math.floor(Math.min.apply(null, accs.concat([res.baseline_accuracy])) * 10) / 10;
    const markers = [{ x: body.epsilon_total, color: COLORS.amber, label: '当前 ε = ' + body.epsilon_total.toFixed(2) }];
    UI.clear(dom.tradeChart);
    dom.tradeChart.appendChild(legend([
      { color: COLORS.primary, label: '预估模型效用（Accuracy，%）' },
      { color: COLORS.muted, label: '无噪声基线 ' + pct(res.baseline_accuracy) },
      { color: COLORS.amber, label: '当前总预算' }
    ]));
    dom.tradeChart.appendChild(chart({
      w: 820, h: 210, xmin: 0, xmax: 10, ymin: lo, ymax: 1,
      xTicks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], yTicks: ticks(lo, 1, Math.round((1 - lo) * 10)),
      xFmt: function (v) { return v.toFixed(0); }, yFmt: function (v) { return (v * 100).toFixed(0) + '%'; },
      xLabel: '总隐私预算 ε', aria: '不同总隐私预算下的预估模型效用',
      series: [
        { color: COLORS.muted, dash: '4 4', width: 1.4, points: [{ x: 0, y: res.baseline_accuracy }, { x: 10, y: res.baseline_accuracy }] },
        { color: COLORS.primary, dots: true, points: pts.map(function (p) { return { x: p.epsilon_total, y: p.estimated_accuracy }; }) }
      ],
      markers: markers
    }));
    const rec = res.recommended_epsilon;
    dom.tradeNote.textContent = rec === null
      ? '在 ε ≤ 10 范围内，效用损失都超过 ' + (res.max_accuracy_loss * 100).toFixed(0) + ' 个百分点；可改用 RDP 会计或放宽裁剪阈值。'
      : '平衡点：效用损失不超过 ' + (res.max_accuracy_loss * 100).toFixed(0) + ' 个百分点的最小总预算为 ε = ' + rec.toFixed(2) +
        '（' + ACC_CN[res.accountant] + '）。当前 ε = ' + body.epsilon_total.toFixed(2) +
        (body.epsilon_total < rec ? '，隐私更强但效用损失超出该阈值。' : '，已达到该效用要求；继续增大 ε 效用提升有限，隐私保护减弱。');
  }

  function renderAccLine() {
    const acc = cfg.accountant || 'basic';
    dom.accLine.textContent = '会计方式：' + ACC_CN[acc] + '；裁剪方式：' + (cfg.clip_mode === 'adaptive' ? '自适应' : '固定') +
      (cfg.policy_id ? '；参数来自策略 ' + cfg.policy_id : '') + '（在「隐私机制」页配置）';
  }

  function applyConfig() {
    mech = cfg.mechanism;
    $('dpEps').value = cfg.epsilon_total;
    $('dpEpsVal').textContent = cfg.epsilon_total.toFixed(2);
    $('dpClip').value = cfg.clip_norm;
    $('dpClipVal').textContent = cfg.clip_norm.toFixed(1);
    $('dpDelta').value = cfg.delta;
    $('dpTotalRounds').textContent = cfg.total_rounds;
    renderMech();
    renderAccLine();
    $('dpEnabledChip').textContent = cfg.enabled ? 'DP 已启用' : 'DP 未启用';
  }

  async function loadBudget() {
    budget = await Api.get('/fl/jobs/' + jobId + '/dp/budget');
    $('dpRounds').textContent = budget.rounds_completed;
    $('dpTotalRounds').textContent = budget.total_rounds;
    $('dpRoundsBar').style.width = Math.round(budget.rounds_completed / budget.total_rounds * 100) + '%';
    $('dpUsed').textContent = budget.epsilon_used.toFixed(3);
    $('dpUsedBar').style.width = budget.used_pct + '%';
    UI.clear(dom.usedSub);
    dom.usedSub.appendChild(document.createTextNode('占总预算 ε = ' + budget.epsilon_total.toFixed(2) + ' 的 '));
    const sp = UI.el('span', null, String(budget.used_pct));
    sp.id = 'dpUsedPct';
    dom.usedSub.appendChild(sp);
    dom.usedSub.appendChild(document.createTextNode('%（' + ACC_CN[budget.accountant || 'basic'] + '累计' +
      (budget.delta_total ? '，累计 δ = ' + fmtDelta(budget.delta_total) : '') + (budget.dp_active ? '' : '，本次运行未启用 DP') + '）'));

    const T = Math.max(2, budget.total_rounds);
    const x = CHART.pl + (Math.max(1, budget.rounds_completed) - 1) / (T - 1) * (CHART.w - CHART.pl - CHART.pr);
    $('dpCursor').setAttribute('x1', x.toFixed(1));
    $('dpCursor').setAttribute('x2', x.toFixed(1));
  }

  function auditRow(a) {
    const row = UI.el('div', 'table-row dp-audit-grid');
    row.appendChild(UI.el('span', 'cell-strong', '第 ' + a.round + ' 轮'));
    row.appendChild(UI.el('span', 'cell-muted', a.epsilon_spent.toFixed(4)));
    row.appendChild(UI.el('span', 'cell-muted', a.epsilon_cumulative.toFixed(3)));
    row.appendChild(UI.el('span', 'cell-muted', a.mechanism === 'gaussian'
      ? '高斯噪声 σ = ' + a.noise_scale.toFixed(3) + '，δ = ' + a.delta + '，被裁剪更新占 ' + pct(a.clip_ratio)
      : '拉普拉斯噪声 b = ' + a.noise_scale.toFixed(3) + '，被裁剪更新占 ' + pct(a.clip_ratio)));
    row.appendChild(UI.el('span', 'cell-muted', a.clip_norm.toFixed(3) + (a.clip_mode === 'adaptive' ? '（自适应）' : '')));
    return row;
  }

  async function loadAudit() {
    const res = await Api.get('/fl/jobs/' + jobId + '/dp/audit', { limit: 5 });
    const wrap = $('dpAudit');
    UI.clear(wrap);
    dom.auditHint.textContent = '最近 5 轮 · 共 ' + res.total + ' 条';
    if (!res.items.length) {
      wrap.appendChild(UI.el('div', 'table-empty', '尚未开始迭代，启动联邦训练后这里会逐轮写入记录'));
      return;
    }
    res.items.forEach(function (a) { wrap.appendChild(auditRow(a)); });
  }

  async function showAllAudit() {
    try {
      const res = await Api.get('/fl/jobs/' + jobId + '/dp/audit', { limit: 'all' });
      const body = UI.el('div', 'dp-modal-body');
      const job = jobs.filter(function (j) { return j.job_id === jobId; })[0];
      body.appendChild(UI.el('span', 'hint', (job ? job.name : jobId) + ' · 共 ' + res.total + ' 轮记录（按轮次倒序），ε 按' +
        ACC_CN[(res.items[0] || {}).accountant || 'basic'] + '计算'));
      const th = UI.el('div', 'table-head dp-audit-grid');
      ['轮次', '本轮 ε 增量', '累计 ε', '噪声添加详情', '裁剪阈值 C'].forEach(function (t) { th.appendChild(UI.el('span', null, t)); });
      body.appendChild(th);
      const list = UI.el('div', 'dp-scroll');
      if (!res.items.length) list.appendChild(UI.el('div', 'table-empty', '暂无记录'));
      res.items.forEach(function (a) { list.appendChild(auditRow(a)); });
      body.appendChild(list);
      const m = UI.modal({ title: '隐私审计记录（全部）', body: body, submitText: '导出 CSV', width: 860, onSubmit: async function () { await exportAudit(); } });
      return m;
    } catch (e) { UI.fail(e); }
  }

  async function exportAudit() {
    try {
      const name = await Api.download('/fl/jobs/' + jobId + '/dp/audit/export');
      if (name) UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  async function loadJob(id) {
    const my = ++seq;
    jobId = id;
    setJob(ctx.projectId, id);
    const c = await Api.get('/fl/jobs/' + jobId + '/dp');
    if (my !== seq) return;
    cfg = c;
    applyConfig();
    const job = jobs.filter(function (j) { return j.job_id === jobId; })[0];
    if (dom.providerText) {
      dom.providerText.textContent = '当前实现：' + (cfg.provider === 'secretflow-native' ? '隐语原生 DP 模块' : cfg.provider) +
        '（适配层保留可替换性，见「框架集成」页）；任务启用 DP 后在梯度聚合前自动调用。' + (job ? ' 任务状态：' + (STATUS_CN[job.status] || job.status) + '。' : '');
    }
    await Promise.all([estimate(), tradeoff(), loadBudget(), loadAudit()]);
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c) {
    ctx = c;
    bindOnce();
    try {
      jobs = await listJobs(ctx.projectId);
      UI.clear(dom.jobSlot);
      if (!jobs.length) { UI.toast('当前项目还没有联邦训练任务'); return; }
      const id = pickJob(ctx.projectId, jobs);
      const f = jobField('dpJobSel', jobs, id, function (v) { loadJob(v).catch(UI.fail); });
      dom.jobSlot.appendChild(f.wrap);
      await loadJob(id);
    } catch (e) { UI.fail(e); }
  }

  /** 训练推进时由 app.js 调用，刷新预算与审计。 */
  async function refresh() {
    if (!jobId) return;
    try { await Promise.all([loadBudget(), loadAudit()]); } catch (e) { /* 忽略后台刷新失败 */ }
  }

  function unmount() { seq++; }

  window.DP = { mount: mount, unmount: unmount, refresh: refresh };
})();
