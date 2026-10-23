/** 差分隐私模块。接口见 API.md §6。DP 配置挂在联邦训练任务上。 */
(function () {
  'use strict';
  const $ = UI.$;

  const CHART = { w: 820, h: 188, pl: 44, pr: 10, pt: 16, pb: 26 };
  const MECH_CN = { gaussian: '高斯机制', laplace: '拉普拉斯机制' };

  let ctx = null;
  let jobId = null;
  let cfg = null;         // 后端权威配置，GET /fl/jobs/{id}/dp 的返回，本地绝不直接改
  let mech = 'gaussian';  // 界面上选中的机制（可能尚未被后端接受）
  let budget = null;
  let booted = false;

  const estimateDebounced = UI.debounce(function () { estimate(); }, 300);

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
    $('dpDelta').addEventListener('change', function () { estimate(); save(); });
  }

  function setMech(m) {
    mech = m;
    renderMech();
    estimate();
    save();
  }

  function renderMech() {
    $('dpGauss').className = 'dp-mech' + (mech === 'gaussian' ? ' on' : '');
    $('dpLap').className = 'dp-mech' + (mech === 'laplace' ? ' on' : '');
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
    } catch (e) {
      // 运行中不允许改配置（40901）：整个界面回滚到后端权威值
      UI.fail(e);
      applyConfig();
      estimate();
    }
  }

  async function estimate() {
    try {
      const body = currentConfig();
      const res = await Api.post('/dp/estimate', {
        mechanism: body.mechanism,
        epsilon_total: body.epsilon_total,
        clip_norm: body.clip_norm,
        delta: body.delta,
        total_rounds: body.total_rounds,
        baseline_job_id: jobId,
        histogram_bins: 13
      });
      renderEstimate(res, body);
    } catch (e) { UI.fail(e); }
  }

  function renderEstimate(res, body) {
    const isG = body.mechanism === 'gaussian';
    $('dpNoiseText').textContent = isG
      ? 'σ = ' + res.noise_scale.toFixed(3) + '　（每轮 ε = ' + res.epsilon_per_round.toFixed(4) +
        '，δ = ' + body.delta + '，C = ' + body.clip_norm.toFixed(1) + '）'
      : 'b = ' + res.noise_scale.toFixed(3) + '　（每轮 ε = ' + res.epsilon_per_round.toFixed(4) +
        '，C = ' + body.clip_norm.toFixed(1) + '）';
    $('dpFormula').textContent = res.formula;

    $('dpUtil').textContent = res.estimated_accuracy.toFixed(3);
    $('dpBaseline').textContent = res.baseline_accuracy.toFixed(3);
    $('dpUtilLoss').textContent = res.accuracy_loss.toFixed(3);
    $('dpPerRound').textContent = res.epsilon_per_round.toFixed(4);
    $('dpMechName').textContent = MECH_CN[body.mechanism];
    $('dpClipEcho').textContent = body.clip_norm.toFixed(1);

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
      ? '高斯噪声按 N(0, σ²) 采样后加入裁剪梯度。'
      : '拉普拉斯噪声按 Lap(0, b) 采样后加入裁剪梯度。';
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
    $('dpEnabledChip').textContent = cfg.enabled ? 'DP 已启用' : 'DP 未启用';
  }

  async function loadBudget() {
    budget = await Api.get('/fl/jobs/' + jobId + '/dp/budget');
    $('dpRounds').textContent = budget.rounds_completed;
    $('dpTotalRounds').textContent = budget.total_rounds;
    $('dpRoundsBar').style.width = budget.used_pct + '%';
    $('dpUsed').textContent = budget.epsilon_used.toFixed(3);
    $('dpUsedPct').textContent = budget.used_pct;
    $('dpUsedBar').style.width = budget.used_pct + '%';

    const x = CHART.pl + (Math.max(1, budget.rounds_completed) - 1) / (budget.total_rounds - 1) * (CHART.w - CHART.pl - CHART.pr);
    $('dpCursor').setAttribute('x1', x.toFixed(1));
    $('dpCursor').setAttribute('x2', x.toFixed(1));
  }

  async function loadAudit() {
    const res = await Api.get('/fl/jobs/' + jobId + '/dp/audit', { limit: 5 });
    const wrap = $('dpAudit');
    UI.clear(wrap);
    if (!res.items.length) {
      wrap.appendChild(UI.el('div', 'table-empty', '尚未开始迭代，启动联邦训练后这里会逐轮写入记录'));
      return;
    }
    res.items.forEach(function (a) {
      const row = UI.el('div', 'table-row dp-audit-grid');
      row.appendChild(UI.el('span', 'cell-strong', '第 ' + a.round + ' 轮'));
      row.appendChild(UI.el('span', 'cell-muted', a.epsilon_spent.toFixed(4)));
      row.appendChild(UI.el('span', 'cell-muted', a.mechanism === 'gaussian'
        ? '高斯噪声　σ = ' + a.noise_scale.toFixed(3) + '，δ = ' + a.delta
        : '拉普拉斯噪声　b = ' + a.noise_scale.toFixed(3)));
      row.appendChild(UI.el('span', 'cell-muted', 'C = ' + a.clip_norm.toFixed(1)));
      wrap.appendChild(row);
    });
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c) {
    ctx = c;
    bindOnce();
    try {
      jobId = window.FL.currentJobId();
      if (!jobId) {
        const res = await Api.get('/projects/' + ctx.projectId + '/fl/jobs', { latest: true });
        jobId = res.items[0].job_id;
      }
      cfg = await Api.get('/fl/jobs/' + jobId + '/dp');
      applyConfig();
      await Promise.all([estimate(), loadBudget(), loadAudit()]);
    } catch (e) { UI.fail(e); }
  }

  /** 训练推进时由 app.js 调用，刷新预算与审计。 */
  async function refresh() {
    if (!jobId) return;
    try { await Promise.all([loadBudget(), loadAudit()]); } catch (e) { /* 忽略后台刷新失败 */ }
  }

  function unmount() { }

  window.DP = { mount: mount, unmount: unmount, refresh: refresh };
})();
