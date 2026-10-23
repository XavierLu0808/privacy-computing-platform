/**
 * 联邦学习 · 任务编排（#/fed/orch）。验收项 FL-ORCH-01 至 FL-ORCH-09，接口见 docs/api/fed-orch.md。
 *
 * 页面四块：项目信息与项目列表（01 / 04）、参与方节点（02）、数据隔离（03）、
 * 算法库（05 内置 / 06 注册 / 07 自定义上传，详情里含 08 版本与 09 参数模板）。
 * 另导出 FLO.paramEditor 供「新建训练任务」弹窗（js/fl.js）按算法参数 schema 渲染参数表单。
 */
(function () {
  'use strict';
  const $ = UI.$;
  const el = UI.el;

  const TYPE_CN = { production: '生产', pilot: '试点', sandbox: '沙箱' };
  const KIND_CN = { builtin: '内置算法', registered: '已注册算法', custom: '自定义模型' };
  const TT_CN = { classification: '分类', timeseries: '时序预测' };
  const AGG_CN = { ss: '秘密共享聚合', he: '同态加密聚合' };
  const TARGETS = [
    { value: 'accuracy', label: 'Accuracy（越高越好，≥）', tt: 'classification', op: '≥' },
    { value: 'auc', label: 'AUC（越高越好，≥）', tt: 'classification', op: '≥' },
    { value: 'loss', label: 'Loss（越低越好，≤）', tt: 'classification', op: '≤' },
    { value: 'rmse', label: 'RMSE 归一化（越低越好，≤）', tt: 'timeseries', op: '≤' },
    { value: 'mae', label: 'MAE 归一化（越低越好，≤）', tt: 'timeseries', op: '≤' }
  ];
  const FORMATS = ['pkl', 'pt', 'h5', 'onnx'];
  const SCHEMA_EXAMPLE = JSON.stringify({
    type: 'object',
    required: ['num_leaves'],
    properties: {
      num_leaves: { type: 'integer', minimum: 2, maximum: 256, default: 31, description: '叶子数' },
      learning_rate: { type: 'number', minimum: 0.001, maximum: 1, default: 0.1, description: '学习率' },
      boosting: { type: 'string', enum: ['gbdt', 'dart'], default: 'gbdt', description: '提升方式' }
    }
  }, null, 2);

  let ctx = null;
  let root = null;
  let gen = 0;               // 每次 mount 递增，丢弃切换项目前发出的请求结果
  let proj = null;           // GET /projects/{id}
  let projects = [];
  let nodes = [];
  let iso = null;
  let algos = [];            // GET /fl/algorithms?project_id=
  let tab = 'builtin';
  let algoId = null;
  let detail = null;         // GET /fl/algorithms/{id}
  let templates = [];

  function op(t) { return t.op === '<=' ? '≤' : '≥'; }
  function targetText(t) { return t.label + ' ' + op(t) + ' ' + t.value; }
  function button(text, cls, fn) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function col() {
    const n = el('div');
    n.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
    return n;
  }
  function stack(a, b) {
    const s = el('span', 'flo-stack');
    s.appendChild(el('span', 'cell-strong', a));
    s.appendChild(el('span', 'hint-2', b));
    return s;
  }
  function textarea(id, value, rows) {
    const t = el('textarea', 'input flo-textarea');
    t.id = id;
    t.rows = rows || 3;
    t.value = value || '';
    return t;
  }

  /* ================= 骨架 ================= */

  function build() {
    UI.clear(root);
    root.innerHTML =
      '<div class="page-head"><div class="page-head-text"><span class="crumb">联邦学习 / 任务编排</span><h1>联邦任务编排</h1></div>' +
      '<button type="button" class="btn-link" id="floGoProc">前往过程管控</button></div>' +

      '<div class="flo-row">' +
        '<div class="card card-lg" data-acc="FL-ORCH-01 FL-ORCH-04">' +
          '<div class="flo-head"><span class="card-title">当前项目</span><span class="tag" id="floProjType">—</span><span class="spacer"></span>' +
            '<button type="button" class="btn-sm" id="floExport">导出配置</button>' +
            '<button type="button" class="btn-sm" id="floEdit">编辑配置</button>' +
            '<button type="button" class="btn-primary flo-btn-sm" id="floNewProj">＋ 新建项目</button></div>' +
          '<div class="cell-strong flo-proj-name" id="floProjName">—</div>' +
          '<div class="hint" id="floProjDesc"></div>' +
          '<div class="flo-kv" id="floProjKv"></div>' +
        '</div>' +
        '<div class="card card-lg" data-acc="FL-ORCH-04">' +
          '<div class="flo-head"><span class="card-title">项目列表</span><span class="hint" id="floProjCount"></span><span class="spacer"></span>' +
            '<input class="input flo-search" id="floProjSearch" placeholder="按名称搜索" aria-label="按项目名称搜索"></div>' +
          '<div class="table-head flo-proj-grid"><span>项目名称 / ID</span><span>类型</span><span>基准模型</span><span>训练目标</span><span>节点</span></div>' +
          '<div id="floProjList"></div>' +
        '</div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-ORCH-02">' +
        '<div class="flo-head"><span class="card-title">参与方节点</span>' +
          '<span class="hint">节点 ID 是任务引用节点的稳定标识；运行中任务使用的节点不能删除，也不能改角色、数据分区或数据目录</span>' +
          '<span class="spacer"></span><button type="button" class="btn-primary flo-btn-sm" id="floAddNode">＋ 添加节点</button></div>' +
        '<div class="table-head flo-node-grid"><span>节点 ID</span><span>IP : 端口</span><span>角色</span><span>数据分区</span><span>本地数据目录</span><span>运行中任务</span><span>最近心跳</span><span>操作</span></div>' +
        '<div id="floNodes"></div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-ORCH-03">' +
        '<div class="flo-head"><span class="card-title">数据隔离</span><span class="hint" id="floIsoRule"></span></div>' +
        '<div class="flo-iso">' +
          '<div class="flo-iso-col"><span class="section-label">节点 × 数据目录访问矩阵</span><div class="flo-matrix-wrap"><table class="preview-table flo-matrix" id="floMatrix"></table></div></div>' +
          '<div class="flo-iso-col"><span class="section-label">训练中跨节点传输的内容</span><div id="floPayload" class="flo-payload"></div></div>' +
        '</div>' +
        '<div class="divider-h"></div>' +
        '<div class="flo-head flo-wrap">' +
          '<div class="field"><label class="field-label" for="floActor">发起节点</label><select class="select select-sm" id="floActor"></select></div>' +
          '<div class="field"><label class="field-label" for="floTarget">目标数据目录</label><select class="select select-sm" id="floTarget"></select></div>' +
          '<button type="button" class="btn-sm btn-kill" id="floCheckDir">越权访问检测</button>' +
          '<span class="divider-v"></span>' +
          '<button type="button" class="btn-sm" id="floCheckPayload">传输内容审计</button>' +
          '<span class="hint">审计最近一个已训练任务最后一轮各节点收发的消息字段</span>' +
        '</div>' +
        '<div class="table-head flo-log-grid"><span>时间</span><span>检测</span><span>对象</span><span>结果</span><span>说明</span></div>' +
        '<div id="floIsoLogs"></div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-ORCH-05 FL-ORCH-06 FL-ORCH-07">' +
        '<div class="flo-head"><span class="card-title">算法库</span>' +
          '<span class="hint">所有算法以统一的 fit / predict / evaluate 接口接入训练引擎，新建训练任务时可选</span><span class="spacer"></span>' +
          '<button type="button" class="btn-sm" id="floRegister">＋ 注册算法</button>' +
          '<button type="button" class="btn-sm" id="floUpload">上传自定义模型</button></div>' +
        '<div class="tabs" role="tablist" id="floTabs">' +
          '<button type="button" class="tab" role="tab" data-tab="builtin" data-acc="FL-ORCH-05">内置算法</button>' +
          '<button type="button" class="tab" role="tab" data-tab="registered" data-acc="FL-ORCH-06">已注册算法</button>' +
          '<button type="button" class="tab" role="tab" data-tab="custom" data-acc="FL-ORCH-07">自定义模型</button>' +
        '</div>' +
        '<div class="flo-lib"><div id="floAlgoList" class="flo-algo-list"></div><div id="floAlgoDetail" class="flo-algo-detail"></div></div>' +
      '</div>';

    $('floGoProc').addEventListener('click', function () { App.go('fed', { sub: 'proc' }); });
    $('floNewProj').addEventListener('click', function () { openProject(null); });
    $('floEdit').addEventListener('click', function () { openProject(proj); });
    $('floExport').addEventListener('click', exportConfig);
    $('floProjSearch').addEventListener('input', UI.debounce(loadProjects, 250));
    $('floAddNode').addEventListener('click', function () { openNode(null); });
    $('floCheckDir').addEventListener('click', checkDir);
    $('floCheckPayload').addEventListener('click', checkPayload);
    $('floRegister').addEventListener('click', openRegister);
    $('floUpload').addEventListener('click', openUpload);
    root.querySelectorAll('#floTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
  }

  /* ================= 数据 ================= */

  function guard(g, fn) { return function (v) { if (g === gen) fn(v); }; }

  async function load() {
    const g = gen;
    const pid = ctx.projectId;
    try {
      const r = await Promise.all([
        Api.get('/projects/' + pid),
        Api.get('/projects/' + pid + '/nodes'),
        Api.get('/projects/' + pid + '/isolation'),
        Api.get('/fl/algorithms', { project_id: pid })
      ]);
      if (g !== gen) return;
      proj = r[0]; nodes = r[1].items; iso = r[2]; algos = r[3].items;
      renderProject();
      renderNodes();
      renderIso();
      renderTabs();
      await loadProjects();
      const pick = algos.filter(function (a) { return a.algo_id === algoId && a.kind === tab; })[0] ||
        algos.filter(function (a) { return a.kind === tab; })[0];
      await selectAlgo(pick ? pick.algo_id : null);
    } catch (e) { if (g === gen) UI.fail(e); }
  }

  async function loadProjects() {
    const g = gen;
    try {
      const res = await Api.get('/projects', { page_size: 100, keyword: $('floProjSearch').value.trim() });
      guard(g, function () { projects = res.items; renderProjects(res.total); })();
    } catch (e) { UI.fail(e); }
  }

  async function reloadNodes() {
    const r = await Promise.all([Api.get('/projects/' + ctx.projectId + '/nodes'), Api.get('/projects/' + ctx.projectId + '/isolation'), Api.get('/projects/' + ctx.projectId)]);
    nodes = r[0].items; iso = r[1]; proj = r[2];
    renderNodes();
    renderIso();
    renderProject();
  }

  async function reloadAlgos(selectId) {
    algos = (await Api.get('/fl/algorithms', { project_id: ctx.projectId })).items;
    renderTabs();
    await selectAlgo(selectId || algoId);
  }

  /* ================= FL-ORCH-01 / 04 项目 ================= */

  function renderProject() {
    $('floProjName').textContent = proj.name;
    $('floProjType').textContent = TYPE_CN[proj.type] || proj.type;
    $('floProjDesc').textContent = proj.description || '暂无描述';
    const kv = $('floProjKv');
    UI.clear(kv);
    const rows = [
      ['项目 ID', proj.project_id],
      ['基准模型版本', proj.base_algorithm_name + ' ' + proj.model_version],
      ['聚合轮数', proj.total_rounds + ' 轮（新建任务默认值）'],
      ['全局训练目标', targetText(proj.target) + '（' + TT_CN[proj.target.task_type] + '任务）'],
      ['参与节点', proj.node_count + ' 个'],
      ['默认聚合策略', proj.aggregation_default ? AGG_CN[proj.aggregation_default] + '（来自聚合与安全页）' : '未设置，新建任务时手选'],
      ['训练任务', proj.job_count + ' 个'],
      ['配置版本', '第 ' + proj.revision + ' 版 · ' + proj.updated_by + ' · ' + UI.datetime(proj.updated_at)]
    ];
    rows.forEach(function (r) {
      kv.appendChild(el('span', 'flo-kv-k', r[0]));
      kv.appendChild(el('span', 'flo-kv-v', r[1]));
    });
  }

  function renderProjects(total) {
    $('floProjCount').textContent = '共 ' + total + ' 个，点击查看详情';
    const wrap = $('floProjList');
    UI.clear(wrap);
    if (!projects.length) { wrap.appendChild(el('div', 'table-empty', '没有匹配的项目')); return; }
    projects.forEach(function (p) {
      const row = el('div', 'table-row clickable flo-proj-grid' + (p.project_id === ctx.projectId ? ' current' : ''));
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = p.name;
      row.appendChild(stack(p.name, p.project_id + ' · 创建于 ' + UI.datetime(p.created_at)));
      row.appendChild(el('span', 'tag', TYPE_CN[p.type] || p.type));
      row.appendChild(el('span', 'cell-muted', p.base_algorithm_name + ' ' + p.model_version));
      row.appendChild(el('span', 'cell-muted', targetText(p.target)));
      row.appendChild(el('span', 'cell-muted', p.node_count + ' 个'));
      const open = function () { showProject(p.project_id); };
      row.addEventListener('click', open);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      wrap.appendChild(row);
    });
  }

  async function showProject(pid) {
    let p;
    try { p = await Api.get('/projects/' + pid); } catch (e) { UI.fail(e); return; }
    const body = el('div', 'flo-kv');
    [
      ['项目名称', p.name], ['项目 ID', p.project_id], ['类型', TYPE_CN[p.type] || p.type], ['描述', p.description || '—'],
      ['基准模型版本', p.base_algorithm_name + ' ' + p.model_version], ['聚合轮数', p.total_rounds + ' 轮'],
      ['全局训练目标', targetText(p.target)], ['参与节点', p.node_count + ' 个'], ['训练任务', p.job_count + ' 个'],
      ['创建时间', UI.datetime(p.created_at)], ['配置版本', '第 ' + p.revision + ' 版 · ' + p.updated_by + ' · ' + UI.datetime(p.updated_at)]
    ].forEach(function (r) {
      body.appendChild(el('span', 'flo-kv-k', r[0]));
      body.appendChild(el('span', 'flo-kv-v', r[1]));
    });
    const isCur = pid === ctx.projectId;
    UI.modal({
      title: '项目详情', body: body, submitText: isCur ? '关闭' : '切换到此项目',
      onSubmit: async function () { if (!isCur) await App.reloadProjects(pid); }
    });
  }

  /** 新建（p = null）或编辑项目配置。 */
  async function openProject(p) {
    let lib;
    try { lib = (await Api.get('/fl/algorithms')).items.filter(function (a) { return a.kind !== 'custom'; }); } catch (e) { UI.fail(e); return; }
    const edit = !!p;
    const body = col();
    const name = UI.inputOf('fpName', edit ? p.name : '');
    name.maxLength = 64;
    name.placeholder = '例如：稀土氧化物价格联合预测 · 2027Q1';
    body.appendChild(UI.formRow('项目名称', name, '必填，不超过 64 个字符，不能与已有项目重名'));
    const type = UI.selectOf('fpType', [{ value: 'pilot', label: '试点' }, { value: 'production', label: '生产' }, { value: 'sandbox', label: '沙箱' }], edit ? p.type : 'pilot');
    body.appendChild(UI.formRow('项目类型', type));
    const desc = textarea('fpDesc', edit ? p.description : '', 3);
    desc.maxLength = 500;
    body.appendChild(UI.formRow('描述', desc, '参与方、数据范围、业务目标，不超过 500 个字符'));

    const two = el('div', 'form-2col');
    const algo = UI.selectOf('fpAlgo', lib.map(function (a) {
      return { value: a.algo_id, label: a.name + '（' + a.task_types.map(function (t) { return TT_CN[t]; }).join(' / ') + (a.kind === 'registered' ? ' · 已注册' : '') + '）' };
    }), edit ? p.base_algorithm : 'lstm');
    const ver = UI.selectOf('fpVer', []);
    two.appendChild(UI.formRow('基准模型', algo));
    two.appendChild(UI.formRow('模型版本', ver, '默认选该算法当前版本'));
    body.appendChild(two);

    const three = el('div', 'form-3col');
    const rounds = UI.inputOf('fpRounds', edit ? p.total_rounds : 30, 'number');
    rounds.min = 1; rounds.max = 200; rounds.step = 1;
    const metric = UI.selectOf('fpMetric', []);
    const value = UI.inputOf('fpTarget', edit ? p.target.value : '', 'number');
    value.step = 'any';
    three.appendChild(UI.formRow('聚合轮数', rounds, '1 – 200 的整数'));
    three.appendChild(UI.formRow('训练目标指标', metric));
    const vRow = UI.formRow('目标值', value);
    three.appendChild(vRow);
    body.appendChild(three);
    const targetNote = el('span', 'hint');
    body.appendChild(targetNote);
    let demo = null;
    if (!edit) {
      const lb = el('label', 'check-item');
      demo = el('input');
      demo.type = 'checkbox'; demo.id = 'fpDemo'; demo.checked = true;
      lb.appendChild(demo);
      lb.appendChild(document.createTextNode('导入演示数据'));
      lb.appendChild(el('span', 'hint', '2 个训练节点 + 1 个聚合节点、4 张稀土演示数据集、2 个示例训练任务；不勾选则创建空项目'));
      body.appendChild(lb);
    }

    async function fillVersions() {
      UI.clear(ver);
      try {
        const d = await Api.get('/fl/algorithms/' + algo.value);
        d.versions.forEach(function (v) {
          const o = document.createElement('option');
          o.value = v.version;
          o.textContent = v.version + (v.is_current ? '（当前版本）' : '') + ' · ' + v.note;
          ver.appendChild(o);
        });
        ver.value = edit && p.base_algorithm === d.algo_id ? p.model_version : d.current_version;
        const tts = d.task_types;
        const keep = metric.value || (edit ? p.target.metric : '');
        UI.clear(metric);
        TARGETS.filter(function (t) { return tts.indexOf(t.tt) >= 0; }).forEach(function (t) {
          const o = document.createElement('option');
          o.value = t.value; o.textContent = t.label;
          metric.appendChild(o);
        });
        if (keep && metric.querySelector('option[value="' + keep + '"]')) metric.value = keep;
        if (!value.value) value.value = tts.indexOf('timeseries') >= 0 ? '0.12' : '0.95';
        noteTarget();
      } catch (e) { UI.fail(e); }
    }
    function noteTarget() {
      const t = TARGETS.filter(function (x) { return x.value === metric.value; })[0];
      if (!t) return;
      targetNote.textContent = '训练目标：' + t.label.split('（')[0] + ' ' + t.op + ' ' + (value.value || '?') +
        '。达到后任务视为达标；RMSE / MAE 为归一化值，Accuracy / AUC 取 0 – 1。';
    }
    algo.addEventListener('change', fillVersions);
    metric.addEventListener('change', noteTarget);
    value.addEventListener('input', noteTarget);
    await fillVersions();

    UI.modal({
      title: edit ? '编辑项目配置' : '新建联邦学习项目', body: body, submitText: edit ? '保存配置' : '创建项目', width: 680,
      onSubmit: async function () {
        const req = {
          name: name.value.trim(), type: type.value, description: desc.value.trim(),
          base_algorithm: algo.value, model_version: ver.value,
          total_rounds: rounds.value === '' ? null : Number(rounds.value),
          target: { metric: metric.value, value: value.value === '' ? null : Number(value.value) }
        };
        if (edit) {
          const saved = await Api.patch('/projects/' + p.project_id, req);
          UI.toast('项目配置已保存（第 ' + saved.revision + ' 版）');
          await App.reloadProjects();
          proj = saved;
          renderProject();
          loadProjects();
        } else {
          req.seed_demo = demo.checked;
          const created = await Api.post('/projects', req);
          UI.toast('已创建项目「' + created.name + '」并切换到该项目' + (req.seed_demo ? '，已导入演示节点、数据集与任务' : '，请先添加参与方节点'));
          await App.reloadProjects(created.project_id);
        }
      }
    });
  }

  async function exportConfig() {
    try {
      const name = await Api.download('/projects/' + ctx.projectId + '/config/export');
      UI.toast('已导出 ' + (name || '项目配置文件'));
    } catch (e) { UI.fail(e); }
  }

  /* ================= FL-ORCH-02 节点 ================= */

  function renderNodes() {
    const wrap = $('floNodes');
    UI.clear(wrap);
    if (!nodes.length) {
      wrap.appendChild(el('div', 'table-empty', '项目还没有节点。联邦训练至少需要 2 个训练节点和 1 个聚合节点，点击「添加节点」登记'));
      return;
    }
    nodes.forEach(function (n) {
      const row = el('div', 'table-row flo-node-grid');
      row.appendChild(el('span', 'cell-strong', n.node_id));
      row.appendChild(el('span', 'cell-muted', n.ip + ' : ' + n.port));
      row.appendChild(el('span', 'tag ' + (n.role === 'aggregator' ? 'tag-ts' : 'tag-cls'), n.role === 'aggregator' ? '聚合节点' : '训练节点'));
      row.appendChild(el('span', 'cell-muted', n.data_partition || '—'));
      const dir = el('span', 'cell-muted flo-mono flo-ellipsis', n.data_dir || '无（不持有原始数据）');
      dir.title = n.data_dir || '';
      row.appendChild(dir);
      const run = el('span', n.running_job_count ? 'st-importing' : 'cell-muted', n.running_job_count ? n.running_job_count + ' 个运行中' : '无');
      row.appendChild(run);
      row.appendChild(n.online === false
        ? el('span', 'st-failed', '离线 · 心跳丢失')
        : el('span', 'cell-muted', UI.datetime(n.last_heartbeat_at)));
      const ops = el('span', 'flo-ops');
      ops.appendChild(button('编辑', 'btn-sm', function () { openNode(n); }));
      const del = button('删除', 'btn-sm btn-kill', function () { removeNode(n); });
      if (n.running_job_count) { del.disabled = true; del.title = '运行中任务使用的节点不能删除'; }
      ops.appendChild(del);
      row.appendChild(ops);
      wrap.appendChild(row);
    });
  }

  function openNode(n) {
    const edit = !!n;
    const body = col();
    const id = UI.inputOf('fnId', edit ? n.node_id : '');
    id.placeholder = 'node-baotou-04';
    body.appendChild(UI.formRow('节点 ID', id, edit ? '已被历史任务引用的节点不能改 ID' : '小写字母 / 数字 / 短横线，项目内唯一'));
    const two = el('div', 'form-2col');
    const ip = UI.inputOf('fnIp', edit ? n.ip : '');
    ip.placeholder = '10.40.3.9';
    const port = UI.inputOf('fnPort', edit ? n.port : 8471, 'number');
    port.min = 1; port.max = 65535;
    two.appendChild(UI.formRow('IP 地址', ip, 'IPv4 或 IPv6'));
    two.appendChild(UI.formRow('端口', port, '1 – 65535'));
    body.appendChild(two);
    const role = UI.selectOf('fnRole', [{ value: 'trainer', label: '参与方 / 训练节点' }, { value: 'aggregator', label: '聚合方 / 协调节点' }], edit ? n.role : 'trainer');
    body.appendChild(UI.formRow('角色', role));
    const two2 = el('div', 'form-2col');
    const part = UI.inputOf('fnPart', edit ? n.data_partition : '');
    part.placeholder = 'part-D';
    const dir = UI.inputOf('fnDir', edit ? n.data_dir : '');
    dir.placeholder = '留空则按 /data/fl/{项目 ID}/{分区} 生成';
    two2.appendChild(UI.formRow('数据分区标识', part, '训练节点必填'));
    two2.appendChild(UI.formRow('本地数据目录', dir, '仅本节点可读'));
    body.appendChild(two2);
    let online = null;
    if (edit) {
      online = UI.selectOf('fnOnline', [{ value: 'true', label: '在线' }, { value: 'false', label: '离线（模拟心跳丢失）' }], n.online === false ? 'false' : 'true');
      body.appendChild(UI.formRow('在线状态', online, '置为离线后，使用该节点的运行中任务转为 Failed，启动校验也会拒绝该节点'));
    }
    if (edit && n.running_job_count) {
      const note = el('div', 'banner-note', '该节点正被 ' + n.running_job_count + ' 个运行中任务使用：只能修改 IP、端口与在线状态。');
      body.appendChild(note);
    }
    const sync = function () { two2.hidden = role.value !== 'trainer'; };
    role.addEventListener('change', sync);
    sync();

    UI.modal({
      title: edit ? '编辑节点 ' + n.node_id : '添加参与方节点', body: body, submitText: edit ? '保存' : '添加',
      onSubmit: async function () {
        const req = { node_id: id.value.trim(), ip: ip.value.trim(), port: port.value === '' ? null : Number(port.value), role: role.value };
        if (role.value === 'trainer') { req.data_partition = part.value.trim(); req.data_dir = dir.value.trim() || undefined; }
        if (edit) {
          req.online = online.value === 'true';
          const diff = {};
          Object.keys(req).forEach(function (k) { if (req[k] !== undefined && req[k] !== n[k]) diff[k] = req[k]; });
          if (diff.online === true && n.online === undefined) delete diff.online;
          if (!Object.keys(diff).length) return;
          await Api.patch('/projects/' + ctx.projectId + '/nodes/' + encodeURIComponent(n.node_id), diff);
          UI.toast('节点 ' + req.node_id + ' 已更新');
        } else {
          await Api.post('/projects/' + ctx.projectId + '/nodes', req);
          UI.toast('节点 ' + req.node_id + ' 已添加，连通性检查通过');
        }
        await reloadNodes();
      }
    });
  }

  function removeNode(n) {
    const body = el('div', 'hint', '删除后新建任务不能再选择 ' + n.node_id + '，已完成任务的历史记录保留。确认删除？');
    UI.modal({
      title: '删除节点', body: body, submitText: '删除',
      onSubmit: async function () {
        await Api.del('/projects/' + ctx.projectId + '/nodes/' + encodeURIComponent(n.node_id));
        UI.toast('节点 ' + n.node_id + ' 已删除');
        await reloadNodes();
      }
    });
  }

  /* ================= FL-ORCH-03 数据隔离 ================= */

  function renderIso() {
    $('floIsoRule').textContent = iso.policy.dir_rule;
    const tb = $('floMatrix');
    UI.clear(tb);
    if (!iso.data_dirs.length) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hint', '暂无训练节点，添加训练节点后显示其数据目录'));
      tb.appendChild(tr);
    } else {
      const head = el('tr');
      head.appendChild(el('th', null, '发起节点 / 目标目录'));
      iso.data_dirs.forEach(function (d) {
        const th = el('th');
        th.appendChild(el('div', null, d.node_id));
        th.appendChild(el('div', 'hint-2 flo-mono', d.data_dir));
        head.appendChild(th);
      });
      tb.appendChild(head);
      iso.matrix.forEach(function (r) {
        const tr = el('tr');
        tr.appendChild(el('td', 'cell-strong', r.node_id + (r.role === 'aggregator' ? '（聚合）' : '')));
        r.cells.forEach(function (c) {
          const td = el('td');
          td.appendChild(el('span', 'tag ' + (c.allowed ? 'flo-ok' : 'flo-deny'), c.allowed ? '可读（本节点）' : '拒绝'));
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
    }

    const pay = $('floPayload');
    UI.clear(pay);
    pay.appendChild(el('span', 'hint', iso.policy.channel_rule));
    iso.payload_allowed.forEach(function (x) {
      const row = el('div', 'flo-pay-row');
      row.appendChild(el('span', 'tag flo-ok', '允许'));
      row.appendChild(el('span', 'flo-mono', x.field));
      row.appendChild(el('span', 'hint', x.label));
      pay.appendChild(row);
    });
    iso.payload_forbidden.forEach(function (x) {
      const row = el('div', 'flo-pay-row');
      row.appendChild(el('span', 'tag flo-deny', '禁止'));
      row.appendChild(el('span', 'flo-mono', x.field));
      row.appendChild(el('span', 'hint', x.label));
      pay.appendChild(row);
    });

    const actor = $('floActor'), target = $('floTarget');
    const keepA = actor.value, keepT = target.value;
    UI.clear(actor); UI.clear(target);
    nodes.forEach(function (n) {
      const o = document.createElement('option');
      o.value = n.node_id; o.textContent = n.node_id;
      actor.appendChild(o);
    });
    iso.data_dirs.forEach(function (d) {
      const o = document.createElement('option');
      o.value = d.node_id; o.textContent = d.node_id + ' · ' + d.data_dir;
      target.appendChild(o);
    });
    if (keepA && nodes.some(function (n) { return n.node_id === keepA; })) actor.value = keepA;
    if (keepT && iso.data_dirs.some(function (d) { return d.node_id === keepT; })) target.value = keepT;
    else if (iso.data_dirs.length > 1 && actor.value === iso.data_dirs[0].node_id) target.value = iso.data_dirs[1].node_id;
    $('floCheckDir').disabled = !nodes.length || !iso.data_dirs.length;
    renderIsoLogs();
  }

  function renderIsoLogs() {
    const wrap = $('floIsoLogs');
    UI.clear(wrap);
    if (!iso.checks.length) {
      wrap.appendChild(el('div', 'table-empty', '暂无检测记录。选择一个节点去读另一个节点的目录，点「越权访问检测」验证隔离'));
      return;
    }
    const RES = { denied: ['已拒绝', 'flo-deny'], allowed: ['允许', 'flo-ok'], passed: ['通过', 'flo-ok'] };
    iso.checks.forEach(function (c) {
      const row = el('div', 'table-row flo-log-grid');
      row.appendChild(el('span', 'cell-muted', UI.datetime(c.at)));
      row.appendChild(el('span', 'cell-muted', c.type === 'dir_access' ? '目录访问' : '传输内容审计'));
      row.appendChild(el('span', 'cell-muted flo-ellipsis', c.type === 'dir_access'
        ? c.actor_node_id + ' → ' + c.target_node_id
        : c.job_name + ' · 第 ' + c.round + ' 轮'));
      const r = RES[c.result] || [c.result, ''];
      row.appendChild(el('span', 'tag ' + r[1], r[0]));
      const d = el('span', 'hint', c.detail);
      if (c.type === 'payload') {
        d.textContent = c.detail + '。' + c.nodes.map(function (n) {
          return n.direction === 'downlink'
            ? n.node_id + ' 下发 ' + UI.bytes(n.total_bytes) + '（全局参数 ' + n.fields[0].elements.toLocaleString('en-US') + ' 个 float32）'
            : n.node_id + ' 上传 ' + UI.bytes(n.total_bytes) + '（梯度 ' + n.fields[0].elements.toLocaleString('en-US') + ' 个 float32）';
        }).join('；');
      }
      row.appendChild(d);
      wrap.appendChild(row);
    });
  }

  async function runCheck(body) {
    try {
      const rec = await Api.post('/projects/' + ctx.projectId + '/isolation/checks', body);
      iso.checks.unshift(rec);
      renderIsoLogs();
      return rec;
    } catch (e) { UI.fail(e); return null; }
  }

  async function checkDir() {
    const rec = await runCheck({ type: 'dir_access', actor_node_id: $('floActor').value, target_node_id: $('floTarget').value });
    if (rec) UI.toast(rec.result === 'denied' ? '越权访问已被拒绝，已写入审计日志' : '本节点访问自己的目录：允许');
  }

  async function checkPayload() {
    const rec = await runCheck({ type: 'payload' });
    if (rec) UI.toast('传输内容审计' + (rec.result === 'passed' ? '通过：未发现原始数据字段' : '未通过'));
  }

  /* ================= FL-ORCH-05 至 09 算法库 ================= */

  function renderTabs() {
    root.querySelectorAll('#floTabs .tab').forEach(function (b) {
      const n = algos.filter(function (a) { return a.kind === b.dataset.tab; }).length;
      b.textContent = KIND_CN[b.dataset.tab] + '（' + n + '）';
      b.classList.toggle('on', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    const wrap = $('floAlgoList');
    UI.clear(wrap);
    const list = algos.filter(function (a) { return a.kind === tab; });
    if (!list.length) {
      wrap.appendChild(el('div', 'table-empty', tab === 'registered' ? '还没有注册算法，点击「注册算法」添加' : '本项目还没有上传自定义模型，点击「上传自定义模型」'));
    }
    list.forEach(function (a) {
      const item = el('button', 'flo-algo-item' + (a.algo_id === algoId ? ' on' : ''));
      item.type = 'button';
      item.dataset.algo = a.algo_id;
      const top = el('span', 'flo-algo-top');
      top.appendChild(el('span', 'cell-strong', a.name));
      top.appendChild(el('span', 'tag', 'v' + a.current_version));
      item.appendChild(top);
      item.appendChild(el('span', 'hint', a.task_types.map(function (t) { return TT_CN[t]; }).join(' / ') + ' · .' + a.model_format + ' · ' + a.version_count + ' 个版本 · ' + a.template_count + ' 个参数模板'));
      item.addEventListener('click', function () { selectAlgo(a.algo_id); });
      wrap.appendChild(item);
    });
  }

  function switchTab(name) {
    tab = name;
    renderTabs();
    const first = algos.filter(function (a) { return a.kind === tab; })[0];
    selectAlgo(first ? first.algo_id : null);
  }

  async function selectAlgo(id) {
    const g = gen;
    algoId = id;
    root.querySelectorAll('.flo-algo-item').forEach(function (b) { b.classList.toggle('on', b.dataset.algo === id); });
    const box = $('floAlgoDetail');
    if (!id) { UI.clear(box); detail = null; box.appendChild(el('div', 'table-empty', '选择左侧算法查看接口、版本与参数模板')); return; }
    try {
      const r = await Promise.all([Api.get('/fl/algorithms/' + id), Api.get('/fl/algorithms/' + id + '/templates')]);
      if (g !== gen || algoId !== id) return;
      detail = r[0];
      templates = r[1].items;
      renderDetail();
    } catch (e) { UI.fail(e); }
  }

  function section(title, acc, extra) {
    const s = el('div', 'flo-sec');
    if (acc) s.dataset.acc = acc;
    const h = el('div', 'flo-head');
    h.appendChild(el('span', 'section-label', title));
    h.appendChild(el('span', 'spacer'));
    if (extra) h.appendChild(extra);
    s.appendChild(h);
    return s;
  }

  function rangeText(d) {
    if (d.enum) return '可选 ' + d.enum.join(' / ');
    if (d.type === 'boolean') return '是 / 否';
    const parts = [];
    if (d.minimum !== undefined) parts.push('≥ ' + d.minimum);
    if (d.maximum !== undefined) parts.push('≤ ' + d.maximum);
    return parts.length ? parts.join('，') : '—';
  }

  function renderDetail() {
    const d = detail;
    const box = $('floAlgoDetail');
    UI.clear(box);

    const head = el('div', 'flo-head');
    head.appendChild(el('span', 'card-title', d.name));
    head.appendChild(el('span', 'tag tag-cls', '当前版本 ' + d.current_version));
    head.appendChild(el('span', 'tag', KIND_CN[d.kind]));
    box.appendChild(head);
    box.appendChild(el('span', 'hint', d.description));
    const kv = el('div', 'flo-kv');
    [['基类', d.base_class], ['实现框架', d.framework], ['适用任务', d.task_types.map(function (t) { return TT_CN[t]; }).join(' / ')],
      ['模型文件格式', '.' + d.model_format], ['算法 ID', d.algo_id + (d.model_file_id ? ' · 制品文件 ' + d.model_file_id : '')]]
      .forEach(function (r) { kv.appendChild(el('span', 'flo-kv-k', r[0])); kv.appendChild(el('span', 'flo-kv-v', r[1])); });
    box.appendChild(kv);

    // FL-ORCH-07 结构校验结果
    if (d.structure) {
      const s = section('模型结构校验（当前版本）', 'FL-ORCH-07');
      s.appendChild(structureView(d.structure));
      box.appendChild(s);
    }

    // FL-ORCH-05 统一接口
    const api = section('统一训练 / 预测接口', 'FL-ORCH-05');
    const t = el('table', 'preview-table flo-iface');
    const hr = el('tr');
    ['方法', '签名', '输入', '输出'].forEach(function (x) { hr.appendChild(el('th', null, x)); });
    t.appendChild(hr);
    d.interface.forEach(function (m) {
      const tr = el('tr');
      tr.appendChild(el('td', 'cell-strong flo-mono', m.method));
      tr.appendChild(el('td', 'flo-mono', m.signature));
      tr.appendChild(el('td', null, m.input));
      tr.appendChild(el('td', null, m.output));
      t.appendChild(tr);
    });
    api.appendChild(t);
    box.appendChild(api);

    // 参数 schema
    const ps = section('参数 schema（JSON Schema 子集）', 'FL-ORCH-06');
    const pt = el('table', 'preview-table');
    const ph = el('tr');
    ['参数', '类型', '取值范围', '默认值', '说明'].forEach(function (x) { ph.appendChild(el('th', null, x)); });
    pt.appendChild(ph);
    const props = d.params_schema.properties;
    Object.keys(props).forEach(function (k) {
      const p = props[k];
      const tr = el('tr');
      tr.appendChild(el('td', 'flo-mono', k + ((d.params_schema.required || []).indexOf(k) >= 0 ? ' *' : '')));
      tr.appendChild(el('td', null, p.type));
      tr.appendChild(el('td', null, rangeText(p)));
      tr.appendChild(el('td', null, p.default === undefined ? '—' : String(p.default)));
      tr.appendChild(el('td', 'hint', p.description || ''));
      pt.appendChild(tr);
    });
    ps.appendChild(pt);
    box.appendChild(ps);

    // FL-ORCH-08 版本
    const vs = section('版本历史', 'FL-ORCH-08', el('span', 'hint', '回滚只移动「当前版本」指针，之后新建的任务使用该版本'));
    vs.appendChild(Object.assign(el('div', 'table-head flo-ver-grid'), { innerHTML: '<span>版本</span><span>说明</span><span>发布人</span><span>发布时间</span><span>操作</span>' }));
    d.versions.forEach(function (v) {
      const row = el('div', 'table-row flo-ver-grid' + (v.is_current ? ' current' : ''));
      const vc = el('span', 'flo-ops');
      vc.appendChild(el('span', 'cell-strong', v.version));
      if (v.is_current) vc.appendChild(el('span', 'tag tag-cls', '当前'));
      row.appendChild(vc);
      row.appendChild(el('span', 'cell-muted flo-ellipsis', v.note));
      row.appendChild(el('span', 'cell-muted', v.created_by));
      row.appendChild(el('span', 'cell-muted', UI.datetime(v.created_at)));
      const ops = el('span');
      if (!v.is_current) ops.appendChild(button('回滚到此版本', 'btn-sm', function () { rollback(v.version); }));
      row.appendChild(ops);
      vs.appendChild(row);
    });
    if (d.history.length) {
      const log = el('div', 'flo-history');
      d.history.forEach(function (h) {
        log.appendChild(el('div', 'hint', UI.datetime(h.at) + ' · ' + h.operator + ' · ' +
          (h.action === 'rollback' ? '回滚 ' + h.from_version + ' → ' + h.to_version + (h.reason ? '（' + h.reason + '）' : '')
            : '发布 ' + h.to_version + (h.from_version ? '（原当前版本 ' + h.from_version + '）' : ''))));
      });
      vs.appendChild(log);
    }
    box.appendChild(vs);

    // FL-ORCH-09 参数模板
    const ts = section('参数模板', 'FL-ORCH-09', button('＋ 另存为模板', 'btn-sm', function () { openTemplate(null); }));
    ts.appendChild(Object.assign(el('div', 'table-head flo-tpl-grid'), { innerHTML: '<span>模板</span><span>参数组合</span><span>来源</span><span>操作</span>' }));
    if (!templates.length) ts.appendChild(el('div', 'table-empty', '暂无模板'));
    templates.forEach(function (tp) {
      const row = el('div', 'table-row flo-tpl-grid');
      row.appendChild(el('span', 'cell-strong', tp.name));
      const pv = el('span', 'flo-mono-soft flo-ellipsis', Object.keys(tp.params).map(function (k) { return k + '=' + tp.params[k]; }).join('  '));
      pv.title = pv.textContent;
      row.appendChild(pv);
      row.appendChild(el('span', 'tag' + (tp.preset ? '' : ' tag-ts'), tp.preset ? '平台预置' : tp.created_by + ' 自定义'));
      const ops = el('span', 'flo-ops');
      ops.appendChild(button('以此为底另存', 'btn-sm', function () { openTemplate(tp); }));
      if (!tp.preset) ops.appendChild(button('删除', 'btn-sm btn-kill', function () { removeTemplate(tp); }));
      row.appendChild(ops);
      ts.appendChild(row);
    });
    box.appendChild(ts);
  }

  function shape(a) { return '(' + a.join(', ') + ')'; }

  function structureView(r) {
    const wrap = el('div', 'flo-struct');
    if (r.valid) {
      const g = el('div', 'metric-grid');
      [['层数', r.layers + ' 层', '各层输入输出维度首尾相接'],
        ['参数量', r.param_count.toLocaleString('en-US') + ' 个', r.param_count_basis],
        ['输入形状', shape(r.input_shape), 'batch 为批大小'],
        ['输出形状', shape(r.output_shape), r.framework]].forEach(function (m) {
        const c = el('div', 'metric');
        c.appendChild(el('span', 'metric-name', m[0]));
        c.appendChild(el('span', 'flo-metric-v', m[1]));
        c.appendChild(el('span', 'metric-sub', m[2]));
        g.appendChild(c);
      });
      wrap.appendChild(g);
    } else {
      wrap.appendChild(el('div', 'banner banner-err', '校验失败：' + r.reason));
    }
    r.checks.forEach(function (c) {
      const row = el('div', 'flo-pay-row');
      row.appendChild(el('span', 'tag ' + (c.passed ? 'flo-ok' : 'flo-deny'), c.passed ? '通过' : '失败'));
      row.appendChild(el('span', 'cell-strong', c.item));
      row.appendChild(el('span', 'hint', c.detail));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function rollback(version) {
    const body = col();
    body.appendChild(el('span', 'hint', detail.name + ' 当前版本 ' + detail.current_version + '，回滚后新建的训练任务使用 ' + version + '，已创建的任务不受影响。'));
    const reason = UI.inputOf('frReason', '');
    reason.placeholder = '例如：1.2.0 在 p2 精度下降';
    body.appendChild(UI.formRow('回滚原因（选填）', reason));
    const id = detail.algo_id;
    UI.modal({
      title: '回滚到 ' + version, body: body, submitText: '确认回滚',
      onSubmit: async function () {
        await Api.post('/fl/algorithms/' + id + '/actions', { action: 'rollback', version: version, reason: reason.value.trim() });
        UI.toast(detail.name + ' 已回滚到 ' + version);
        await reloadAlgos(id);
      }
    });
  }

  function openTemplate(base) {
    const body = col();
    const name = UI.inputOf('ftName', base ? base.name + ' · 副本' : '');
    name.maxLength = 30;
    body.appendChild(UI.formRow('模板名称', name, '同一算法下不能重名，不超过 30 个字符'));
    const ed = paramEditor(detail.params_schema, base ? base.params : null, 'ftp');
    body.appendChild(ed.el);
    const id = detail.algo_id;
    UI.modal({
      title: '另存 ' + detail.name + ' 参数模板', body: body, submitText: '保存模板', width: 720,
      onSubmit: async function () {
        const t = await Api.post('/fl/algorithms/' + id + '/templates', { name: name.value.trim(), params: ed.read() });
        UI.toast('已保存模板「' + t.name + '」，新建训练任务时可选');
        await reloadAlgos(id);
      }
    });
  }

  function removeTemplate(tp) {
    UI.modal({
      title: '删除参数模板', body: el('div', 'hint', '删除模板「' + tp.name + '」？已用它创建的任务不受影响。'), submitText: '删除',
      onSubmit: async function () {
        await Api.del('/fl/param-templates/' + tp.template_id);
        UI.toast('模板已删除');
        await reloadAlgos(detail.algo_id);
      }
    });
  }

  /* --- FL-ORCH-06 注册算法 --- */

  function openRegister() {
    const body = col();
    const two = el('div', 'form-2col');
    const name = UI.inputOf('fgName', '');
    name.placeholder = 'LightGBM-Fed';
    const ver = UI.inputOf('fgVer', '1.0.0');
    two.appendChild(UI.formRow('算法名', name, '与已注册算法同名即发布新版本'));
    two.appendChild(UI.formRow('版本', ver, '主.次.修订，例如 1.0.0'));
    body.appendChild(two);
    const two2 = el('div', 'form-2col');
    const fmt = UI.selectOf('fgFmt', FORMATS.map(function (f) { return { value: f, label: '.' + f }; }), 'pkl');
    const base = UI.inputOf('fgBase', 'FedEstimator');
    two2.appendChild(UI.formRow('模型文件格式', fmt));
    two2.appendChild(UI.formRow('继承基类', base, '需实现 fit / predict / evaluate'));
    body.appendChild(two2);
    const tts = el('div', 'chip-row');
    ['classification', 'timeseries'].forEach(function (t, i) {
      const lb = el('label', 'check-item');
      const cb = el('input');
      cb.type = 'checkbox'; cb.value = t; cb.checked = i === 0; cb.name = 'fgTT';
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode(TT_CN[t]));
      tts.appendChild(lb);
    });
    const ttRow = el('div', 'field-col');
    ttRow.appendChild(el('label', null, '适用任务类型'));
    ttRow.appendChild(tts);
    body.appendChild(ttRow);
    const desc = UI.inputOf('fgDesc', '');
    desc.placeholder = '一句话说明算法用途';
    body.appendChild(UI.formRow('说明', desc));
    const schema = textarea('fgSchema', SCHEMA_EXAMPLE, 12);
    schema.classList.add('flo-mono');
    body.appendChild(UI.formRow('参数 schema（JSON）', schema, '根节点 type 为 object；参数 type 支持 integer / number / string / boolean，约束支持 minimum / maximum / enum / default / required'));

    UI.modal({
      title: '注册算法', body: body, submitText: '注册', width: 720,
      onSubmit: async function () {
        const a = await Api.post('/fl/algorithms', {
          name: name.value.trim(), version: ver.value.trim(), model_format: fmt.value, base_class: base.value.trim(),
          description: desc.value.trim(), params_schema: schema.value,
          task_types: Array.prototype.slice.call(tts.querySelectorAll('input:checked')).map(function (c) { return c.value; })
        });
        UI.toast('已注册 ' + a.name + ' ' + a.current_version + '，新建训练任务的算法下拉中可选');
        tab = 'registered';
        await reloadAlgos(a.algo_id);
      }
    });
  }

  /* --- FL-ORCH-07 上传自定义模型 --- */

  function openUpload() {
    const body = col();
    const file = el('input');
    file.type = 'file';
    file.id = 'fuFile';
    file.accept = '.pkl,.pt,.h5,.onnx';
    body.appendChild(UI.formRow('模型文件', file, '支持 .pkl / .pt / .h5 / .onnx，单个文件不超过 2 GB'));
    const two = el('div', 'form-2col');
    const name = UI.inputOf('fuName', '');
    name.placeholder = '默认取文件名';
    const tt = UI.selectOf('fuTT', [{ value: 'classification', label: '分类' }, { value: 'timeseries', label: '时序预测' }],
      proj && proj.target.task_type === 'timeseries' ? 'timeseries' : 'classification');
    two.appendChild(UI.formRow('模型名称', name, '同名再次上传生成新版本'));
    two.appendChild(UI.formRow('任务类型', tt, '决定校验时使用的输入形状'));
    body.appendChild(two);
    const result = el('div');
    body.appendChild(result);
    file.addEventListener('change', function () {
      UI.clear(result);
      if (file.files[0] && !name.value) name.value = file.files[0].name.replace(/\.[^.]+$/, '');
    });

    const m = UI.modal({
      title: '上传自定义模型', body: body, submitText: '上传并校验', width: 680,
      onSubmit: async function () {
        UI.clear(result);
        if (!file.files[0]) throw new Error('请先选择模型文件');
        const f = await Api.upload('/files', file.files[0], { purpose: 'fl_model', project_id: ctx.projectId });
        try {
          const model = await Api.post('/projects/' + ctx.projectId + '/fl/models', { file_id: f.file_id, name: name.value.trim(), task_type: tt.value });
          UI.toast('模型 ' + model.name + ' ' + model.current_version + ' 校验通过：' + model.report.layers + ' 层，' + model.report.param_count.toLocaleString('en-US') + ' 个参数');
          tab = 'custom';
          await reloadAlgos(model.algo_id);
        } catch (e) {
          if (e.data && e.data.report) {
            result.appendChild(el('span', 'section-label', '结构校验报告'));
            result.appendChild(structureView(e.data.report));
            m.showError('模型未登记：结构校验未通过，请修复后重新上传');
            return false;
          }
          throw e;
        }
      }
    });
  }

  /* ================= 参数表单（也供 js/fl.js 新建任务弹窗使用） ================= */

  /**
   * 按参数 schema 渲染表单。values 缺省时用 schema 默认值。
   * 返回 { el, read() → params 对象, set(values) }。
   */
  function paramEditor(schema, values, prefix) {
    prefix = prefix || 'pe';
    const wrap = el('div', 'form-3col');
    const ctls = {};
    const props = (schema && schema.properties) || {};
    Object.keys(props).forEach(function (k) {
      const d = props[k];
      const id = prefix + '_' + k;
      let c;
      if (d.enum) {
        c = UI.selectOf(id, d.enum.map(function (v, i) { return { value: String(i), label: String(v) }; }));
      } else if (d.type === 'boolean') {
        c = UI.selectOf(id, [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]);
      } else {
        c = UI.inputOf(id, '', d.type === 'string' ? 'text' : 'number');
        if (d.type !== 'string') c.step = d.type === 'integer' ? '1' : 'any';
        if (d.minimum !== undefined) c.min = d.minimum;
        if (d.maximum !== undefined) c.max = d.maximum;
      }
      ctls[k] = c;
      wrap.appendChild(UI.formRow(k, c, (d.description ? d.description + '，' : '') + rangeText(d)));
    });
    function set(vals) {
      Object.keys(ctls).forEach(function (k) {
        const d = props[k];
        const v = vals && vals[k] !== undefined ? vals[k] : d.default;
        if (d.enum) ctls[k].value = String(Math.max(0, d.enum.indexOf(v)));
        else if (d.type === 'boolean') ctls[k].value = v ? 'true' : 'false';
        else ctls[k].value = v === undefined || v === null ? '' : String(v);
      });
    }
    function read() {
      const out = {};
      Object.keys(ctls).forEach(function (k) {
        const d = props[k], c = ctls[k];
        if (d.enum) out[k] = d.enum[Number(c.value)];
        else if (d.type === 'boolean') out[k] = c.value === 'true';
        else if (c.value === '') return;
        else out[k] = d.type === 'string' ? c.value : Number(c.value);
      });
      return out;
    }
    set(values);
    return { el: wrap, read: read, set: set };
  }

  /* ================= 生命周期 ================= */

  function mount(c, section) {
    ctx = c;
    gen += 1;
    if (root !== section || !section.querySelector('#floProjKv')) { root = section; build(); }
    load();
  }

  function unmount() { gen += 1; }

  window.FLO = { mount: mount, unmount: unmount, paramEditor: paramEditor };
})();
