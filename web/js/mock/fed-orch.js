/**
 * mock 扩展：联邦学习 · 任务编排（FL-ORCH-01 至 FL-ORCH-09）。接口文档见 docs/api/fed-orch.md。
 *
 * 自有数据挂在 k.db.flo 下（语义上对应 fl_project_config / fl_algorithm / fl_algorithm_version /
 * fl_param_template / fl_isolation_audit 五张表）。另外按文档写两处内核数据：
 *   k.db.projects / k.db.nodes   新建项目、节点增删改（节点对象补 data_dir、last_heartbeat_at）
 *   k.db.seeded[新项目]          不导入演示数据时置 true；导入时先写 3 个演示节点再调 k.seedProject
 *   k.db.files                   注册算法时登记一条模型制品文件记录，新建任务时作为 model_file_id
 */
(function () {
  'use strict';
  window.MockServer.extend(function (k) {
    const db = k.db;
    const ok = k.ok, err = k.err;
    const DAY = 86400000;

    /* ================= 常量 ================= */

    const PROJECT_TYPES = ['production', 'pilot', 'sandbox'];
    const MODEL_FORMATS = ['pkl', 'pt', 'h5', 'onnx'];
    /** 训练目标可选指标：better 决定比较方向（lower → ≤，higher → ≥），task_type 决定适用的任务类型。 */
    const TARGET_METRICS = {
      accuracy: { label: 'Accuracy', better: 'higher', task_type: 'classification', min: 0, max: 1 },
      auc: { label: 'AUC', better: 'higher', task_type: 'classification', min: 0, max: 1 },
      loss: { label: 'Loss', better: 'lower', task_type: 'classification', min: 0, max: 10 },
      rmse: { label: 'RMSE（归一化）', better: 'lower', task_type: 'timeseries', min: 0, max: 1 },
      mae: { label: 'MAE（归一化）', better: 'lower', task_type: 'timeseries', min: 0, max: 1 }
    };

    /* ================= 内置算法（FL-ORCH-05） ================= */

    const num = function (min, max, def, desc) { return { type: 'number', minimum: min, maximum: max, default: def, description: desc }; };
    const int = function (min, max, def, desc) { return { type: 'integer', minimum: min, maximum: max, default: def, description: desc }; };
    const schemaOf = function (props) { return { type: 'object', properties: props, required: [] }; };

    const TAB_IO = {
      X: 'ndarray[n_samples, n_features] float32，本节点本地特征（按数据分区读取）',
      y: 'ndarray[n_samples] int，0/1 或类别编号'
    };
    const TS_IO = {
      X: 'ndarray[n_samples, window_size, n_features] float32，按时间列排序后的滑动窗口',
      y: 'ndarray[n_samples, horizon] float32，未来 horizon 步的目标值（归一化）'
    };
    function iface(io, evalOut, predictOut) {
      return [
        { method: 'fit', signature: 'fit(X, y, *, rounds: int, aggregator: Aggregator, params: dict) -> TrainReport',
          input: 'X: ' + io.X + '；y: ' + io.y, output: 'TrainReport { rounds_done, history: [{ round, metrics }] }' },
        { method: 'predict', signature: 'predict(X) -> ndarray', input: 'X: ' + io.X, output: predictOut },
        { method: 'evaluate', signature: 'evaluate(X, y) -> dict', input: 'X、y 同 fit', output: evalOut }
      ];
    }
    const CLS_EVAL = 'dict { loss: float, accuracy: float }';
    const TS_EVAL = 'dict { rmse: float, mae: float }（均为归一化值）';

    const BUILTIN = [
      {
        algo_id: 'lr', name: '逻辑回归', task_types: ['classification'], model_format: 'pkl',
        base_class: 'FedLogisticRegression(FedEstimator)', framework: 'SecretFlow SS-LR（纵向秘密共享逻辑回归）',
        description: '线性可解释基线，适合特征维度中等的违约 / 风险二分类',
        interface: iface(TAB_IO, CLS_EVAL, 'ndarray[n_samples] float32，正类概率'),
        params_schema: schemaOf({
          learning_rate: num(0.0001, 1, 0.05, '学习率'),
          penalty: { type: 'string', enum: ['l2', 'l1', 'none'], default: 'l2', description: '正则项' },
          C: num(0.001, 100, 1.0, '正则强度倒数'),
          max_iter: int(10, 1000, 100, '每轮本地最大迭代次数'),
          batch_size: int(16, 4096, 512, '批大小')
        }),
        versions: [['1.0.0', 120, '首个版本：SS-LR 纵向训练'], ['1.1.0', 60, '增加 L1 正则'], ['1.2.0', 18, '梯度裁剪接入差分隐私']],
        templates: [
          ['默认参数', { learning_rate: 0.05, penalty: 'l2', C: 1.0, max_iter: 100, batch_size: 512 }],
          ['强正则（L1 稀疏）', { learning_rate: 0.02, penalty: 'l1', C: 0.1, max_iter: 200, batch_size: 512 }]
        ]
      },
      {
        algo_id: 'xgb', name: 'XGBoost', task_types: ['classification'], model_format: 'pkl',
        base_class: 'FedXGBoost(FedEstimator)', framework: 'SecretFlow SecureBoost（同态加密梯度直方图）',
        description: '梯度提升树，表格数据精度高，供应商违约与风险评分的默认算法',
        interface: iface(TAB_IO, CLS_EVAL, 'ndarray[n_samples] float32，正类概率'),
        params_schema: schemaOf({
          max_depth: int(1, 16, 6, '树最大深度'),
          eta: num(0.001, 1, 0.3, '学习率（收缩系数）'),
          n_estimators: int(10, 2000, 200, '树的数量'),
          subsample: num(0.1, 1, 0.8, '行采样比例'),
          min_child_weight: num(0, 20, 1, '叶子节点最小样本权重和')
        }),
        versions: [['1.0.0', 150, '首个版本：SecureBoost 二分类'], ['1.1.0', 75, '支持行采样 subsample'], ['1.2.0', 21, '直方图分桶改为 64 桶，通信量下降约 30%']],
        templates: [
          ['默认参数', { max_depth: 6, eta: 0.3, n_estimators: 200, subsample: 0.8, min_child_weight: 1 }],
          ['快速基线', { max_depth: 4, eta: 0.5, n_estimators: 100, subsample: 1, min_child_weight: 1 }],
          ['高精度（慢）', { max_depth: 8, eta: 0.05, n_estimators: 800, subsample: 0.8, min_child_weight: 3 }]
        ]
      },
      {
        algo_id: 'cnn', name: 'CNN / MLP', task_types: ['classification'], model_format: 'pt',
        base_class: 'FedNeuralNet(FedEstimator)，子类 FedMLP / FedCNN1D', framework: 'PyTorch 2.3 + FedAvg',
        description: '神经网络基类，arch 选 mlp（全连接）或 cnn1d（一维卷积），适合高维特征',
        interface: iface(TAB_IO, CLS_EVAL, 'ndarray[n_samples, n_classes] float32，softmax 概率'),
        params_schema: schemaOf({
          arch: { type: 'string', enum: ['mlp', 'cnn1d'], default: 'mlp', description: '网络结构' },
          hidden_units: int(8, 1024, 128, '隐藏层宽度'),
          num_layers: int(1, 8, 3, '隐藏层数'),
          learning_rate: num(0.00001, 0.1, 0.001, '学习率'),
          batch_size: int(16, 4096, 256, '批大小'),
          local_epochs: int(1, 20, 2, '每轮本地训练 epoch 数'),
          dropout: num(0, 0.9, 0.2, 'Dropout 比例')
        }),
        versions: [['1.0.0', 90, '首个版本：MLP'], ['1.1.0', 30, '新增 CNN1D 结构']],
        templates: [
          ['MLP 默认', { arch: 'mlp', hidden_units: 128, num_layers: 3, learning_rate: 0.001, batch_size: 256, local_epochs: 2, dropout: 0.2 }],
          ['CNN1D 宽网络', { arch: 'cnn1d', hidden_units: 256, num_layers: 4, learning_rate: 0.0005, batch_size: 128, local_epochs: 3, dropout: 0.3 }]
        ]
      },
      {
        algo_id: 'lstm', name: 'LSTM', task_types: ['timeseries'], model_format: 'pt',
        base_class: 'FedLSTM(FedSequenceModel)', framework: 'PyTorch 2.3 + FedAvg',
        description: '长短期记忆网络，稀土氧化物价格等日度序列预测的默认算法',
        interface: iface(TS_IO, TS_EVAL, 'ndarray[n_samples, horizon] float32，预测值（归一化）'),
        params_schema: schemaOf({
          hidden_size: int(8, 512, 64, '隐藏状态维度'),
          num_layers: int(1, 4, 2, 'LSTM 层数'),
          learning_rate: num(0.00001, 0.1, 0.001, '学习率'),
          batch_size: int(16, 2048, 128, '批大小'),
          local_epochs: int(1, 20, 2, '每轮本地训练 epoch 数'),
          dropout: num(0, 0.9, 0.1, 'Dropout 比例')
        }),
        versions: [['1.0.0', 80, '首个版本'], ['1.1.0', 12, '支持多步预测 horizon']],
        templates: [
          ['默认参数', { hidden_size: 64, num_layers: 2, learning_rate: 0.001, batch_size: 128, local_epochs: 2, dropout: 0.1 }],
          ['长窗口大模型', { hidden_size: 128, num_layers: 3, learning_rate: 0.0005, batch_size: 64, local_epochs: 3, dropout: 0.2 }]
        ]
      },
      {
        algo_id: 'tcn', name: 'TCN', task_types: ['timeseries'], model_format: 'pt',
        base_class: 'FedTCN(FedSequenceModel)', framework: 'PyTorch 2.3 + FedAvg',
        description: '时间卷积网络，因果膨胀卷积，训练比 LSTM 快，适合较长回看窗口',
        interface: iface(TS_IO, TS_EVAL, 'ndarray[n_samples, horizon] float32，预测值（归一化）'),
        params_schema: schemaOf({
          num_channels: int(8, 256, 32, '每层卷积通道数'),
          kernel_size: int(2, 7, 3, '卷积核大小'),
          num_levels: int(1, 8, 4, '膨胀卷积层数（感受野 = 2^层数）'),
          learning_rate: num(0.00001, 0.1, 0.002, '学习率'),
          local_epochs: int(1, 20, 2, '每轮本地训练 epoch 数'),
          dropout: num(0, 0.9, 0.1, 'Dropout 比例')
        }),
        versions: [['1.0.0', 45, '首个版本']],
        templates: [
          ['默认参数', { num_channels: 32, kernel_size: 3, num_levels: 4, learning_rate: 0.002, local_epochs: 2, dropout: 0.1 }],
          ['大感受野', { num_channels: 64, kernel_size: 5, num_levels: 6, learning_rate: 0.001, local_epochs: 2, dropout: 0.2 }]
        ]
      }
    ];

    const flo = db.flo = {
      configs: {},     // project_id -> 项目配置（fl_project_config）
      algos: {},       // algo_id -> 算法（fl_algorithm + fl_algorithm_version）
      templates: {},   // template_id -> 参数模板（fl_param_template）
      isoLogs: {},     // project_id -> [检测记录]（fl_isolation_audit），最新在前
      seq: 0
    };
    // 本扩展自己的序号，不占用内核 db.seq（内核任务 ID 依赖它，测试按 ID 断言）
    function fid(prefix) { flo.seq += 1; return prefix + '_' + String(flo.seq).padStart(4, '0'); }

    const SEED_AT = Date.parse('2026-10-20T10:00:00+08:00');
    const ISO = function (ms) { return new Date(ms).toISOString(); };

    BUILTIN.forEach(function (b) {
      const versions = b.versions.map(function (v) {
        return { version: v[0], created_at: ISO(SEED_AT - v[1] * DAY), created_by: '平台内置', note: v[2], params_schema: b.params_schema, file_id: null };
      });
      flo.algos[b.algo_id] = {
        algo_id: b.algo_id, name: b.name, kind: 'builtin', project_id: null, task_types: b.task_types,
        base_class: b.base_class, framework: b.framework, description: b.description, model_format: b.model_format,
        interface: b.interface, versions: versions, current_version: versions[versions.length - 1].version, history: []
      };
      b.templates.forEach(function (t, i) {
        const id = 'tpl_' + b.algo_id + '_' + (i + 1);
        flo.templates[id] = { template_id: id, algo_id: b.algo_id, name: t[0], params: t[1], preset: true, created_by: '平台内置', created_at: ISO(SEED_AT - 30 * DAY) };
      });
    });

    const SEED_CONFIG = {
      p1: { description: '参与方 A / B / C 分别持有华东、华南、赣州区域的 Nd₂O₃、CeO₂、La₂O₃ 日度成交价（元/吨）与库存数据，联合训练价格预测模型，原始数据不出域。',
        base_algorithm: 'lstm', model_version: '1.1.0', total_rounds: 30, target: { metric: 'rmse', value: 0.12 } },
      p2: { description: '冶炼分离企业与贸易商联合评估稀土供应商违约风险，特征按参与方纵向切分。',
        base_algorithm: 'xgb', model_version: '1.2.0', total_rounds: 30, target: { metric: 'accuracy', value: 0.9 } },
      p3: { description: '稀土产品批次溯源核验的沙箱环境，用于验证新算法与新节点接入。',
        base_algorithm: 'lr', model_version: '1.2.0', total_rounds: 30, target: { metric: 'accuracy', value: 0.85 } }
    };

    /* ================= 工具 ================= */

    function project(pid) { return db.projects.filter(function (p) { return p.project_id === pid; })[0]; }
    function operator() { return db.user.display_name; }

    function config(pid) {
      if (!flo.configs[pid]) {
        const s = SEED_CONFIG[pid] || { description: '', base_algorithm: 'xgb', model_version: '1.2.0', total_rounds: k.TOTAL_ROUNDS, target: { metric: 'accuracy', value: 0.9 } };
        flo.configs[pid] = {
          description: s.description, base_algorithm: s.base_algorithm, model_version: s.model_version,
          total_rounds: s.total_rounds, target: s.target, revision: 1,
          updated_at: (project(pid) || {}).created_at || k.NOW(), updated_by: operator()
        };
      }
      return flo.configs[pid];
    }

    function targetView(t) {
      const m = TARGET_METRICS[t.metric];
      return { metric: t.metric, label: m.label, op: m.better === 'lower' ? '<=' : '>=', value: t.value, task_type: m.task_type };
    }

    function runningJobs(pid, nodeId) {
      return Object.keys(db.flJobs).map(function (id) { return db.flJobs[id]; }).filter(function (j) {
        return j.project_id === pid && (j.status === 'Running' || j.status === 'Paused') &&
          (!nodeId || j.node_ids.indexOf(nodeId) >= 0);
      });
    }
    function jobsUsingNode(pid, nodeId) {
      return Object.keys(db.flJobs).map(function (id) { return db.flJobs[id]; })
        .filter(function (j) { return j.project_id === pid && j.node_ids.indexOf(nodeId) >= 0; });
    }

    function projectView(p) {
      const c = config(p.project_id);
      const algo = flo.algos[c.base_algorithm];
      const jobs = Object.keys(db.flJobs).filter(function (id) { return db.flJobs[id].project_id === p.project_id; });
      return {
        project_id: p.project_id, name: p.name, type: p.type, created_at: p.created_at,
        description: c.description,
        base_algorithm: c.base_algorithm, base_algorithm_name: algo ? algo.name : c.base_algorithm,
        model_version: c.model_version, total_rounds: c.total_rounds, target: targetView(c.target),
        node_count: (db.nodes[p.project_id] || []).length, job_count: jobs.length,
        aggregation_default: aggDefault(p.project_id),
        revision: c.revision, updated_at: c.updated_at, updated_by: c.updated_by
      };
    }

    /** 聚合与安全页把项目聚合策略存在 k.db.fla[project_id].strategy，存在时作为新建任务默认值。 */
    function aggDefault(pid) {
      const f = db.fla && db.fla[pid];
      return f && (f.strategy === 'ss' || f.strategy === 'he') ? f.strategy : null;
    }

    /** 项目字段校验（创建全量 / 修改部分）。返回错误包或 null。 */
    function checkProject(body, partial, selfId) {
      const has = function (f) { return body[f] !== undefined; };
      if (!partial || has('name')) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return err(40000, '项目名称必填');
        if (name.length > 64) return err(40003, '项目名称不能超过 64 个字符');
        if (db.projects.some(function (p) { return p.name === name && p.project_id !== selfId; })) {
          return err(40902, '项目名称「' + name + '」已存在');
        }
      }
      if (has('seed_demo') && typeof body.seed_demo !== 'boolean') return err(40000, 'seed_demo 必须是布尔值');
      if (has('type') && PROJECT_TYPES.indexOf(body.type) < 0) return err(40000, '项目类型必须是 production / pilot / sandbox');
      if (has('description') && String(body.description).length > 500) return err(40003, '描述不能超过 500 个字符');
      if (!partial || has('total_rounds')) {
        const n = Number(body.total_rounds);
        if (body.total_rounds === undefined || body.total_rounds === null || body.total_rounds === '') return err(40000, '聚合轮数必填');
        if (!Number.isInteger(n) || n < 1 || n > 200) return err(40003, '聚合轮数必须是 1 – 200 的整数');
      }
      if (!partial || has('target')) {
        const t = body.target;
        if (!t || !t.metric) return err(40000, '训练目标必填（指标 + 目标值）');
        const m = TARGET_METRICS[t.metric];
        if (!m) return err(40000, '训练目标指标必须是 ' + Object.keys(TARGET_METRICS).join(' / '));
        const v = Number(t.value);
        if (t.value === undefined || t.value === null || t.value === '' || Number.isNaN(v)) return err(40002, '训练目标值必须是数字');
        if (v <= m.min || v > m.max) return err(40003, m.label + ' 目标值必须在 (' + m.min + ', ' + m.max + '] 内');
      }
      if (!partial || has('base_algorithm') || has('model_version')) {
        if (!body.base_algorithm) return err(40000, '基准模型必填');
        const a = flo.algos[body.base_algorithm];
        if (!a || a.kind === 'custom') return err(40400, '基准模型必须是内置或已注册算法：' + body.base_algorithm);
        if (!body.model_version) return err(40000, '模型版本必填');
        if (!a.versions.some(function (v) { return v.version === body.model_version; })) {
          return err(40400, a.name + ' 没有版本 ' + body.model_version + '，可选：' + a.versions.map(function (v) { return v.version; }).join(' / '));
        }
        const metric = (body.target && body.target.metric) || (selfId && config(selfId).target.metric);
        const tt = TARGET_METRICS[metric].task_type;
        if (a.task_types.indexOf(tt) < 0) {
          return err(40000, '训练目标 ' + TARGET_METRICS[metric].label + ' 属于' + k.taskTypeOf(tt).name + '任务，基准模型 ' + a.name + ' 不支持');
        }
      }
      return null;
    }

    /* ================= FL-ORCH-01 / 04 项目 ================= */

    k.routeFirst('GET', '/projects', function (p, q) {
      let list = db.projects.slice();
      if (q.keyword) list = list.filter(function (x) { return x.name.indexOf(q.keyword) >= 0; });
      const size = Math.min(100, Math.max(1, Number(q.page_size) || 20));
      const page = Math.max(1, Number(q.page) || 1);
      return ok({ items: list.slice((page - 1) * size, page * size).map(projectView), page: page, page_size: size, total: list.length });
    });

    k.route('POST', '/projects', function (p, q, body) {
      const bad = checkProject(body, false, null);
      if (bad) return bad;
      let n = db.projects.length + 1;
      while (project('p' + n)) n += 1;
      const pid = 'p' + n;
      const proj = { project_id: pid, name: body.name.trim(), type: body.type || 'pilot', created_at: k.NOW() };
      db.projects.push(proj);
      if (body.seed_demo === true) {
        // 导入演示数据：先登记 2 个训练节点 + 1 个聚合节点，再由内核 seedProject 按原逻辑播种数据集与任务
        db.nodes[pid] = DEMO_NODES.map(function (d, i) {
          const n = { node_id: d[0] + '-' + pid, ip: '10.8' + i + '.' + n4(pid) + '.' + (11 + i), port: d[1] === 'aggregator' ? 9090 : 8471,
            role: d[1], role_label: roleLabel(d[1]), data_partition: d[2], online: true, last_heartbeat_at: k.NOW() };
          n.data_dir = defaultDir(pid, n);
          return n;
        });
        k.seedProject(pid);
      } else {
        db.nodes[pid] = [];
        db.seeded[pid] = true;   // 空项目：不播种演示数据集与任务
      }
      flo.configs[pid] = {
        description: body.description || '', base_algorithm: body.base_algorithm, model_version: body.model_version,
        total_rounds: Number(body.total_rounds), target: { metric: body.target.metric, value: Number(body.target.value) },
        revision: 1, updated_at: proj.created_at, updated_by: operator()
      };
      return ok(projectView(proj));
    });

    const DEMO_NODES = [['node-baotou', 'trainer', 'part-A'], ['node-ganzhou', 'trainer', 'part-B'], ['node-center-agg', 'aggregator', null]];
    function n4(pid) { return parseInt(k.hashHex(pid, 1).slice(0, 2), 16) % 200 + 1; }

    k.route('GET', '/projects/{project_id}', function (p) {
      const proj = project(p.project_id);
      if (!proj) return err(40400, '项目不存在');
      k.seedProject(p.project_id);   // 详情里的任务数包含首次访问时播种的任务
      return ok(projectView(proj));
    });

    k.route('PATCH', '/projects/{project_id}', function (p, q, body) {
      const proj = project(p.project_id);
      if (!proj) return err(40400, '项目不存在');
      const c = config(p.project_id);
      // 基准模型和版本成对校验：只改其一时用当前值补齐
      const merged = Object.assign({}, body);
      if (body.base_algorithm !== undefined || body.model_version !== undefined || body.target !== undefined) {
        if (merged.base_algorithm === undefined) merged.base_algorithm = c.base_algorithm;
        if (merged.model_version === undefined) merged.model_version = c.model_version;
      }
      const bad = checkProject(merged, true, p.project_id);
      if (bad) return bad;
      if (body.name !== undefined) proj.name = body.name.trim();
      if (body.type !== undefined) proj.type = body.type;
      if (body.description !== undefined) c.description = String(body.description);
      if (body.total_rounds !== undefined) c.total_rounds = Number(body.total_rounds);
      if (body.target !== undefined) c.target = { metric: body.target.metric, value: Number(body.target.value) };
      if (merged.base_algorithm !== undefined) { c.base_algorithm = merged.base_algorithm; c.model_version = merged.model_version; }
      c.revision += 1;
      c.updated_at = k.NOW();
      c.updated_by = operator();
      return ok(projectView(proj));
    });

    k.download(/^\/projects\/([^/]+)\/config\/export$/, function (m) {
      const proj = project(m[1]);
      if (!proj) return null;
      const v = projectView(proj);
      const doc = {
        schema_version: 'fl-project-config/1',
        exported_at: k.NOW(),
        exported_by: operator(),
        project: { project_id: v.project_id, name: v.name, type: v.type, description: v.description, created_at: v.created_at },
        training: {
          base_algorithm: v.base_algorithm, model_version: v.model_version, total_rounds: v.total_rounds,
          target: { metric: v.target.metric, op: v.target.op, value: v.target.value }, aggregation_default: v.aggregation_default
        },
        nodes: nodesOf(proj.project_id).map(nodeView).map(function (n) {
          return { node_id: n.node_id, ip: n.ip, port: n.port, role: n.role, data_partition: n.data_partition, data_dir: n.data_dir };
        }),
        isolation_policy: ISO_POLICY,
        revision: v.revision, updated_at: v.updated_at, updated_by: v.updated_by
      };
      return { fileName: 'fl_project_' + proj.project_id + '_config.json', contentType: 'application/json;charset=utf-8', content: JSON.stringify(doc, null, 2) };
    });

    /* ================= FL-ORCH-02 节点管理 ================= */

    function defaultDir(pid, n) {
      return n.role === 'trainer' && n.data_partition ? '/data/fl/' + pid + '/' + n.data_partition.toLowerCase() : null;
    }
    function nodeView(n) {
      return Object.assign({}, n, {
        data_dir: n.data_dir !== undefined ? n.data_dir : defaultDir(n._pid, n),
        last_heartbeat_at: n.last_heartbeat_at || ISO(Date.now() - (parseInt(k.hashHex(n.node_id, 1).slice(0, 2), 16) % 50) * 1000),
        running_job_count: n._pid ? runningJobs(n._pid, n.node_id).length : 0
      });
    }
    function nodesOf(pid) {
      return (db.nodes[pid] || []).map(function (n) {
        if (!n._pid) Object.defineProperty(n, '_pid', { value: pid, enumerable: false, writable: true });
        return n;
      });
    }

    function isIp(s) {
      if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) {
        return s.split('.').every(function (x) { return Number(x) <= 255 && String(Number(x)) === x; });
      }
      return /^[0-9a-fA-F:]+$/.test(s) && s.indexOf(':') >= 0 && s.split(':').length <= 8 &&
        s.split(':').every(function (x) { return x.length <= 4; });
    }

    /** 节点字段校验。partial = 编辑时只校验传入的字段。 */
    function checkNode(body, partial, role) {
      const has = function (f) { return body[f] !== undefined; };
      if (!partial || has('node_id')) {
        if (!body.node_id || !/^[a-z0-9-]+$/.test(body.node_id)) return err(40000, '节点 ID 只能包含小写字母、数字和短横线');
        if (body.node_id.length > 40) return err(40003, '节点 ID 不能超过 40 个字符');
      }
      if (!partial || has('ip')) {
        if (!body.ip) return err(40000, 'IP 地址必填');
        if (!isIp(String(body.ip).trim())) return err(40002, 'IP 地址格式不正确：' + body.ip + '（需为 IPv4 如 10.40.3.9 或 IPv6）');
      }
      if (!partial || has('port')) {
        const port = Number(body.port);
        if (body.port === undefined || body.port === null || body.port === '') return err(40000, '端口必填');
        if (!Number.isInteger(port) || port < 1 || port > 65535) return err(40003, '端口必须是 1 – 65535 的整数');
      }
      if (!partial || has('role')) {
        if (['trainer', 'aggregator'].indexOf(body.role) < 0) return err(40000, '角色必须是 trainer 或 aggregator');
      }
      if (role === 'trainer' && (!partial || has('data_partition') || has('role')) && !body.data_partition) {
        return err(40000, '训练节点必须指定数据分区');
      }
      if (has('data_partition') && body.data_partition && !/^[A-Za-z0-9_-]{1,32}$/.test(body.data_partition)) {
        return err(40002, '数据分区标识只能包含字母、数字、下划线和短横线');
      }
      if (has('data_dir') && body.data_dir && !/^\/[\w./-]*$/.test(body.data_dir)) return err(40002, '数据目录必须是绝对路径，例如 /data/fl/part-c');
      // 连通性检查：192.0.2.0/24 是文档保留网段（RFC 5737），mock 视为不可达
      if (has('ip') && /^192\.0\.2\./.test(String(body.ip))) return err(42201, '连通性检查失败：' + body.ip + ':' + body.port + ' 在 3 秒内无响应');
      return null;
    }

    function roleLabel(role) { return role === 'aggregator' ? '聚合方 / 协调节点' : '参与方 / 训练节点'; }

    k.routeFirst('GET', '/projects/{project_id}/nodes', function (p) {
      const items = nodesOf(p.project_id).map(nodeView);
      return ok({ items: items, page: 1, page_size: 20, total: items.length });
    });

    k.routeFirst('POST', '/projects/{project_id}/nodes', function (p, q, body) {
      if (!project(p.project_id)) return err(40400, '项目不存在');
      const list = db.nodes[p.project_id] || (db.nodes[p.project_id] = []);
      const bad = checkNode(body, false, body.role);
      if (bad) return bad;
      if (list.some(function (n) { return n.node_id === body.node_id; })) return err(40902, '节点 ' + body.node_id + ' 已存在');
      const node = {
        node_id: body.node_id, ip: String(body.ip).trim(), port: Number(body.port), role: body.role,
        role_label: roleLabel(body.role), data_partition: body.role === 'trainer' ? body.data_partition : null, online: true
      };
      node.data_dir = body.role === 'trainer' ? (body.data_dir || defaultDir(p.project_id, node)) : null;
      node.last_heartbeat_at = k.NOW();
      list.push(node);
      return ok(nodeView(nodesOf(p.project_id)[list.length - 1]));
    });

    k.route('PATCH', '/projects/{project_id}/nodes/{node_id}', function (p, q, body) {
      const list = nodesOf(p.project_id);
      const node = list.filter(function (n) { return n.node_id === p.node_id; })[0];
      if (!node) return err(40400, '节点不存在');
      const role = body.role !== undefined ? body.role : node.role;
      const merged = Object.assign({}, body);
      if (role === 'trainer' && merged.data_partition === undefined && body.role !== undefined) merged.data_partition = node.data_partition;
      if (merged.ip !== undefined && merged.port === undefined) merged.port = node.port;
      const bad = checkNode(merged, true, role);
      if (bad) return bad;
      if (body.online !== undefined && typeof body.online !== 'boolean') return err(40000, 'online 必须是布尔值');
      const renamed = body.node_id !== undefined && body.node_id !== node.node_id;
      const structural = renamed || (body.role !== undefined && body.role !== node.role) ||
        (body.data_partition !== undefined && body.data_partition !== node.data_partition) ||
        (body.data_dir !== undefined && body.data_dir !== node.data_dir);
      const running = runningJobs(p.project_id, node.node_id);
      if (structural && running.length) {
        return err(40901, '节点正被运行中的任务使用（' + running.map(function (j) { return j.name; }).join('、') + '），不能修改节点 ID、角色、数据分区或数据目录', { job_ids: running.map(function (j) { return j.job_id; }) });
      }
      if (renamed) {
        if (list.some(function (n) { return n.node_id === body.node_id; })) return err(40902, '节点 ' + body.node_id + ' 已存在');
        const used = jobsUsingNode(p.project_id, node.node_id);
        if (used.length) return err(40901, '节点已被 ' + used.length + ' 个历史任务引用，节点 ID 不可修改（可新增节点后删除旧节点）');
        node.node_id = body.node_id;
      }
      if (body.online !== undefined && body.online !== node.online) {
        node.online = body.online;
        if (node.online) node.last_heartbeat_at = k.NOW();
        else failJobsOnNode(p.project_id, node.node_id);   // 心跳丢失：使用该节点的运行中任务转 Failed
      }
      if (body.ip !== undefined) node.ip = String(body.ip).trim();
      if (body.port !== undefined) node.port = Number(body.port);
      if (body.role !== undefined) { node.role = body.role; node.role_label = roleLabel(body.role); }
      if (node.role === 'aggregator') { node.data_partition = null; node.data_dir = null; }
      else {
        if (body.data_partition !== undefined) node.data_partition = body.data_partition;
        if (body.data_dir !== undefined) node.data_dir = body.data_dir || null;
        if (!node.data_dir) node.data_dir = defaultDir(p.project_id, node);
      }
      return ok(nodeView(node));
    });

    k.routeFirst('DELETE', '/projects/{project_id}/nodes/{node_id}', function (p) {
      const list = db.nodes[p.project_id] || [];
      const idx = list.findIndex(function (n) { return n.node_id === p.node_id; });
      if (idx < 0) return err(40400, '节点不存在');
      const running = runningJobs(p.project_id, p.node_id);
      if (running.length) {
        return err(40901, '节点正被运行中的任务使用（' + running.map(function (j) { return j.name; }).join('、') + '），请先暂停或终止任务', { job_ids: running.map(function (j) { return j.job_id; }) });
      }
      list.splice(idx, 1);
      return ok({ node_id: p.node_id, deleted: true });
    });

    /* ================= FL-ORCH-03 数据隔离 ================= */

    const ISO_POLICY = {
      dir_rule: '每个训练节点只挂载自己的数据目录（权限 0700，属主为该节点的服务账户），其他节点的目录不在其挂载命名空间内',
      channel_rule: '节点之间只通过 gRPC 通道收发 ModelUpdate 消息，消息字段白名单为梯度 / 模型参数增量 / 样本数 / 本地指标',
      audit_rule: '每轮上传前按白名单检查消息字段，并与本节点数据集的列名比对，出现原始数据字段即拒绝发送'
    };
    const PAYLOAD_ALLOWED = [
      { field: 'weights_delta', kind: 'gradient', label: '模型参数增量 / 梯度（float32 张量，聚合前经同态加密或秘密共享）' },
      { field: 'num_samples', kind: 'metadata', label: '本轮参与训练的样本数（整数，用于 FedAvg 加权）' },
      { field: 'local_metrics', kind: 'metric', label: '本地评估指标（Loss / Accuracy 或 RMSE / MAE 标量）' },
      { field: 'global_weights', kind: 'model_param', label: '聚合后的全局模型参数（聚合节点下发给训练节点）' }
    ];
    const PAYLOAD_FORBIDDEN = [
      { field: 'raw_rows', label: '原始样本行（任何特征明细）' },
      { field: 'labels', label: '标签列 / 预测目标原值' },
      { field: 'id_columns', label: '求交键与个人标识（phone_hash、id_card_hash 等）' },
      { field: 'file_paths', label: '本地数据目录与文件路径' }
    ];

    function isoLogs(pid) { return flo.isoLogs[pid] || (flo.isoLogs[pid] = []); }

    k.route('GET', '/projects/{project_id}/isolation', function (p) {
      if (!project(p.project_id)) return err(40400, '项目不存在');
      const nodes = nodesOf(p.project_id).map(nodeView);
      const dirs = nodes.filter(function (n) { return n.data_dir; });
      const matrix = nodes.map(function (n) {
        return {
          node_id: n.node_id, role: n.role,
          cells: dirs.map(function (d) { return { owner_node_id: d.node_id, data_dir: d.data_dir, allowed: d.node_id === n.node_id }; })
        };
      });
      return ok({
        policy: ISO_POLICY,
        data_dirs: dirs.map(function (d) { return { node_id: d.node_id, data_partition: d.data_partition, data_dir: d.data_dir }; }),
        matrix: matrix,
        payload_allowed: PAYLOAD_ALLOWED, payload_forbidden: PAYLOAD_FORBIDDEN,
        checks: isoLogs(p.project_id).slice(0, 20)
      });
    });

    /**
     * 两类检测：
     *   type = dir_access：actor 节点尝试读 target 节点的数据目录，非本节点一律拒绝并记日志
     *   type = payload：审计某任务最近一轮各节点上传的消息字段，确认只含白名单字段、无原始数据列
     */
    k.route('POST', '/projects/{project_id}/isolation/checks', function (p, q, body) {
      const pid = p.project_id;
      if (!project(pid)) return err(40400, '项目不存在');
      const nodes = nodesOf(pid).map(nodeView);
      const byId = function (id) { return nodes.filter(function (n) { return n.node_id === id; })[0]; };
      let rec;
      if (body.type === 'dir_access') {
        if (!body.actor_node_id || !body.target_node_id) return err(40000, 'actor_node_id 与 target_node_id 必填');
        const actor = byId(body.actor_node_id), target = byId(body.target_node_id);
        if (!actor || !target) return err(40400, '节点不属于本项目');
        if (!target.data_dir) return err(40001, target.node_id + ' 是聚合节点，没有本地数据目录');
        const path = target.data_dir + '/train.parquet';
        const allowed = actor.node_id === target.node_id;
        rec = {
          check_id: fid('iso'), type: 'dir_access', at: k.NOW(), operator: operator(),
          actor_node_id: actor.node_id, target_node_id: target.node_id, path: path,
          result: allowed ? 'allowed' : 'denied',
          detail: allowed
            ? actor.node_id + ' 读取本节点目录 ' + path + '：允许'
            : 'open("' + path + '", O_RDONLY) 被拒绝：EACCES，' + actor.node_id + ' 的挂载命名空间内不存在 ' + target.node_id + ' 的数据目录',
          rule: ISO_POLICY.dir_rule
        };
      } else if (body.type === 'payload') {
        const jobs = k.jobsOfProject(pid);
        const job = body.job_id ? db.flJobs[body.job_id] : jobs.filter(function (j) { return j.metrics.length; })[0];
        if (body.job_id && (!job || job.project_id !== pid)) return err(40400, '任务不存在或不属于本项目');
        if (!job || !job.metrics.length) return err(40901, '该任务尚未产生训练轮次，没有可审计的传输内容，请先启动训练');
        const last = job.metrics[job.metrics.length - 1];
        const cols = {};
        Object.keys(db.datasets).forEach(function (id) {
          const d = db.datasets[id];
          if (d.project_id === pid) d.columns.forEach(function (c) { cols[c.name] = true; });
        });
        const metricKeys = k.taskTypeOf(job.task_type).metrics.map(function (m) { return m.key; });
        const roleOf = {};
        nodes.forEach(function (n) { roleOf[n.node_id] = n.role; });
        const perNode = last.nodes.map(function (nm) {
          const bytes = Math.round(nm.upload_kb * 1024);
          const agg = roleOf[nm.node_id] === 'aggregator';
          const fields = agg ? [
            { field: 'global_weights', kind: 'model_param', dtype: 'float32', elements: Math.floor((bytes - 8) / 4), bytes: bytes - 8 },
            { field: 'round', kind: 'metadata', dtype: 'int64', elements: 1, bytes: 8 }
          ] : [
            { field: 'weights_delta', kind: 'gradient', dtype: 'float32', elements: Math.floor((bytes - 64) / 4), bytes: bytes - 64 },
            { field: 'num_samples', kind: 'metadata', dtype: 'int64', elements: 1, bytes: 8 },
            { field: 'local_metrics', kind: 'metric', dtype: 'float32', elements: metricKeys.length, bytes: 56 }
          ];
          const leaked = fields.filter(function (f) { return cols[f.field]; }).length;
          return { node_id: nm.node_id, role: agg ? 'aggregator' : 'trainer', direction: agg ? 'downlink' : 'uplink', round: last.round, total_bytes: bytes, fields: fields, raw_fields_found: leaked };
        });
        const leakedTotal = perNode.reduce(function (s, n) { return s + n.raw_fields_found; }, 0);
        rec = {
          check_id: fid('iso'), type: 'payload', at: k.NOW(), operator: operator(),
          job_id: job.job_id, job_name: job.name, round: last.round,
          scanned_columns: Object.keys(cols).length, nodes: perNode,
          result: leakedTotal ? 'denied' : 'passed',
          detail: '第 ' + last.round + ' 轮 ' + perNode.length + ' 个节点的消息只含白名单字段（训练节点上传 weights_delta / num_samples / local_metrics，聚合节点下发 global_weights / round）；' +
            '与本项目数据集 ' + Object.keys(cols).length + ' 个列名比对，命中原始数据字段 ' + leakedTotal + ' 个',
          rule: ISO_POLICY.audit_rule
        };
      } else {
        return err(40000, 'type 必须是 dir_access 或 payload');
      }
      isoLogs(pid).unshift(rec);
      if (isoLogs(pid).length > 50) isoLogs(pid).length = 50;
      return ok(rec);
    });

    /* ================= 参数 schema（FL-ORCH-06 / 09 共用） ================= */

    const SCHEMA_KEYS = ['$schema', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties'];
    const PROP_KEYS = ['type', 'title', 'description', 'default', 'minimum', 'maximum', 'enum'];
    const PROP_TYPES = ['integer', 'number', 'string', 'boolean'];

    function typeOk(type, v) {
      if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
      if (type === 'number') return typeof v === 'number' && !Number.isNaN(v);
      if (type === 'string') return typeof v === 'string';
      return typeof v === 'boolean';
    }

    /** 校验 JSON Schema 子集：根为 object，属性只允许 integer / number / string / boolean 及常用约束。返回错误信息或 null。 */
    function schemaError(s) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return '参数 schema 必须是 JSON 对象';
      const extra = Object.keys(s).filter(function (x) { return SCHEMA_KEYS.indexOf(x) < 0; });
      if (extra.length) return '参数 schema 不支持关键字 ' + extra.join(', ') + '（支持 ' + SCHEMA_KEYS.join(' / ') + '）';
      if (s.type !== 'object') return '参数 schema 根节点 type 必须是 "object"';
      const props = s.properties;
      if (!props || typeof props !== 'object' || Array.isArray(props) || !Object.keys(props).length) return 'properties 至少定义 1 个参数';
      const names = Object.keys(props);
      for (let i = 0; i < names.length; i++) {
        const n = names[i], d = props[n];
        if (!/^[a-z_][a-z0-9_]*$/.test(n)) return '参数名 ' + n + ' 只能包含小写字母、数字和下划线';
        if (!d || typeof d !== 'object') return '参数 ' + n + ' 的定义必须是对象';
        const bad = Object.keys(d).filter(function (x) { return PROP_KEYS.indexOf(x) < 0; });
        if (bad.length) return '参数 ' + n + ' 不支持关键字 ' + bad.join(', ');
        if (PROP_TYPES.indexOf(d.type) < 0) return '参数 ' + n + ' 的 type 必须是 ' + PROP_TYPES.join(' / ');
        const numeric = d.type === 'integer' || d.type === 'number';
        if ((d.minimum !== undefined || d.maximum !== undefined) && !numeric) return '参数 ' + n + ' 不是数值类型，不能设置 minimum / maximum';
        if (d.minimum !== undefined && typeof d.minimum !== 'number') return '参数 ' + n + ' 的 minimum 必须是数字';
        if (d.maximum !== undefined && typeof d.maximum !== 'number') return '参数 ' + n + ' 的 maximum 必须是数字';
        if (d.minimum !== undefined && d.maximum !== undefined && d.minimum > d.maximum) return '参数 ' + n + ' 的 minimum 大于 maximum';
        if (d.enum !== undefined) {
          if (!Array.isArray(d.enum) || !d.enum.length) return '参数 ' + n + ' 的 enum 必须是非空数组';
          if (!d.enum.every(function (v) { return typeOk(d.type, v); })) return '参数 ' + n + ' 的 enum 取值与 type 不一致';
        }
        if (d.default !== undefined) {
          const e = valueError(n, d, d.default);
          if (e) return '默认值不合法：' + e.message;
        }
      }
      if (s.required !== undefined) {
        if (!Array.isArray(s.required)) return 'required 必须是数组';
        const miss = s.required.filter(function (x) { return names.indexOf(x) < 0; });
        if (miss.length) return 'required 中的 ' + miss.join(', ') + ' 未在 properties 中定义';
      }
      return null;
    }

    /** 单个参数值校验，返回 { code, message } 或 null。 */
    function valueError(name, d, v) {
      if (!typeOk(d.type, v)) return { code: 40002, message: '参数 ' + name + ' 应为 ' + d.type + '，收到 ' + JSON.stringify(v) };
      if (d.enum && d.enum.indexOf(v) < 0) return { code: 40002, message: '参数 ' + name + ' 只能取 ' + d.enum.join(' / ') };
      if (d.minimum !== undefined && v < d.minimum) return { code: 40003, message: '参数 ' + name + ' 不能小于 ' + d.minimum };
      if (d.maximum !== undefined && v > d.maximum) return { code: 40003, message: '参数 ' + name + ' 不能大于 ' + d.maximum };
      return null;
    }

    /** 按 schema 校验参数并补默认值。返回 { params } 或 { error: 响应包 }。 */
    function resolveParams(schema, params) {
      params = params || {};
      if (typeof params !== 'object' || Array.isArray(params)) return { error: err(40000, 'params 必须是对象') };
      const props = schema.properties;
      const unknown = Object.keys(params).filter(function (x) { return !props[x]; });
      if (unknown.length) return { error: err(40000, '参数 ' + unknown.join(', ') + ' 不在该算法的参数 schema 中') };
      const out = {};
      const names = Object.keys(props);
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        const v = params[n] !== undefined ? params[n] : props[n].default;
        if (v === undefined) {
          if ((schema.required || []).indexOf(n) >= 0) return { error: err(40000, '缺少必填参数 ' + n) };
          continue;
        }
        const e = valueError(n, props[n], v);
        if (e) return { error: err(e.code, e.message) };
        out[n] = v;
      }
      return { params: out };
    }

    /* ================= FL-ORCH-05 / 06 / 07 / 08 算法库 ================= */

    function currentVer(a) { return a.versions.filter(function (v) { return v.version === a.current_version; })[0]; }

    function algoView(a, full) {
      const cur = currentVer(a);
      const v = {
        algo_id: a.algo_id, name: a.name, kind: a.kind, project_id: a.project_id, task_types: a.task_types,
        base_class: a.base_class, framework: a.framework, description: a.description, model_format: a.model_format,
        current_version: a.current_version, version_count: a.versions.length,
        model_file_id: cur.file_id, structure: cur.structure || null,
        template_count: Object.keys(flo.templates).filter(function (id) { return flo.templates[id].algo_id === a.algo_id; }).length
      };
      if (full) {
        v.interface = a.interface;
        v.params_schema = cur.params_schema;
        v.versions = a.versions.slice().reverse().map(function (x) {
          return {
            version: x.version, is_current: x.version === a.current_version, created_at: x.created_at, created_by: x.created_by,
            note: x.note, file_id: x.file_id, structure: x.structure || null
          };
        });
        v.history = a.history.slice().reverse();
      }
      return v;
    }

    k.route('GET', '/fl/algorithms', function (p, q) {
      let list = Object.keys(flo.algos).map(function (id) { return flo.algos[id]; });
      list = list.filter(function (a) { return a.kind !== 'custom' || a.project_id === q.project_id; });
      if (q.kind) list = list.filter(function (a) { return a.kind === q.kind; });
      if (q.task_type) list = list.filter(function (a) { return a.task_types.indexOf(q.task_type) >= 0; });
      return ok({ items: list.map(function (a) { return algoView(a, false); }), page: 1, page_size: 100, total: list.length });
    });

    k.route('GET', '/fl/algorithms/{algo_id}', function (p) {
      const a = flo.algos[p.algo_id];
      if (!a) return err(40400, '算法不存在');
      return ok(algoView(a, true));
    });

    const SEMVER = /^\d+\.\d+\.\d+$/;
    function cmpVer(x, y) {
      const a = x.split('.').map(Number), b = y.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    }

    /** 注册算法：同名算法再次注册即发布新版本（版本号须大于已有最高版本）。 */
    k.route('POST', '/fl/algorithms', function (p, q, body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return err(40000, '算法名必填');
      if (name.length > 40) return err(40003, '算法名不能超过 40 个字符');
      if (!body.version || !SEMVER.test(body.version)) return err(40002, '版本号必须是 主.次.修订 格式，例如 1.0.0');
      if (MODEL_FORMATS.indexOf(body.model_format) < 0) return err(40000, '模型文件格式必须是 ' + MODEL_FORMATS.join(' / '));
      const tts = body.task_types || [];
      if (!Array.isArray(tts) || !tts.length || tts.some(function (t) { return !k.taskTypeOf(t); })) {
        return err(40000, 'task_types 至少选一个：classification / timeseries');
      }
      let schema = body.params_schema;
      if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch (e) { return err(40002, '参数 schema 不是合法 JSON：' + e.message); }
      }
      const se = schemaError(schema);
      if (se) return err(40002, se);

      const same = Object.keys(flo.algos).map(function (id) { return flo.algos[id]; })
        .filter(function (a) { return a.kind !== 'custom' && a.name === name; })[0];
      if (same && same.kind === 'builtin') return err(40902, '「' + name + '」是内置算法名，请换一个名称');
      if (same && same.versions.some(function (v) { return v.version === body.version; })) {
        return err(40902, '算法 ' + name + ' 已存在版本 ' + body.version);
      }
      if (same) {
        const top = same.versions.map(function (v) { return v.version; }).sort(cmpVer).pop();
        if (cmpVer(body.version, top) <= 0) return err(40003, '新版本号必须大于已有最高版本 ' + top);
      }
      const a = same || {
        algo_id: fid('alg'), name: name, kind: 'registered', project_id: null, task_types: tts,
        base_class: String(body.base_class || 'FedEstimator').trim(), framework: body.framework || '用户注册',
        description: body.description || '', model_format: body.model_format,
        interface: iface(tts.indexOf('timeseries') >= 0 && tts.length === 1 ? TS_IO : TAB_IO,
          tts.length === 1 && tts[0] === 'timeseries' ? TS_EVAL : CLS_EVAL, 'ndarray，与 fit 的 y 同形'),
        versions: [], current_version: null, history: []
      };
      // 注册时登记模型制品文件，新建任务时作为 model_file_id 交给训练引擎加载
      const fileId = 'f_' + a.algo_id + '_' + body.version.replace(/\./g, '');
      db.files[fileId] = {
        file_id: fileId, file_name: a.algo_id + '-' + body.version + '.' + body.model_format, size_bytes: 0,
        purpose: 'fl_model', sha256: k.hashHex(fileId, 8), uploaded_at: k.NOW()
      };
      const prev = a.current_version;
      a.versions.push({ version: body.version, created_at: k.NOW(), created_by: operator(), note: body.description || (same ? '发布新版本' : '首次注册'), params_schema: schema, file_id: fileId });
      a.current_version = body.version;
      a.model_format = body.model_format;
      a.history.push({ action: 'publish', from_version: prev, to_version: body.version, operator: operator(), at: k.NOW() });
      flo.algos[a.algo_id] = a;
      return ok(algoView(a, true));
    });

    /** 回滚：把当前版本指针移到历史版本，记录操作人和时间；新建任务即使用该版本。 */
    k.route('POST', '/fl/algorithms/{algo_id}/actions', function (p, q, body) {
      const a = flo.algos[p.algo_id];
      if (!a) return err(40400, '算法不存在');
      if (body.action !== 'rollback') return err(40000, 'action 只支持 rollback');
      if (!body.version) return err(40000, 'version 必填');
      if (!a.versions.some(function (v) { return v.version === body.version; })) return err(40400, a.name + ' 没有版本 ' + body.version);
      if (body.version === a.current_version) return err(40901, body.version + ' 已是当前版本');
      const prev = a.current_version;
      a.current_version = body.version;
      a.history.push({ action: 'rollback', from_version: prev, to_version: body.version, operator: operator(), at: k.NOW(), reason: body.reason || '' });
      return ok(algoView(a, true));
    });

    /* --- FL-ORCH-07 自定义模型上传 + 结构校验 --- */

    const FORMAT_INFO = {
      pkl: { framework: 'scikit-learn / XGBoost（pickle）', unit: '棵树 / 层', corrupt: 'pickle 流在偏移 0x1F40 处截断，缺少 STOP 操作码' },
      pt: { framework: 'PyTorch（TorchScript / state_dict）', unit: '层', corrupt: 'ZIP 中央目录缺失，无法读取 data.pkl 与张量存储' },
      h5: { framework: 'Keras / TensorFlow（HDF5）', unit: '层', corrupt: 'HDF5 文件签名不匹配（应为 \\x89HDF\\r\\n\\x1a\\n），model_config 属性缺失' },
      onnx: { framework: 'ONNX（opset 17）', unit: '算子节点', corrupt: 'ModelProto 解析失败：graph.node 为空，输入输出未定义' }
    };

    /** 按文件名与大小确定性地推出结构信息；文件名含 corrupt 或大小为 0 判为不完整。 */
    function inspectModel(file, taskType) {
      const ext = (file.file_name.split('.').pop() || '').toLowerCase();
      const info = FORMAT_INFO[ext];
      const checks = [];
      const fail = function (reason) { return { valid: false, format: ext, reason: reason, checks: checks }; };
      checks.push({ item: '文件格式', passed: !!info, detail: info ? '.' + ext + ' · ' + info.framework : '不支持 .' + ext + '，可选 .pkl / .pt / .h5 / .onnx' });
      if (!info) return fail('不支持的模型文件格式 .' + ext);
      checks.push({ item: '文件大小', passed: file.size_bytes > 0, detail: fmtBytes(file.size_bytes) });
      if (!file.size_bytes) return fail('文件为空（0 B），无法解析模型结构');
      const broken = /corrupt/i.test(file.file_name);
      checks.push({ item: '文件头与序列化结构', passed: !broken, detail: broken ? info.corrupt : '可完整反序列化' });
      if (broken) return fail(info.corrupt);
      const h = parseInt(k.hashHex(file.file_name + file.size_bytes, 1), 16);
      const layers = 3 + (h % 10);
      const params = Math.max(1, Math.floor((file.size_bytes - 512) / 4));
      const inputShape = taskType === 'timeseries' ? ['batch', 30, 11] : ['batch', 68];
      const outputShape = taskType === 'timeseries' ? ['batch', 7] : ['batch', 2];
      checks.push({ item: '层结构', passed: true, detail: layers + ' ' + info.unit + '，各层输入输出维度首尾相接' });
      checks.push({ item: '输入形状', passed: true, detail: '(' + inputShape.join(', ') + ')，与' + k.taskTypeOf(taskType).name + '任务的样本格式一致' });
      return {
        valid: true, format: ext, framework: info.framework, layers: layers, param_count: params,
        param_count_basis: '按 float32 每个参数 4 字节、扣除 512 B 文件头估算',
        input_shape: inputShape, output_shape: outputShape, checks: checks, reason: null
      };
    }
    function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

    /** 上传后注册自定义模型。同项目同名模型再次上传即生成新版本（次版本号 +1）。 */
    k.route('POST', '/projects/{project_id}/fl/models', function (p, q, body) {
      const pid = p.project_id;
      if (!project(pid)) return err(40400, '项目不存在');
      if (!body.file_id) return err(40000, 'file_id 必填，请先调用 POST /files 上传模型文件');
      const file = db.files[body.file_id];
      if (!file) return err(40400, '模型文件不存在：' + body.file_id);
      if (file.purpose !== 'fl_model') return err(40000, '文件用途不是 fl_model');
      const taskType = body.task_type || 'classification';
      if (!k.taskTypeOf(taskType)) return err(40000, '未知任务类型 ' + taskType);
      const name = (body.name || file.file_name.replace(/\.[^.]+$/, '')).trim();
      if (name.length > 40) return err(40003, '模型名称不能超过 40 个字符');
      const report = inspectModel(file, taskType);
      if (!report.valid) return err(40002, '模型结构校验失败：' + report.reason, { report: report });

      let a = Object.keys(flo.algos).map(function (id) { return flo.algos[id]; })
        .filter(function (x) { return x.kind === 'custom' && x.project_id === pid && x.name === name; })[0];
      if (a && a.task_types[0] !== taskType) return err(40902, '同名模型「' + name + '」已用于' + k.taskTypeOf(a.task_types[0]).name + '任务，请换名称');
      const schema = schemaOf({
        learning_rate: num(0.00001, 1, 0.001, '学习率'),
        local_epochs: int(1, 20, 2, '每轮本地训练 epoch 数'),
        batch_size: int(16, 4096, 128, '批大小')
      });
      let version = '1.0.0';
      if (!a) {
        a = {
          algo_id: fid('mdl'), name: name, kind: 'custom', project_id: pid, task_types: [taskType],
          base_class: 'CustomModelWrapper(FedEstimator)', framework: report.framework,
          description: '用户上传的自定义模型，平台以统一 fit / predict / evaluate 接口包装', model_format: report.format,
          interface: iface(taskType === 'timeseries' ? TS_IO : TAB_IO, taskType === 'timeseries' ? TS_EVAL : CLS_EVAL, 'ndarray，形状 (' + report.output_shape.join(', ') + ')'),
          versions: [], current_version: null, history: []
        };
        flo.algos[a.algo_id] = a;
      } else {
        const top = a.versions.map(function (v) { return v.version; }).sort(cmpVer).pop().split('.').map(Number);
        version = top[0] + '.' + (top[1] + 1) + '.0';
      }
      const prev = a.current_version;
      a.versions.push({
        version: version, created_at: k.NOW(), created_by: operator(), note: '上传 ' + file.file_name + '（' + fmtBytes(file.size_bytes) + '）',
        params_schema: schema, file_id: file.file_id, structure: report
      });
      a.current_version = version;
      a.model_format = report.format;
      a.framework = report.framework;
      a.history.push({ action: 'publish', from_version: prev, to_version: version, operator: operator(), at: k.NOW() });
      return ok(Object.assign(algoView(a, true), { report: report }));
    });

    /* --- FL-ORCH-09 参数模板 --- */

    k.route('GET', '/fl/algorithms/{algo_id}/templates', function (p) {
      const a = flo.algos[p.algo_id];
      if (!a) return err(40400, '算法不存在');
      const items = Object.keys(flo.templates).map(function (id) { return flo.templates[id]; })
        .filter(function (t) { return t.algo_id === a.algo_id; })
        .sort(function (x, y) { return (y.preset - x.preset) || (x.created_at < y.created_at ? -1 : 1); });
      return ok({ items: items, page: 1, page_size: 100, total: items.length });
    });

    k.route('POST', '/fl/algorithms/{algo_id}/templates', function (p, q, body) {
      const a = flo.algos[p.algo_id];
      if (!a) return err(40400, '算法不存在');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return err(40000, '模板名称必填');
      if (name.length > 30) return err(40003, '模板名称不能超过 30 个字符');
      if (Object.keys(flo.templates).some(function (id) { return flo.templates[id].algo_id === a.algo_id && flo.templates[id].name === name; })) {
        return err(40902, a.name + ' 已有同名模板「' + name + '」');
      }
      const r = resolveParams(currentVer(a).params_schema, body.params);
      if (r.error) return r.error;
      const id = fid('tpl');
      flo.templates[id] = { template_id: id, algo_id: a.algo_id, name: name, params: r.params, preset: false, created_by: operator(), created_at: k.NOW() };
      return ok(flo.templates[id]);
    });

    k.route('DELETE', '/fl/param-templates/{template_id}', function (p) {
      const t = flo.templates[p.template_id];
      if (!t) return err(40400, '模板不存在');
      if (t.preset) return err(40001, '平台预置模板不能删除');
      delete flo.templates[p.template_id];
      return ok({ template_id: p.template_id, deleted: true });
    });

    /* ================= 新建训练任务：支持注册算法 / 自定义模型 + 参数 + 项目默认值 ================= */

    /**
     * 覆盖内核 POST /projects/{id}/fl/jobs：
     *   - algorithm 为 alg_* / mdl_* 时映射成内核的 custom + model_file_id（取该算法当前版本的制品文件）
     *   - params 按算法当前版本的 schema 校验并补默认值，与 algo_ref 一起记在任务上
     *   - 未传 aggregation 时取聚合与安全页的项目策略（k.db.fla），未传 total_rounds 时取项目配置
     * 内置算法且不带 params 时行为与内核完全一致。
     */
    k.routeFirst('POST', '/projects/{project_id}/fl/jobs', function (p, q, body) {
      const pid = p.project_id;
      k.seedProject(pid);
      const req = Object.assign({}, body);
      if (req.aggregation === undefined && aggDefault(pid)) req.aggregation = aggDefault(pid);
      if (req.total_rounds === undefined && project(pid)) req.total_rounds = config(pid).total_rounds;
      const a = flo.algos[req.algorithm];
      if (a && a.kind !== 'builtin') {
        const tt = req.task_type || 'classification';
        if (a.task_types.indexOf(tt) < 0) return err(40000, k.taskTypeOf(tt).name + '任务不支持算法 ' + a.name + '，该算法适用于 ' + a.task_types.map(function (t) { return k.taskTypeOf(t).name; }).join(' / '));
        if (a.kind === 'custom' && a.project_id !== pid) return err(40400, '自定义模型不属于本项目');
        req.algorithm = 'custom';
        req.model_file_id = currentVer(a).file_id;
      }
      const bad = k.validateJobBody(pid, req);
      if (bad) return bad;
      let params = null;
      if (a) {
        const r = resolveParams(currentVer(a).params_schema, req.params);
        if (r.error) return r.error;
        params = r.params;
      }
      if (a && a.kind !== 'builtin' && !req.name) req.name = a.name + ' ' + a.current_version + ' · ' + k.taskTypeOf(req.task_type || 'classification').name;
      const job = k.createJob(pid, req);
      if (a) {
        job.algo_ref = { algo_id: a.algo_id, name: a.name, kind: a.kind, version: a.current_version };
        job.params = params;
        if (req.template_id && flo.templates[req.template_id]) job.algo_ref.template_id = req.template_id;
      }
      return ok(withRef(job));
    });

    /* --- 任务读接口补 algo_ref：列表 / 详情 / 动作返回注册算法或自定义模型的真实名称与版本 --- */

    function withRef(job) {
      const v = k.jobView(job);
      v.algo_ref = job.algo_ref || null;
      v.params = job.params || null;
      v.algo_ref_name = job.algorithm === 'custom' && job.algo_ref && job.algo_ref.kind !== 'builtin'
        ? job.algo_ref.name + ' v' + job.algo_ref.version + (job.algo_ref.kind === 'custom' ? '（自定义模型）' : '（已注册）')
        : null;
      return Object.assign(v, procView(job));
    }

    // 过滤逻辑与内核 GET /projects/{id}/fl/jobs 一致
    k.routeFirst('GET', '/projects/{project_id}/fl/jobs', function (p, q) {
      let list = k.jobsOfProject(p.project_id);
      if (q.status) {
        const want = q.status.split(',');
        list = list.filter(function (j) { return want.indexOf(j.status) >= 0; });
      }
      if (q.task_type) list = list.filter(function (j) { return j.task_type === q.task_type; });
      if (q.latest === 'true' || q.latest === true) list = list.slice(0, 1);
      return ok({ items: list.map(withRef), page: 1, page_size: 20, total: list.length });
    });

    k.routeFirst('GET', '/fl/jobs/{job_id}', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return err(40400, '任务不存在');
      return ok(withRef(job));
    });

    /* ================= 过程管控（FL-PROC-01 至 FL-PROC-08） ================= */

    // 与内核 FL_TRANSITIONS 一致（内核未导出），用于返回 allowed_actions
    const TRANSITIONS = {
      Created: { start: 'Running', reset: 'Created' },
      Running: { pause: 'Paused', terminate: 'Terminated' },
      Paused: { resume: 'Running', terminate: 'Terminated', reset: 'Created' },
      Success: { reset: 'Created' },
      Failed: { start: 'Running', reset: 'Created' },
      Terminated: { start: 'Running', reset: 'Created' }
    };
    const EMA_ALPHA = 0.3;
    const TRAIN_IMAGE = 'registry.local/fl-runtime:1.2.0';

    flo.proc = {};   // job_id -> { history, runtime, checkpoints }
    function proc(job) {
      if (!flo.proc[job.job_id]) {
        const created = { from: null, to: 'Created', action: 'create', at: job.created_at, operator: operator(), reason: null };
        const h = [created];
        // 内核种子任务（已完成的历史任务）补齐迁移记录
        if (job.started_at) h.push({ from: 'Created', to: 'Running', action: 'start', at: job.started_at, operator: operator(), reason: null });
        flo.proc[job.job_id] = { history: h, runtime: null, checkpoints: [] };
      }
      const st = flo.proc[job.job_id];
      const last = st.history[st.history.length - 1];
      // 跑满轮次由训练引擎自动迁移到 Success：读取时补记一条迁移与资源回收
      if (job.status === 'Success' && last.to !== 'Success') {
        st.history.push({ from: 'Running', to: 'Success', action: 'complete', at: job.finished_at || k.NOW(), operator: '训练引擎', reason: '完成全部 ' + job.total_rounds + ' 轮聚合' });
        if (st.runtime) releaseWorkers(st.runtime, 'completed', job.finished_at);
      }
      return st;
    }

    /** 第 r 轮的耗时（秒）：基准 4.2 秒，按轮次正弦波动并叠加确定性抖动，约每 11 轮出现一次慢节点拖尾（+2.4 秒）。 */
    function roundDur(job, r) {
      const h = parseInt(k.hashHex(job.job_id + ':' + r, 1).slice(0, 4), 16);
      const phase = (parseInt(k.hashHex(job.job_id, 1).slice(0, 2), 16) % 60) / 10;
      let d = 4.2 * (1 + 0.12 * Math.sin(0.8 * r + phase)) + ((h % 100) / 100) * 0.6 - 0.3;
      if (h % 11 === 0) d += 2.4;
      return Math.round(d * 10) / 10;
    }

    /** 指数平滑（EMA）预估剩余时间：s₁ = d₁，sᵣ = α·dᵣ + (1 − α)·sᵣ₋₁，ETA = sᵣ ×（总轮次 − 已完成轮次）。 */
    function etaOf(job) {
      const r = job.current_round;
      const hist = [];
      let elapsed = 0, ema = null;
      for (let i = 1; i <= r; i++) {
        const d = roundDur(job, i);
        elapsed += d;
        ema = ema === null ? d : EMA_ALPHA * d + (1 - EMA_ALPHA) * ema;
        hist.push({ round: i, duration_sec: d, ema_sec: Number(ema.toFixed(2)), eta_sec: Number((ema * (job.total_rounds - i)).toFixed(1)) });
      }
      const remaining = Math.max(0, job.total_rounds - r);
      const done = job.status === 'Success';
      return {
        job_id: job.job_id, status: job.status, current_round: r, total_rounds: job.total_rounds,
        elapsed_sec: Number(elapsed.toFixed(1)),
        eta_sec: done ? 0 : (r === 0 ? null : Number((ema * remaining).toFixed(1))),
        eta_naive_sec: done ? 0 : (r === 0 ? null : Number((elapsed / r * remaining).toFixed(1))),
        avg_round_sec: r ? Number((elapsed / r).toFixed(2)) : null,
        ema_round_sec: ema === null ? null : Number(ema.toFixed(2)),
        method: 'ema', alpha: EMA_ALPHA,
        formula: 'sᵣ = α·dᵣ + (1 − α)·sᵣ₋₁，ETA = sᵣ × (总轮次 − 已完成轮次)，α = ' + EMA_ALPHA,
        history: hist
      };
    }

    function procView(job) {
      const st = proc(job);
      const e = etaOf(job);
      return {
        elapsed_sec: e.elapsed_sec, eta_sec: e.eta_sec,
        eta: { method: e.method, alpha: e.alpha, ema_round_sec: e.ema_round_sec, avg_round_sec: e.avg_round_sec, eta_naive_sec: e.eta_naive_sec },
        allowed_actions: Object.keys(TRANSITIONS[job.status] || {}),
        state_history: st.history.slice(),
        runtime: st.runtime,
        checkpoint: st.checkpoints.length ? st.checkpoints[st.checkpoints.length - 1] : null,
        failure_reason: job.failure_reason || null
      };
    }

    function releaseWorkers(rt, status, at) {
      rt.workers.forEach(function (w) {
        if (w.status === 'running' || w.status === 'suspended') { w.status = status; w.released_at = at || k.NOW(); }
      });
      rt.released = true;
      rt.released_at = at || k.NOW();
    }

    /** 启动 / 恢复前的预检：项目、节点可用性、算法兼容性。返回 { error } 或 { checks, nodes }。 */
    function preflight(job) {
      const pid = job.project_id;
      const checks = [];
      if (!project(pid)) return { error: err(40400, '任务所属项目不存在') };
      const cfg = config(pid);
      checks.push({ item: '项目配置', passed: true, detail: '基准模型 ' + cfg.base_algorithm + ' ' + cfg.model_version + '，训练目标 ' + targetView(cfg.target).label + ' ' + (targetView(cfg.target).op === '<=' ? '≤' : '≥') + ' ' + cfg.target.value });
      const all = db.nodes[pid] || [];
      const missing = job.node_ids.filter(function (id) { return !all.some(function (n) { return n.node_id === id; }); });
      if (missing.length) return { error: err(40901, '参与节点已从项目移除：' + missing.join('、') + '，请重置任务后重新选择节点', { missing_node_ids: missing }) };
      const picked = all.filter(function (n) { return job.node_ids.indexOf(n.node_id) >= 0; });
      const offline = picked.filter(function (n) { return n.online === false; });
      if (offline.length) {
        return { error: err(42201, '节点不可用：' + offline.map(function (n) { return n.node_id; }).join('、') + ' 心跳丢失（离线），请恢复节点后再启动', { offline_node_ids: offline.map(function (n) { return n.node_id; }) }) };
      }
      const trainers = picked.filter(function (n) { return n.role === 'trainer'; }).length;
      const aggs = picked.filter(function (n) { return n.role === 'aggregator'; }).length;
      if (trainers < 2 || aggs < 1) return { error: err(40000, '参与节点不足：当前 ' + trainers + ' 个训练节点、' + aggs + ' 个聚合节点，至少需要 2 个训练节点和 1 个聚合节点') };
      checks.push({ item: '节点可用性', passed: true, detail: picked.length + ' 个节点在线（' + trainers + ' 训练 + ' + aggs + ' 聚合）' });
      const tt = k.taskTypeOf(job.task_type);
      if (tt.algorithms.indexOf(job.algorithm) < 0) return { error: err(40000, '算法不兼容：' + tt.name + '任务不支持 ' + job.algorithm + '，可选 ' + tt.algorithms.join(' / ')) };
      if (job.algorithm === 'custom') {
        if (!job.model_file_id || !db.files[job.model_file_id]) return { error: err(40000, '算法不兼容：自定义模型文件不存在，请重新上传') };
        const a = job.algo_ref && flo.algos[job.algo_ref.algo_id];
        if (a && a.task_types.indexOf(job.task_type) < 0) return { error: err(40000, '算法不兼容：' + a.name + ' 不支持' + tt.name + '任务') };
      }
      checks.push({ item: '算法兼容性', passed: true, detail: (job.algo_ref ? job.algo_ref.name + ' ' + job.algo_ref.version : job.algorithm) + ' 支持' + tt.name + '任务' });
      return { checks: checks, nodes: picked };
    }

    function allocate(job, nodes) {
      const at = k.NOW();
      return {
        allocated_at: at, image: TRAIN_IMAGE, released: false, released_at: null,
        workers: nodes.map(function (n) {
          const h = parseInt(k.hashHex(job.job_id + n.node_id + at, 1).slice(0, 6), 16);
          return {
            node_id: n.node_id, role: n.role, container_id: 'flc-' + k.hashHex(job.job_id + n.node_id + at, 2).slice(0, 12),
            pid: 2000 + (h % 60000), cpu_cores: n.role === 'aggregator' ? 2 : 4, memory_mb: n.role === 'aggregator' ? 4096 : 8192,
            status: 'running', started_at: at, released_at: null
          };
        })
      };
    }

    function transit(job, from, action, reason) {
      proc(job).history.push({ from: from, to: job.status, action: action, at: k.NOW(), operator: operator(), reason: reason || null });
    }

    /** 节点心跳丢失：使用它的运行中任务停止聚合循环并迁移到 Failed，回收容器。 */
    function failJobsOnNode(pid, nodeId) {
      runningJobs(pid, nodeId).filter(function (j) { return j.status === 'Running'; }).forEach(function (job) {
        if (job._timer) { clearInterval(job._timer); job._timer = null; }
        job.status = 'Failed';
        job.finished_at = k.NOW();
        job.failure_reason = '节点 ' + nodeId + ' 心跳丢失，第 ' + (job.current_round + 1) + ' 轮聚合未完成';
        const st = proc(job);
        st.history.push({ from: 'Running', to: 'Failed', action: 'fail', at: job.finished_at, operator: '训练引擎', reason: job.failure_reason });
        if (st.runtime) releaseWorkers(st.runtime, 'failed', job.finished_at);
        k.emit('/fl/jobs/' + job.job_id + '/events', 'status_changed', { job_id: job.job_id, status: 'Failed', previous_status: 'Running', at: job.finished_at });
      });
    }

    k.routeFirst('POST', '/fl/jobs/{job_id}/actions', function (p, q, body) {
      const job = db.flJobs[p.job_id];
      if (!job) return err(40400, '任务不存在');
      const action = (body || {}).action;
      const st = proc(job);
      let pre = null;
      if ((action === 'start' || action === 'resume') && (TRANSITIONS[job.status] || {})[action]) {
        pre = preflight(job);
        if (pre.error) return pre.error;
      }
      const from = job.status;
      const r = k.flAction(job, action);
      if (r.code !== 0) return r;
      if (action === 'start') {
        job.failure_reason = null;
        st.checkpoints = [];
        st.runtime = allocate(job, pre.nodes);
        precompensate(job);
      } else if (action === 'pause') {
        // 断点：保存本轮聚合后的全局模型参数、优化器状态与各训练节点的数据读取位置
        const last = job.metrics[job.metrics.length - 1];
        const bytes = last ? Math.round(last.nodes.reduce(function (s, n) { return s + n.upload_kb; }, 0) * 1024 / Math.max(1, last.nodes.length)) : 0;
        st.checkpoints.push({
          checkpoint_id: fid('ckpt'), round: job.current_round, saved_at: k.NOW(),
          path: '/data/fl/ckpt/' + job.job_id + '/round_' + String(job.current_round).padStart(3, '0') + '.ckpt',
          global_model_sha256: k.hashHex('ckpt' + job.job_id + job.current_round, 8),
          global_model_bytes: bytes, global_metrics: last ? Object.assign({}, last.global) : null,
          optimizer_state: '服务端聚合器动量与学习率调度步数（step = ' + job.current_round + '）',
          node_cursors: job.node_ids.filter(function (id) { return (db.nodes[job.project_id] || []).some(function (n) { return n.node_id === id && n.role === 'trainer'; }); })
            .map(function (id) { return { node_id: id, epoch: job.current_round, batch_offset: 0 }; })
        });
        if (st.runtime) st.runtime.workers.forEach(function (w) { if (w.status === 'running') w.status = 'suspended'; });
      } else if (action === 'resume') {
        if (st.runtime) st.runtime.workers.forEach(function (w) { if (w.status === 'suspended') w.status = 'running'; });
      } else if (action === 'terminate') {
        if (st.runtime) releaseWorkers(st.runtime, 'killed');
      } else if (action === 'reset') {
        st.runtime = null;
        st.checkpoints = [];
        job.failure_reason = null;
      }
      const ck = st.checkpoints[st.checkpoints.length - 1];
      transit(job, from, action, action === 'resume' && ck ? '从第 ' + ck.round + ' 轮断点继续' : (action === 'terminate' ? '强制终止，容器以 SIGKILL 结束并释放资源' : null));
      const v = withRef(job);
      if (pre) v.preflight = pre.checks;
      if (action === 'resume' && ck) v.resumed_from_round = ck.round;
      return ok(v);
    });

    /**
     * 内核 jobTick 每轮先执行 elapsed_sec += 4.2 再推送 round_completed，推送的 eta_sec 取 db.etaOf(job)。
     * 为让推送里的 elapsed_sec 也等于逐轮耗时之和 Σdᵣ，这里预先把内核计数器调成「Σdᵣ + dᵣ₊₁ − 4.2」，
     * 内核下一次 +4.2 后正好得到 Σdᵣ₊₁。列表 / 详情 / ETA 接口一律按 etaOf 重新计算，不读这个计数器。
     */
    function precompensate(job) {
      const S = etaOf(job).elapsed_sec;
      job.elapsed_sec = Math.round((S + roundDur(job, job.current_round + 1) - 4.2) * 10) / 10;
    }
    db.etaOf = function (job) {
      const e = etaOf(job);
      if (job.current_round < job.total_rounds) precompensate(job);
      return e.eta_sec;
    };

    k.route('GET', '/fl/jobs/{job_id}/eta', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return err(40400, '任务不存在');
      proc(job);
      return ok(etaOf(job));
    });

    /* --- 指标：按轮次 / 写入时间过滤（扩展内核 GET /fl/jobs/{id}/metrics） --- */

    function parseTime(v, name) {
      if (v === undefined || v === null || v === '') return { t: null };
      const t = Date.parse(v);
      if (Number.isNaN(t)) return { error: err(40002, name + ' 不是合法的 ISO 8601 时间：' + v) };
      return { t: t };
    }
    function timeRange(q) {
      const a = parseTime(q.start_time, 'start_time'), b = parseTime(q.end_time, 'end_time');
      if (a.error) return a;
      if (b.error) return b;
      if (a.t !== null && b.t !== null && a.t > b.t) return { error: err(40003, 'start_time 不能晚于 end_time') };
      return { from: a.t, to: b.t };
    }
    function inRange(m, tr) {
      const t = Date.parse(m.recorded_at);
      return (tr.from === null || t >= tr.from) && (tr.to === null || t <= tr.to);
    }

    k.routeFirst('GET', '/fl/jobs/{job_id}/metrics', function (p, q) {
      const job = db.flJobs[p.job_id];
      if (!job) return err(40400, '任务不存在');
      const scope = q.scope || 'global';
      if (scope !== 'global' && scope !== 'nodes') return err(40000, 'scope 必须是 global 或 nodes');
      const from = q.from_round !== undefined ? Number(q.from_round) : 1;
      const to = q.to_round !== undefined ? Number(q.to_round) : job.total_rounds;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1) return err(40002, 'from_round / to_round 必须是正整数');
      if (from > to) return err(40003, 'from_round 不能大于 to_round');
      const tr = timeRange(q);
      if (tr.error) return tr.error;
      const keys = k.taskTypeOf(job.task_type).metrics.map(function (s) { return s.key; });
      const rows = job.metrics.filter(function (m) { return m.round >= from && m.round <= to && inRange(m, tr); });
      const point = function (src, m) {
        const out = { round: m.round, recorded_at: m.recorded_at };
        keys.forEach(function (key) { out[key] = src[key]; });
        return out;
      };
      const series = [{ key: 'global', label: '全局', points: rows.map(function (m) { return point(m.global, m); }) }];
      if (scope === 'nodes') {
        k.jobNodes(job).forEach(function (nd) {
          series.push({
            key: nd.node_id, label: nd.node_id,
            points: rows.map(function (m) { return point(m.nodes.filter(function (x) { return x.node_id === nd.node_id; })[0] || {}, m); })
          });
        });
      }
      return ok({ total_rounds: job.total_rounds, metrics_spec: k.taskTypeOf(job.task_type).metrics, series: series });
    });

    /* --- 历史指标查询与导出：按时间范围、项目 ID、任务 ID --- */

    const ALL_KEYS = ['loss', 'accuracy', 'rmse', 'mae'];
    function historyRows(q) {
      if (q.project_id && !project(q.project_id)) return { error: err(40400, '项目不存在：' + q.project_id) };
      if (q.job_id && !db.flJobs[q.job_id]) return { error: err(40400, '任务不存在：' + q.job_id) };
      const scope = q.scope || 'global';
      if (scope !== 'global' && scope !== 'nodes') return { error: err(40000, 'scope 必须是 global 或 nodes') };
      const tr = timeRange(q);
      if (tr.error) return tr;
      if (q.project_id) k.seedProject(q.project_id);
      const jobs = Object.keys(db.flJobs).map(function (id) { return db.flJobs[id]; }).filter(function (j) {
        return (!q.project_id || j.project_id === q.project_id) && (!q.job_id || j.job_id === q.job_id);
      });
      const rows = [];
      jobs.forEach(function (j) {
        j.metrics.filter(function (m) { return inRange(m, tr); }).forEach(function (m) {
          const add = function (series, src) {
            const row = { project_id: j.project_id, job_id: j.job_id, job_name: j.name, task_type: j.task_type, round: m.round, series: series, recorded_at: m.recorded_at };
            ALL_KEYS.forEach(function (key) { row[key] = src[key] !== undefined ? src[key] : null; });
            rows.push(row);
          };
          add('global', m.global);
          if (scope === 'nodes') m.nodes.forEach(function (n) { add(n.node_id, n); });
        });
      });
      return { rows: rows, jobs: jobs.length };
    }

    k.route('GET', '/fl/metrics', function (p, q) {
      const r = historyRows(q);
      if (r.error) return r.error;
      const size = Math.min(500, Math.max(1, Number(q.page_size) || 50));
      const page = Math.max(1, Number(q.page) || 1);
      return ok({ items: r.rows.slice((page - 1) * size, page * size), page: page, page_size: size, total: r.rows.length, job_count: r.jobs });
    });

    function metricsCsv(q, name) {
      const r = historyRows(q);
      if (r.error) return null;
      const cols = ['project_id', 'job_id', 'task_type', 'round', 'series'].concat(ALL_KEYS, ['recorded_at']);
      const csv = cols.join(',') + '\n' + r.rows.map(function (row) {
        return cols.map(function (c) { return row[c] === null ? '' : row[c]; }).join(',');
      }).join('\n') + (r.rows.length ? '\n' : '');
      return { fileName: name, contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
    }
    // 覆盖内核单任务导出：列与内核一致（job_id,round,series,<指标>,recorded_at，默认 scope = nodes），start_time / end_time 生效
    k.downloadFirst(/^\/fl\/jobs\/([^/]+)\/metrics\/export$/, function (m, q) {
      const job = db.flJobs[m[1]];
      if (!job) return null;
      const tr = timeRange(q);
      if (tr.error) throw new Error(tr.error.message);
      const scope = q.scope || 'nodes';
      if (scope !== 'global' && scope !== 'nodes') throw new Error('scope 必须是 global 或 nodes');
      const keys = k.taskTypeOf(job.task_type).metrics.map(function (x) { return x.key; });
      const line = function (name, src, x) {
        return [job.job_id, x.round, name].concat(keys.map(function (key) { return src[key]; }), [x.recorded_at]).join(',') + '\n';
      };
      let csv = ['job_id', 'round', 'series'].concat(keys, ['recorded_at']).join(',') + '\n';
      job.metrics.filter(function (x) { return inRange(x, tr); }).forEach(function (x) {
        csv += line('global', x.global, x);
        if (scope === 'nodes') x.nodes.forEach(function (n) { csv += line(n.node_id, n, x); });
      });
      return { fileName: job.job_id + '_metrics.csv', contentType: 'text/csv;charset=utf-8', content: '\ufeff' + csv };
    });

    k.download(/^\/projects\/([^/]+)\/fl\/metrics\/export$/, function (m, q) {
      return metricsCsv(Object.assign({}, q, { project_id: m[1] }), 'fl_metrics_' + m[1] + '.csv');
    });
    k.download(/^\/fl\/metrics\/export$/, function (m, q) {
      return metricsCsv(q, 'fl_metrics' + (q.project_id ? '_' + q.project_id : '') + (q.job_id ? '_' + q.job_id : '') + '.csv');
    });

    /* --- 任务维度节点：离线节点显示 offline（扩展内核 GET /fl/jobs/{id}/nodes） --- */

    k.routeFirst('GET', '/fl/jobs/{job_id}/nodes', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return err(40400, '任务不存在');
      const last = job.metrics[job.metrics.length - 1];
      const base = job.current_round === 0 ? 'pending' : ({ Running: 'uploading', Paused: 'suspended', Terminated: 'released', Failed: 'released' })[job.status] || 'completed';
      const items = k.jobNodes(job).map(function (nd) {
        const m = last ? last.nodes.filter(function (x) { return x.node_id === nd.node_id; })[0] : null;
        return {
          node_id: nd.node_id, ip: nd.ip, port: nd.port, role: nd.role, role_label: nd.role_label, data_partition: nd.data_partition,
          round_upload_kb: m ? m.upload_kb : null, status: nd.online === false ? 'offline' : base
        };
      });
      return ok({ items: items, page: 1, page_size: 20, total: items.length });
    });
  });
})();
