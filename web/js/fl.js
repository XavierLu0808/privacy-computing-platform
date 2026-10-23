/** 联邦学习模块。接口见 API.md §2。 */
(function () {
  'use strict';
  const $ = UI.$;

  const STATE_CN = {
    Created: '已创建', Running: '运行中', Paused: '已暂停',
    Success: '已完成', Failed: '失败', Terminated: '已终止'
  };
  const STATE_ORDER = ['Created', 'Running', 'Paused', 'Success', 'Failed', 'Terminated'];
  const BADGE = {
    Created: ['#F0F2F5', '#4C5564'], Running: ['#E7F0FA', '#1A4F8A'], Paused: ['#FCF2E3', '#8A5B12'],
    Success: ['#E9F4EF', '#1D5C42'], Failed: ['#FBEDEA', '#A33B21'], Terminated: ['#F0F2F5', '#4C5564']
  };
  const ALGO_CN = { lr: '逻辑回归', xgb: 'XGBoost', cnn: 'CNN', lstm: 'LSTM', tcn: 'TCN', custom: '自定义上传模型' };
  const AGG_CN = { ss: '秘密共享聚合', he: '同态加密聚合' };
  const NODE_ST = {
    pending: ['待启动', '#8A93A2'], uploading: ['上传中', '#1A4F8A'], suspended: ['已挂起', '#8A5B12'],
    completed: ['已完成', '#1D5C42'], released: ['已释放', '#A33B21'], offline: ['离线', '#A33B21']
  };
  const NODE_COLORS = ['#7FA9DB', '#0E6F6C', '#9A6516', '#8E5BA8', '#5C6B7F'];
  const CHART = { w: 548, h: 184, pl: 44, pr: 10, pt: 14, pb: 26 };

  let ctx = null;        // { projectId }
  let taskTypes = [];    // GET /fl/task-types
  let jobs = [];         // 当前项目的任务列表（最新在前）
  let job = null;        // 当前查看的任务详情
  let series = {};       // key -> { label, points: [{round, <metric>...}] }
  let nodes = [];
  let sse = null;
  let booted = false;

  /** 注册算法 / 自定义模型的任务 algorithm 为 custom，真实名称与版本在 algo_ref_name（任务编排 mock 补充）。 */
  function algoLabel(j) { return j.algo_ref_name || ALGO_CN[j.algorithm] || j.algorithm; }

  function typeDef(t) { return taskTypes.filter(function (x) { return x.task_type === t; })[0]; }
  function spec() { return job.metrics_spec; }

  function bindOnce() {
    if (booted) return;
    booted = true;

    ['flStart:start', 'flPause:pause', 'flResume:resume', 'flKill:terminate', 'flReset:reset']
      .forEach(function (pair) {
        const parts = pair.split(':');
        $(parts[0]).addEventListener('click', function () { action(parts[1]); });
      });

    $('flAlgo').addEventListener('change', function () { patch({ algorithm: $('flAlgo').value }); });
    $('flAgg').addEventListener('change', function () { patch({ aggregation: $('flAgg').value }); });
    $('flView').addEventListener('change', function () { loadMetrics(); });
    $('flExport').addEventListener('click', exportCsv);
    $('flViewKey').addEventListener('click', viewKey);
    $('flAddNode').addEventListener('click', addNode);
    $('flNewJob').addEventListener('click', openCreate);
    $('flTypeFilter').addEventListener('change', renderJobs);
  }

  async function action(name) {
    try {
      job = await Api.post('/fl/jobs/' + job.job_id + '/actions', { action: name });
      if (name === 'start' || name === 'reset') { series = {}; renderCharts(); }
      syncListItem();
      render();
      loadNodes();
    } catch (e) { UI.fail(e); }
  }

  async function patch(body) {
    try {
      const prev = job;
      job = await Api.patch('/fl/jobs/' + job.job_id, body);
      // PATCH 响应不含 algo_ref_name：算法未变时沿用
      if (job.algo_ref_name === undefined && job.algorithm === prev.algorithm) job.algo_ref_name = prev.algo_ref_name;
      syncListItem();
      render();
      UI.toast('配置已更新');
    } catch (e) {
      UI.fail(e);
      render(); // 回滚下拉框到后端真实值
    }
  }

  async function exportCsv() {
    try {
      const name = await Api.download('/fl/jobs/' + job.job_id + '/metrics/export', {
        query: { scope: $('flView').value === 'nodes' ? 'nodes' : 'global' }
      });
      UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  async function viewKey() {
    try {
      const k = await Api.get('/fl/jobs/' + job.job_id + '/he-public-key');
      UI.toast('公钥 ' + k.key_id + ' · ' + k.fingerprint);
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 弹窗：添加节点 ---------- */

  function addNode() {
    const role = UI.selectOf('nodeRole', [
      { value: 'trainer', label: '参与方 / 训练节点' }, { value: 'aggregator', label: '聚合方 / 协调节点' }
    ], 'trainer');
    const part = UI.inputOf('nodePart', 'part-C');
    const partRow = UI.formRow('数据分区', part, '训练节点必填，对应本地数据目录');
    const body = UI.el('div');
    body.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
    body.appendChild(UI.formRow('节点 ID', UI.inputOf('nodeId', 'node-beijing-03'), '小写字母 / 数字 / 短横线'));
    const two = UI.el('div', 'form-2col');
    two.appendChild(UI.formRow('IP 地址', UI.inputOf('nodeIp', '10.40.3.9')));
    two.appendChild(UI.formRow('端口', UI.inputOf('nodePort', '8471', 'number')));
    body.appendChild(two);
    body.appendChild(UI.formRow('角色', role));
    body.appendChild(partRow);
    role.addEventListener('change', function () { partRow.hidden = role.value !== 'trainer'; });

    UI.modal({
      title: '添加参与方节点', body: body, submitText: '添加',
      onSubmit: async function () {
        const id = $('nodeId').value.trim();
        await Api.post('/projects/' + ctx.projectId + '/nodes', {
          node_id: id, ip: $('nodeIp').value.trim(), port: Number($('nodePort').value),
          role: role.value, data_partition: role.value === 'trainer' ? part.value.trim() : null
        });
        UI.toast('节点 ' + id + ' 已添加到项目，新建任务时可选');
      }
    });
  }

  /* ---------- 弹窗：新建训练任务 ---------- */

  async function openCreate() {
    let projNodes, datasets, pipelines, project, library;
    try {
      const r = await Promise.all([
        Api.get('/projects/' + ctx.projectId + '/nodes'),
        Api.get('/projects/' + ctx.projectId + '/datasets', { status: 'ready' }),
        Api.get('/projects/' + ctx.projectId + '/psi/pipelines', { status: 'finished' }),
        Api.get('/projects/' + ctx.projectId),
        Api.get('/fl/algorithms', { project_id: ctx.projectId })
      ]);
      projNodes = r[0].items;
      datasets = r[1].items;
      pipelines = r[2].items.filter(function (p) { return p.status === 'finished'; });
      project = r[3];
      library = r[4].items;
    } catch (e) { UI.fail(e); return; }

    // 默认值取任务编排页的项目配置：任务类型跟随训练目标、基准模型、聚合轮数、聚合策略
    let taskType = project.target.task_type || 'classification';
    let modelFileId = null;
    const body = UI.el('div');
    body.style.cssText = 'display:flex; flex-direction:column; gap:14px;';

    body.appendChild(UI.formRow('任务名称', UI.inputOf('njName', ''), '不填则自动生成'));

    // 任务类型：分段按钮
    const seg = UI.el('div', 'seg');
    const typeHint = UI.el('span', 'hint');
    taskTypes.forEach(function (t) {
      const b = UI.el('button', t.task_type === taskType ? 'on' : '', t.name);
      b.type = 'button';
      b.dataset.type = t.task_type;
      b.addEventListener('click', function () { taskType = t.task_type; refresh(); });
      seg.appendChild(b);
    });
    const typeRow = UI.el('div', 'field-col');
    typeRow.appendChild(UI.el('label', null, '任务类型'));
    typeRow.appendChild(seg);
    typeRow.appendChild(typeHint);
    body.appendChild(typeRow);

    const algo = UI.selectOf('njAlgo', []);
    const agg = UI.selectOf('njAgg', [{ value: 'he', label: '同态加密聚合' }, { value: 'ss', label: '秘密共享聚合' }], project.aggregation_default || 'he');
    const two = UI.el('div', 'form-2col');
    two.appendChild(UI.formRow('算法', algo));
    two.appendChild(UI.formRow('聚合策略', agg, project.aggregation_default ? '默认取「聚合与安全」页的项目策略' : null));
    body.appendChild(two);

    // 参数模板（FL-ORCH-09）：选模板填充下方参数，参数按算法 schema 校验
    const tplSel = UI.selectOf('njTpl', []);
    const tplRow = UI.formRow('参数模板', tplSel, '模板在「任务编排 → 算法库」维护');
    const paramBox = UI.el('div');
    let paramEd = null, tplList = [], loadSeq = 0;
    body.appendChild(tplRow);
    body.appendChild(paramBox);
    async function loadParams() {
      const seq = ++loadSeq;
      UI.clear(tplSel); UI.clear(paramBox); paramEd = null; tplList = [];
      tplRow.hidden = algo.value === 'custom';
      if (tplRow.hidden || !window.FLO) return;
      try {
        const r = await Promise.all([Api.get('/fl/algorithms/' + algo.value), Api.get('/fl/algorithms/' + algo.value + '/templates')]);
        if (seq !== loadSeq) return;
        tplList = r[1].items;
        [{ value: '', label: '不使用模板（schema 默认值）' }].concat(tplList.map(function (t) {
          return { value: t.template_id, label: t.name + (t.preset ? '（平台预置）' : '（自定义）') };
        })).forEach(function (o) {
          const op = document.createElement('option');
          op.value = o.value; op.textContent = o.label;
          tplSel.appendChild(op);
        });
        paramEd = window.FLO.paramEditor(r[0].params_schema, null, 'njp');
        paramBox.appendChild(paramEd.el);
      } catch (e) { UI.fail(e); }
    }
    tplSel.addEventListener('change', function () {
      const t = tplList.filter(function (x) { return x.template_id === tplSel.value; })[0];
      if (paramEd) paramEd.set(t ? t.params : null);
    });

    const fileIn = UI.el('input');
    fileIn.type = 'file';
    fileIn.id = 'njModel';
    fileIn.accept = '.py,.zip,.pt,.onnx';
    const fileNote = UI.el('span', 'hint', '支持 .py / .zip / .pt / .onnx');
    const fileRow = UI.formRow('模型文件', fileIn);
    fileRow.appendChild(fileNote);
    body.appendChild(fileRow);
    fileIn.addEventListener('change', async function () {
      modelFileId = null;
      if (!fileIn.files[0]) return;
      try {
        fileNote.textContent = '上传中…';
        const f = await Api.upload('/files', fileIn.files[0], { purpose: 'fl_model', project_id: ctx.projectId });
        modelFileId = f.file_id;
        fileNote.textContent = '已上传 ' + f.file_name + '（' + f.file_id + ' · ' + UI.bytes(f.size_bytes) + '）';
      } catch (e) { fileNote.textContent = e.message; }
    });

    const rounds = UI.inputOf('njRounds', String(project.total_rounds || 30), 'number');
    const dp = UI.el('label', 'check-item');
    const dpBox = UI.el('input');
    dpBox.type = 'checkbox'; dpBox.id = 'njDp'; dpBox.checked = true;
    dp.appendChild(dpBox);
    dp.appendChild(document.createTextNode('启用差分隐私（配置见「差分隐私」模块）'));
    const two2 = UI.el('div', 'form-2col');
    two2.appendChild(UI.formRow('聚合轮次', rounds, '1 – 200'));
    const dpWrap = UI.el('div', 'field-col');
    dpWrap.appendChild(UI.el('label', null, '隐私保护'));
    dpWrap.appendChild(dp);
    two2.appendChild(dpWrap);
    body.appendChild(two2);

    // 参与节点
    const nodeList = UI.el('div', 'check-list');
    projNodes.forEach(function (n) {
      const row = UI.el('label', 'check-item');
      const cb = UI.el('input');
      cb.type = 'checkbox'; cb.value = n.node_id; cb.checked = true; cb.name = 'njNode';
      row.appendChild(cb);
      row.appendChild(document.createTextNode(n.node_id));
      row.appendChild(UI.el('span', 'hint', n.role_label + (n.data_partition ? ' · ' + n.data_partition : '')));
      nodeList.appendChild(row);
    });
    body.appendChild(UI.formRow('参与节点', nodeList, '至少 2 个训练节点 + 1 个聚合节点'));

    // 数据来源
    const srcSel = UI.selectOf('njSrc', [
      { value: 'dataset', label: '已接入的数据集' },
      { value: 'psi_pipeline', label: 'PSI 求交对齐结果' }
    ], 'dataset');
    const dsList = UI.el('div', 'check-list');
    const pipeSel = UI.selectOf('njPipe', pipelines.length
      ? pipelines.map(function (p) { return { value: p.pipeline_id, label: p.pipeline_id + ' · ' + UI.rows(p.stages[1].stats.rows) + '条' }; })
      : [{ value: '', label: '暂无已完成的求交流水线' }]);
    const dsRow = UI.formRow('数据集', dsList);
    const pipeRow = UI.formRow('求交流水线', pipeSel);
    body.appendChild(UI.formRow('数据来源', srcSel));
    body.appendChild(dsRow);
    body.appendChild(pipeRow);

    // 时序参数
    const tsBox = UI.el('div', 'form-3col');
    const timeCol = UI.selectOf('njTimeCol', []);
    tsBox.appendChild(UI.formRow('时间列', timeCol));
    tsBox.appendChild(UI.formRow('回看窗口（天）', UI.inputOf('njWindow', '30', 'number'), '1 – 365'));
    tsBox.appendChild(UI.formRow('预测步长（天）', UI.inputOf('njHorizon', '7', 'number'), '1 – 90'));
    const tsWrap = UI.el('div', 'field-col');
    tsWrap.appendChild(UI.el('span', 'section-label', '时序参数'));
    tsWrap.appendChild(tsBox);
    body.appendChild(tsWrap);

    function renderDatasets() {
      UI.clear(dsList);
      const ts = taskType === 'timeseries';
      const shown = datasets.filter(function (d) { return !ts || d.time_column; });
      if (!shown.length) dsList.appendChild(UI.el('span', 'hint', ts ? '没有带时间列的数据集，请先在「隐私求交 · 数据接入」登记' : '暂无数据集'));
      shown.forEach(function (d, i) {
        const row = UI.el('label', 'check-item');
        const cb = UI.el('input');
        cb.type = 'checkbox'; cb.value = d.dataset_id; cb.name = 'njDs';
        cb.checked = ts ? i === 0 : d.party_id !== 'party-a' || !d.time_column;
        cb.addEventListener('change', renderTimeCols);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(d.name));
        row.appendChild(UI.el('span', 'hint', d.party_name + ' · ' + UI.rows(d.row_count) + '行' + (d.time_column ? ' · 时间列 ' + d.time_column : '')));
        dsList.appendChild(row);
      });
      renderTimeCols();
    }

    function checkedDatasets() {
      return Array.prototype.slice.call(dsList.querySelectorAll('input:checked')).map(function (c) { return c.value; });
    }

    function renderTimeCols() {
      UI.clear(timeCol);
      const cols = {};
      datasets.forEach(function (d) {
        if (checkedDatasets().indexOf(d.dataset_id) >= 0 && d.time_column) cols[d.time_column] = true;
      });
      const keys = Object.keys(cols);
      (keys.length ? keys : ['']).forEach(function (k) {
        const o = document.createElement('option');
        o.value = k; o.textContent = k || '（所选数据集无时间列）';
        timeCol.appendChild(o);
      });
    }

    function refresh() {
      const t = typeDef(taskType);
      seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.type === taskType); });
      typeHint.textContent = t.description + ' · 评估指标 ' + t.metrics.map(function (m) { return m.label; }).join(' / ');
      UI.clear(algo);
      // 内置算法（带当前版本）→ 已注册算法 / 本项目自定义模型 → 临时上传模型文件
      const lib = library.filter(function (a) { return a.task_types.indexOf(taskType) >= 0; });
      const builtin = lib.filter(function (a) { return a.kind === 'builtin'; });
      t.algorithms.filter(function (a) { return a !== 'custom'; }).forEach(function (a) {
        const b = builtin.filter(function (x) { return x.algo_id === a; })[0];
        const o = document.createElement('option');
        o.value = a; o.textContent = (ALGO_CN[a] || a) + (b ? ' ' + b.current_version : '');
        algo.appendChild(o);
      });
      lib.filter(function (a) { return a.kind !== 'builtin'; }).forEach(function (a) {
        const o = document.createElement('option');
        o.value = a.algo_id; o.textContent = a.name + ' ' + a.current_version + (a.kind === 'custom' ? '（自定义模型）' : '（已注册）');
        algo.appendChild(o);
      });
      if (t.algorithms.indexOf('custom') >= 0) {
        const o = document.createElement('option');
        o.value = 'custom'; o.textContent = ALGO_CN.custom + '（本次上传文件）';
        algo.appendChild(o);
      }
      if (algo.querySelector('option[value="' + project.base_algorithm + '"]')) algo.value = project.base_algorithm;
      fileRow.hidden = algo.value !== 'custom';
      loadParams();
      tsWrap.hidden = !t.requires_timeseries;
      renderDatasets();
      srcChanged();
    }
    function srcChanged() {
      dsRow.hidden = srcSel.value !== 'dataset';
      pipeRow.hidden = srcSel.value !== 'psi_pipeline';
    }
    algo.addEventListener('change', function () { fileRow.hidden = algo.value !== 'custom'; loadParams(); });
    srcSel.addEventListener('change', srcChanged);
    refresh();

    UI.modal({
      title: '新建训练任务', body: body, submitText: '创建任务', width: 680,
      onSubmit: async function () {
        const req = {
          task_type: taskType,
          algorithm: algo.value,
          aggregation: agg.value,
          total_rounds: Number(rounds.value),
          dp_enabled: dpBox.checked,
          node_ids: Array.prototype.slice.call(nodeList.querySelectorAll('input:checked')).map(function (c) { return c.value; })
        };
        const name = $('njName').value.trim();
        if (name) req.name = name;
        if (algo.value === 'custom') req.model_file_id = modelFileId;
        if (paramEd) req.params = paramEd.read();
        if (tplSel.value) req.template_id = tplSel.value;
        req.dataset_source = srcSel.value === 'dataset'
          ? { type: 'dataset', dataset_ids: checkedDatasets() }
          : { type: 'psi_pipeline', pipeline_id: pipeSel.value };
        if (typeDef(taskType).requires_timeseries) {
          req.timeseries = {
            time_column: timeCol.value,
            window_size: Number($('njWindow').value),
            horizon: Number($('njHorizon').value)
          };
        }
        const created = await Api.post('/projects/' + ctx.projectId + '/fl/jobs', req);
        UI.toast('已创建任务「' + created.name + '」，点击「启动训练」开始');
        await loadJobs();
        await selectJob(created.job_id);
      }
    });
  }

  /* ---------- 渲染 ---------- */

  function render() {
    const st = job.status;
    const badge = $('flBadge');
    badge.style.background = BADGE[st][0];
    badge.style.color = BADGE[st][1];
    $('flBadgeText').textContent = STATE_CN[st];

    const t = typeDef(job.task_type);
    $('flJobName').textContent = job.name;
    $('flJobType').textContent = t ? t.name : job.task_type;
    $('flJobType').className = 'tag ' + (job.task_type === 'timeseries' ? 'tag-ts' : 'tag-cls');
    const meta = [job.job_id, '算法 ' + algoLabel(job), job.node_ids.length + ' 个节点'];
    if (job.timeseries) meta.push('时间列 ' + job.timeseries.time_column + ' · 窗口 ' + job.timeseries.window_size + ' 天 · 预测 ' + job.timeseries.horizon + ' 天');
    if (job.dataset_source) {
      meta.push(job.dataset_source.type === 'psi_pipeline'
        ? '数据：PSI ' + job.dataset_source.pipeline_id
        : '数据：' + job.dataset_source.dataset_ids.length + ' 个数据集');
    }
    $('flJobMeta').textContent = meta.join(' · ');

    const wrap = $('flStates');
    UI.clear(wrap);
    STATE_ORDER.forEach(function (k) {
      wrap.appendChild(UI.el('span', 'chip' + (k === st ? ' on' : ''), k + ' · ' + STATE_CN[k]));
    });

    const allowed = {
      Created: ['start', 'reset'], Running: ['pause', 'terminate'],
      Paused: ['resume', 'terminate', 'reset'], Success: ['reset'],
      Failed: ['start', 'reset'], Terminated: ['start', 'reset']
    }[st] || [];
    $('flStart').disabled = allowed.indexOf('start') < 0;
    $('flPause').disabled = allowed.indexOf('pause') < 0;
    $('flResume').disabled = allowed.indexOf('resume') < 0;
    $('flKill').disabled = allowed.indexOf('terminate') < 0;
    $('flReset').disabled = allowed.indexOf('reset') < 0;

    // 算法下拉随任务类型变化
    const algoSel = $('flAlgo');
    UI.clear(algoSel);
    (t ? t.algorithms : [job.algorithm]).forEach(function (a) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a === job.algorithm ? algoLabel(job) : (ALGO_CN[a] || a);
      algoSel.appendChild(o);
    });
    const locked = st === 'Running' || st === 'Paused';
    algoSel.disabled = locked;
    $('flAgg').disabled = locked;
    algoSel.value = job.algorithm;
    $('flAgg').value = job.aggregation;

    const info = job.aggregation_info;
    $('flAggNote').textContent = info.type === 'he'
      ? '同态加密聚合 · 密钥对已生成'
      : '秘密共享聚合 · 门限 ' + info.threshold + ' / ' + info.share_count;
    $('flViewKey').hidden = info.type !== 'he';

    // 两张指标卡按 metrics_spec 渲染
    const sp = spec();
    const cur = job.global_metrics || {}, prev = job.global_metrics_prev || {};
    [['flM1Name', 'flLoss', 'flLossPrev', 'flM1Better'], ['flM2Name', 'flAcc', 'flAccPrev', 'flM2Better']]
      .forEach(function (ids, i) {
        const m = sp[i];
        $(ids[0]).textContent = '全局 ' + m.label;
        $(ids[1]).textContent = UI.fixed(cur[m.key], m.digits);
        $(ids[2]).textContent = UI.fixed(prev[m.key], m.digits);
        $(ids[3]).textContent = m.better === 'lower' ? '越低越好' : '越高越好';
      });

    $('flRound').textContent = job.current_round;
    $('flTotalRounds').textContent = job.total_rounds;
    $('flProgress').style.width = job.progress_pct + '%';
    $('flEta').textContent = job.eta_sec === null ? '—' : UI.duration(job.eta_sec);
    $('flElapsed').textContent = UI.duration(job.elapsed_sec);

    // 曲线标题与坐标轴
    [['flC1Label', 'flC1Max', 'flC1Mid', 'flC1Min'], ['flC2Label', 'flC2Max', 'flC2Mid', 'flC2Min']]
      .forEach(function (ids, i) {
        const m = sp[i];
        $(ids[0]).textContent = m.label + '（纵轴 ' + m.y_min + ' – ' + m.y_max + '，横轴 轮次 1 – ' + job.total_rounds + '）';
        $(ids[1]).textContent = String(m.y_max);
        $(ids[2]).textContent = String(Number(((m.y_min + m.y_max) / 2).toFixed(2)));
        $(ids[3]).textContent = String(m.y_min);
      });
    document.querySelectorAll('.flXMax').forEach(function (n) { n.textContent = String(job.total_rounds); });

    $('flChartHint').textContent = job.current_round < 2
      ? '启动训练后，每完成一轮聚合即写入一次全局与各节点指标。'
      : '算法 ' + algoLabel(job) + ' · 已写入 ' + job.current_round + ' 轮指标，可导出 CSV。';
  }

  function renderJobs() {
    const wrap = $('flJobs');
    UI.clear(wrap);
    const filter = $('flTypeFilter').value;
    const list = jobs.filter(function (j) { return !filter || j.task_type === filter; });
    if (!list.length) {
      wrap.appendChild(UI.el('div', 'table-empty', '暂无任务，点击右上角「新建训练任务」'));
      return;
    }
    list.forEach(function (j) {
      const row = UI.el('div', 'table-row clickable fl-job-grid' + (job && j.job_id === job.job_id ? ' current' : ''));
      row.dataset.jobId = j.job_id;
      const nameCell = UI.el('span');
      nameCell.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0;';
      nameCell.appendChild(UI.el('span', 'cell-strong', j.name));
      nameCell.appendChild(UI.el('span', 'hint-2', j.job_id));
      row.appendChild(nameCell);
      const t = typeDef(j.task_type);
      row.appendChild(UI.el('span', 'tag ' + (j.task_type === 'timeseries' ? 'tag-ts' : 'tag-cls'), t ? t.name : j.task_type));
      const algoCell = UI.el('span', 'cell-muted', algoLabel(j));
      algoCell.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      algoCell.title = algoLabel(j);
      row.appendChild(algoCell);
      row.appendChild(UI.el('span', 'cell-muted', AGG_CN[j.aggregation]));
      row.appendChild(UI.el('span', 'cell-muted', j.current_round + ' / ' + j.total_rounds));
      const st = UI.el('span', 'tag', STATE_CN[j.status]);
      st.style.background = BADGE[j.status][0];
      st.style.color = BADGE[j.status][1];
      row.appendChild(st);
      row.appendChild(UI.el('span', 'cell-muted', UI.datetime(j.created_at)));
      row.addEventListener('click', function () {
        if (!job || j.job_id !== job.job_id) selectJob(j.job_id);
      });
      wrap.appendChild(row);
    });
  }

  /** 把当前任务的最新状态写回列表缓存并重绘列表。 */
  function syncListItem() {
    if (!job) return;
    const idx = jobs.findIndex(function (j) { return j.job_id === job.job_id; });
    if (idx >= 0) jobs[idx] = Object.assign({}, job);
    renderJobs();
  }

  function renderCharts() {
    const keys = Object.keys(series);
    const lossG = $('flLossLines'), accG = $('flAccLines');
    UI.clear(lossG); UI.clear(accG);

    const legend = $('flLegend');
    UI.clear(legend);
    if (!job) return;
    const sp = spec();

    let nodeIdx = 0;
    keys.forEach(function (key) {
      const s = series[key];
      const isGlobal = key === 'global';
      const color = isGlobal ? '#1D4E89' : NODE_COLORS[nodeIdx++ % NODE_COLORS.length];
      const width = isGlobal ? 2.4 : 1.6;

      [lossG, accG].forEach(function (g, i) {
        const m = sp[i];
        const pts = UI.polyline(s.points.map(function (p) { return { x: p.round, y: p[m.key] }; }),
          Object.assign({ ymin: m.y_min, ymax: m.y_max, xmax: job.total_rounds }, CHART));
        if (pts) {
          g.appendChild(UI.svgEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' }));
        }
      });

      const item = UI.el('span', 'legend-item');
      const dot = UI.el('i');
      dot.style.background = color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(s.label));
      legend.appendChild(item);
    });
  }

  function renderNodes() {
    const wrap = $('flNodes');
    UI.clear(wrap);
    nodes.forEach(function (n) {
      const row = UI.el('div', 'table-row fl-node-grid');
      row.appendChild(UI.el('span', 'cell-strong', n.node_id));
      row.appendChild(UI.el('span', 'cell-muted', n.ip + ' : ' + n.port));
      row.appendChild(UI.el('span', 'cell-muted', n.role_label));
      row.appendChild(UI.el('span', 'cell-muted', n.data_partition || '—'));

      const up = UI.el('span', 'node-upload');
      const bar = UI.el('span', 'bar bar-6');
      const fill = UI.el('i');
      fill.style.width = Math.min(100, ((n.round_upload_kb || 0) / 200) * 100) + '%';
      bar.appendChild(fill);
      up.appendChild(bar);
      up.appendChild(UI.el('span', 'hint', n.round_upload_kb === null ? '—' : n.round_upload_kb.toFixed(1) + ' KB'));
      row.appendChild(up);

      const st = NODE_ST[n.status] || [n.status, '#8A93A2'];
      const stEl = UI.el('span', null, st[0]);
      stEl.style.color = st[1];
      stEl.style.fontWeight = '600';
      stEl.style.fontSize = '12px';
      row.appendChild(stEl);

      wrap.appendChild(row);
    });
  }

  /* ---------- 数据 ---------- */

  async function loadJobs() {
    const res = await Api.get('/projects/' + ctx.projectId + '/fl/jobs');
    jobs = res.items;
    renderJobs();
  }

  async function loadMetrics() {
    const scope = $('flView').value;
    const res = await Api.get('/fl/jobs/' + job.job_id + '/metrics', { scope: scope });
    series = {};
    res.series.forEach(function (s) {
      series[s.key] = { label: s.label, points: s.points };
    });
    renderCharts();
  }

  async function loadNodes() {
    const res = await Api.get('/fl/jobs/' + job.job_id + '/nodes');
    nodes = res.items;
    renderNodes();
  }

  async function selectJob(jobId) {
    if (sse) { sse.close(); sse = null; }
    try {
      job = await Api.get('/fl/jobs/' + jobId);
      series = {};
      render();
      renderJobs();
      await Promise.all([loadMetrics(), loadNodes()]);
      const id = job.job_id;
      sse = Api.subscribe('/fl/jobs/' + id + '/events', {
        round_completed: function (ev) { if (job && job.job_id === id) onRound(ev); },
        status_changed: function () { if (job && job.job_id === id) onStatus(); }
      });
    } catch (e) { UI.fail(e); }
  }

  function onRound(ev) {
    job.current_round = ev.round;
    job.progress_pct = Math.round((ev.round / job.total_rounds) * 100);
    job.global_metrics_prev = job.global_metrics;
    job.global_metrics = ev.global_metrics;
    job.elapsed_sec = ev.elapsed_sec;
    job.eta_sec = ev.eta_sec;
    render();
    syncListItem();

    const keys = spec().map(function (m) { return m.key; });
    const point = function (src) {
      const p = { round: ev.round };
      keys.forEach(function (k) { p[k] = src[k]; });
      return p;
    };
    if (!series.global) series.global = { label: '全局', points: [] };
    series.global.points.push(point(ev.global_metrics));
    if ($('flView').value === 'nodes') {
      ev.node_metrics.forEach(function (n) {
        if (!series[n.node_id]) series[n.node_id] = { label: n.node_id, points: [] };
        series[n.node_id].points.push(point(n));
      });
    }
    renderCharts();

    nodes = nodes.map(function (nd) {
      const hit = ev.node_metrics.filter(function (x) { return x.node_id === nd.node_id; })[0];
      return hit ? Object.assign({}, nd, { round_upload_kb: hit.upload_kb, status: 'uploading' }) : nd;
    });
    renderNodes();
  }

  async function onStatus() {
    try {
      job = await Api.get('/fl/jobs/' + job.job_id);
      render();
      syncListItem();
      loadNodes();
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c, focusJobId) {
    ctx = c;
    bindOnce();
    try {
      if (!taskTypes.length) {
        taskTypes = (await Api.get('/fl/task-types')).items;
        const f = $('flTypeFilter');
        taskTypes.forEach(function (t) {
          const o = document.createElement('option');
          o.value = t.task_type; o.textContent = t.name;
          f.appendChild(o);
        });
      }
      job = null;
      await loadJobs();
      // 默认看最近一个任务（列表最新在前）
      const target = focusJobId || (jobs[0] && jobs[0].job_id);
      if (target) await selectJob(target);
    } catch (e) { UI.fail(e); }
  }

  /** 回到 FL 页时刷新列表（PSI 等模块可能新建了任务）；focusJobId 用于「前往训练」跳转。 */
  async function refresh(focusJobId) {
    try {
      await loadJobs();
      if (focusJobId && (!job || job.job_id !== focusJobId)) await selectJob(focusJobId);
    } catch (e) { UI.fail(e); }
  }

  function unmount() {
    if (sse) { sse.close(); sse = null; }
  }

  function currentJobId() { return job ? job.job_id : null; }

  window.FL = { mount: mount, refresh: refresh, unmount: unmount, currentJobId: currentJobId };
})();
