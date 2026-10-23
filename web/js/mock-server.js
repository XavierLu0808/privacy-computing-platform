/**
 * 浏览器内 mock 后端 —— 按 ../../API.md 实现全部 52 个端点 + 3 路 SSE（v1.1）。
 *
 * 它是「后端的替身」：路由表、请求校验、状态机、错误码都按文档来，
 * 前端代码不知道自己在跟 mock 说话。接真后端时把 config.js 的 useMock 改成 false 即可。
 *
 * 所有仿真数值沿用原设计稿的公式，保证视觉与演示手感一致。
 */
(function () {
  'use strict';

  const TOTAL_ROUNDS = 30;
  const NOW = function () { return new Date().toISOString(); };

  /* ================= 工具 ================= */

  function ok(data) { return { code: 0, message: 'ok', data: data, request_id: rid() }; }
  function err(code, message, data) { return { code: code, message: message, data: data || null, request_id: rid() }; }
  function rid() { return 'req_' + Math.random().toString(16).slice(2, 10); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function hashHex(seed, blocks) {
    let h = 2166136261 >>> 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) { h = h ^ s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    let out = '', x = h;
    for (let k = 0; k < blocks; k++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out += ('00000000' + x.toString(16)).slice(-8);
    }
    return out;
  }

  function lossAt(r, off) { return 0.94 * Math.exp(-r / 8.5) + 0.075 + off + 0.012 * Math.sin(r * 1.7); }
  function accAt(r, off) { return 0.56 + 0.40 * (1 - Math.exp(-r / 7.5)) - off * 0.6 + 0.005 * Math.sin(r * 2.1); }
  // 时序预测：归一化后的 RMSE / MAE，随轮次下降
  function rmseAt(r, off) { return 0.62 * Math.exp(-r / 9) + 0.11 + off * 0.8 + 0.008 * Math.sin(r * 1.3); }
  function maeAt(r, off) { return rmseAt(r, off) * 0.74 + 0.004 * Math.cos(r * 1.9); }

  /** 按任务类型算某一轮的指标，返回 { metric_key: value }。 */
  function metricsAt(taskType, r, off) {
    if (taskType === 'timeseries') {
      return { rmse: Number(rmseAt(r, off).toFixed(4)), mae: Number(maeAt(r, off).toFixed(4)) };
    }
    return { loss: Number(lossAt(r, off).toFixed(4)), accuracy: Number(accAt(r, off).toFixed(4)) };
  }

  /* ================= SSE 总线 ================= */

  const bus = {};
  function emit(path, event, data) {
    (bus[path] || []).forEach(function (sub) {
      if (sub.handlers[event]) sub.handlers[event](data);
    });
  }
  function subscribe(path, handlers) {
    const sub = { handlers: handlers };
    (bus[path] = bus[path] || []).push(sub);
    return {
      close: function () {
        bus[path] = (bus[path] || []).filter(function (s) { return s !== sub; });
      }
    };
  }

  /* ================= 静态数据 ================= */

  const db = {
    user: { user_id: 'u_1001', display_name: 'Rui', avatar_text: 'R', avatar_url: null, roles: ['admin'] },
    platform: {
      platform_name: '隐私计算平台',
      environment: 'demo',
      environment_label: '演示数据 · 非真实业务环境',
      version: '1.0.0'
    },
    projects: [
      { project_id: 'p1', name: '风控联合建模 · 2026Q3', type: 'production', created_at: '2026-07-01T10:00:00+08:00' },
      { project_id: 'p2', name: '营销人群拓展 · 试点', type: 'pilot', created_at: '2026-08-12T09:30:00+08:00' },
      { project_id: 'p3', name: '跨机构反欺诈 · 沙箱', type: 'sandbox', created_at: '2026-09-01T14:20:00+08:00' }
    ],
    nodes: {
      p1: [
        { node_id: 'node-shanghai-01', ip: '10.22.6.14', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-A', online: true },
        { node_id: 'node-hangzhou-02', ip: '10.31.8.27', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-B', online: true },
        { node_id: 'node-center-agg', ip: '10.10.1.5', port: 9090, role: 'aggregator', role_label: '聚合方 / 协调节点', data_partition: null, online: true }
      ],
      p2: [
        { node_id: 'node-shenzhen-05', ip: '10.51.2.8', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-A', online: true },
        { node_id: 'node-chengdu-06', ip: '10.62.7.19', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-B', online: true },
        { node_id: 'node-center-agg-2', ip: '10.10.1.6', port: 9090, role: 'aggregator', role_label: '聚合方 / 协调节点', data_partition: null, online: true }
      ],
      p3: [
        { node_id: 'node-beijing-11', ip: '10.70.4.3', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-A', online: true },
        { node_id: 'node-tianjin-12', ip: '10.71.4.9', port: 8471, role: 'trainer', role_label: '参与方 / 训练节点', data_partition: 'part-B', online: true },
        { node_id: 'node-center-agg-3', ip: '10.10.1.7', port: 9090, role: 'aggregator', role_label: '聚合方 / 协调节点', data_partition: null, online: true }
      ]
    },
    flJobs: {},      // job_id -> job
    heKeys: {},      // key_id -> key
    heCiphers: {},   // ciphertext_id -> ct
    mpcTasks: {},    // task_id -> task
    psiPipelines: {},
    psiTemplates: {},
    datasets: {},    // dataset_id -> dataset
    files: {},       // file_id -> file
    seeded: {},      // project_id -> true
    seq: 0
  };

  /* --- 数据集种子：每个项目两方各一张用户表，参与方 A 另有一张交易流水时序表 --- */
  const PSI_PARTIES = [
    { party_id: 'party-a', party_name: '参与方 A' },
    { party_id: 'party-b', party_name: '参与方 B' }
  ];
  function partyName(id) {
    const p = PSI_PARTIES.filter(function (x) { return x.party_id === id; })[0];
    return p ? p.party_name : id;
  }
  function featureCols(prefix, n) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push({ name: prefix + '_' + String(i).padStart(2, '0'), type: 'float' });
    return out;
  }
  const DATASET_SEED = [
    {
      key: 'a_user', party_id: 'party-a', name: '用户画像表', source_type: 'database',
      source: { jdbc_url: 'jdbc:mysql://10.22.6.14:3306/risk', table: 'user_profile' },
      row_count: 1200000, id_column: 'phone_hash', time_column: null,
      columns: [{ name: 'phone_hash', type: 'string' }, { name: 'id_card_hash', type: 'string' }].concat(featureCols('a_feat', 32))
    },
    {
      key: 'b_user', party_id: 'party-b', name: '信贷行为表', source_type: 'database',
      source: { jdbc_url: 'jdbc:postgresql://10.31.8.27:5432/credit', table: 'loan_behavior' },
      row_count: 864000, id_column: 'phone_hash', time_column: null,
      columns: [{ name: 'phone_hash', type: 'string' }, { name: 'label', type: 'int' }].concat(featureCols('b_feat', 36))
    },
    {
      key: 'a_txn_ts', party_id: 'party-a', name: '日交易流水（时序）', source_type: 'hdfs',
      source: { path: 'hdfs://10.22.6.14:8020/warehouse/txn_daily' },
      row_count: 3650000, id_column: 'phone_hash', time_column: 'txn_date',
      columns: [{ name: 'phone_hash', type: 'string' }, { name: 'txn_date', type: 'date' }, { name: 'txn_amount', type: 'float' }].concat(featureCols('ts_feat', 8))
    }
  ];

  function datasetView(ds) {
    return {
      dataset_id: ds.dataset_id, project_id: ds.project_id, name: ds.name,
      party_id: ds.party_id, party_name: partyName(ds.party_id),
      source_type: ds.source_type, source: ds.source,
      status: ds.status, row_count: ds.status === 'ready' ? ds.row_count : null,
      columns: ds.columns, feature_count: ds.columns.filter(function (c) {
        return c.name !== ds.id_column && c.name !== ds.time_column && c.name !== 'label' && c.name !== 'id_card_hash';
      }).length,
      id_column: ds.id_column, time_column: ds.time_column,
      error: ds.error || null, created_at: ds.created_at
    };
  }

  function nextId(prefix) { db.seq += 1; return prefix + '_' + String(db.seq).padStart(4, '0'); }

  const ALGO_CN = { lr: '逻辑回归', xgb: 'XGBoost', cnn: 'CNN', lstm: 'LSTM', tcn: 'TCN', custom: '自定义上传模型' };

  /** 任务类型目录（GET /fl/task-types）。指标卡、曲线量纲、CSV 列都按 metrics 走。 */
  const TASK_TYPES = [
    {
      task_type: 'classification', name: '分类', description: '二分类 / 多分类，如风控违约预测',
      algorithms: ['lr', 'xgb', 'cnn', 'custom'],
      metrics: [
        { key: 'loss', label: 'Loss', y_min: 0, y_max: 1, better: 'lower', digits: 4 },
        { key: 'accuracy', label: 'Accuracy', y_min: 0.5, y_max: 1, better: 'higher', digits: 4 }
      ],
      requires_timeseries: false
    },
    {
      task_type: 'timeseries', name: '时序预测', description: '按时间窗口预测未来值，如交易额、流量预测',
      algorithms: ['lstm', 'tcn', 'custom'],
      metrics: [
        { key: 'rmse', label: 'RMSE（归一化）', y_min: 0, y_max: 1, better: 'lower', digits: 4 },
        { key: 'mae', label: 'MAE（归一化）', y_min: 0, y_max: 0.8, better: 'lower', digits: 4 }
      ],
      requires_timeseries: true
    }
  ];
  function taskTypeOf(t) { return TASK_TYPES.filter(function (x) { return x.task_type === t; })[0]; }

  const HE_SCHEMES = [
    { scheme: 'paillier', name: 'Paillier', description: '半同态 · 整数加、数乘', library: 'Pyfhel (Paillier)', input_type: 'integer', supported_ops: ['add_ct_ct', 'mul_ct_pt'], key_params: { key_size_bits: 2048 } },
    { scheme: 'ckks', name: 'CKKS', description: '全同态 · 浮点近似计算', library: 'SEAL TenSEAL (CKKS)', input_type: 'float', supported_ops: ['add_ct_ct', 'mul_ct_ct', 'mul_ct_pt'], key_params: { poly_modulus_degree: 8192 } },
    { scheme: 'bgv', name: 'BGV', description: '全同态 · 整数精确计算', library: 'SEAL (BGV)', input_type: 'integer_exact', supported_ops: ['add_ct_ct', 'mul_ct_ct', 'mul_ct_pt'], key_params: { poly_modulus_degree: 8192 } }
  ];

  const MPC_OPERATORS = {
    ss: [{ key: 'secure_product', name: '安全求积' }, { key: 'secure_mean', name: '安全求均值' }],
    gc: [{ key: 'secure_compare', name: '安全比较' }, { key: 'logic_op', name: '逻辑运算' }],
    ot: [{ key: 'vector_ot', name: '向量 OT' }]
  };
  const MPC_EST = {
    ss: { compute: 26, comm: 22 },
    gc: { compute: 42, comm: 68 },
    ot: { compute: 18, comm: 31 }
  };
  const MPC_PARTY_DEFS = [
    { party_id: 'party-a', tag: 'A', name: '参与方 A', role: 'input', ip: '10.22.6.14', f: 1.0 },
    { party_id: 'party-b', tag: 'B', name: '参与方 B', role: 'compute', ip: '10.31.8.27', f: 1.08 },
    { party_id: 'party-c', tag: 'C', name: '参与方 C', role: 'output', ip: '10.44.2.61', f: 2.35 }
  ];
  const MPC_HISTORY = [
    { task_id: 'mpc-20260918-07', protocol: 'ss', operator: 'secure_mean', party_count: 3, total_comm_bytes: 193566310, total_duration_sec: 72, finished_at: '2026-09-18T16:42:00+08:00', status: 'finished' },
    { task_id: 'mpc-20260917-12', protocol: 'gc', operator: 'secure_compare', party_count: 3, total_comm_bytes: 642043084, total_duration_sec: 228, finished_at: '2026-09-17T11:05:00+08:00', status: 'finished' },
    { task_id: 'mpc-20260915-03', protocol: 'ot', operator: 'vector_ot', party_count: 4, total_comm_bytes: 100768154, total_duration_sec: 51, finished_at: '2026-09-15T09:27:00+08:00', status: 'finished' },
    { task_id: 'mpc-20260912-21', protocol: 'ss', operator: 'secure_product', party_count: 3, total_comm_bytes: 213714534, total_duration_sec: 90, finished_at: '2026-09-12T20:14:00+08:00', status: 'finished' }
  ];

  const PSI_PROTOCOLS = [
    {
      protocol: 'ecdh', name: 'ECDH-PSI', description: '基于椭圆曲线，通信量小，适合两方中等规模集合',
      params: [
        { key: 'curve', label: '椭圆曲线', value: 'Curve25519', display: 'Curve25519', editable: true },
        { key: 'hash', label: '哈希算法', value: 'SHA-256', display: 'SHA-256（point hashing）', editable: true },
        { key: 'batch_size', label: '分块大小', value: 8192, display: '8 192 条 / 批', editable: true },
        { key: 'point_compression', label: '曲线点压缩', value: true, display: '开启', editable: true }
      ]
    },
    {
      protocol: 'kkrt', name: 'KKRT（基于 OT）', description: '基于不经意传输扩展，大集合下计算最快，通信量较高',
      params: [
        { key: 'ot_security_lambda', label: 'OT 扩展安全参数 λ', value: 128, display: '128', editable: true },
        { key: 'cuckoo_bucket_factor', label: '布谷鸟哈希桶数', value: 1.27, display: '1.27 n', editable: true },
        { key: 'hash_count', label: '哈希函数个数', value: 3, display: '3', editable: true },
        { key: 'bloom_fpr_log2', label: '布隆过滤器假阳率', value: -40, display: '2⁻⁴⁰', editable: true }
      ]
    },
    {
      protocol: 'unbalanced', name: '非平衡 PSI', description: '两方集合规模差距大时使用，小集合方开销显著降低',
      params: [
        { key: 'small_set_party_id', label: '小集合持有方', value: 'party-b', display: '参与方 B（12 万条）', editable: true },
        { key: 'oprf_batch_size', label: 'OPRF 批大小', value: 4096, display: '4 096', editable: true },
        { key: 'preprocess_cache_ttl_hours', label: '大集合预处理缓存', value: 24, display: '开启（TTL 24 h）', editable: true },
        { key: 'poly_degree', label: '多项式插值次数', value: 1305, display: '1 305', editable: true }
      ]
    }
  ];

  /* ================= 联邦学习引擎 ================= */

  function defaultDp() {
    return {
      enabled: true, mechanism: 'gaussian', epsilon_total: 2.0, clip_norm: 1.0,
      delta: '1e-5', total_rounds: TOTAL_ROUNDS, provider: 'secretflow-native', updated_at: NOW()
    };
  }

  function createJob(projectId, body) {
    const id = 'fl_' + projectId + '_' + String(db.seq += 1).padStart(3, '0');
    const taskType = body.task_type || 'classification';
    const job = {
      job_id: id,
      project_id: projectId,
      name: body.name || ((taskTypeOf(taskType) || TASK_TYPES[0]).name + '任务 ' + id.slice(-3)),
      task_type: taskType,
      status: 'Created',
      algorithm: body.algorithm || (taskType === 'timeseries' ? 'lstm' : 'xgb'),
      model_file_id: body.model_file_id || null,
      aggregation: body.aggregation || 'he',
      node_ids: body.node_ids || (db.nodes[projectId] || []).map(function (n) { return n.node_id; }),
      dataset_source: body.dataset_source || null,
      timeseries: taskType === 'timeseries' ? Object.assign({ time_column: 'txn_date', window_size: 30, horizon: 7 }, body.timeseries || {}) : null,
      total_rounds: body.total_rounds || TOTAL_ROUNDS,
      current_round: 0,
      elapsed_sec: 0,
      dp_enabled: body.dp_enabled !== undefined ? body.dp_enabled : true,
      created_at: NOW(),
      started_at: null,
      finished_at: null,
      failure_reason: null,
      metrics: [],
      dp: defaultDp(),
      dp_audit: [],
      _timer: null
    };
    db.flJobs[id] = job;
    return job;
  }

  /** 首次访问项目时播种：数据集 + 一个已完成的时序任务（历史）+ 一个待启动的分类任务。 */
  function seedProject(projectId) {
    if (db.seeded[projectId]) return;
    db.seeded[projectId] = true;
    const day = 86400000;
    DATASET_SEED.forEach(function (s, i) {
      const id = 'ds_' + projectId + '_' + s.key;
      db.datasets[id] = {
        dataset_id: id, project_id: projectId, name: s.name, party_id: s.party_id,
        source_type: s.source_type, source: s.source, status: 'ready',
        row_count: s.row_count, columns: s.columns, id_column: s.id_column, time_column: s.time_column,
        created_at: new Date(Date.now() - (20 - i) * day).toISOString()
      };
    });
    const ts = createJob(projectId, {
      name: '日交易额预测 · LSTM', task_type: 'timeseries', algorithm: 'lstm', aggregation: 'ss', total_rounds: 20,
      dataset_source: { type: 'dataset', dataset_ids: ['ds_' + projectId + '_a_txn_ts'] },
      timeseries: { time_column: 'txn_date', window_size: 30, horizon: 7 }
    });
    ts.created_at = new Date(Date.now() - 3 * day).toISOString();
    ts.started_at = new Date(Date.now() - 3 * day + 60000).toISOString();
    for (let r = 1; r <= ts.total_rounds; r++) ts.metrics.push(roundEntry(ts, r));
    ts.current_round = ts.total_rounds;
    ts.elapsed_sec = Number((ts.total_rounds * 4.2).toFixed(1));
    ts.status = 'Success';
    ts.finished_at = new Date(Date.now() - 3 * day + 150000).toISOString();
    createJob(projectId, {
      name: '违约预测 · XGBoost',
      dataset_source: { type: 'dataset', dataset_ids: ['ds_' + projectId + '_a_user', 'ds_' + projectId + '_b_user'] }
    });
  }

  function jobsOfProject(projectId) {
    seedProject(projectId);
    return Object.keys(db.flJobs).map(function (k) { return db.flJobs[k]; })
      .filter(function (j) { return j.project_id === projectId; })
      .reverse();   // 最新在前
  }

  function jobOfProject(projectId) {
    const list = jobsOfProject(projectId);
    return list.length ? list[0] : createJob(projectId, {});
  }

  function jobNodes(job) {
    return (db.nodes[job.project_id] || []).filter(function (n) { return job.node_ids.indexOf(n.node_id) >= 0; });
  }

  const NODE_OFFSETS = [0.05, -0.025, 0.09, 0.03, -0.01];

  function roundEntry(job, r) {
    const nodeMetrics = jobNodes(job).map(function (nd, i) {
      return Object.assign({ node_id: nd.node_id }, metricsAt(job.task_type, r, NODE_OFFSETS[i % NODE_OFFSETS.length]), {
        upload_kb: Number((148 * (1 + (i * 0.06)) + (r % 5) * 3.4).toFixed(1))
      });
    });
    return { round: r, recorded_at: NOW(), global: metricsAt(job.task_type, r, 0), nodes: nodeMetrics };
  }

  function aggregationInfo(job) {
    if (job.aggregation === 'he') {
      return { type: 'he', threshold: null, share_count: null, he_key_ready: true, he_public_key_id: 'hek_' + hashHex(job.job_id, 1).slice(0, 4) };
    }
    return { type: 'ss', threshold: 2, share_count: 3, he_key_ready: null, he_public_key_id: null };
  }

  function jobView(job) {
    const r = job.current_round;
    const last = job.metrics[job.metrics.length - 1];
    const prev = job.metrics[job.metrics.length - 2];
    const remaining = Math.max(0, job.total_rounds - r) * 4.2;
    const tt = taskTypeOf(job.task_type);
    const pick = function (m, k) { return m && m.global[k] !== undefined ? m.global[k] : null; };
    return {
      job_id: job.job_id,
      project_id: job.project_id,
      name: job.name,
      task_type: job.task_type,
      metrics_spec: tt.metrics,
      status: job.status,
      algorithm: job.algorithm,
      model_file_id: job.model_file_id,
      aggregation: job.aggregation,
      aggregation_info: aggregationInfo(job),
      node_ids: job.node_ids.slice(),
      dataset_source: job.dataset_source,
      timeseries: job.timeseries,
      current_round: r,
      total_rounds: job.total_rounds,
      progress_pct: Math.round((r / job.total_rounds) * 100),
      global_metrics: last ? Object.assign({}, last.global) : null,
      global_metrics_prev: prev ? Object.assign({}, prev.global) : null,
      global_loss: pick(last, 'loss'),
      global_loss_prev: pick(prev, 'loss'),
      global_accuracy: pick(last, 'accuracy'),
      global_accuracy_prev: pick(prev, 'accuracy'),
      elapsed_sec: job.elapsed_sec,
      eta_sec: job.status === 'Success' ? 0 : (r === 0 ? null : remaining),
      dp_enabled: job.dp_enabled,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      failure_reason: job.failure_reason
    };
  }

  /** POST /projects/{id}/fl/jobs 请求体校验，返回错误包或 null。 */
  function validateJobBody(projectId, body) {
    const tt = taskTypeOf(body.task_type || 'classification');
    if (!tt) return err(40000, '未知任务类型 ' + body.task_type);
    if (!body.algorithm) return err(40000, 'algorithm 必填');
    if (tt.algorithms.indexOf(body.algorithm) < 0) {
      return err(40000, tt.name + '任务不支持算法 ' + body.algorithm + '，可选：' + tt.algorithms.join(' / '));
    }
    if (body.algorithm === 'custom') {
      if (!body.model_file_id) return err(40000, '自定义模型需要先上传模型文件');
      if (!db.files[body.model_file_id]) return err(40400, '模型文件不存在：' + body.model_file_id);
    }
    if (['ss', 'he'].indexOf(body.aggregation) < 0) return err(40000, 'aggregation 必须是 ss 或 he');
    if (body.total_rounds !== undefined) {
      const n = Number(body.total_rounds);
      if (!Number.isInteger(n) || n < 1 || n > 200) return err(40003, '聚合轮次必须是 1 – 200 的整数');
    }
    const nodes = db.nodes[projectId] || [];
    const ids = body.node_ids || [];
    const picked = nodes.filter(function (n) { return ids.indexOf(n.node_id) >= 0; });
    if (picked.length !== ids.length) return err(40400, '存在不属于本项目的节点');
    const trainers = picked.filter(function (n) { return n.role === 'trainer'; }).length;
    const aggs = picked.filter(function (n) { return n.role === 'aggregator'; }).length;
    if (trainers < 2 || aggs < 1) return err(40000, '至少选择 2 个训练节点和 1 个聚合节点');
    const src = body.dataset_source;
    if (src && src.type === 'dataset') {
      const list = (src.dataset_ids || []).map(function (id) { return db.datasets[id]; });
      if (!list.length || list.some(function (d) { return !d || d.project_id !== projectId; })) {
        return err(40400, '数据集不存在或不属于本项目');
      }
      if (list.some(function (d) { return d.status !== 'ready'; })) return err(40901, '数据集尚未接入完成');
    }
    if (src && src.type === 'psi_pipeline') {
      const pipe = db.psiPipelines[src.pipeline_id];
      if (!pipe || pipe.project_id !== projectId) return err(40400, 'PSI 流水线不存在');
      if (pipe.status !== 'finished') return err(40901, 'PSI 流水线尚未完成');
    }
    if (tt.requires_timeseries) {
      const ts = body.timeseries || {};
      if (!ts.time_column) return err(40000, '时序任务必须指定时间列 time_column');
      if (!Number.isInteger(ts.window_size) || ts.window_size < 1 || ts.window_size > 365) return err(40003, '回看窗口必须是 1 – 365 的整数');
      if (!Number.isInteger(ts.horizon) || ts.horizon < 1 || ts.horizon > 90) return err(40003, '预测步长必须是 1 – 90 的整数');
      if (src && src.type === 'dataset') {
        const hasTime = src.dataset_ids.some(function (id) {
          return db.datasets[id].columns.some(function (c) { return c.name === ts.time_column; });
        });
        if (!hasTime) return err(40000, '所选数据集中没有时间列 ' + ts.time_column);
      }
    }
    return null;
  }

  function stopJobTimer(job) {
    if (job._timer) { clearInterval(job._timer); job._timer = null; }
  }

  function jobTick(job) {
    if (job.current_round >= job.total_rounds) {
      stopJobTimer(job);
      job.status = 'Success';
      job.finished_at = NOW();
      emit('/fl/jobs/' + job.job_id + '/events', 'status_changed', { job_id: job.job_id, status: 'Success', previous_status: 'Running', at: NOW() });
      return;
    }
    const r = job.current_round + 1;
    job.current_round = r;
    job.elapsed_sec = Math.round((job.elapsed_sec + 4.2) * 10) / 10;

    const entry = roundEntry(job, r);
    const nodeMetrics = entry.nodes;
    job.metrics.push(entry);

    let dpPayload = null;
    if (job.dp_enabled && job.dp.enabled) {
      const perRound = job.dp.epsilon_total / job.dp.total_rounds;
      job.dp_audit.push({
        round: r,
        epsilon_spent: Number(perRound.toFixed(4)),
        mechanism: job.dp.mechanism,
        noise_scale: Number(noiseScale(job.dp).toFixed(3)),
        delta: job.dp.mechanism === 'gaussian' ? job.dp.delta : null,
        clip_norm: job.dp.clip_norm,
        recorded_at: NOW()
      });
      dpPayload = { epsilon_spent: Number(perRound.toFixed(4)), epsilon_used: Number((perRound * r).toFixed(4)) };
    }

    emit('/fl/jobs/' + job.job_id + '/events', 'round_completed', {
      job_id: job.job_id,
      round: r,
      global_metrics: Object.assign({}, entry.global),
      global_loss: entry.global.loss !== undefined ? entry.global.loss : null,
      global_accuracy: entry.global.accuracy !== undefined ? entry.global.accuracy : null,
      node_metrics: nodeMetrics,
      elapsed_sec: job.elapsed_sec,
      eta_sec: Math.max(0, job.total_rounds - r) * 4.2,
      dp: dpPayload
    });
  }

  function startJobTimer(job) {
    stopJobTimer(job);
    job._timer = setInterval(function () { jobTick(job); }, 650);
  }

  const FL_TRANSITIONS = {
    Created: { start: 'Running', reset: 'Created' },
    Running: { pause: 'Paused', terminate: 'Terminated' },
    Paused: { resume: 'Running', terminate: 'Terminated', reset: 'Created' },
    Success: { reset: 'Created' },
    Failed: { start: 'Running', reset: 'Created' },
    Terminated: { start: 'Running', reset: 'Created' }
  };

  function flAction(job, action) {
    const allowed = FL_TRANSITIONS[job.status] || {};
    if (!allowed[action]) {
      return err(40901, '当前状态 ' + job.status + ' 不允许执行 ' + action, {
        status: job.status, allowed_actions: Object.keys(allowed)
      });
    }
    const prev = job.status;
    if (action === 'start') {
      stopJobTimer(job);
      job.status = 'Running';
      job.current_round = 0;
      job.elapsed_sec = 0;
      job.metrics = [];
      job.dp_audit = [];
      job.started_at = NOW();
      job.finished_at = null;
      startJobTimer(job);
    } else if (action === 'pause') {
      stopJobTimer(job);
      job.status = 'Paused';
    } else if (action === 'resume') {
      job.status = 'Running';
      startJobTimer(job);
    } else if (action === 'terminate') {
      stopJobTimer(job);
      job.status = 'Terminated';
      job.finished_at = NOW();
    } else if (action === 'reset') {
      stopJobTimer(job);
      job.status = 'Created';
      job.current_round = 0;
      job.elapsed_sec = 0;
      job.metrics = [];
      job.dp_audit = [];
      job.started_at = null;
      job.finished_at = null;
    }
    emit('/fl/jobs/' + job.job_id + '/events', 'status_changed', {
      job_id: job.job_id, status: job.status, previous_status: prev, at: NOW()
    });
    return ok(jobView(job));
  }

  function flNodeStatus(job, index) {
    if (job.current_round === 0) return 'pending';
    if (job.status === 'Running') return 'uploading';
    if (job.status === 'Paused') return 'suspended';
    if (job.status === 'Terminated') return 'released';
    return 'completed';
  }

  /* ================= 同态加密引擎 ================= */

  function schemeOf(s) { return HE_SCHEMES.filter(function (x) { return x.scheme === s; })[0]; }

  function heTiming(scheme) {
    if (scheme === 'paillier') return { enc: 3.4, addOp: 0.8, mulOp: 1.1, dec: 4.2, ct: 0.52 };
    if (scheme === 'ckks') return { enc: 18.6, addOp: 7.4, mulOp: 46.3, dec: 12.8, ct: 262.1 };
    return { enc: 24.1, addOp: 7.4, mulOp: 46.3, dec: 16.5, ct: 318.4 };
  }

  /* ================= MPC 引擎 ================= */

  function createMpcTask(projectId, body) {
    const id = 'mpc-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(db.seq += 1).padStart(2, '0');
    const task = {
      task_id: id,
      project_id: projectId,
      protocol: body.protocol || 'ss',
      operator: body.operator || MPC_OPERATORS[body.protocol || 'ss'][0].key,
      status: 'pending',
      tick: 0,
      started_at: null,
      finished_at: null,
      _timer: null
    };
    db.mpcTasks[id] = task;
    return task;
  }

  function mpcView(task) {
    const t = task.tick;
    const comms = MPC_PARTY_DEFS.map(function (p) { return p.f * t * 1.8; });
    const avg = (comms[0] + comms[1] + comms[2]) / 3;
    const alarms = [];
    const parties = MPC_PARTY_DEFS.map(function (p, i) {
      const c = comms[i];
      const anom = t > 4 && c > avg * 1.35;
      if (anom) {
        alarms.push({
          alarm_id: 'al_' + task.task_id + '_' + p.party_id,
          type: 'comm_anomaly',
          party_id: p.party_id,
          ratio_to_mean: Number((c / avg).toFixed(2)),
          message: '检测到' + p.name + '的通信量为三方均值的 ' + (c / avg).toFixed(2) + ' 倍，显著偏离基线，建议检查其网络链路与分片规模。',
          raised_at: NOW()
        });
      }
      return {
        party_id: p.party_id, tag: p.tag, name: p.name, role: p.role, ip: p.ip,
        status: anom ? 'abnormal' : (task.status === 'running' ? 'running' : (t === 0 ? 'pending' : 'finished')),
        comm_bytes: Math.round(c * 1048576),
        compute_sec: Number((p.f * t * 0.42).toFixed(1)),
        interaction_rounds: t * 3
      };
    });
    return {
      task_id: task.task_id,
      protocol: task.protocol,
      operator: task.operator,
      status: task.status,
      parties: parties,
      alarms: alarms,
      started_at: task.started_at,
      finished_at: task.finished_at
    };
  }

  function stopMpcTimer(task) { if (task._timer) { clearInterval(task._timer); task._timer = null; } }

  function startMpcTimer(task) {
    stopMpcTimer(task);
    task._timer = setInterval(function () {
      if (task.tick >= 36) {
        stopMpcTimer(task);
        task.status = 'finished';
        task.finished_at = NOW();
        emit('/mpc/tasks/' + task.task_id + '/events', 'status_changed', { task_id: task.task_id, status: 'finished' });
        return;
      }
      task.tick += 1;
      const view = mpcView(task);
      emit('/mpc/tasks/' + task.task_id + '/events', 'metrics', { parties: view.parties });
      view.alarms.forEach(function (a) {
        emit('/mpc/tasks/' + task.task_id + '/events', 'alarm_raised', a);
      });
    }, 420);
  }

  /* ================= PSI 引擎 ================= */

  const PSI_STAGE_DEFS = [
    { stage: 'intersect', name: '安全求交', seconds: 46, stats: { left_rows: 1200000, right_rows: 864000, intersection_rows: 412000 } },
    { stage: 'align', name: '特征对齐', seconds: 18, stats: { rows: 412000, feature_dim: 68 } },
    { stage: 'train', name: '联合训练', seconds: 92, stats: { rows: 412000 } }
  ];

  /** 校验 parties[]：两方不同、数据集存在且已就绪、求交键列存在。返回错误包或 null。 */
  function validatePipelineBody(projectId, body) {
    if (!PSI_PROTOCOLS.some(function (x) { return x.protocol === body.protocol; })) return err(40000, '未知协议 ' + body.protocol);
    const parties = body.parties || [];
    if (parties.length !== 2) return err(40000, '求交需要恰好两方数据集');
    if (parties[0].party_id === parties[1].party_id) return err(40000, '两方必须是不同参与方');
    for (let i = 0; i < 2; i++) {
      const pt = parties[i];
      const ds = db.datasets[pt.dataset_id];
      if (!ds || ds.project_id !== projectId) return err(40400, '数据集不存在：' + pt.dataset_id);
      if (ds.party_id !== pt.party_id) return err(40000, '数据集 ' + ds.name + ' 不属于 ' + partyName(pt.party_id));
      if (ds.status !== 'ready') return err(40901, '数据集 ' + ds.name + ' 尚未接入完成');
      if (!ds.columns.some(function (c) { return c.name === pt.id_column; })) {
        return err(40000, '数据集 ' + ds.name + ' 中没有列 ' + pt.id_column);
      }
    }
    return null;
  }

  function pipelineStats(pipe) {
    const a = db.datasets[pipe.parties[0].dataset_id];
    const b = db.datasets[pipe.parties[1].dataset_id];
    const left = a ? a.row_count : 0, right = b ? b.row_count : 0;
    const inter = Math.round(Math.min(left, right) * 0.4769 / 1000) * 1000;
    const dim = (a ? datasetView(a).feature_count : 0) + (b ? datasetView(b).feature_count : 0);
    return {
      intersect: { left_rows: left, right_rows: right, intersection_rows: inter },
      align: { rows: inter, feature_dim: dim },
      train: { rows: inter }
    };
  }

  function createPipeline(projectId, body) {
    const id = 'psi_' + projectId + '_' + String(db.seq += 1).padStart(3, '0');
    const pipe = {
      pipeline_id: id,
      project_id: projectId,
      protocol: body.protocol || 'ecdh',
      params: body.params || {},
      parties: body.parties,
      training: body.training || null,
      status: 'pending',
      progress: 0,           // 0..300
      created_at: NOW(),
      finished_at: null,
      fl_job_id: null,
      _timer: null
    };
    db.psiPipelines[id] = pipe;
    return pipe;
  }

  function pipelineView(pipe) {
    const project = db.projects.filter(function (p) { return p.project_id === pipe.project_id; })[0];
    const stats = pipelineStats(pipe);
    const stages = PSI_STAGE_DEFS.map(function (def, i) {
      const raw = pipe.progress - i * 100;
      const pct = Math.max(0, Math.min(100, raw));
      const st = pct >= 100 ? 'finished' : (pct > 0 ? 'running' : 'pending');
      return {
        stage: def.stage,
        name: def.name,
        status: st,
        progress_pct: Math.round(pct),
        duration_sec: pct > 0 ? Number((pct / 100 * def.seconds).toFixed(0)) : null,
        stats: pct > 0 ? stats[def.stage] : {}
      };
    });
    return {
      pipeline_id: pipe.pipeline_id,
      protocol: pipe.protocol,
      parties: pipe.parties.map(function (pt) {
        const ds = db.datasets[pt.dataset_id];
        return Object.assign({}, pt, { party_name: partyName(pt.party_id), dataset_name: ds ? ds.name : null });
      }),
      status: pipe.status,
      stages: stages,
      target_project: project ? { project_id: project.project_id, name: project.name } : null,
      fl_job_id: pipe.fl_job_id,
      error: null,
      created_at: pipe.created_at,
      finished_at: pipe.finished_at
    };
  }

  function stopPipeTimer(pipe) { if (pipe._timer) { clearInterval(pipe._timer); pipe._timer = null; } }

  function startPipeline(pipe) {
    stopPipeTimer(pipe);
    pipe.status = 'running';
    pipe.progress = 0;
    pipe.finished_at = null;
    pipe.fl_job_id = null;
    const path = '/psi/pipelines/' + pipe.pipeline_id + '/events';
    pipe._timer = setInterval(function () {
      if (pipe.progress >= 300) {
        stopPipeTimer(pipe);
        pipe.status = 'finished';
        pipe.finished_at = NOW();
        // 联合训练阶段：按 training.fl_job_config 新建任务，否则把样本挂到项目最新任务上
        const cfg = pipe.training && pipe.training.fl_job_config;
        const job = cfg ? createJob(pipe.project_id, Object.assign({}, cfg, { name: cfg.name || ('PSI 对齐样本训练 · ' + pipe.pipeline_id.slice(-3)) }))
          : jobOfProject(pipe.project_id);
        job.dataset_source = { type: 'psi_pipeline', pipeline_id: pipe.pipeline_id };
        pipe.fl_job_id = job.job_id;
        const v = pipelineView(pipe);
        emit(path, 'pipeline_finished', {
          pipeline_id: pipe.pipeline_id, status: 'finished',
          fl_job_id: pipe.fl_job_id, target_project: v.target_project
        });
        return;
      }
      pipe.progress += 2;
      const view = pipelineView(pipe);
      view.stages.forEach(function (s) { emit(path, 'stage_progress', s); });
    }, 30);
  }

  /* ================= 差分隐私计算 ================= */

  function noiseScale(cfg) {
    const perRound = cfg.epsilon_total / cfg.total_rounds;
    const eps = Math.max(perRound, 0.001);
    if (cfg.mechanism === 'gaussian') {
      const delta = cfg.delta === '1e-4' ? 1e-4 : (cfg.delta === '1e-6' ? 1e-6 : 1e-5);
      return cfg.clip_norm * Math.sqrt(2 * Math.log(1.25 / delta)) / eps;
    }
    return cfg.clip_norm / eps;
  }

  const DP_BASELINE = 0.921;
  function utilityOf(eps, mechanism) {
    return 0.62 + 0.30 * (1 - Math.exp(-eps / 2.2)) - (mechanism === 'gaussian' ? 0 : 0.015);
  }

  function dpEstimate(body) {
    const cfg = {
      mechanism: body.mechanism, epsilon_total: body.epsilon_total,
      clip_norm: body.clip_norm, delta: body.delta, total_rounds: body.total_rounds
    };
    const perRound = cfg.epsilon_total / cfg.total_rounds;
    const scale = noiseScale(cfg);
    const util = utilityOf(cfg.epsilon_total, cfg.mechanism);
    const curve = [];
    for (let i = 1; i <= cfg.total_rounds; i++) {
      curve.push({
        round: i,
        cumulative_epsilon: Number((perRound * i).toFixed(4)),
        estimated_accuracy: Number(utilityOf(cfg.epsilon_total * i / cfg.total_rounds, cfg.mechanism).toFixed(4))
      });
    }
    const bins = body.histogram_bins || 13;
    const half = Math.floor(bins / 2);
    const histogram = [];
    for (let k = -half; k <= half; k++) {
      const x = (k / half) * 3;
      const density = cfg.mechanism === 'gaussian'
        ? Math.exp(-(x * x) / 2)
        : Math.exp(-Math.abs(x) * 0.9);
      histogram.push({ x: Number(x.toFixed(2)), density: Number(density.toFixed(4)) });
    }
    return {
      epsilon_per_round: Number(perRound.toFixed(4)),
      noise_scale: Number(scale.toFixed(3)),
      noise_scale_name: cfg.mechanism === 'gaussian' ? 'sigma' : 'b',
      formula: cfg.mechanism === 'gaussian' ? 'σ = C · √(2 ln(1.25/δ)) / ε_每轮' : 'b = C / ε_每轮',
      baseline_accuracy: DP_BASELINE,
      estimated_accuracy: Number(util.toFixed(3)),
      accuracy_loss: Number((DP_BASELINE - util).toFixed(3)),
      curve: curve,
      histogram: histogram
    };
  }

  /* ================= 路由表 ================= */

  const routes = [];
  function route(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, function (_, k) {
      keys.push(k); return '([^/]+)';
    }) + '$');
    routes.push({ method: method, rx: rx, keys: keys, handler: handler });
  }

  /* --- 公共 --- */
  route('GET', '/me', function () { return ok(db.user); });
  route('GET', '/platform/info', function () { return ok(db.platform); });
  route('GET', '/projects', function () {
    return ok({ items: db.projects, page: 1, page_size: 20, total: db.projects.length });
  });
  // multipart 由 api.js 转成 { file: { name, size }, purpose, project_id }
  route('POST', '/files', function (p, q, body) {
    const f = body.file;
    if (!f || !f.name) return err(40000, 'file 必填');
    if (['fl_model', 'dataset'].indexOf(body.purpose) < 0) return err(40000, 'purpose 必须是 fl_model 或 dataset');
    if (!body.project_id) return err(40000, 'project_id 必填');
    if (f.size > 2 * 1073741824) return err(40003, '单个文件不能超过 2 GB');
    const id = nextId('f');
    const file = {
      file_id: id, file_name: f.name, size_bytes: f.size || 0, purpose: body.purpose,
      sha256: hashHex(f.name + f.size, 8), uploaded_at: NOW()
    };
    db.files[id] = file;
    return ok(file);
  });

  /* --- 联邦学习 --- */
  route('GET', '/fl/task-types', function () { return ok({ items: TASK_TYPES }); });
  route('GET', '/projects/{project_id}/fl/jobs', function (p, q) {
    let list = jobsOfProject(p.project_id);
    if (q.status) {
      const want = q.status.split(',');
      list = list.filter(function (j) { return want.indexOf(j.status) >= 0; });
    }
    if (q.task_type) list = list.filter(function (j) { return j.task_type === q.task_type; });
    if (q.latest === 'true' || q.latest === true) list = list.slice(0, 1);
    return ok({ items: list.map(jobView), page: 1, page_size: 20, total: list.length });
  });
  route('POST', '/projects/{project_id}/fl/jobs', function (p, q, body) {
    seedProject(p.project_id);
    const bad = validateJobBody(p.project_id, body);
    if (bad) return bad;
    return ok(jobView(createJob(p.project_id, body)));
  });
  route('GET', '/fl/jobs/{job_id}', function (p) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    return ok(jobView(job));
  });
  route('PATCH', '/fl/jobs/{job_id}', function (p, q, body) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    if (['Running', 'Paused'].indexOf(job.status) >= 0) {
      return err(40901, '任务运行中不允许修改配置', { status: job.status });
    }
    if (body.algorithm) {
      if (!ALGO_CN[body.algorithm]) return err(40000, '未知算法 ' + body.algorithm);
      const tt = taskTypeOf(job.task_type);
      if (tt.algorithms.indexOf(body.algorithm) < 0) return err(40000, tt.name + '任务不支持算法 ' + body.algorithm);
      if (body.algorithm === 'custom' && !body.model_file_id && !job.model_file_id) {
        return err(40000, '自定义模型需要先上传模型文件');
      }
      job.algorithm = body.algorithm;
    }
    if (body.aggregation) job.aggregation = body.aggregation;
    if (body.total_rounds) job.total_rounds = body.total_rounds;
    if (body.dp_enabled !== undefined) job.dp_enabled = body.dp_enabled;
    return ok(jobView(job));
  });
  route('POST', '/fl/jobs/{job_id}/actions', function (p, q, body) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    return flAction(job, (body || {}).action);
  });
  route('GET', '/fl/jobs/{job_id}/metrics', function (p, q) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    const scope = q.scope || 'global';
    const keys = taskTypeOf(job.task_type).metrics.map(function (s) { return s.key; });
    const point = function (src, m) {
      const out = { round: m.round, recorded_at: m.recorded_at };
      keys.forEach(function (k) { out[k] = src[k]; });
      return out;
    };
    const global = { key: 'global', label: '全局', points: job.metrics.map(function (m) { return point(m.global, m); }) };
    const series = [global];
    if (scope === 'nodes') {
      jobNodes(job).forEach(function (nd) {
        series.push({
          key: nd.node_id, label: nd.node_id,
          points: job.metrics.map(function (m) {
            const hit = m.nodes.filter(function (x) { return x.node_id === nd.node_id; })[0] || {};
            return point(hit, m);
          })
        });
      });
    }
    return ok({ total_rounds: job.total_rounds, metrics_spec: taskTypeOf(job.task_type).metrics, series: series });
  });
  route('GET', '/fl/jobs/{job_id}/he-public-key', function (p) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    if (job.aggregation !== 'he') return err(40400, '当前聚合策略不是同态加密聚合');
    return ok({
      key_id: aggregationInfo(job).he_public_key_id,
      scheme: 'paillier',
      key_size_bits: 2048,
      public_key: hashHex('agg' + job.job_id, 8),
      fingerprint: 'SHA256:' + hashHex('fp' + job.job_id, 2).slice(0, 32),
      created_at: job.created_at
    });
  });
  route('GET', '/fl/jobs/{job_id}/nodes', function (p) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    const last = job.metrics[job.metrics.length - 1];
    const items = jobNodes(job).map(function (nd, i) {
      const m = last ? last.nodes.filter(function (x) { return x.node_id === nd.node_id; })[0] : null;
      return {
        node_id: nd.node_id, ip: nd.ip, port: nd.port, role: nd.role, role_label: nd.role_label,
        data_partition: nd.data_partition,
        round_upload_kb: m ? m.upload_kb : null,
        status: flNodeStatus(job, i)
      };
    });
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });
  route('GET', '/projects/{project_id}/nodes', function (p) {
    const items = db.nodes[p.project_id] || [];
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });
  route('POST', '/projects/{project_id}/nodes', function (p, q, body) {
    const list = db.nodes[p.project_id] || (db.nodes[p.project_id] = []);
    if (!body.node_id || !/^[a-z0-9-]+$/.test(body.node_id)) {
      return err(40000, '节点 ID 只能包含小写字母、数字和短横线');
    }
    if (list.some(function (n) { return n.node_id === body.node_id; })) {
      return err(40902, '节点 ' + body.node_id + ' 已存在');
    }
    if (!body.ip || !body.port) return err(40000, 'IP 与端口必填');
    if (body.role === 'trainer' && !body.data_partition) return err(40000, '训练节点必须指定数据分区');
    const node = {
      node_id: body.node_id, ip: body.ip, port: Number(body.port), role: body.role,
      role_label: body.role === 'aggregator' ? '聚合方 / 协调节点' : '参与方 / 训练节点',
      data_partition: body.data_partition || null, online: true
    };
    list.push(node);
    return ok(node);
  });
  route('DELETE', '/projects/{project_id}/nodes/{node_id}', function (p) {
    const list = db.nodes[p.project_id] || [];
    const idx = list.findIndex(function (n) { return n.node_id === p.node_id; });
    if (idx < 0) return err(40400, '节点不存在');
    list.splice(idx, 1);
    return ok({ node_id: p.node_id, deleted: true });
  });

  /* --- 同态加密 --- */
  route('GET', '/he/schemes', function () { return ok({ items: HE_SCHEMES }); });
  route('POST', '/he/keys', function (p, q, body) {
    const sch = schemeOf(body.scheme);
    if (!sch) return err(40000, '未知加密方案 ' + body.scheme);
    const id = nextId('hek');
    const key = {
      key_id: id, scheme: body.scheme, project_id: body.project_id,
      key_params: sch.key_params,
      public_key_preview: hashHex('pk' + body.scheme + id, 5).slice(0, 56),
      elapsed_ms: 8.5,
      created_at: NOW(),
      expires_at: new Date(Date.now() + 86400000).toISOString()
    };
    db.heKeys[id] = key;
    return ok(key);
  });
  route('POST', '/he/encrypt', function (p, q, body) {
    const key = db.heKeys[body.key_id];
    if (!key) return err(40402, '密钥不存在、已销毁或已过期');
    const prec = body.precision;
    if (typeof prec !== 'number' || prec < 0 || prec > 8) return err(40003, '精度必须在 0 – 8 之间');
    const timing = heTiming(key.scheme);
    const scale = Math.pow(10, prec);
    const cts = [];
    for (let i = 0; i < body.values.length; i++) {
      const v = body.values[i];
      const num = parseFloat(v.value);
      if (Number.isNaN(num)) return err(40002, '明文 ' + v.name + ' 不是合法数值：' + v.value);
      const ctId = nextId('hec');
      const encoded = Math.round(num * scale);
      db.heCiphers[ctId] = { ciphertext_id: ctId, key_id: key.key_id, plain: num, precision: prec };
      cts.push({
        name: v.name, ciphertext_id: ctId,
        preview: hashHex(v.name + encoded + key.scheme, 5).slice(0, 56),
        size_kb: timing.ct,
        encoded_integer: key.scheme === 'paillier' ? String(encoded) : null
      });
    }
    return ok({ ciphertexts: cts, scale_exponent: prec, elapsed_ms: Number((timing.enc * body.values.length).toFixed(1)) });
  });
  route('POST', '/he/evaluate', function (p, q, body) {
    const key = db.heKeys[body.key_id];
    if (!key) return err(40402, '密钥不存在、已销毁或已过期');
    const left = db.heCiphers[body.left_ciphertext_id];
    if (!left) return err(40400, '左操作数密文不存在');
    const hasCt = !!body.right_ciphertext_id;
    const hasPt = body.right_plaintext !== undefined && body.right_plaintext !== null;
    if (hasCt === hasPt) return err(40000, 'right_ciphertext_id 与 right_plaintext 必须二选一');
    if (key.scheme === 'paillier' && body.op === 'mul' && hasCt) {
      return err(40001, 'Paillier 不支持密文乘密文');
    }
    const timing = heTiming(key.scheme);
    let result;
    if (hasCt) {
      const right = db.heCiphers[body.right_ciphertext_id];
      if (!right) return err(40400, '右操作数密文不存在');
      result = body.op === 'mul' ? left.plain * right.plain : left.plain + right.plain;
    } else {
      const rp = parseFloat(body.right_plaintext);
      if (Number.isNaN(rp)) return err(40002, '明文操作数不是合法数值');
      result = body.op === 'mul' ? left.plain * rp : left.plain + rp;
    }
    const ctId = nextId('hec');
    db.heCiphers[ctId] = { ciphertext_id: ctId, key_id: key.key_id, plain: result, precision: left.precision };
    const isMul = body.op === 'mul';
    return ok({
      result_ciphertext_id: ctId,
      expression: isMul ? (hasCt ? 'Enc(A) ⊗ Enc(B)' : 'Enc(A) ⊗ b') : 'Enc(A) ⊕ Enc(B)',
      preview: hashHex('r' + result + body.op + key.scheme, 5).slice(0, 56),
      size_kb: Number((timing.ct * (isMul && hasCt ? 1.9 : 1)).toFixed(1)),
      elapsed_ms: isMul ? timing.mulOp : timing.addOp,
      noise_budget_remaining: key.scheme === 'paillier' ? null : (isMul ? 71 : 98)
    });
  });
  route('POST', '/he/decrypt', function (p, q, body) {
    const key = db.heKeys[body.key_id];
    if (!key) return err(40402, '密钥不存在、已销毁或已过期');
    const ct = db.heCiphers[body.ciphertext_id];
    if (!ct) return err(40400, '密文不存在');
    const timing = heTiming(key.scheme);
    const plaintext = ct.plain.toFixed(ct.precision);
    return ok({
      plaintext: plaintext,
      elapsed_ms: timing.dec,
      verification: body.verify === false ? null : {
        expected: plaintext, matched: true, abs_error: (0).toFixed(ct.precision)
      },
      session_summary: {
        total_elapsed_ms: Number((8.5 + timing.enc * 2 + timing.addOp + timing.dec).toFixed(1)),
        total_ciphertext_kb: Number((timing.ct * 3).toFixed(1)),
        logged: true
      }
    });
  });
  route('DELETE', '/he/keys/{key_id}', function (p) {
    if (!db.heKeys[p.key_id]) return err(40402, '密钥不存在或已销毁');
    delete db.heKeys[p.key_id];
    Object.keys(db.heCiphers).forEach(function (k) {
      if (db.heCiphers[k].key_id === p.key_id) delete db.heCiphers[k];
    });
    return ok({ key_id: p.key_id, destroyed: true });
  });

  /* --- MPC --- */
  route('GET', '/projects/{project_id}/mpc/estimate', function (p, q) {
    const proto = q.protocol || 'ss';
    const est = MPC_EST[proto];
    if (!est) return err(40000, '未知协议 ' + proto);
    return ok({
      protocol: proto,
      operators: MPC_OPERATORS[proto],
      party_count: 3,
      data_rows: 1200000,
      est_compute_sec: est.compute,
      est_comm_sec: est.comm
    });
  });
  route('POST', '/projects/{project_id}/mpc/tasks', function (p, q, body) {
    const task = createMpcTask(p.project_id, body || {});
    if ((body || {}).auto_start !== false) {
      task.status = 'running';
      task.started_at = NOW();
      startMpcTimer(task);
    }
    return ok(mpcView(task));
  });
  route('GET', '/mpc/tasks/{task_id}', function (p) {
    const task = db.mpcTasks[p.task_id];
    if (!task) return err(40400, '任务不存在');
    return ok(mpcView(task));
  });
  route('POST', '/mpc/tasks/{task_id}/actions', function (p, q, body) {
    const task = db.mpcTasks[p.task_id];
    if (!task) return err(40400, '任务不存在');
    const action = (body || {}).action;
    if (action === 'start') {
      if (task.status === 'finished') return err(40901, '任务已结束，请新建任务', { status: task.status });
      task.status = 'running';
      if (!task.started_at) task.started_at = NOW();
      startMpcTimer(task);
    } else if (action === 'stop') {
      stopMpcTimer(task);
      task.status = 'stopped';
    } else if (action === 'reset') {
      stopMpcTimer(task);
      task.status = 'pending';
      task.tick = 0;
      task.started_at = null;
      task.finished_at = null;
    } else {
      return err(40000, '未知动作 ' + action);
    }
    emit('/mpc/tasks/' + task.task_id + '/events', 'status_changed', { task_id: task.task_id, status: task.status });
    return ok(mpcView(task));
  });
  route('GET', '/projects/{project_id}/mpc/tasks', function (p, q) {
    const own = Object.keys(db.mpcTasks).map(function (k) { return db.mpcTasks[k]; })
      .filter(function (t) { return t.project_id === p.project_id && (t.status === 'finished'); })
      .map(function (t) {
        const v = mpcView(t);
        const total = v.parties.reduce(function (s, x) { return s + x.comm_bytes; }, 0);
        return {
          task_id: t.task_id, protocol: t.protocol, operator: t.operator, party_count: v.parties.length,
          total_comm_bytes: total,
          total_duration_sec: Math.max.apply(null, v.parties.map(function (x) { return x.compute_sec; })),
          finished_at: t.finished_at, status: t.status
        };
      });
    const items = own.concat(MPC_HISTORY);
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });

  /* --- 数据接入 --- */
  route('GET', '/psi/parties', function () { return ok({ items: PSI_PARTIES }); });
  route('GET', '/projects/{project_id}/datasets', function (p, q) {
    seedProject(p.project_id);
    const items = Object.keys(db.datasets).map(function (k) { return db.datasets[k]; })
      .filter(function (d) {
        return d.project_id === p.project_id &&
          (!q.party_id || d.party_id === q.party_id) &&
          (!q.status || d.status === q.status) &&
          (q.has_time_column !== 'true' || !!d.time_column);
      })
      .map(datasetView).reverse();
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });
  route('POST', '/projects/{project_id}/datasets', function (p, q, body) {
    seedProject(p.project_id);
    if (!body.name) return err(40000, '数据集名称必填');
    if (!PSI_PARTIES.some(function (x) { return x.party_id === body.party_id; })) return err(40000, '未知参与方 ' + body.party_id);
    const src = body.source || {};
    if (body.source_type === 'file') {
      const f = db.files[src.file_id];
      if (!f) return err(40400, '文件不存在，请先上传');
      if (f.purpose !== 'dataset') return err(40000, '该文件不是数据集文件');
    } else if (body.source_type === 'database') {
      if (!/^jdbc:(mysql|postgresql|oracle|hive2):\/\//.test(src.jdbc_url || '')) return err(40000, 'JDBC 地址格式不正确，例：jdbc:mysql://10.0.0.1:3306/db');
      if (!src.table) return err(40000, '表名必填');
    } else if (body.source_type === 'hdfs') {
      if (!/^hdfs:\/\//.test(src.path || '')) return err(40000, 'HDFS 路径必须以 hdfs:// 开头');
    } else {
      return err(40000, 'source_type 必须是 file / database / hdfs');
    }
    if (!body.id_column || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.id_column)) return err(40000, '求交键列名不合法');
    if (body.time_column && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.time_column)) return err(40000, '时间列名不合法');
    const dup = Object.keys(db.datasets).some(function (k) {
      const d = db.datasets[k];
      return d.project_id === p.project_id && d.party_id === body.party_id && d.name === body.name;
    });
    if (dup) return err(40902, '该参与方下已存在同名数据集');
    const id = nextId('ds');
    const cols = [{ name: body.id_column, type: 'string' }];
    if (body.time_column) cols.push({ name: body.time_column, type: 'date' });
    const nFeat = 6 + (db.seq % 10);
    const ds = {
      dataset_id: id, project_id: p.project_id, name: body.name, party_id: body.party_id,
      source_type: body.source_type, source: src, status: 'importing',
      row_count: 50000 + (parseInt(hashHex(id, 1).slice(0, 4), 16) % 900) * 1000,
      columns: cols.concat(featureCols('feat', nFeat)),
      id_column: body.id_column, time_column: body.time_column || null, created_at: NOW()
    };
    db.datasets[id] = ds;
    setTimeout(function () { ds.status = 'ready'; }, 1200);  // 模拟后台导入 + schema 探测
    return ok(datasetView(ds));
  });
  route('GET', '/datasets/{dataset_id}', function (p) {
    const ds = db.datasets[p.dataset_id];
    if (!ds) return err(40400, '数据集不存在');
    const v = datasetView(ds);
    // 预览只给求交键的脱敏前缀和特征列样例，原始数据不出域
    v.preview = ds.status !== 'ready' ? [] : [0, 1, 2].map(function (i) {
      const row = {};
      ds.columns.slice(0, 6).forEach(function (c, j) {
        row[c.name] = c.name === ds.id_column ? hashHex(ds.dataset_id + i, 1).slice(0, 6) + '…'
          : (c.type === 'date' ? '2026-09-' + String(10 + i).padStart(2, '0')
            : (c.type === 'string' ? '***' : Number((Math.sin(i * 7 + j) * 0.5 + 0.5).toFixed(3))));
      });
      return row;
    });
    return ok(v);
  });
  route('DELETE', '/datasets/{dataset_id}', function (p) {
    const ds = db.datasets[p.dataset_id];
    if (!ds) return err(40400, '数据集不存在');
    const running = Object.keys(db.psiPipelines).some(function (k) {
      const x = db.psiPipelines[k];
      return x.status === 'running' && x.parties.some(function (pt) { return pt.dataset_id === p.dataset_id; });
    });
    if (running) return err(40901, '数据集正被运行中的求交流水线使用');
    delete db.datasets[p.dataset_id];
    return ok({ dataset_id: p.dataset_id, deleted: true });
  });

  /* --- PSI --- */
  route('GET', '/psi/protocols', function () { return ok({ items: PSI_PROTOCOLS }); });
  route('POST', '/projects/{project_id}/psi/templates', function (p, q, body) {
    if (!body.name) return err(40000, '模板名称必填');
    const id = nextId('tpl');
    const tpl = {
      template_id: id, project_id: p.project_id, name: body.name,
      protocol: body.protocol, params: body.params || {}, created_at: NOW()
    };
    db.psiTemplates[id] = tpl;
    return ok(tpl);
  });
  route('GET', '/projects/{project_id}/psi/templates', function (p, q) {
    const items = Object.keys(db.psiTemplates).map(function (k) { return db.psiTemplates[k]; })
      .filter(function (t) {
        return t.project_id === p.project_id && (!q.protocol || t.protocol === q.protocol);
      });
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });
  route('GET', '/psi/templates/{template_id}', function (p) {
    const tpl = db.psiTemplates[p.template_id];
    if (!tpl) return err(40400, '模板不存在');
    return ok(tpl);
  });
  route('DELETE', '/psi/templates/{template_id}', function (p) {
    if (!db.psiTemplates[p.template_id]) return err(40400, '模板不存在');
    delete db.psiTemplates[p.template_id];
    return ok({ template_id: p.template_id, deleted: true });
  });
  route('POST', '/projects/{project_id}/psi/pipelines', function (p, q, body) {
    seedProject(p.project_id);
    const bad = validatePipelineBody(p.project_id, body);
    if (bad) return bad;
    const pipe = createPipeline(p.project_id, body);
    startPipeline(pipe);
    return ok(pipelineView(pipe));
  });
  route('GET', '/psi/pipelines/{pipeline_id}', function (p) {
    const pipe = db.psiPipelines[p.pipeline_id];
    if (!pipe) return err(40400, '流水线不存在');
    return ok(pipelineView(pipe));
  });
  route('POST', '/psi/pipelines/{pipeline_id}/cancel', function (p) {
    const pipe = db.psiPipelines[p.pipeline_id];
    if (!pipe) return err(40400, '流水线不存在');
    stopPipeTimer(pipe);
    pipe.status = 'canceled';
    pipe.progress = 0;
    pipe.fl_job_id = null;
    return ok(pipelineView(pipe));
  });
  route('GET', '/projects/{project_id}/psi/pipelines', function (p) {
    const items = Object.keys(db.psiPipelines).map(function (k) { return db.psiPipelines[k]; })
      .filter(function (x) { return x.project_id === p.project_id; })
      .map(pipelineView);
    return ok({ items: items, page: 1, page_size: 20, total: items.length });
  });

  /* --- DP --- */
  route('GET', '/fl/jobs/{job_id}/dp', function (p) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    return ok(job.dp);
  });
  route('PUT', '/fl/jobs/{job_id}/dp', function (p, q, body) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    if (['Running', 'Paused'].indexOf(job.status) >= 0) {
      return err(40901, '任务运行中不允许修改 DP 配置，已消耗的预算不可回退', { status: job.status });
    }
    if (body.epsilon_total < 0.2 || body.epsilon_total > 10) return err(40003, 'ε 必须在 0.2 – 10 之间');
    if (body.clip_norm < 0.2 || body.clip_norm > 4) return err(40003, '裁剪阈值 C 必须在 0.2 – 4 之间');
    if (body.mechanism === 'gaussian' && !body.delta) return err(40000, '高斯机制必须指定 δ');
    job.dp = Object.assign({}, job.dp, {
      enabled: body.enabled, mechanism: body.mechanism,
      epsilon_total: body.epsilon_total, clip_norm: body.clip_norm,
      delta: body.delta || job.dp.delta, updated_at: NOW()
    });
    job.dp_enabled = body.enabled;
    return ok(job.dp);
  });
  route('POST', '/dp/estimate', function (p, q, body) {
    if (!body.mechanism) return err(40000, 'mechanism 必填');
    if (body.mechanism === 'gaussian' && !body.delta) return err(40000, '高斯机制必须指定 δ');
    return ok(dpEstimate(body));
  });
  route('GET', '/fl/jobs/{job_id}/dp/budget', function (p) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    const used = job.dp.epsilon_total * job.current_round / job.dp.total_rounds;
    return ok({
      epsilon_total: job.dp.epsilon_total,
      epsilon_used: Number(used.toFixed(3)),
      used_pct: Math.round((job.current_round / job.dp.total_rounds) * 100),
      rounds_completed: job.current_round,
      total_rounds: job.dp.total_rounds,
      exhausted: job.current_round >= job.dp.total_rounds
    });
  });
  route('GET', '/fl/jobs/{job_id}/dp/audit', function (p, q) {
    const job = db.flJobs[p.job_id];
    if (!job) return err(40400, '任务不存在');
    const limit = Number(q.limit || 5);
    const items = job.dp_audit.slice(-limit).reverse();
    return ok({ items: items });
  });

  /* ================= 文件下载 ================= */

  const downloads = [
    {
      rx: /^\/fl\/jobs\/([^/]+)\/metrics\/export/,
      build: function (m, q) {
        const job = db.flJobs[m[1]];
        if (!job) return null;
        const scope = q.scope || 'nodes';
        const keys = taskTypeOf(job.task_type).metrics.map(function (s) { return s.key; });
        const line = function (series, src, x) {
          return [job.job_id, x.round, series].concat(keys.map(function (k) { return src[k]; }), [x.recorded_at]).join(',') + '\n';
        };
        let csv = ['job_id', 'round', 'series'].concat(keys, ['recorded_at']).join(',') + '\n';
        job.metrics.forEach(function (x) {
          csv += line('global', x.global, x);
          if (scope === 'nodes') {
            x.nodes.forEach(function (n) { csv += line(n.node_id, n, x); });
          }
        });
        return { fileName: job.job_id + '_metrics.csv', contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
      }
    },
    {
      rx: /^\/projects\/([^/]+)\/mpc\/tasks\/export/,
      build: function (m) {
        let csv = '任务 ID,协议,算子,参与方数,总通信量(MB),总耗时(秒),结束时间,状态\n';
        MPC_HISTORY.forEach(function (t) {
          csv += [t.task_id, t.protocol, t.operator, t.party_count,
            (t.total_comm_bytes / 1048576).toFixed(1), t.total_duration_sec, t.finished_at, t.status].join(',') + '\n';
        });
        return { fileName: 'mpc_tasks_' + m[1] + '.csv', contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
      }
    }
  ];

  /* ================= 分发 ================= */

  function splitUrl(url) {
    const i = url.indexOf('?');
    const path = i < 0 ? url : url.slice(0, i);
    const query = {};
    if (i >= 0) {
      new URLSearchParams(url.slice(i + 1)).forEach(function (v, k) { query[k] = v; });
    }
    return { path: path, query: query };
  }

  async function handle(method, url, body) {
    const cfg = window.APP_CONFIG;
    if (cfg.mockLatencyMs) await sleep(cfg.mockLatencyMs);
    const parsed = splitUrl(url);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (r.method !== method) continue;
      const m = r.rx.exec(parsed.path);
      if (!m) continue;
      const params = {};
      r.keys.forEach(function (k, idx) { params[k] = decodeURIComponent(m[idx + 1]); });
      try {
        return r.handler(params, parsed.query, body || {});
      } catch (e) {
        console.error('[mock] handler error', e);
        return err(50000, '服务内部错误：' + e.message);
      }
    }
    return err(40400, '接口不存在：' + method + ' ' + parsed.path);
  }

  async function download(url) {
    const cfg = window.APP_CONFIG;
    if (cfg.mockLatencyMs) await sleep(cfg.mockLatencyMs);
    const parsed = splitUrl(url);
    for (let i = 0; i < downloads.length; i++) {
      const m = downloads[i].rx.exec(parsed.path);
      if (m) {
        const file = downloads[i].build(m, parsed.query);
        if (file) return file;
      }
    }
    throw new Error('导出接口不存在：' + parsed.path);
  }

  window.MockServer = { handle: handle, subscribe: subscribe, download: download, _db: db };
})();
