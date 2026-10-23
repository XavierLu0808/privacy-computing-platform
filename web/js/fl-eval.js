/**
 * 联邦学习 · 技术指标验证（FL-EVAL-01–03，对应合同技术参数指标 T-01 / T-02）。接口见 docs/api/fed-sec.md §2。
 *
 * 每个指标一张卡：评估配置 → 开始评估（POST /projects/{id}/fl/evaluations）→ SSE 进度 → 结果表 + 达标判定 → 导出 CSV。
 * 页面只负责展示；样本数、成功判定、压缩比、百分点下降全部由后端计算后返回。
 */
(function () {
  'use strict';

  const ITEMS = [
    {
      kind: 'gradient_attack', acc: 'FL-EVAL-01', code: 'T-01', title: '梯度重构攻击评估',
      contract: '基于三类稀土氧化物（氧化钕 Nd₂O₃、氧化铈 CeO₂、氧化镧 La₂O₃）历史价格时序数据集，在单服务端与三客户端组成的联邦学习架构下……实现 DLG、iDLG 两类经典梯度重构攻击成功率 ≤ 5%。（注：梯度重构攻击成功率定义为攻击者截获客户端上传的梯度或权重更新后，利用 DLG、iDLG 逆向算法还原出原始训练数据的比例）',
      fields: [
        { key: 'sample_count', label: '攻击样本数（个）', hint: '20 至 1000，从 3 个客户端的训练窗口中均匀抽取' },
        { key: 'max_iterations', label: '攻击迭代次数（次）', hint: '50 至 2000，DLG / iDLG 的 L-BFGS 优化步数' },
        { key: 'target_client', label: '被攻击客户端', options: [['all', '全部客户端（A / B / C）'], ['party-a', '参与方 A'], ['party-b', '参与方 B'], ['party-c', '参与方 C']] },
        { key: 'seed', label: '随机种子', hint: '0 至 99999，相同种子结果完全一致' }
      ],
      method: [
        '场景：数据集 ds_{项目}_ree_price，三类稀土氧化物日度价格（元/吨）及 6 维市场特征，按 Min-Max 归一化到 [0, 1]，切成 30 日回看窗口 × 9 维特征、预测未来 7 日。1 个服务端 + 3 个客户端（参与方 A / B / C）联邦训练 LSTM（参数量 P = 203,143）。每个攻击样本是某客户端在某一轮、批大小 1 时上传的更新。',
        '攻击者视角：半诚实服务端或信道窃听者截获客户端上行。明文 FedAvg 下截获的是原始梯度；本算法下截获的是 Top-k 稀疏化 + 8 bit 量化 + 高斯 DP 加噪（ε = 8，δ = 1e-5，裁剪阈值 C = 1.0）后、再经秘密共享掩码的份额。为给出保守上界，评估假设掩码已被移除，攻击直接作用于稀疏、量化、加噪后的单方梯度。',
        'DLG（Zhu 等，NeurIPS 2019）：随机初始化伪样本 (x′, y′)，用 L-BFGS 最小化梯度匹配损失 ‖∇W(x′, y′) − ∇W‖²，最多迭代设定次数；本算法下只在被保留的 Top-k 坐标上做匹配。',
        'iDLG（Zhao 等，2020）：先从输出层梯度解析出标签相关量（回归任务中由输出层权重梯度与偏置梯度之比得到最后隐层表示，进而求出标签 y），固定 y 后只优化输入 x′，收敛更快，对明文梯度的还原率高于 DLG。',
        '判定口径：还原样本 x′ 与原始样本 x 在归一化空间的逐元素均方误差 MSE ≤ 0.0025 记为还原成功（项目例会确定，等价于 RMSE ≤ 0.05，即误差不超过价格区间的 5%）。还原成功率 = 还原成功数 ÷ 攻击样本数，DLG、iDLG 分开统计；平均还原 MSE 为全部攻击样本 MSE 的算术平均。合同要求本算法两类攻击的还原成功率均 ≤ 5%。'
      ]
    },
    {
      kind: 'compression', acc: 'FL-EVAL-02', code: 'T-01', title: '通信压缩比评估',
      contract: '对比经典 FedAvg 方法，单轮训练平均通信压缩比 ≥ 6。（注：通信压缩比定义为 FedAvg 联邦学习方法单轮训练平均通信数据总量与本算法单轮训练平均通信数据总量的比值）',
      fields: [
        { key: 'rounds', label: '训练轮次（轮）', hint: '5 至 100' },
        { key: 'topk_ratio', label: 'Top-k 保留比例（%）', pct: true, hint: '0.1% 至 100%，默认取本项目已保存的稀疏化配置' },
        { key: 'quant_bits', label: '量化位数', options: [[4, '4 bit'], [8, '8 bit'], [16, '16 bit'], [32, '32 bit（不量化）']] },
        { key: 'error_feedback', label: '误差反馈', options: [[true, '开启'], [false, '关闭']] },
        { key: 'field_bits', label: '有限域位数（bit）', hint: '量化位数 + 2 至 64（3 方求和不溢出）' }
      ],
      method: [
        '场景：与梯度重构攻击评估同一时序任务（稀土氧化物价格数据集，1 服务端 + 3 客户端，LSTM 参数量 P = 203,143），明文 FedAvg 与本算法各训练设定轮次，逐轮统计服务端与全部客户端之间上下行字节总数。',
        'FedAvg 每轮：每个客户端上传完整梯度 P × 32 bit，服务端下发完整模型 P × 32 bit，单轮总量 = 3 × 2 × P × 32 bit。',
        '本算法每轮：服务端下发全局 Top-k 下标集合（下标列表 k × 18 bit 与位图 P bit 取小），客户端只上传这 k 个位置的量化梯度，并在有限域上加秘密共享掩码（每个元素占有限域位数）；服务端聚合后下发 k 个 32 bit 明文更新；掩码种子每 10 轮用 X25519 重新协商一次（每方公钥 256 bit）。保留数量按梯度能量逐轮动态调整：前几轮梯度分散、保留偏多，随收敛回落到设定比例。',
        '单轮平均通信压缩比 = FedAvg 单轮平均通信总量 ÷ 本算法单轮平均通信总量（两者各自对全部轮次取算术平均后相除），合同要求 ≥ 6。',
        '模型效果：两种方法在同一测试集（时间上最后 20% 的窗口）上计算 RMSE 与 MAE（Min-Max 归一化价格，越低越好），并给出本算法相对 FedAvg 的变化百分比，用于说明压缩没有以明显牺牲预测精度为代价。'
      ]
    },
    {
      kind: 'accuracy', acc: 'FL-EVAL-03', code: 'T-02', title: '联邦训练精度衰减评估',
      contract: '在同等模型架构与参数配置下，相较于理想的集中式明文训练基线，基于隐私保护机制的联邦学习模型效用（Utility）衰减可控。在基于卷积神经网络（CNN）与标准图像分类数据集（如 MNIST、CIFAR-10）的验证场景中，核心指标（准确率 Accuracy）下降幅度 ≤ 3%。',
      fields: [
        { key: 'rounds', label: '联邦轮次（轮）', hint: '10 至 200；轮次过少时联邦模型未收敛，下降幅度会变大' },
        { key: 'local_epochs', label: '本地训练轮数 E', hint: '1 至 5，每轮每个客户端在本地数据上训练的 epoch 数' },
        { key: 'partition', label: '数据划分', options: [['iid', 'IID 均匀划分'], ['dirichlet', 'Non-IID（Dirichlet α = 0.5）']] },
        { key: 'seed', label: '随机种子', hint: '0 至 99999' }
      ],
      method: [
        '同等模型架构与超参数：两种训练方式使用同一 CNN 结构与 SGD（学习率 0.01，动量 0.9，批大小 64）。集中式明文基线把 3 个客户端的数据合并后训练「联邦轮次 × E」个 epoch，与联邦训练的总计算量一致。',
        '联邦训练：3 个客户端，每轮本地训练 E 个 epoch，上传前做 Top-k 稀疏化、高斯 DP 加噪（ε = 8，δ = 1e-5），服务端以秘密共享安全聚合融合更新。',
        'Accuracy 在官方测试集上计算（MNIST 10,000 张、CIFAR-10 10,000 张）。下降幅度 = 集中式 Accuracy − 联邦 Accuracy，单位为百分点；合同「≤ 3%」按百分点判定（比相对下降更严格），同时给出相对下降 = 下降百分点 ÷ 集中式 Accuracy。'
      ]
    }
  ];
  const BY_KIND = {};
  ITEMS.forEach(function (it) { BY_KIND[it.kind] = it; });

  let ctx = null, root = null, alive = false;
  let defaults = null;
  let history = [];
  const subs = {};     // kind -> SSE 订阅
  const shown = {};    // kind -> 当前卡片展示的评估记录

  function $(id) { return root.querySelector('#' + id); }
  function pct1(r) { return (r * 100).toFixed(1) + '%'; }
  function pct2(r) { return (r * 100).toFixed(2) + '%'; }
  function mb(b) { return (b / 1048576).toFixed(3); }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }

  function verdictTag(passed) {
    return UI.el('span', 'tag fs-verdict ' + (passed ? 'fs-pass' : 'fs-fail'), passed ? '达标' : '未达标');
  }

  /* ---------- 骨架 ---------- */

  function skeleton() {
    root.innerHTML =
      '<div class="page-head"><div class="page-head-text"><span class="crumb">联邦学习 / 技术指标验证</span><h1>合同技术参数指标验证</h1></div>' +
        '<span class="hint">每项评估可调配置后单独运行；结果确定可复现（同项目、同配置结果一致），可导出 CSV 评估报告</span></div>' +
      '<div class="card card-lg" data-acc="FL-EVAL-01 FL-EVAL-02 FL-EVAL-03">' +
        '<div class="fla-row"><span class="card-title">指标总览</span><span class="hint">取每项最近一次完成的评估</span></div>' +
        '<div class="table-head fle-sum-grid"><span>指标</span><span>合同要求</span><span>最近一次结果</span><span>判定</span><span>评估时间</span></div>' +
        '<div id="fleSummary"></div>' +
      '</div>' +
      '<div id="fleCards" class="fle-cards"></div>' +
      '<div class="card card-lg" data-acc="FL-EVAL-01 FL-EVAL-02 FL-EVAL-03">' +
        '<div class="fla-row"><span class="card-title">历史评估记录</span><span class="spacer"></span><span class="hint" id="fleHistCount">—</span></div>' +
        '<div class="table-head fle-hist-grid"><span>评估 ID</span><span>评估项</span><span>配置</span><span>结果</span><span>判定</span><span>完成时间</span><span>操作</span></div>' +
        '<div id="fleHistory"></div>' +
      '</div>';

    const cards = $('fleCards');
    ITEMS.forEach(function (it) { cards.appendChild(buildCard(it)); });
  }

  function buildCard(it) {
    const card = UI.el('div', 'card card-lg');
    card.id = 'fleCard_' + it.kind;
    card.dataset.acc = it.acc;

    const head = UI.el('div', 'fla-row');
    head.appendChild(UI.el('span', 'card-title', it.title));
    head.appendChild(UI.el('span', 'tag', '合同 ' + it.code + ' · ' + it.acc));
    head.appendChild(UI.el('span', 'spacer'));
    const exp = UI.el('button', 'btn-link', '导出 CSV');
    exp.type = 'button'; exp.id = 'fleExport_' + it.kind; exp.disabled = true;
    exp.addEventListener('click', function () { if (shown[it.kind]) exportRun(shown[it.kind].eval_id); });
    const run = UI.el('button', 'btn-primary', '开始评估');
    run.type = 'button'; run.id = 'fleRun_' + it.kind;
    run.addEventListener('click', function () { start(it); });
    head.appendChild(exp);
    head.appendChild(run);
    card.appendChild(head);

    const c = UI.el('div', 'banner-note');
    c.appendChild(UI.el('span', null, '合同原文：' + it.contract));
    card.appendChild(c);

    const formEl = UI.el('div', 'form-3col fle-form');
    formEl.id = 'fleForm_' + it.kind;
    card.appendChild(formEl);
    const err = UI.el('span', 'fla-err');
    err.id = 'fleErr_' + it.kind; err.hidden = true;
    card.appendChild(err);

    const prog = UI.el('div', 'fle-progress');
    prog.id = 'fleProg_' + it.kind; prog.hidden = true;
    prog.innerHTML = '<div class="fla-row"><span class="hint" data-role="stage">—</span><span class="spacer"></span><span class="hint" data-role="pct">0%</span></div>' +
      '<span class="bar bar-6"><i data-role="bar" style="width:0%"></i></span>';
    card.appendChild(prog);

    const res = UI.el('div', 'fle-result');
    res.id = 'fleRes_' + it.kind;
    res.appendChild(UI.el('div', 'table-empty', '尚未评估，点击「开始评估」运行'));
    card.appendChild(res);

    const det = UI.el('details', 'fs-method');
    det.appendChild(UI.el('summary', null, it.kind === 'gradient_attack' ? '评估方法（攻击实现、判定口径、统计方法）' : '评估方法（统计口径与判定方法）'));
    it.method.forEach(function (t) { det.appendChild(UI.el('p', null, t)); });
    card.appendChild(det);
    return card;
  }

  function renderForm(it) {
    const box = $('fleForm_' + it.kind);
    UI.clear(box);
    const d = defaults[it.kind];
    it.fields.forEach(function (f) {
      const id = 'fle_' + it.kind + '_' + f.key;
      let ctl;
      if (f.options) {
        ctl = UI.selectOf(id, f.options.map(function (o) { return { value: String(o[0]), label: o[1] }; }), String(d[f.key]));
      } else {
        ctl = UI.inputOf(id, f.pct ? Number((d[f.key] * 100).toFixed(3)) : d[f.key], 'number');
        ctl.step = f.pct ? '0.5' : '1';
      }
      ctl.dataset.key = f.key;
      box.appendChild(UI.formRow(f.label, ctl, f.hint));
    });
  }

  function readForm(it) {
    const out = {};
    it.fields.forEach(function (f) {
      const v = $('fle_' + it.kind + '_' + f.key).value.trim();
      if (f.options) {
        const o = f.options.filter(function (x) { return String(x[0]) === v; })[0];
        out[f.key] = o ? o[0] : v;
      } else if (v === '') {
        out[f.key] = null;
      } else {
        out[f.key] = f.pct ? Number((Number(v) / 100).toFixed(6)) : Number(v);
      }
    });
    return out;
  }

  /* ---------- 运行 ---------- */

  async function start(it) {
    const err = $('fleErr_' + it.kind);
    err.hidden = true;
    try {
      const run = await Api.post('/projects/' + ctx.projectId + '/fl/evaluations', { kind: it.kind, config: readForm(it) });
      UI.toast('已开始' + it.title + '（' + run.eval_id + '）');
      follow(run);
      loadHistory();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      UI.fail(e);
    }
  }

  function follow(run) {
    const kind = run.kind;
    if (subs[kind]) subs[kind].close();
    setRunning(kind, true, run.progress, run.stage);
    subs[kind] = Api.subscribe('/fl/evaluations/' + run.eval_id + '/events', {
      progress: function (ev) { if (alive) setRunning(kind, true, ev.progress, ev.stage); },
      finished: function (ev) {
        if (!alive) return;
        subs[kind].close();
        delete subs[kind];
        setRunning(kind, false);
        shown[kind] = ev;
        renderResult(kind);
        loadHistory();
      }
    });
  }

  function setRunning(kind, on, progress, stage) {
    const prog = $('fleProg_' + kind);
    prog.hidden = !on;
    $('fleRun_' + kind).disabled = on;
    $('fleRun_' + kind).textContent = on ? '评估中…' : '开始评估';
    if (on) {
      prog.querySelector('[data-role=stage]').textContent = '当前阶段：' + (stage || '—');
      prog.querySelector('[data-role=pct]').textContent = (progress || 0) + '%';
      prog.querySelector('[data-role=bar]').style.width = (progress || 0) + '%';
    }
  }

  async function exportRun(evalId) {
    try {
      const name = await Api.download('/fl/evaluations/' + evalId + '/export');
      if (name) UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 结果 ---------- */

  function grid(cls, headers, rows) {
    const wrap = UI.el('div', 'fle-table');
    const h = UI.el('div', 'table-head ' + cls);
    headers.forEach(function (t) { h.appendChild(UI.el('span', null, t)); });
    wrap.appendChild(h);
    rows.forEach(function (r) {
      const row = UI.el('div', 'table-row ' + cls);
      r.forEach(function (c) {
        if (c instanceof Node) row.appendChild(c);
        else row.appendChild(UI.el('span', null, c));
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  function banner(passed, text) {
    const b = UI.el('div', 'banner ' + (passed ? 'banner-ok' : 'banner-err'));
    b.appendChild(UI.el('strong', null, passed ? '达标' : '未达标'));
    b.appendChild(UI.el('span', null, text));
    return b;
  }

  function cfgLine(run) {
    const c = run.config;
    if (run.kind === 'gradient_attack') {
      return '攻击样本 ' + c.sample_count + ' 个，迭代 ' + c.max_iterations + ' 次，' +
        ({ all: '全部客户端', 'party-a': '参与方 A', 'party-b': '参与方 B', 'party-c': '参与方 C' })[c.target_client] + '，种子 ' + c.seed;
    }
    if (run.kind === 'compression') {
      return c.rounds + ' 轮，Top-k 保留 ' + Number((c.topk_ratio * 100).toFixed(3)) + '%，量化 ' + c.quant_bits + ' bit，误差反馈' +
        (c.error_feedback ? '开启' : '关闭') + '，有限域 ' + c.field_bits + ' bit';
    }
    return c.rounds + ' 轮 × 本地 ' + c.local_epochs + ' epoch，' + (c.partition === 'iid' ? 'IID' : 'Non-IID（α = 0.5）') + '，种子 ' + c.seed;
  }

  function resultLine(run) {
    const r = run.result;
    if (run.kind === 'gradient_attack') {
      const o = r.groups[0].attacks;
      return '本算法 DLG ' + pct1(o[0].success_rate) + '（' + o[0].success_count + ' / ' + o[0].sample_count + '），iDLG ' +
        pct1(o[1].success_rate) + '（' + o[1].success_count + ' / ' + o[1].sample_count + '）';
    }
    if (run.kind === 'compression') return '单轮平均通信压缩比 ' + r.ratio.toFixed(2) + ' 倍，RMSE +' + r.utility.rmse_increase_pct.toFixed(2) + '%';
    return r.datasets.map(function (d) { return d.dataset + ' 下降 ' + d.drop_pp.toFixed(2) + ' 个百分点'; }).join('，');
  }

  function renderResult(kind) {
    const run = shown[kind];
    const box = $('fleRes_' + kind);
    UI.clear(box);
    $('fleExport_' + kind).disabled = !(run && run.status === 'finished');
    if (!run || run.status !== 'finished') {
      box.appendChild(UI.el('div', 'table-empty', '尚未评估，点击「开始评估」运行'));
      return;
    }
    const r = run.result;
    const meta = UI.el('span', 'hint', '评估 ' + run.eval_id + ' · 完成于 ' + UI.datetime(run.finished_at) + ' · 配置：' + cfgLine(run));
    box.appendChild(meta);

    if (kind === 'gradient_attack') {
      const o = r.groups[0].attacks, f = r.groups[1].attacks;
      box.appendChild(banner(r.passed,
        '本算法 DLG 还原成功率 ' + pct1(o[0].success_rate) + '（' + o[0].success_count + ' / ' + o[0].sample_count + ' 个样本），iDLG ' +
        pct1(o[1].success_rate) + '（' + o[1].success_count + ' / ' + o[1].sample_count + '），合同阈值为两类攻击均 ≤ 5%。对照明文 FedAvg：DLG ' +
        pct1(f[0].success_rate) + '，iDLG ' + pct1(f[1].success_rate) + '。'));
      const rows = [];
      r.groups.forEach(function (g) {
        g.attacks.forEach(function (a) {
          rows.push([
            UI.el('span', 'cell-strong', g.key === 'ours' ? '本算法（稀疏化 + 安全聚合 + DP）' : '对照：明文 FedAvg'),
            a.attack, fmtInt(a.sample_count), fmtInt(a.success_count), pct1(a.success_rate), a.mean_mse.toFixed(5)
          ]);
        });
      });
      box.appendChild(grid('fle-atk-grid', ['组别', '攻击方法', '攻击样本数（个）', '还原成功数（个）', '还原成功率', '平均还原 MSE'], rows));
      const s = r.scenario;
      box.appendChild(UI.el('span', 'hint-2',
        '场景：' + s.dataset_name + '（' + s.dataset_id + '，' + fmtInt(s.dataset_rows) + ' 行），' + s.server_count + ' 服务端 + ' + s.client_count +
        ' 客户端，' + s.model + '，回看窗口 ' + s.window_size + ' 日 × ' + s.feature_count + ' 维特征，批大小 ' + s.batch_size +
        '。还原成功：还原样本与原始样本在 Min-Max 归一化后的逐元素 MSE ≤ ' + s.mse_threshold + '。'));
    } else if (kind === 'compression') {
      box.appendChild(banner(r.passed,
        '单轮平均通信压缩比 = FedAvg 单轮平均通信总量 ' + mb(r.fedavg_avg_bytes) + ' MB ÷ 本算法 ' + mb(r.ours_avg_bytes) + ' MB = ' +
        r.ratio.toFixed(2) + ' 倍（' + r.rounds.length + ' 轮平均），合同阈值 ≥ 6 倍。本算法测试集 RMSE 相对 FedAvg 增加 ' +
        r.utility.rmse_increase_pct.toFixed(2) + '%，MAE 增加 ' + r.utility.mae_increase_pct.toFixed(2) + '%。'));
      const u = r.utility;
      box.appendChild(UI.el('span', 'section-label', '模型效果（测试集，Min-Max 归一化价格，越低越好）'));
      box.appendChild(grid('fle-util-grid', ['方法', 'RMSE', 'MAE'], [
        [UI.el('span', 'cell-strong', '对照：明文 FedAvg'), u.fedavg.rmse.toFixed(4), u.fedavg.mae.toFixed(4)],
        [UI.el('span', 'cell-strong', '本算法（稀疏化 + 安全聚合 + DP）'), u.ours.rmse.toFixed(4), u.ours.mae.toFixed(4)],
        [UI.el('span', 'cell-muted', '本算法相对 FedAvg 变化'), '+' + u.rmse_increase_pct.toFixed(2) + '%', '+' + u.mae_increase_pct.toFixed(2) + '%']
      ]));
      box.appendChild(UI.el('span', 'section-label', '逐轮通信数据量（1 MB = 1,048,576 字节，含全部客户端上下行）'));
      const t = grid('fle-comm-grid', ['轮次', '本轮保留梯度数（占 P 比例）', 'FedAvg 通信量（MB）', '本算法通信量（MB）', '本轮压缩比（倍）'],
        r.rounds.map(function (x) {
          return [String(x.round), fmtInt(x.kept) + '（' + pct2(x.kept_ratio) + '）', mb(x.fedavg_bytes), mb(x.ours_bytes), x.ratio.toFixed(2)];
        }).concat([[UI.el('span', 'cell-strong', '平均'), '—', UI.el('span', 'cell-strong', mb(r.fedavg_avg_bytes)),
          UI.el('span', 'cell-strong', mb(r.ours_avg_bytes)), UI.el('span', 'cell-strong', r.ratio.toFixed(2))]]));
      t.classList.add('fle-scroll');
      box.appendChild(t);
    } else {
      box.appendChild(banner(r.passed, r.datasets.map(function (d) {
        return d.dataset + ' 集中式明文 ' + pct2(d.centralized_accuracy) + ' → 联邦 ' + pct2(d.federated_accuracy) + '，下降 ' + d.drop_pp.toFixed(2) + ' 个百分点';
      }).join('；') + '。合同阈值为下降幅度 ≤ 3 个百分点。'));
      box.appendChild(grid('fle-acc-grid', ['数据集', '模型', '集中式明文 Accuracy', '联邦（含隐私保护）Accuracy', '下降幅度（百分点）', '相对下降', '判定'],
        r.datasets.map(function (d) {
          return [UI.el('span', 'cell-strong', d.dataset), UI.el('span', 'cell-muted', d.model), pct2(d.centralized_accuracy), pct2(d.federated_accuracy),
            d.drop_pp.toFixed(2), d.relative_drop_pct.toFixed(2) + '%', verdictTag(d.passed)];
        })));
      const s = r.scenario;
      box.appendChild(UI.el('span', 'hint-2', '联邦：' + s.client_count + ' 客户端，隐私保护 ' + s.privacy + '；优化器 ' + s.optimizer +
        '；集中式基线训练 ' + s.centralized_epochs + ' 个 epoch（= 联邦轮次 × 本地 epoch）。'));
    }
  }

  /* ---------- 总览与历史 ---------- */

  function latest(kind) {
    return history.filter(function (h) { return h.kind === kind && h.status === 'finished'; })[0] || null;
  }

  function renderSummary() {
    const box = $('fleSummary');
    UI.clear(box);
    const atk = latest('gradient_attack'), cmp = latest('compression'), accR = latest('accuracy');
    const rows = [
      ['DLG 梯度重构攻击还原成功率（本算法）', '≤ 5%', atk, function (r) { const a = r.groups[0].attacks[0]; return [pct1(a.success_rate) + '（' + a.success_count + ' / ' + a.sample_count + ' 个样本）', a.success_rate <= 0.05]; }],
      ['iDLG 梯度重构攻击还原成功率（本算法）', '≤ 5%', atk, function (r) { const a = r.groups[0].attacks[1]; return [pct1(a.success_rate) + '（' + a.success_count + ' / ' + a.sample_count + ' 个样本）', a.success_rate <= 0.05]; }],
      ['相对 FedAvg 单轮平均通信压缩比', '≥ 6 倍', cmp, function (r) { return [r.ratio.toFixed(2) + ' 倍（' + r.rounds.length + ' 轮平均）', r.passed]; }],
      ['CNN + MNIST Accuracy 下降幅度', '≤ 3 个百分点', accR, function (r) { const d = r.datasets[0]; return [d.drop_pp.toFixed(2) + ' 个百分点（' + pct2(d.centralized_accuracy) + ' → ' + pct2(d.federated_accuracy) + '）', d.passed]; }],
      ['CNN + CIFAR-10 Accuracy 下降幅度', '≤ 3 个百分点', accR, function (r) { const d = r.datasets[1]; return [d.drop_pp.toFixed(2) + ' 个百分点（' + pct2(d.centralized_accuracy) + ' → ' + pct2(d.federated_accuracy) + '）', d.passed]; }]
    ];
    rows.forEach(function (x) {
      const row = UI.el('div', 'table-row fle-sum-grid');
      row.appendChild(UI.el('span', 'cell-strong', x[0]));
      row.appendChild(UI.el('span', null, x[1]));
      if (x[2]) {
        const v = x[3](x[2].result);
        row.appendChild(UI.el('span', null, v[0]));
        row.appendChild(verdictTag(v[1]));
        row.appendChild(UI.el('span', 'cell-muted', UI.datetime(x[2].finished_at)));
      } else {
        row.appendChild(UI.el('span', 'cell-muted', '尚未评估'));
        row.appendChild(UI.el('span', 'cell-muted', '—'));
        row.appendChild(UI.el('span', 'cell-muted', '—'));
      }
      box.appendChild(row);
    });
  }

  function renderHistory() {
    const box = $('fleHistory');
    UI.clear(box);
    $('fleHistCount').textContent = '共 ' + history.length + ' 条';
    if (!history.length) box.appendChild(UI.el('div', 'table-empty', '暂无评估记录'));
    history.forEach(function (h) {
      const row = UI.el('div', 'table-row fle-hist-grid');
      row.appendChild(UI.el('span', 'cell-strong', h.eval_id));
      row.appendChild(UI.el('span', null, BY_KIND[h.kind].title));
      row.appendChild(UI.el('span', 'cell-muted', cfgLine(h)));
      const done = h.status === 'finished';
      row.appendChild(UI.el('span', null, done ? resultLine(h) : '评估中 ' + h.progress + '%'));
      row.appendChild(done ? verdictTag(h.passed) : UI.el('span', 'st-importing', '评估中'));
      row.appendChild(UI.el('span', 'cell-muted', done ? UI.datetime(h.finished_at) : '—'));
      const ops = UI.el('span', 'fle-ops');
      const look = UI.el('button', 'btn-sm', '查看');
      look.type = 'button'; look.disabled = !done;
      look.addEventListener('click', function () {
        shown[h.kind] = h;
        renderResult(h.kind);
        $('fleCard_' + h.kind).scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      const ex = UI.el('button', 'btn-sm', '导出');
      ex.type = 'button'; ex.disabled = !done;
      ex.addEventListener('click', function () { exportRun(h.eval_id); });
      ops.appendChild(look); ops.appendChild(ex);
      row.appendChild(ops);
      box.appendChild(row);
    });
  }

  async function loadHistory() {
    const pid = ctx.projectId;
    try {
      const res = await Api.get('/projects/' + pid + '/fl/evaluations');
      if (!alive || pid !== ctx.projectId) return;
      history = res.items;
      renderSummary();
      renderHistory();
    } catch (e) { UI.fail(e); }
  }

  async function load() {
    const pid = ctx.projectId;
    try {
      const res = await Promise.all([
        Api.get('/projects/' + pid + '/fl/evaluations/defaults'),
        Api.get('/projects/' + pid + '/fl/evaluations')
      ]);
      if (!alive || pid !== ctx.projectId) return;
      defaults = res[0];
      history = res[1].items;
      ITEMS.forEach(function (it) {
        renderForm(it);
        shown[it.kind] = latest(it.kind);
        renderResult(it.kind);
        const running = history.filter(function (h) { return h.kind === it.kind && h.status === 'running'; })[0];
        if (running) follow(running);
      });
      renderSummary();
      renderHistory();
    } catch (e) { UI.fail(e); }
  }

  window.FLE = {
    mount: function (c, el) {
      ctx = c;
      root = el;
      alive = true;
      history = [];
      Object.keys(shown).forEach(function (k) { delete shown[k]; });
      skeleton();
      load();
    },
    unmount: function () {
      alive = false;
      Object.keys(subs).forEach(function (k) { subs[k].close(); delete subs[k]; });
    }
  };
})();
