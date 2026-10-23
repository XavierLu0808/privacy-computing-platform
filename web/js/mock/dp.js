/**
 * mock 扩展：差分隐私（隐私机制 / 效果评估 / 框架集成）。接口见 docs/api/dp.md。
 *
 * 自有数据挂在 k.db.dpx；读写内核的 job.dp（DP 配置本就挂在训练任务上，写入字段见 docs/api/dp.md §0）。
 * 会计方式（accountant）三选一：basic 基础组合 / advanced 高级组合（Dwork–Rothblum–Vadhan 2010）/
 * rdp Rényi 差分隐私（Mironov 2017，即 Moments Accountant 的 Rényi 形式，不计子采样放大）。
 * basic 下所有数值与内核 6.3–6.5 完全一致，其余两种按同一总预算反解每轮噪声。
 */
(function () {
  'use strict';
  window.MockServer.extend(function (k) {
    const db = k.db;
    const S = db.dpx = {
      provider: 'secretflow-native',   // 平台默认实现
      providerOf: {},                   // project_id -> 该项目选用的实现
      policies: {},      // policy_id -> policy
      snap: {},          // job_id -> { started_at, dp }：一次训练运行期间的 DP 配置快照
      queryCfg: {},      // project_id -> 统计查询 DP 配置
      queries: {}        // project_id -> [release]
    };

    const MECHS = ['gaussian', 'laplace'];
    const ACCOUNTANTS = ['basic', 'advanced', 'rdp'];
    const DELTAS = ['1e-4', '1e-5', '1e-6'];
    const ACC_CN = { basic: '基础组合', advanced: '高级组合', rdp: 'RDP 会计' };
    const MECH_CN = { gaussian: '高斯机制', laplace: '拉普拉斯机制' };
    // 默认 RDP 会计：同样总预算下每轮噪声最小（basic 仍可选，数值与内核 v1.1 一致）
    const DEFAULT_EXT = { accountant: 'rdp', clip_mode: 'fixed', apply_to: 'gradient', policy_id: null, policy_dimension: null };

    /* ================= 数学工具 ================= */

    function deltaNum(d) { const n = Number(d); return n > 0 && n < 1 ? n : 1e-5; }
    function round(v, n) { return Number(Number(v).toFixed(n)); }

    // Abramowitz–Stegun 7.1.26，最大误差 1.5e-7
    function erf(x) {
      const s = x < 0 ? -1 : 1;
      x = Math.abs(x);
      const t = 1 / (1 + 0.3275911 * x);
      const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
      return s * y;
    }
    function Phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
    const Z = { 0.01: -2.3263, 0.025: -1.96, 0.05: -1.6449, 0.1: -1.2816, 0.9: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };

    function rng(seed) {
      let a = parseInt(k.hashHex(seed, 1), 16) >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function bisect(f, lo, hi, target, increasing) {
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        const v = f(mid);
        if ((v < target) === increasing) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }

    /* ---------- 组合定理 ---------- */

    const ALPHAS = [1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 32, 48, 64, 96, 128, 256];
    function lse2(a, x, b, y) { const m = Math.max(x, y); return m + Math.log(a * Math.exp(x - m) + b * Math.exp(y - m)); }

    /** 单步 RDP ε(α)。gaussian：scale = z = σ/Δ；laplace：scale = λ = b/Δ。 */
    function rdpStep(mech, scale, alpha) {
      if (mech === 'gaussian') return alpha / (2 * scale * scale);
      return lse2(alpha / (2 * alpha - 1), (alpha - 1) / scale, (alpha - 1) / (2 * alpha - 1), -alpha / scale) / (alpha - 1);
    }
    function rdpTotal(mech, scale, t, delta) {
      let best = Infinity, bestA = null;
      ALPHAS.forEach(function (a) {
        const e = t * rdpStep(mech, scale, a) + Math.log(1 / delta) / (a - 1);
        if (e < best) { best = e; bestA = a; }
      });
      return { eps: best, alpha: bestA };
    }

    /** 由单步 ε₀ 得到噪声倍数（gaussian 用经典定标 z = √(2 ln(1.25/δ))/ε₀，laplace λ = 1/ε₀）。 */
    function scaleOf(mech, eps0, delta) {
      return mech === 'gaussian' ? Math.sqrt(2 * Math.log(1.25 / delta)) / eps0 : 1 / eps0;
    }
    function eps0Of(mech, scale, delta) {
      return mech === 'gaussian' ? Math.sqrt(2 * Math.log(1.25 / delta)) / scale : 1 / scale;
    }

    /** t 步之后的累计 ε。 */
    function composeAt(acc, mech, scale, delta, t) {
      if (t <= 0) return 0;
      const e0 = eps0Of(mech, scale, delta);
      if (acc === 'basic') return t * e0;
      if (acc === 'advanced') return Math.min(t * e0, e0 * Math.sqrt(2 * t * Math.log(1 / delta)) + t * e0 * (Math.exp(e0) - 1));
      const r = rdpTotal(mech, scale, t, delta).eps;
      return mech === 'laplace' ? Math.min(r, t * e0) : r;
    }
    function deltaTotal(acc, mech, delta, t) {
      let d = delta;
      if (acc === 'basic') d = mech === 'gaussian' ? t * delta : 0;
      else if (acc === 'advanced') d = mech === 'gaussian' ? t * delta + delta : delta;
      return Number(d.toPrecision(3));
    }

    /** 按总预算 ε、总步数 T 和会计方式反解每步噪声。返回 { scale, eps0, noise_scale, delta_total }。 */
    function calibrate(cfg) {
      const mech = cfg.mechanism, delta = deltaNum(cfg.delta), T = cfg.total_rounds, E = cfg.epsilon_total;
      const acc = cfg.accountant || 'rdp';
      let scale;
      if (acc === 'basic') scale = scaleOf(mech, E / T, delta);
      else {
        scale = bisect(function (s) { return composeAt(acc, mech, s, delta, T); }, 1e-3, 1e6, E, false);
      }
      return {
        accountant: acc,
        scale: scale,
        eps0: eps0Of(mech, scale, delta),
        noise_scale: scale * cfg.clip_norm,
        delta_total: deltaTotal(acc, mech, delta, T)
      };
    }

    /* ================= 任务 DP 配置（扩展字段 + 快照） ================= */

    const STARTABLE = ['Created', 'Failed', 'Terminated'];
    function projectProvider(pid) { return S.providerOf[pid] || S.provider; }

    function running(job) { return ['Running', 'Paused'].indexOf(job.status) >= 0; }

    function normalize(job) {
      const dp = job.dp;
      Object.keys(DEFAULT_EXT).forEach(function (key) { if (dp[key] === undefined) dp[key] = DEFAULT_EXT[key]; });
      if (!running(job)) {
        dp.total_rounds = job.total_rounds;   // createJob 已同步；PATCH /fl/jobs/{id} 改轮数时内核不同步 job.dp，这里兜底
        // 只有待启动 / 失败 / 已终止的任务跟随项目当前实现；已完成任务保留训练时的实现记录
        if (STARTABLE.indexOf(job.status) >= 0 || !dp.provider) dp.provider = projectProvider(job.project_id);
      }
      if (running(job)) {
        const s = S.snap[job.job_id];
        if (!s || s.started_at !== job.started_at) S.snap[job.job_id] = { started_at: job.started_at, dp: Object.assign({}, dp), dp_enabled: job.dp_enabled };
      }
      return dp;
    }

    /** 当前运行（或最近一次运行）实际使用的配置。 */
    function runCfg(job) {
      normalize(job);
      const s = S.snap[job.job_id];
      if (job.current_round > 0 && s && s.started_at === job.started_at) return { dp: s.dp, enabled: s.dp_enabled && s.dp.enabled };
      return { dp: job.dp, enabled: job.dp_enabled && job.dp.enabled };
    }

    function validateDp(body) {
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (!(body.epsilon_total >= 0.2 && body.epsilon_total <= 10)) return k.err(40003, 'ε 必须在 0.2 – 10 之间');
      if (!(body.clip_norm >= 0.2 && body.clip_norm <= 4)) return k.err(40003, '裁剪阈值 C 必须在 0.2 – 4 之间');
      if (body.mechanism === 'gaussian' && !body.delta) return k.err(40000, '高斯机制必须指定 δ');
      if (body.delta && DELTAS.indexOf(String(body.delta)) < 0) return k.err(40002, 'δ 只能是 1e-4 / 1e-5 / 1e-6');
      if (body.accountant !== undefined && ACCOUNTANTS.indexOf(body.accountant) < 0) return k.err(40000, 'accountant 必须是 basic / advanced / rdp');
      if (body.clip_mode !== undefined && ['fixed', 'adaptive'].indexOf(body.clip_mode) < 0) return k.err(40000, 'clip_mode 必须是 fixed 或 adaptive');
      return null;
    }

    function writeDp(job, patch) {
      normalize(job);
      // 已有训练历史而尚无快照（如播种的历史任务）：先把旧配置存为该次运行的快照，历史审计不随新配置改变
      if (job.current_round > 0) {
        const s = S.snap[job.job_id];
        if (!s || s.started_at !== job.started_at) S.snap[job.job_id] = { started_at: job.started_at, dp: Object.assign({}, job.dp), dp_enabled: job.dp_enabled };
      }
      const next = Object.assign({}, job.dp, {
        enabled: patch.enabled !== undefined ? !!patch.enabled : job.dp.enabled,
        mechanism: patch.mechanism, epsilon_total: patch.epsilon_total, clip_norm: patch.clip_norm,
        delta: patch.delta || job.dp.delta, updated_at: k.NOW()
      });
      ['accountant', 'clip_mode', 'policy_id', 'policy_dimension'].forEach(function (key) {
        if (patch[key] !== undefined) next[key] = patch[key];
      });
      // 从固定切到自适应时记住原固定 C，自适应对比始终以它为基准；切回固定则清空
      if (patch.clip_mode === 'adaptive' && job.dp.clip_mode !== 'adaptive') next.clip_norm_fixed = job.dp.clip_norm;
      else if (next.clip_mode !== 'adaptive') next.clip_norm_fixed = null;
      job.dp = next;
      job.dp_enabled = next.enabled;
      return next;
    }

    k.routeFirst('GET', '/fl/jobs/{job_id}/dp', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      return k.ok(Object.assign({}, normalize(job)));
    });

    k.routeFirst('PUT', '/fl/jobs/{job_id}/dp', function (p, q, body) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      if (running(job)) return k.err(40901, '任务运行中不允许修改 DP 配置，已消耗的预算不可回退', { status: job.status });
      const bad = validateDp(body);
      if (bad) return bad;
      const patch = Object.assign({}, body);
      // 手动修改参数即脱离策略
      if (body.policy_id === undefined && job.dp.policy_id &&
        (body.epsilon_total !== job.dp.epsilon_total || body.mechanism !== job.dp.mechanism || body.clip_norm !== job.dp.clip_norm)) {
        patch.policy_id = null; patch.policy_dimension = null;
      }
      return k.ok(Object.assign({}, writeDp(job, patch)));
    });

    /* ================= 6.3 参数预估（按会计方式） ================= */

    function util(eps, mech) { return 0.62 + 0.30 * (1 - Math.exp(-eps / 2.2)) - (mech === 'gaussian' ? 0 : 0.015); }

    /** 与 basic 下噪声相同的「等效基础组合总 ε」，模型效用按噪声大小而非账面 ε 估算。 */
    function epsEq(cal, T) { return Math.min(cal.eps0 * T, 60); }

    function estimate(body) {
      const acc = body.accountant || 'rdp';
      const T = body.total_rounds;
      const cal = calibrate(Object.assign({}, body, { accountant: acc }));
      const eq = epsEq(cal, T);
      const res = k.dpEstimate(Object.assign({}, body, { epsilon_total: acc === 'basic' ? body.epsilon_total : eq }));
      const delta = deltaNum(body.delta);
      res.accountant = acc;
      res.epsilon_total = body.epsilon_total;
      res.delta_total = body.mechanism === 'gaussian' || acc !== 'basic' ? deltaTotal(acc, body.mechanism, delta, T) : 0;
      res.epsilon_per_round_avg = round(body.epsilon_total / T, 4);
      if (acc !== 'basic') {
        res.epsilon_per_round = round(cal.eps0, 4);
        res.noise_scale = round(cal.noise_scale, 3);
        res.curve.forEach(function (pt) {
          pt.cumulative_epsilon = round(composeAt(acc, body.mechanism, cal.scale, delta, pt.round), 4);
        });
      }
      res.noise_multiplier = round(cal.scale, 3);
      return withMetrics(res, body, eq, T);
    }

    /**
     * 按任务类型给出效用指标（metrics_spec）。分类：Accuracy（越高越好，沿用 v1.1 公式）。
     * 时序：RMSE / MAE（归一化，越低越好）= 无噪声基线 × (1 + κ · e^(−ε_eq / 2.2))，κ = 1.2，拉普拉斯再乘 1.05；
     * 基线取内核 metricsAt('timeseries', T, 0)，即该任务无噪声训练 T 轮后的全局指标。e^(−ε/2.2) 与分类公式的饱和项相同。
     */
    function tsFactor(eps, mech) { return (1 + 1.2 * Math.exp(-eps / 2.2)) * (mech === 'laplace' ? 1.05 : 1); }
    function taskTypeOfBody(body) {
      const job = body.baseline_job_id && db.flJobs[body.baseline_job_id];
      return (job && job.task_type) || body.task_type || 'classification';
    }
    function withMetrics(res, body, eq, T) {
      const tt = taskTypeOfBody(body);
      const spec = (k.taskTypeOf(tt) || k.TASK_TYPES[0]).metrics;
      res.task_type = tt;
      if (tt !== 'timeseries') {
        res.primary_metric = 'accuracy';
        res.metrics = [{ key: 'accuracy', label: 'Accuracy', better: 'higher', baseline: res.baseline_accuracy, estimated: res.estimated_accuracy,
          change_pct: round((res.estimated_accuracy - res.baseline_accuracy) / res.baseline_accuracy * 100, 2) }];
        return res;
      }
      const base = k.metricsAt('timeseries', T, 0);
      const f = tsFactor(eq, body.mechanism);
      res.primary_metric = 'rmse';
      res.metrics = spec.map(function (m) {
        const est = round(base[m.key] * f, 4);
        return { key: m.key, label: m.label, better: m.better, baseline: base[m.key], estimated: est, change_pct: round((f - 1) * 100, 2) };
      });
      // 时序任务没有 Accuracy：分类口径字段置空，避免误读
      res.baseline_accuracy = null; res.estimated_accuracy = null; res.accuracy_loss = null;
      res.curve.forEach(function (pt) {
        pt.estimated_accuracy = null;
        pt.estimated_rmse = round(base.rmse * tsFactor(eq * pt.round / T, body.mechanism), 4);
      });
      return res;
    }

    k.routeFirst('POST', '/dp/estimate', function (p, q, body) {
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必填，且必须是 gaussian 或 laplace');
      if (body.mechanism === 'gaussian' && !body.delta) return k.err(40000, '高斯机制必须指定 δ');
      if (body.accountant && ACCOUNTANTS.indexOf(body.accountant) < 0) return k.err(40000, 'accountant 必须是 basic / advanced / rdp');
      if (!(body.epsilon_total > 0) || !(body.clip_norm > 0) || !(body.total_rounds >= 1)) return k.err(40000, 'epsilon_total / clip_norm / total_rounds 必须为正数');
      return k.ok(estimate(body));
    });

    /* ---------- 效用-隐私平衡（DP-EVAL-02 / C-09） ---------- */
    const TRADEOFF_GRID = [0.2, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10];
    k.route('POST', '/dp/tradeoff', function (p, q, body) {
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (body.mechanism === 'gaussian' && !body.delta) return k.err(40000, '高斯机制必须指定 δ');
      if (!(body.total_rounds >= 1) || !(body.clip_norm > 0)) return k.err(40000, 'total_rounds / clip_norm 必须为正数');
      const grid = Array.isArray(body.epsilons) && body.epsilons.length ? body.epsilons : TRADEOFF_GRID;
      if (grid.some(function (e) { return !(e >= 0.05 && e <= 20); })) return k.err(40003, 'ε 取值必须在 0.05 – 20 之间');
      const maxLoss = body.max_accuracy_loss || 0.03;
      const maxInc = body.max_metric_increase_pct || 10;
      const tt = taskTypeOfBody(body);
      const points = grid.map(function (e) {
        const r = estimate(Object.assign({}, body, { epsilon_total: e }));
        const pm = r.metrics[0];
        return {
          epsilon_total: e, noise_scale: r.noise_scale, estimated_accuracy: r.estimated_accuracy, accuracy_loss: r.accuracy_loss,
          metric_value: pm.estimated, metric_change_pct: pm.change_pct
        };
      });
      const ok = tt === 'timeseries'
        ? function (x) { return x.metric_change_pct <= maxInc; }
        : function (x) { return x.accuracy_loss <= maxLoss; };
      const hit = points.filter(ok)[0];
      const first = estimate(Object.assign({}, body, { epsilon_total: grid[0] })).metrics[0];
      return k.ok({
        accountant: body.accountant || 'rdp', task_type: tt,
        metric: { key: first.key, label: first.label, better: first.better, baseline: first.baseline },
        baseline_accuracy: tt === 'timeseries' ? null : 0.921, max_accuracy_loss: maxLoss, max_metric_increase_pct: maxInc,
        rule: tt === 'timeseries' ? 'RMSE 相对无噪声基线增幅 ≤ ' + maxInc + '%' : 'Accuracy 损失 ≤ ' + (maxLoss * 100) + ' 个百分点',
        points: points, recommended_epsilon: hit ? hit.epsilon_total : null
      });
    });

    /* ================= 每轮记录（审计 / 框架指标共用） ================= */

    const BATCH = 256;    // DP-SGD：每个参与方每轮逐样本裁剪后求和加噪的样本数
    const GRAD_S = 0.5;   // 样本梯度 L2 范数的对数标准差
    function gradMedian(r) { return 0.25 + 0.9 * Math.exp(-r / 12); }
    function clipExpect(m, s, C) {
      const mu = Math.log(m);
      return Math.exp(mu + s * s / 2) * Phi((Math.log(C) - mu - s * s) / s) + C * (1 - Phi((Math.log(C) - mu) / s));
    }
    function clipAt(dp, r) {
      if (dp.clip_mode !== 'adaptive' || r <= 1) return dp.clip_norm;
      return gradMedian(r - 1);   // 自适应：用上一轮样本梯度范数的中位数（目标分位 0.5）作为本轮 C
    }

    function trainers(job) {
      return Math.max(1, k.jobNodes(job).filter(function (n) { return n.role === 'trainer'; }).length || job.node_ids.length);
    }

    function roundRow(job, dp, cal, r) {
      const delta = deltaNum(dp.delta);
      const acc = dp.accountant || 'rdp';
      const C = clipAt(dp, r);
      const m = gradMedian(r);
      const noise = cal.scale * C;
      const d = k.MODEL_PARAMS[job.algorithm] || k.MODEL_PARAMS.custom;   // 单次上传参数维度，与联邦学习模块同源
      const noiseL2 = dp.mechanism === 'gaussian' ? noise * Math.sqrt(d) : noise * Math.sqrt(2 * d);
      const signal = trainers(job) * BATCH * clipExpect(m, GRAD_S, C);
      const cum = composeAt(acc, dp.mechanism, cal.scale, delta, r);
      return {
        round: r,
        epsilon_spent: round(cum - composeAt(acc, dp.mechanism, cal.scale, delta, r - 1), 4),
        epsilon_cumulative: round(cum, 4),
        accountant: acc,
        mechanism: dp.mechanism,
        noise_scale: round(noise, 3),
        noise_multiplier: round(cal.scale, 3),
        delta: dp.mechanism === 'gaussian' ? dp.delta : null,
        clip_norm: round(C, 3),
        clip_mode: dp.clip_mode || 'fixed',
        clip_ratio: round(1 - Phi((Math.log(C) - Math.log(m)) / GRAD_S), 4),
        update_norm_median: round(m, 4),
        noise_l2: round(noiseL2, 2),
        signal_l2: round(signal, 4),
        snr: round(signal / noiseL2, 6),
        model_dim: d,
        batch_size: BATCH,
        trainers: trainers(job)
      };
    }

    /** 本次运行的逐轮记录（升序）。内核审计记录提供轮次与时间；播种的历史任务无内核记录时按其配置回放。 */
    function rowsOf(job) {
      const rc = runCfg(job);
      if (!rc.enabled && !job.dp_audit.length) return [];
      const dp = Object.assign({}, DEFAULT_EXT, rc.dp, { total_rounds: rc.dp.total_rounds || job.total_rounds });
      const cal = calibrate(dp);
      const src = job.dp_audit.length ? job.dp_audit.map(function (a) { return { round: a.round, at: a.recorded_at }; })
        : job.metrics.map(function (m) { return { round: m.round, at: m.recorded_at }; });
      return src.map(function (x) {
        return Object.assign(roundRow(job, dp, cal, x.round), { recorded_at: x.at, source: job.dp_audit.length ? 'engine' : 'seed_history' });
      });
    }

    k.routeFirst('GET', '/fl/jobs/{job_id}/dp/budget', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      const rc = runCfg(job);
      const dp = Object.assign({}, DEFAULT_EXT, rc.dp);
      const cal = calibrate(dp);
      const delta = deltaNum(dp.delta);
      const r = Math.min(job.current_round, dp.total_rounds);
      const used = rc.enabled ? composeAt(dp.accountant, dp.mechanism, cal.scale, delta, r) : 0;
      return k.ok({
        epsilon_total: dp.epsilon_total,
        epsilon_used: round(used, 3),
        used_pct: Math.min(100, Math.round(used / dp.epsilon_total * 100)),
        rounds_completed: job.current_round,
        total_rounds: dp.total_rounds,
        exhausted: job.current_round >= dp.total_rounds,
        accountant: dp.accountant,
        delta_total: rc.enabled ? deltaTotal(dp.accountant, dp.mechanism, delta, r) : 0,
        dp_active: rc.enabled
      });
    });

    // 内核 jobTick 推送 round_completed 时调用：SSE 里的本轮 / 累计 ε 与 DP 页按同一会计方式计算
    db.dpAccount = function (job, r) {
      const rc = runCfg(job);
      const dp = Object.assign({}, DEFAULT_EXT, rc.dp);
      const cal = calibrate(dp);
      const delta = deltaNum(dp.delta);
      const cum = composeAt(dp.accountant, dp.mechanism, cal.scale, delta, r);
      return { epsilon_spent: round(cum - composeAt(dp.accountant, dp.mechanism, cal.scale, delta, r - 1), 4), epsilon_used: round(cum, 4), accountant: dp.accountant };
    };

    function auditSlice(job, q) {
      let rows = rowsOf(job);
      if (q.from_round) rows = rows.filter(function (x) { return x.round >= Number(q.from_round); });
      if (q.to_round) rows = rows.filter(function (x) { return x.round <= Number(q.to_round); });
      const total = rows.length;
      const lim = q.limit === 'all' || q.limit === '0' ? total : Number(q.limit || 5);
      return { items: rows.slice(-lim).reverse(), total: total };
    }

    k.routeFirst('GET', '/fl/jobs/{job_id}/dp/audit', function (p, q) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      if (q.limit !== undefined && q.limit !== 'all' && !(Number(q.limit) >= 0)) return k.err(40002, 'limit 必须是非负整数或 all');
      return k.ok(auditSlice(job, q));
    });

    k.download(/^\/fl\/jobs\/([^/]+)\/dp\/audit\/export/, function (m) {
      const job = db.flJobs[m[1]];
      if (!job) return null;
      let csv = 'job_id,round,accountant,mechanism,epsilon_spent,epsilon_cumulative,noise_scale,noise_multiplier,delta,clip_norm,clip_ratio_pct,noise_l2,recorded_at(UTC+8)\n';
      rowsOf(job).forEach(function (a) {
        csv += [job.job_id, a.round, a.accountant, a.mechanism, a.epsilon_spent, a.epsilon_cumulative, a.noise_scale,
          a.noise_multiplier, a.delta || '', a.clip_norm, (a.clip_ratio * 100).toFixed(1), a.noise_l2, k.fmtLocal(a.recorded_at)].join(',') + '\n';
      });
      return { fileName: job.job_id + '_dp_audit.csv', contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
    });

    /* ================= DP-MECH-01 机制目录 ================= */

    const MECHANISMS = [
      {
        mechanism: 'gaussian', name: '高斯机制', guarantee: '(ε, δ)-DP',
        definition: '对任意只差一条记录的相邻数据集 D、D′ 与任意输出集合 S，Pr[M(D) ∈ S] ≤ e^ε · Pr[M(D′) ∈ S] + δ。',
        noise: 'N(0, σ²)，σ = Δ₂ · √(2 ln(1.25/δ)) / ε',
        sensitivity: 'L2 敏感度 Δ₂（梯度场景即裁剪阈值 C）',
        scenarios: ['联邦训练梯度扰动（DP-FedAvg / DP-SGD）', '高维向量发布', '多轮迭代，配合 RDP 会计可显著降低累计 ε'],
        params: [
          { key: 'epsilon_total', name: '总隐私预算 ε', min: 0.2, max: 10, step: 0.1 },
          { key: 'delta', name: '松弛参数 δ', options: DELTAS },
          { key: 'clip_norm', name: '裁剪阈值 C / 敏感度 Δ₂', min: 0.2, max: 4, step: 0.1 },
          { key: 'apply_to', name: '作用对象', options: ['gradient', 'query'] }
        ]
      },
      {
        mechanism: 'laplace', name: '拉普拉斯机制', guarantee: 'ε-DP（纯差分隐私，δ = 0）',
        definition: '对任意相邻数据集 D、D′ 与任意输出集合 S，Pr[M(D) ∈ S] ≤ e^ε · Pr[M(D′) ∈ S]。',
        noise: 'Lap(0, b)，密度 (1/2b) · e^(−|x|/b)，b = Δ₁ / ε',
        sensitivity: 'L1 敏感度 Δ₁',
        scenarios: ['计数、求和、均值等低维统计查询', '要求 δ = 0 的严格场景', '单次或少量次数发布'],
        params: [
          { key: 'epsilon_total', name: '总隐私预算 ε', min: 0.2, max: 10, step: 0.1 },
          { key: 'clip_norm', name: '裁剪阈值 C / 敏感度 Δ₁', min: 0.2, max: 4, step: 0.1 },
          { key: 'apply_to', name: '作用对象', options: ['gradient', 'query'] }
        ]
      }
    ];
    k.route('GET', '/dp/mechanisms', function () { return k.ok({ items: MECHANISMS }); });

    /* ================= DP-MECH-03 字段分布与自适应噪声 ================= */

    // 稀土价格字段：对数正态拟合参数（中位数 元/吨、对数标准差）与业务公开取值上界（不看数据即可确定）
    const FIELD_MODEL = {
      nd2o3_price: { median: 420000, s: 0.38, upper: 2000000, unit: '元/吨', label: '氧化钕 Nd₂O₃ 价格' },
      ceo2_price: { median: 9800, s: 0.75, upper: 150000, unit: '元/吨', label: '氧化铈 CeO₂ 价格' },
      la2o3_price: { median: 9500, s: 0.72, upper: 150000, unit: '元/吨', label: '氧化镧 La₂O₃ 价格' }
    };
    function fieldModel(ds, col) {
      if (FIELD_MODEL[col]) return FIELD_MODEL[col];
      const h = parseInt(k.hashHex(ds.dataset_id + col, 1).slice(0, 6), 16);
      const median = round(0.5 + (h % 100) / 100, 2), s = round(0.3 + (h % 40) / 100, 2);
      return { median: median, s: s, upper: Math.ceil(median * Math.exp(4.5 * s)), unit: '无量纲', label: col };
    }
    function lnQ(fm, p) { return fm.median * Math.exp(fm.s * Z[p]); }
    function clipBias(fm, a, b) {
      const mu = Math.log(fm.median), s = fm.s, M = Math.exp(mu + s * s / 2);
      let bias = 0;
      if (a > 0) bias += a * Phi((Math.log(a) - mu) / s) - M * Phi((Math.log(a) - mu - s * s) / s);
      bias += b * (1 - Phi((Math.log(b) - mu) / s)) - M * (1 - Phi((Math.log(b) - mu - s * s) / s));
      return bias;
    }
    function noiseStd(mech, sens, eps, delta) {
      return mech === 'gaussian' ? sens * Math.sqrt(2 * Math.log(1.25 / delta)) / eps : Math.SQRT2 * sens / eps;
    }
    function noiseParam(mech, sens, eps, delta) {
      return mech === 'gaussian' ? sens * Math.sqrt(2 * Math.log(1.25 / delta)) / eps : sens / eps;
    }

    const Q_CANDIDATES = [[0.01, 0.99], [0.025, 0.975], [0.05, 0.95], [0.1, 0.9]];
    const QUANTILE_SHARE = 0.1;   // 自适应裁剪：10% 预算用于差分隐私分位数估计

    function fieldOf(dsId, col) {
      const ds = db.datasets[dsId];
      if (!ds) return { e: k.err(40400, '数据集不存在') };
      if (ds.status !== 'ready') return { e: k.err(40901, '数据集尚未导入完成') };
      const c = ds.columns.filter(function (x) { return x.name === col; })[0];
      if (!c) return { e: k.err(40000, '数据集中没有字段 ' + col) };
      if (c.type !== 'float') return { e: k.err(40001, '字段 ' + col + ' 不是数值型，不能做数值统计加噪') };
      return { ds: ds, fm: fieldModel(ds, col) };
    }

    function adaptiveField(ds, fm, body) {
      const mech = body.mechanism, delta = deltaNum(body.delta), eps = body.epsilon;
      const n = body.query === 'group_mean' ? 21 : ds.row_count;
      const mean = fm.median * Math.exp(fm.s * fm.s / 2);
      function plan(lo, hi, epsQ) {
        const sens = (hi - lo) / n;
        const std = noiseStd(mech, sens, epsQ, delta);
        const bias = clipBias(fm, lo, hi);
        const rmse = Math.sqrt(std * std + bias * bias);
        return {
          lower: round(lo, 2), upper: round(hi, 2), sensitivity: round(sens, 4), epsilon_used: round(epsQ, 4),
          noise_scale: round(noiseParam(mech, sens, epsQ, delta), 4), noise_std: round(std, 4),
          bias: round(bias, 4), rmse: round(rmse, 4), rel_error_pct: round(rmse / mean * 100, 3)
        };
      }
      const fixed = plan(0, fm.upper, eps);
      const cands = Q_CANDIDATES.map(function (qq) {
        return Object.assign({ q_low: qq[0], q_high: qq[1] }, plan(lnQ(fm, qq[0]), lnQ(fm, qq[1]), eps * (1 - QUANTILE_SHARE)));
      });
      const best = cands.slice().sort(function (a, b) { return a.rmse - b.rmse; })[0];
      return {
        target: 'field', dataset_id: ds.dataset_id, column: body.column, label: fm.label, unit: fm.unit,
        mechanism: mech, epsilon: eps, delta: mech === 'gaussian' ? body.delta : null,
        query: body.query === 'group_mean' ? 'group_mean' : 'mean', rows: ds.row_count, group_size: n,
        stats: {
          fit: 'lognormal', median: fm.median, log_sd: fm.s, mean: round(mean, 2),
          p01: round(lnQ(fm, 0.01), 2), p05: round(lnQ(fm, 0.05), 2), p95: round(lnQ(fm, 0.95), 2), p99: round(lnQ(fm, 0.99), 2),
          public_lower: 0, public_upper: fm.upper
        },
        fixed: fixed,
        adaptive: Object.assign({ epsilon_quantile: round(eps * QUANTILE_SHARE, 4) }, best),
        candidates: cands,
        recommended: best.rmse < fixed.rmse ? 'adaptive' : 'fixed',
        noise_reduction_pct: round((1 - best.noise_std / fixed.noise_std) * 100, 1),
        rmse_reduction_pct: round((1 - best.rmse / fixed.rmse) * 100, 1)
      };
    }

    function adaptiveGradient(job) {
      const dp = Object.assign({}, DEFAULT_EXT, normalize(job));
      const cal = calibrate(dp);
      const T = dp.total_rounds;
      const series = [];
      // 固定基准：已启用自适应时用切换前的固定 C，否则用当前 C；自适应首轮用当前 C（初始 C）
      const Cf = dp.clip_mode === 'adaptive' && dp.clip_norm_fixed ? dp.clip_norm_fixed : dp.clip_norm;
      const C0 = dp.clip_norm;
      let sumF = 0, sumA = 0, nzF = 0, nzA = 0;
      for (let r = 1; r <= T; r++) {
        const m = gradMedian(r);
        const ca = r <= 1 ? C0 : gradMedian(r - 1);
        const rf = 1 - Phi((Math.log(Cf) - Math.log(m)) / GRAD_S);
        const ra = 1 - Phi((Math.log(ca) - Math.log(m)) / GRAD_S);
        sumF += rf; sumA += ra; nzF += cal.scale * Cf; nzA += cal.scale * ca;
        series.push({
          round: r, update_norm_median: round(m, 4), clip_fixed: Cf, clip_adaptive: round(ca, 4),
          clip_ratio_fixed: round(rf, 4), clip_ratio_adaptive: round(ra, 4),
          noise_fixed: round(cal.scale * Cf, 3), noise_adaptive: round(cal.scale * ca, 3)
        });
      }
      const rec = Math.max(0.2, Math.min(4, Math.round(gradMedian(Math.ceil(T / 2)) * 10) / 10));
      return {
        target: 'gradient', job_id: job.job_id, mechanism: dp.mechanism, accountant: dp.accountant,
        clip_mode: dp.clip_mode, fixed_clip_norm: Cf, initial_clip_norm: C0,
        noise_multiplier: round(cal.scale, 3), target_quantile: 0.5, series: series,
        summary: {
          clip_ratio_fixed_avg: round(sumF / T, 4), clip_ratio_adaptive_avg: round(sumA / T, 4),
          noise_fixed_avg: round(nzF / T, 3), noise_adaptive_avg: round(nzA / T, 3),
          noise_reduction_pct: round((1 - nzA / nzF) * 100, 1),
          adaptive_better: nzA < nzF
        },
        recommended_clip_norm: rec
      };
    }

    k.route('POST', '/dp/adaptive-noise', function (p, q, body) {
      if (body.target === 'gradient') {
        const job = db.flJobs[body.job_id];
        if (!job) return k.err(40400, '任务不存在');
        return k.ok(adaptiveGradient(job));
      }
      if (body.target !== undefined && body.target !== 'field') return k.err(40000, 'target 必须是 field 或 gradient');
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (!(body.epsilon >= 0.05 && body.epsilon <= 10)) return k.err(40003, 'ε 必须在 0.05 – 10 之间');
      if (body.mechanism === 'gaussian' && DELTAS.indexOf(String(body.delta)) < 0) return k.err(40002, '高斯机制的 δ 只能是 1e-4 / 1e-5 / 1e-6');
      if (body.query && ['mean', 'group_mean'].indexOf(body.query) < 0) return k.err(40000, 'query 必须是 mean 或 group_mean');
      const f = fieldOf(body.dataset_id, body.column);
      if (f.e) return f.e;
      return k.ok(adaptiveField(f.ds, f.fm, body));
    });

    /* ---------- 统计查询（作用对象 = 统计查询） ---------- */

    function validQueryCfg(b) {
      if (MECHS.indexOf(b.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (!(b.epsilon >= 0.05 && b.epsilon <= 10)) return k.err(40003, '单次查询 ε 必须在 0.05 – 10 之间');
      if (b.mechanism === 'gaussian' && DELTAS.indexOf(String(b.delta)) < 0) return k.err(40002, '高斯机制的 δ 只能是 1e-4 / 1e-5 / 1e-6');
      if (['mean', 'group_mean'].indexOf(b.query) < 0) return k.err(40000, 'query 必须是 mean 或 group_mean');
      if (['fixed', 'adaptive'].indexOf(b.clip_mode) < 0) return k.err(40000, 'clip_mode 必须是 fixed 或 adaptive');
      const f = fieldOf(b.dataset_id, b.column);
      return f.e || null;
    }

    k.route('GET', '/projects/{project_id}/dp/query-config', function (p) {
      k.seedProject(p.project_id);
      return k.ok(S.queryCfg[p.project_id] || {
        mechanism: 'laplace', epsilon: 0.5, delta: '1e-5', dataset_id: 'ds_' + p.project_id + '_ree_price',
        column: 'nd2o3_price', query: 'group_mean', clip_mode: 'adaptive', updated_at: null
      });
    });
    k.route('PUT', '/projects/{project_id}/dp/query-config', function (p, q, body) {
      k.seedProject(p.project_id);
      const bad = validQueryCfg(body);
      if (bad) return bad;
      const cfg = {
        mechanism: body.mechanism, epsilon: body.epsilon, delta: body.mechanism === 'gaussian' ? body.delta : null,
        dataset_id: body.dataset_id, column: body.column, query: body.query, clip_mode: body.clip_mode, updated_at: k.NOW()
      };
      S.queryCfg[p.project_id] = cfg;
      return k.ok(cfg);
    });

    /** 执行一次加噪统计查询。真实值不返回，只返回加噪结果与误差估计。 */
    function release(projectId, cfg, meta) {
      const f = fieldOf(cfg.dataset_id, cfg.column);
      const plan = adaptiveField(f.ds, f.fm, { mechanism: cfg.mechanism, epsilon: cfg.epsilon, delta: cfg.delta, query: cfg.query, column: cfg.column });
      const use = cfg.clip_mode === 'adaptive' ? plan.adaptive : plan.fixed;
      const list = S.queries[projectId] = S.queries[projectId] || [];
      const rand = rng(projectId + cfg.dataset_id + cfg.column + list.length);
      const truth = plan.stats.mean * (cfg.query === 'group_mean' ? (0.92 + 0.16 * rng(cfg.dataset_id + cfg.column)()) : 1);
      let noise;
      if (cfg.mechanism === 'gaussian') {
        noise = use.noise_scale * Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      } else {
        const u = rand() - 0.5;
        noise = -use.noise_scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
      }
      const clippedTruth = truth + use.bias;
      const rel = {
        release_id: k.nextId('dpq'), project_id: projectId, dataset_id: cfg.dataset_id, column: cfg.column,
        label: plan.label, unit: plan.unit, query: plan.query, group_size: plan.group_size,
        mechanism: cfg.mechanism, clip_mode: cfg.clip_mode, epsilon_spent: cfg.epsilon,
        delta: cfg.mechanism === 'gaussian' ? cfg.delta : null,
        clip_lower: use.lower, clip_upper: use.upper, sensitivity: use.sensitivity, noise_scale: use.noise_scale,
        // 后处理（裁回裁剪区间）不消耗额外预算
        noisy_value: round(Math.min(use.upper, Math.max(use.lower, clippedTruth + noise)), 2), expected_rmse: use.rmse,
        policy_id: meta.policy_id || null, dimension_key: meta.dimension_key || null, released_at: k.NOW()
      };
      list.push(rel);
      return rel;
    }

    k.route('POST', '/projects/{project_id}/dp/query', function (p, q, body) {
      k.seedProject(p.project_id);
      if (body.policy_id) {
        const pol = S.policies[body.policy_id];
        if (!pol || pol.project_id !== p.project_id) return k.err(40400, '策略不存在');
        const dim = pol.dimensions.filter(function (x) { return x.key === body.dimension_key; })[0];
        if (!dim) return k.err(40400, '策略中没有维度 ' + body.dimension_key);
        if (dim.kind !== 'query') return k.err(40001, '该维度是训练任务维度，请用「下发」写入任务');
        if (dim.steps_used >= dim.steps) return k.err(40901, '该维度预算已用完（' + dim.steps + ' 次查询）');
        dim.steps_used += 1;
        return k.ok(Object.assign(release(p.project_id, {
          mechanism: pol.mechanism, epsilon: dim.epsilon_per_step, delta: pol.delta, dataset_id: dim.dataset_id,
          column: dim.column, query: dim.query, clip_mode: dim.clip_mode
        }, { policy_id: pol.policy_id, dimension_key: dim.key }), { steps_used: dim.steps_used, steps: dim.steps }));
      }
      const bad = validQueryCfg(body);
      if (bad) return bad;
      return k.ok(release(p.project_id, body, {}));
    });

    k.route('GET', '/projects/{project_id}/dp/queries', function (p) {
      const list = (S.queries[p.project_id] || []).slice().reverse();
      const total = list.reduce(function (s, x) { return s + x.epsilon_spent; }, 0);
      return k.ok({ items: list, total: list.length, epsilon_spent_total: round(total, 4) });
    });

    /* ================= DP-MECH-04 组合定理与策略编排 ================= */

    function composeReport(mech, eps0, delta, T) {
      const scale = scaleOf(mech, eps0, delta);
      const step = Math.max(1, Math.ceil(T / 60));
      const curve = [];
      for (let t = step; t <= T; t += step) curve.push(t);
      if (curve[curve.length - 1] !== T) curve.push(T);
      const rd = rdpTotal(mech, scale, T, delta);
      return {
        mechanism: mech, epsilon_per_step: eps0, delta: mech === 'gaussian' ? String(delta) : null, delta_conv: String(delta),
        rounds: T, noise_multiplier: round(scale, 4),
        results: {
          basic: { epsilon: round(composeAt('basic', mech, scale, delta, T), 4), delta_total: deltaTotal('basic', mech, delta, T) },
          advanced: { epsilon: round(composeAt('advanced', mech, scale, delta, T), 4), delta_total: deltaTotal('advanced', mech, delta, T) },
          rdp: { epsilon: round(composeAt('rdp', mech, scale, delta, T), 4), delta_total: deltaTotal('rdp', mech, delta, T), alpha: rd.alpha }
        },
        curve: curve.map(function (t) {
          return {
            t: t,
            basic: round(composeAt('basic', mech, scale, delta, t), 4),
            advanced: round(composeAt('advanced', mech, scale, delta, t), 4),
            rdp: round(composeAt('rdp', mech, scale, delta, t), 4)
          };
        })
      };
    }

    k.route('POST', '/dp/compose', function (p, q, body) {
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (!(body.epsilon_per_step >= 0.001 && body.epsilon_per_step <= 5)) return k.err(40003, '单步 ε 必须在 0.001 – 5 之间');
      if (!Number.isInteger(body.rounds) || body.rounds < 1 || body.rounds > 1000) return k.err(40003, '步数 T 必须是 1 – 1000 的整数');
      if (DELTAS.indexOf(String(body.delta)) < 0) return k.err(40002, 'δ 只能是 1e-4 / 1e-5 / 1e-6');
      return k.ok(composeReport(body.mechanism, body.epsilon_per_step, deltaNum(body.delta), body.rounds));
    });

    function policyDims(projectId, body) {
      const dims = body.dimensions;
      if (!Array.isArray(dims) || !dims.length || dims.length > 8) return { e: k.err(40000, '维度数必须是 1 – 8 个') };
      const seen = {};
      const W = dims.reduce(function (s, d) { return s + (Number(d.weight) || 0); }, 0);
      const out = [];
      for (let i = 0; i < dims.length; i++) {
        const d = dims[i];
        const key = d.key || ('d' + (i + 1));
        if (seen[key]) return { e: k.err(40902, '维度 key 重复：' + key) };
        seen[key] = true;
        if (!d.label) return { e: k.err(40000, '第 ' + (i + 1) + ' 个维度缺少名称') };
        if (!(d.weight > 0 && d.weight <= 100)) return { e: k.err(40003, '维度「' + d.label + '」的权重必须在 (0, 100] 之间') };
        const x = { key: key, label: d.label, kind: d.kind, weight: d.weight };
        if (d.kind === 'training') {
          const job = db.flJobs[d.job_id];
          if (!job || job.project_id !== projectId) return { e: k.err(40400, '维度「' + d.label + '」绑定的训练任务不存在') };
          if (!(d.sensitivity >= 0.2 && d.sensitivity <= 4)) return { e: k.err(40003, '训练维度的裁剪阈值 C 必须在 0.2 – 4 之间') };
          Object.assign(x, { job_id: job.job_id, job_name: job.name, steps: job.total_rounds, sensitivity: d.sensitivity });
        } else if (d.kind === 'query') {
          if (!Number.isInteger(d.steps) || d.steps < 1 || d.steps > 1000) return { e: k.err(40003, '维度「' + d.label + '」的查询次数必须是 1 – 1000 的整数') };
          const f = fieldOf(d.dataset_id, d.column);
          if (f.e) return f;
          const clipMode = d.clip_mode === 'fixed' ? 'fixed' : 'adaptive';
          Object.assign(x, { dataset_id: d.dataset_id, column: d.column, query: d.query === 'mean' ? 'mean' : 'group_mean', clip_mode: clipMode, steps: d.steps, steps_used: 0 });
        } else {
          return { e: k.err(40000, '维度类型 kind 必须是 training 或 query') };
        }
        x.share = d.weight / W;
        out.push(x);
      }
      return { dims: out };
    }

    function allocate(pol) {
      const delta = deltaNum(pol.delta);
      let dTot = 0;
      pol.dimensions.forEach(function (d) {
        d.epsilon = round(pol.epsilon_total * d.share, 4);
        d.share_pct = round(d.share * 100, 1);
        const sens = d.kind === 'training' ? d.sensitivity : 1;   // 查询维度的 Δ 在发布时按字段分布确定，这里给噪声倍数
        const byAcc = {};
        ACCOUNTANTS.forEach(function (acc) {
          const c = calibrate({ mechanism: pol.mechanism, epsilon_total: d.epsilon, delta: pol.delta, total_rounds: d.steps, clip_norm: sens, accountant: acc });
          byAcc[acc] = { noise_multiplier: round(c.scale, 4), epsilon_per_step: round(c.eps0, 5), delta_total: c.delta_total };
        });
        d.noise_by_accountant = byAcc;
        const cur = byAcc[pol.accountant];
        d.noise_multiplier = cur.noise_multiplier;
        d.epsilon_per_step = cur.epsilon_per_step;
        d.noise_scale = d.kind === 'training' ? round(cur.noise_multiplier * d.sensitivity, 4) : null;
        d.delta_total = cur.delta_total;
        dTot += pol.mechanism === 'gaussian' || pol.accountant !== 'basic' ? cur.delta_total : 0;
      });
      pol.delta_total = Number(dTot.toPrecision(3));
      return pol;
    }

    k.route('POST', '/projects/{project_id}/dp/policies', function (p, q, body) {
      k.seedProject(p.project_id);
      if (!body.name || !String(body.name).trim()) return k.err(40000, '策略名称必填');
      const dup = Object.keys(S.policies).some(function (id) { return S.policies[id].project_id === p.project_id && S.policies[id].name === body.name; });
      if (dup) return k.err(40902, '本项目已有同名策略');
      if (ACCOUNTANTS.indexOf(body.accountant) < 0) return k.err(40000, 'accountant 必须是 basic / advanced / rdp');
      if (MECHS.indexOf(body.mechanism) < 0) return k.err(40000, 'mechanism 必须是 gaussian 或 laplace');
      if (!(body.epsilon_total >= 0.2 && body.epsilon_total <= 50)) return k.err(40003, '策略总预算 ε 必须在 0.2 – 50 之间');
      if (DELTAS.indexOf(String(body.delta)) < 0) return k.err(40002, 'δ 只能是 1e-4 / 1e-5 / 1e-6');
      const r = policyDims(p.project_id, body);
      if (r.e) return r.e;
      const pol = allocate({
        policy_id: k.nextId('dpp'), project_id: p.project_id, name: String(body.name).trim(),
        accountant: body.accountant, mechanism: body.mechanism, epsilon_total: body.epsilon_total, delta: String(body.delta),
        dimensions: r.dims, created_at: k.NOW(), applied_at: null, applied: []
      });
      S.policies[pol.policy_id] = pol;
      return k.ok(pol);
    });

    k.route('GET', '/projects/{project_id}/dp/policies', function (p) {
      const items = Object.keys(S.policies).map(function (id) { return S.policies[id]; })
        .filter(function (x) { return x.project_id === p.project_id; }).reverse();
      return k.ok({ items: items, total: items.length });
    });

    k.route('POST', '/dp/policies/{policy_id}/apply', function (p, q, body) {
      const pol = S.policies[p.policy_id];
      if (!pol) return k.err(40400, '策略不存在');
      const dims = pol.dimensions.filter(function (d) {
        return d.kind === 'training' && (!body.dimension_keys || body.dimension_keys.indexOf(d.key) >= 0);
      });
      if (!dims.length) return k.err(40001, '该策略没有可下发的训练任务维度');
      // 先整体校验，任一任务不可写则全部不下发
      for (let i = 0; i < dims.length; i++) {
        const job = db.flJobs[dims[i].job_id];
        if (!job) return k.err(40400, '任务 ' + dims[i].job_id + ' 不存在');
        if (running(job)) return k.err(40901, '任务「' + job.name + '」运行中，不允许下发策略（已消耗的预算不可回退）', { job_id: job.job_id, status: job.status });
        if (!(dims[i].epsilon >= 0.2 && dims[i].epsilon <= 10)) {
          return k.err(40003, '维度「' + dims[i].label + '」分到的 ε = ' + dims[i].epsilon + '，超出任务允许的 0.2 – 10，请调整权重或总预算');
        }
      }
      const applied = dims.map(function (d) {
        const job = db.flJobs[d.job_id];
        writeDp(job, {
          enabled: true, mechanism: pol.mechanism, epsilon_total: d.epsilon, clip_norm: d.sensitivity,
          delta: pol.mechanism === 'gaussian' ? pol.delta : job.dp.delta, accountant: pol.accountant,
          policy_id: pol.policy_id, policy_dimension: d.key
        });
        return { dimension_key: d.key, job_id: job.job_id, job_name: job.name, epsilon_total: d.epsilon, noise_scale: d.noise_scale };
      });
      pol.applied_at = k.NOW();
      pol.applied = applied;
      return k.ok({ policy_id: pol.policy_id, applied: applied, applied_at: pol.applied_at });
    });

    /* ================= DP-FW-01 框架适配层 ================= */

    const PROVIDERS = [
      {
        provider: 'secretflow-native', name: '隐语 SecretFlow 原生 DP', library: 'secretflow',
        version_note: '适配层 dp-adapter 1.2.0；secretflow 版本以部署环境 pip 包为准',
        mechanisms: ['gaussian', 'laplace'], accountants: ['basic', 'advanced', 'rdp'],
        mapping: [
          { iface: 'DPStrategy.build(job.dp)', impl: 'secretflow.security.privacy.DPStrategyFL', source: 'native', note: '联邦场景 DP 策略容器，持有模型级 DP 对象' },
          { iface: 'GradientDP.gaussian(C, z)', impl: 'secretflow.security.privacy.mechanism.tensorflow.GaussianModelDP', source: 'native', note: '按 l2_norm_clip 裁剪并加高斯噪声；Torch 后端以所用版本的同名类为准' },
          { iface: 'GradientDP.laplace(C, b)', impl: 'dp_adapter.mechanisms.LaplaceModelDP', source: 'adapter', note: '隐语未提供联邦拉普拉斯模型 DP，由适配层实现同一接口' },
          { iface: 'Accountant.spent(t)', impl: 'dp_adapter.accounting.{Basic,Advanced,Rdp}Accountant', source: 'adapter', note: '三种组合定理统一记账接口，可替换为隐语自带记账或 dp_accounting' },
          { iface: 'SecureAggregator.aggregate()', impl: 'secretflow.security.aggregation.SecureAggregator', source: 'native', note: '加噪后的更新进入安全聚合（同态加密聚合时走 HE 聚合器）' }
        ]
      },
      {
        provider: 'opacus', name: 'Opacus（PyTorch）', library: 'opacus',
        version_note: '适配层 dp-adapter 1.2.0；opacus 版本以部署环境为准',
        mechanisms: ['gaussian', 'laplace'], accountants: ['basic', 'advanced', 'rdp'],
        mapping: [
          { iface: 'DPStrategy.build(job.dp)', impl: 'opacus.PrivacyEngine', source: 'native', note: 'make_private 包装模型、优化器与数据加载器' },
          { iface: 'GradientDP.gaussian(C, z)', impl: 'opacus.optimizers.DPOptimizer', source: 'native', note: 'max_grad_norm = C，noise_multiplier = z' },
          { iface: 'GradientDP.laplace(C, b)', impl: 'dp_adapter.mechanisms.LaplaceModelDP', source: 'adapter', note: 'Opacus 只提供高斯噪声，拉普拉斯由适配层补齐' },
          { iface: 'Accountant.spent(t)', impl: 'opacus.accountants.RDPAccountant', source: 'native', note: 'RDP 记账；基础 / 高级组合由适配层计算' },
          { iface: 'SecureAggregator.aggregate()', impl: 'dp_adapter.aggregation.PlatformAggregator', source: 'adapter', note: '复用平台安全聚合服务' }
        ]
      },
      {
        provider: 'tf-privacy', name: 'TensorFlow Privacy', library: 'tensorflow_privacy',
        version_note: '适配层 dp-adapter 1.2.0；tensorflow_privacy 版本以部署环境为准',
        mechanisms: ['gaussian', 'laplace'], accountants: ['basic', 'advanced', 'rdp'],
        mapping: [
          { iface: 'DPStrategy.build(job.dp)', impl: 'dp_adapter.strategy.TfPrivacyStrategy', source: 'adapter', note: '组装优化器与记账器' },
          { iface: 'GradientDP.gaussian(C, z)', impl: 'tensorflow_privacy.DPKerasSGDOptimizer', source: 'native', note: 'l2_norm_clip = C，noise_multiplier = z' },
          { iface: 'GradientDP.laplace(C, b)', impl: 'dp_adapter.mechanisms.LaplaceModelDP', source: 'adapter', note: '由适配层实现' },
          { iface: 'Accountant.spent(t)', impl: 'dp_accounting.rdp.RdpAccountant', source: 'native', note: 'Google dp_accounting 库的 RDP 记账' },
          { iface: 'SecureAggregator.aggregate()', impl: 'dp_adapter.aggregation.PlatformAggregator', source: 'adapter', note: '复用平台安全聚合服务' }
        ]
      }
    ];
    function providerOf(id) { return PROVIDERS.filter(function (x) { return x.provider === id; })[0]; }

    k.route('GET', '/dp/providers', function (p, q) {
      return k.ok({ project_id: q.project_id || null, current: q.project_id ? projectProvider(q.project_id) : S.provider, items: PROVIDERS });
    });
    /** 按项目切换实现：只改该项目待启动 / 失败 / 已终止的任务；运行中 / 已暂停沿用到本次训练结束；已完成保留记录。 */
    k.route('PUT', '/dp/provider', function (p, q, body) {
      if (!providerOf(body.provider)) return k.err(40000, '未知实现 ' + body.provider);
      if (!body.project_id || !db.projects.some(function (x) { return x.project_id === body.project_id; })) return k.err(40000, 'project_id 必填且必须是已有项目');
      S.providerOf[body.project_id] = body.provider;
      const affected = [], kept = [], finished = [];
      k.jobsOfProject(body.project_id).forEach(function (job) {
        normalize(job);
        if (STARTABLE.indexOf(job.status) >= 0) { job.dp.provider = body.provider; affected.push(job.job_id); }
        else if (running(job)) kept.push({ job_id: job.job_id, status: job.status, provider: job.dp.provider });
        else finished.push({ job_id: job.job_id, status: job.status, provider: job.dp.provider });
      });
      return k.ok({
        project_id: body.project_id, current: body.provider,
        affected_jobs: affected.length, affected_job_ids: affected, kept_running: kept, kept_finished: finished
      });
    });

    /* ================= DP-FW-02 训练引擎 DP hook 链 ================= */

    function hooksOf(job) {
      const rc = runCfg(job);
      const dp = Object.assign({}, DEFAULT_EXT, rc.dp);
      const prov = providerOf(dp.provider) || PROVIDERS[0];
      const map = {};
      prov.mapping.forEach(function (m) { map[m.iface.split('.')[0] + (m.iface.indexOf('laplace') >= 0 ? 'L' : '')] = m.impl; });
      const n = trainers(job), r = job.current_round;
      const on = rc.enabled;
      const last = job.metrics.length ? job.metrics[job.metrics.length - 1].recorded_at : null;
      const cal = calibrate(dp);
      function st(isDp) {
        if (isDp && !on) return 'skipped';
        if (r === 0) return job.status === 'Running' ? 'active' : 'pending';
        return job.status === 'Running' ? 'active' : 'done';
      }
      const nz = dp.mechanism === 'gaussian' ? 'N(0, σ²/' + n + ')' : 'Lap(0, b)';
      const steps = [
        { key: 'load', name: '数据加载', impl: 'DataLoader（本地分区）', dp: false, calls: r * n, detail: '各参与方按轮读取本地分区，原始数据不出域' },
        { key: 'train', name: '本地训练', impl: (k.ALGO_CN[job.algorithm] || job.algorithm) + ' 本地迭代', dp: false, calls: r * n, detail: '按样本计算梯度 g（DP-SGD，逐样本）' },
        { key: 'clip', name: '梯度裁剪', impl: map.GradientDP || '—', dp: true, calls: r * n,
          detail: dp.clip_mode === 'adaptive' ? '自适应裁剪：C 取上一轮样本梯度范数中位数（初始 C = ' + dp.clip_norm + '）' : '逐样本固定裁剪：‖g‖₂ 超过 C = ' + dp.clip_norm + ' 时按比例缩放（每参与方每轮 ' + BATCH + ' 个样本）' },
        { key: 'noise', name: '加噪', impl: dp.mechanism === 'laplace' ? (map.GradientDPL || '—') : (map.GradientDP || '—'), dp: true, calls: r * n,
          detail: MECH_CN[dp.mechanism] + '，噪声倍数 z = ' + cal.scale.toFixed(3) + '；各参与方对 ' + BATCH + ' 个裁剪后样本梯度之和加 ' + nz + '，聚合后总噪声满足所配 ε' },
        { key: 'agg', name: '安全聚合', impl: job.aggregation === 'he' ? 'HE 聚合器（同态加密）' : (map.SecureAggregator || '—'), dp: false, calls: r,
          detail: job.aggregation === 'he' ? '加噪后的更新以同态密文上传并求和' : '加噪后的更新以秘密分片上传并求和' },
        { key: 'account', name: '预算记账', impl: map.Accountant || '—', dp: true, calls: r,
          detail: ACC_CN[dp.accountant] + '，每轮聚合后累计 ε 并写审计记录' }
      ].map(function (s) {
        if (s.dp && !on) s.calls = 0;
        return Object.assign(s, { status: st(s.dp), last_called_at: s.calls ? last : null });
      });
      return {
        job_id: job.job_id, job_status: job.status, dp_enabled: on, provider: prov.provider, provider_name: prov.name,
        initialized: on && !!job.started_at, initialized_at: on ? job.started_at : null,
        hook_point: 'before_aggregate', rounds_completed: r, trainers: n, steps: steps
      };
    }

    k.route('GET', '/fl/jobs/{job_id}/dp/hooks', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      return k.ok(hooksOf(job));
    });

    /* ================= DP-FW-03 框架内部 DP 指标 ================= */

    k.route('GET', '/fl/jobs/{job_id}/dp/metrics', function (p, q) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      const rows = rowsOf(job);
      const bins = Number(q.bins || 21);
      if (!Number.isInteger(bins) || bins < 5 || bins > 61) return k.err(40003, 'bins 必须是 5 – 61 的整数');
      const last = rows[rows.length - 1] || null;
      let histogram = [];
      let samples = 0;
      if (last) {
        // 末轮噪声坐标抽样（以 σ 或 b 为单位），给出经验分布与理论密度
        const rand = rng(job.job_id + ':' + last.round);
        samples = 4000;
        const counts = new Array(bins).fill(0);
        const lo = -3, hi = 3, w = (hi - lo) / bins;
        for (let i = 0; i < samples; i++) {
          let x;
          if (last.mechanism === 'gaussian') x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
          else { const u = rand() - 0.5; x = -Math.sign(u) * Math.log(1 - 2 * Math.abs(u)); }
          const b = Math.floor((x - lo) / w);
          if (b >= 0 && b < bins) counts[b] += 1;
        }
        const peak = Math.max.apply(null, counts) || 1;
        histogram = counts.map(function (c, i) {
          const x = lo + (i + 0.5) * w;
          const th = last.mechanism === 'gaussian' ? Math.exp(-x * x / 2) : Math.exp(-Math.abs(x));
          return { x: round(x, 3), count: c, density: round(c / peak, 4), theory: round(th, 4) };
        });
      }
      const avg = function (key) { return rows.length ? rows.reduce(function (s, x) { return s + x[key]; }, 0) / rows.length : null; };
      return k.ok({
        job_id: job.job_id, rounds: rows.map(function (x) {
          return { round: x.round, clip_ratio: x.clip_ratio, clip_norm: x.clip_norm, update_norm_median: x.update_norm_median, noise_l2: x.noise_l2, signal_l2: x.signal_l2, snr: x.snr };
        }),
        summary: last ? {
          clip_ratio_avg: round(avg('clip_ratio'), 4), noise_l2_last: last.noise_l2, snr_last: last.snr,
          snr_db_last: round(10 * Math.log10(last.snr * last.snr), 2), model_dim: last.model_dim, trainers: last.trainers, batch_size: last.batch_size,
          mechanism: last.mechanism, noise_scale: last.noise_scale
        } : null,
        histogram: histogram, histogram_samples: samples
      });
    });

    /* ================= DP-FW-04 初始化检查 ================= */

    k.route('POST', '/fl/jobs/{job_id}/dp/init-check', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      const dp = Object.assign({}, DEFAULT_EXT, normalize(job));
      const prov = providerOf(projectProvider(job.project_id));
      const cal = calibrate(dp);
      const n = trainers(job);
      const startable = ['Created', 'Failed', 'Terminated'].indexOf(job.status) >= 0;
      const checks = [
        { key: 'enabled', name: '任务已启用 DP', pass: !!(job.dp_enabled && dp.enabled), detail: job.dp_enabled && dp.enabled ? '训练引擎将在梯度聚合前调用 DP hook' : '任务未启用 DP，请在第 2 步保存配置' },
        { key: 'params', name: '参数在允许范围', pass: dp.epsilon_total >= 0.2 && dp.epsilon_total <= 10 && dp.clip_norm >= 0.2 && dp.clip_norm <= 4 && (dp.mechanism !== 'gaussian' || !!dp.delta),
          detail: 'ε = ' + dp.epsilon_total + '（总预算），C = ' + dp.clip_norm + (dp.mechanism === 'gaussian' ? '，δ = ' + dp.delta : '') },
        { key: 'provider', name: '实现可用', pass: !!prov && prov.mechanisms.indexOf(dp.mechanism) >= 0 && prov.accountants.indexOf(dp.accountant) >= 0,
          detail: (prov ? prov.name : projectProvider(job.project_id)) + ' 支持' + MECH_CN[dp.mechanism] + '与' + ACC_CN[dp.accountant] },
        { key: 'calibration', name: '噪声定标完成', pass: isFinite(cal.scale) && cal.scale > 0,
          detail: '噪声倍数 z = ' + cal.scale.toFixed(3) + '，每轮噪声尺度 ' + (dp.mechanism === 'gaussian' ? 'σ' : 'b') + ' = ' + cal.noise_scale.toFixed(3) + '（共 ' + dp.total_rounds + ' 轮，' + ACC_CN[dp.accountant] + '）' },
        { key: 'aggregation', name: '安全聚合已配置', pass: ['he', 'ss'].indexOf(job.aggregation) >= 0, detail: job.aggregation === 'he' ? '同态加密聚合' : '秘密共享聚合' },
        { key: 'nodes', name: '参与方 ≥ 2', pass: n >= 2, detail: n + ' 个训练参与方' },
        { key: 'status', name: '任务可启动', pass: startable, detail: startable ? '当前状态 ' + job.status : '当前状态 ' + job.status + '，需先在「过程管控」重置或等待结束' }
      ];
      return k.ok({ job_id: job.job_id, ok: checks.every(function (c) { return c.pass; }), checks: checks, checked_at: k.NOW() });
    });
  });
})();
