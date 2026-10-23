/** 隐私求交模块。接口见 API.md §5。 */
(function () {
  'use strict';
  const $ = UI.$;

  const STAGE_ST = {
    pending: ['待执行', '#F0F2F5', '#4C5564'],
    running: ['执行中', '#E7F0FA', '#1A4F8A'],
    finished: ['已完成', '#E9F4EF', '#1D5C42'],
    failed: ['失败', '#FBEDEA', '#A33B21'],
    skipped: ['已跳过', '#F0F2F5', '#4C5564']
  };

  const SRC_CN = { file: '文件上传', database: '数据库', hdfs: 'HDFS' };
  const DS_ST = { ready: ['已就绪', 'st-ready'], importing: ['接入中', 'st-importing'], failed: ['失败', 'st-failed'] };

  let ctx = null;
  let protocols = [];
  let parties = [];          // GET /psi/parties
  let datasets = [];         // 当前项目已登记数据集
  let tab = 'data';
  let pollTimer = null;
  let selected = 'ecdh';
  let paramValues = {};      // key -> value（可编辑）
  let pipeline = null;
  let sse = null;
  let booted = false;

  function protoDef(k) { return protocols.filter(function (p) { return p.protocol === k; })[0]; }

  function bindOnce() {
    if (booted) return;
    booted = true;
    $('psiRun').addEventListener('click', run);
    $('psiPipeReset').addEventListener('click', cancel);
    $('psiSave').addEventListener('click', saveTemplate);
    $('psiLoad').addEventListener('click', loadTemplate);
    $('psiGoFed').addEventListener('click', function () {
      window.App.go('fed', { focusJobId: pipeline && pipeline.fl_job_id });
    });
    $('psiTabData').addEventListener('click', function () { switchTab('data'); });
    $('psiTabPipe').addEventListener('click', function () { switchTab('pipe'); });
    $('psiToData').addEventListener('click', function () { switchTab('data'); });
    $('dsNew').addEventListener('click', openImport);
    $('dsPartyFilter').addEventListener('change', renderDatasets);
    $('dsDetailClose').addEventListener('click', function () { $('dsDetail').hidden = true; });
    ['psiDsA', 'psiDsB'].forEach(function (id, i) {
      $(id).addEventListener('change', function () { renderKeySel(i); renderDsNote(); });
    });
    ['psiKeyA', 'psiKeyB'].forEach(function (id) { $(id).addEventListener('change', renderDsNote); });
  }

  function switchTab(name) {
    tab = name;
    $('psiTabData').classList.toggle('on', name === 'data');
    $('psiTabPipe').classList.toggle('on', name === 'pipe');
    $('psiPanelData').hidden = name !== 'data';
    $('psiPanelPipe').hidden = name !== 'pipe';
    if (name === 'pipe') renderPartySel();
  }

  /* ---------- 数据接入 ---------- */

  async function loadDatasets() {
    const res = await Api.get('/projects/' + ctx.projectId + '/datasets');
    datasets = res.items;
    renderDatasets();
    renderPartySel();
    // 有「接入中」的数据集时轮询，直到全部就绪
    clearTimeout(pollTimer);
    if (datasets.some(function (d) { return d.status === 'importing'; })) {
      pollTimer = setTimeout(function () { loadDatasets().catch(UI.fail); }, 800);
    }
  }

  function renderDatasets() {
    const wrap = $('dsList');
    UI.clear(wrap);
    const pf = $('dsPartyFilter').value;
    const list = datasets.filter(function (d) { return !pf || d.party_id === pf; });
    if (!list.length) {
      wrap.appendChild(UI.el('div', 'table-empty', '暂无数据集，点击「接入数据」登记参与方本地数据'));
      return;
    }
    list.forEach(function (d) {
      const row = UI.el('div', 'table-row ds-grid');
      const nameCell = UI.el('span');
      nameCell.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0;';
      nameCell.appendChild(UI.el('span', 'cell-strong', d.name));
      nameCell.appendChild(UI.el('span', 'hint-2', d.dataset_id));
      row.appendChild(nameCell);
      row.appendChild(UI.el('span', 'cell-muted', d.party_name));
      row.appendChild(UI.el('span', 'cell-muted', SRC_CN[d.source_type]));
      const addr = UI.el('span', 'cell-muted', sourceText(d));
      addr.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      addr.title = sourceText(d);
      row.appendChild(addr);
      row.appendChild(UI.el('span', 'cell-muted', d.row_count === null ? '—' : UI.rows(d.row_count)));
      row.appendChild(UI.el('span', 'cell-muted', d.id_column + (d.time_column ? ' / ' + d.time_column : '')));
      const st = DS_ST[d.status] || [d.status, ''];
      row.appendChild(UI.el('span', st[1], st[0]));
      const ops = UI.el('span');
      ops.style.cssText = 'display:flex; gap:6px;';
      const view = UI.el('button', 'btn-sm', '详情');
      view.type = 'button';
      view.disabled = d.status !== 'ready';
      view.addEventListener('click', function () { showDetail(d.dataset_id); });
      const del = UI.el('button', 'btn-sm btn-kill', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { removeDataset(d); });
      ops.appendChild(view);
      ops.appendChild(del);
      row.appendChild(ops);
      wrap.appendChild(row);
    });
  }

  function sourceText(d) {
    const s = d.source || {};
    if (d.source_type === 'database') return s.jdbc_url + ' · ' + s.table;
    if (d.source_type === 'hdfs') return s.path;
    return s.file_name || s.file_id || '—';
  }

  async function showDetail(id) {
    try {
      const d = await Api.get('/datasets/' + id);
      $('dsDetail').hidden = false;
      $('dsDetailTitle').textContent = d.name;
      $('dsDetailMeta').textContent = d.party_name + ' · ' + SRC_CN[d.source_type] + ' · ' + UI.rows(d.row_count) + '行 · 特征 ' + d.feature_count + ' 列';
      $('dsColCount').textContent = d.columns.length;
      const cols = $('dsCols');
      UI.clear(cols);
      d.columns.forEach(function (c) {
        const isKey = c.name === d.id_column, isTime = c.name === d.time_column;
        const t = UI.el('span', 'tag' + (isKey ? ' tag-cls' : (isTime ? ' tag-ts' : '')),
          c.name + ' · ' + c.type + (isKey ? ' · 求交键' : (isTime ? ' · 时间列' : '')));
        cols.appendChild(t);
      });
      const tb = $('dsPreview');
      UI.clear(tb);
      if (d.preview.length) {
        const head = UI.el('tr');
        Object.keys(d.preview[0]).forEach(function (k) { head.appendChild(UI.el('th', null, k)); });
        tb.appendChild(head);
        d.preview.forEach(function (r) {
          const tr = UI.el('tr');
          Object.keys(r).forEach(function (k) { tr.appendChild(UI.el('td', null, String(r[k]))); });
          tb.appendChild(tr);
        });
      }
    } catch (e) { UI.fail(e); }
  }

  async function removeDataset(d) {
    if (!window.confirm('删除数据集「' + d.name + '」的登记信息？参与方本地数据不受影响。')) return;
    try {
      await Api.del('/datasets/' + d.dataset_id);
      UI.toast('已删除 ' + d.name);
      $('dsDetail').hidden = true;
      await loadDatasets();
    } catch (e) { UI.fail(e); }
  }

  function openImport() {
    let fileId = null, fileName = null;
    const body = UI.el('div');
    body.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
    const two = UI.el('div', 'form-2col');
    two.appendChild(UI.formRow('数据集名称', UI.inputOf('diName', '')));
    two.appendChild(UI.formRow('所属参与方', UI.selectOf('diParty', parties.map(function (p) {
      return { value: p.party_id, label: p.party_name };
    }))));
    body.appendChild(two);

    const srcSel = UI.selectOf('diSrc', [
      { value: 'database', label: '数据库（JDBC）' }, { value: 'hdfs', label: 'HDFS 路径' }, { value: 'file', label: '上传文件（CSV / Parquet）' }
    ], 'database');
    body.appendChild(UI.formRow('数据来源', srcSel));

    const dbBox = UI.el('div', 'form-2col');
    dbBox.appendChild(UI.formRow('JDBC 地址', UI.inputOf('diJdbc', 'jdbc:mysql://10.22.6.14:3306/risk')));
    dbBox.appendChild(UI.formRow('表名', UI.inputOf('diTable', '')));
    const hdfsRow = UI.formRow('HDFS 路径', UI.inputOf('diHdfs', 'hdfs://10.22.6.14:8020/warehouse/'));
    const fileIn = UI.el('input');
    fileIn.type = 'file'; fileIn.id = 'diFile'; fileIn.accept = '.csv,.parquet';
    const fileNote = UI.el('span', 'hint', '文件只上传到本参与方节点，不经过其他参与方');
    const fileRow = UI.formRow('数据文件', fileIn);
    fileRow.appendChild(fileNote);
    body.appendChild(dbBox);
    body.appendChild(hdfsRow);
    body.appendChild(fileRow);
    fileIn.addEventListener('change', async function () {
      fileId = null;
      if (!fileIn.files[0]) return;
      try {
        fileNote.textContent = '上传中…';
        const f = await Api.upload('/files', fileIn.files[0], { purpose: 'dataset', project_id: ctx.projectId });
        fileId = f.file_id; fileName = f.file_name;
        fileNote.textContent = '已上传 ' + f.file_name + '（' + UI.bytes(f.size_bytes) + '）';
      } catch (e) { fileNote.textContent = e.message; }
    });

    const two2 = UI.el('div', 'form-2col');
    two2.appendChild(UI.formRow('求交键列', UI.inputOf('diKey', 'phone_hash'), '已做哈希的手机号 / 证件号列'));
    two2.appendChild(UI.formRow('时间列（可选）', UI.inputOf('diTime', ''), '填写后可用于时序预测任务'));
    body.appendChild(two2);

    function srcChanged() {
      dbBox.hidden = srcSel.value !== 'database';
      hdfsRow.hidden = srcSel.value !== 'hdfs';
      fileRow.hidden = srcSel.value !== 'file';
    }
    srcSel.addEventListener('change', srcChanged);
    srcChanged();

    UI.modal({
      title: '接入数据', body: body, submitText: '开始接入', width: 640,
      onSubmit: async function () {
        const type = srcSel.value;
        const source = type === 'database' ? { jdbc_url: $('diJdbc').value.trim(), table: $('diTable').value.trim() }
          : (type === 'hdfs' ? { path: $('diHdfs').value.trim() } : { file_id: fileId, file_name: fileName });
        const req = {
          name: $('diName').value.trim(), party_id: $('diParty').value,
          source_type: type, source: source, id_column: $('diKey').value.trim()
        };
        const t = $('diTime').value.trim();
        if (t) req.time_column = t;
        const ds = await Api.post('/projects/' + ctx.projectId + '/datasets', req);
        UI.toast('「' + ds.name + '」接入中，schema 探测完成后可用于求交');
        await loadDatasets();
      }
    });
  }

  /* ---------- 求交数据选择 ---------- */

  function partyDatasets(i) {
    const pid = parties[i] && parties[i].party_id;
    return datasets.filter(function (d) { return d.party_id === pid && d.status === 'ready'; });
  }

  function renderPartySel() {
    ['psiDsA', 'psiDsB'].forEach(function (id, i) {
      const sel = $(id);
      const keep = sel.value;
      UI.clear(sel);
      const list = partyDatasets(i);
      if (!list.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '该参与方暂无就绪数据集';
        sel.appendChild(o);
      }
      list.forEach(function (d) {
        const o = document.createElement('option');
        o.value = d.dataset_id; o.textContent = d.name + '（' + UI.rows(d.row_count) + '行）';
        sel.appendChild(o);
      });
      if (list.some(function (d) { return d.dataset_id === keep; })) sel.value = keep;
      else {
        // 默认优先选截面表，时序流水表通常不直接拿来求交
        const plain = list.filter(function (d) { return !d.time_column; })[0];
        if (plain) sel.value = plain.dataset_id;
      }
      renderKeySel(i);
    });
    renderDsNote();
  }

  function renderKeySel(i) {
    const ds = datasets.filter(function (d) { return d.dataset_id === $(i ? 'psiDsB' : 'psiDsA').value; })[0];
    const sel = $(i ? 'psiKeyB' : 'psiKeyA');
    UI.clear(sel);
    (ds ? ds.columns.filter(function (c) { return c.type === 'string'; }) : []).forEach(function (c) {
      const o = document.createElement('option');
      o.value = c.name; o.textContent = '求交键：' + c.name;
      sel.appendChild(o);
    });
    if (ds) sel.value = ds.id_column;
  }

  function renderDsNote() {
    const a = $('psiKeyA').value, b = $('psiKeyB').value;
    $('psiDsNote').textContent = !$('psiDsA').value || !$('psiDsB').value
      ? '两方都需要选择已就绪的数据集'
      : (a !== b ? '两方求交键列名不同（' + a + ' / ' + b + '），请确认哈希口径一致' : '按 ' + a + ' 求交，原始数据不出域');
  }

  /* ---------- 协议与参数 ---------- */

  function renderProtocols() {
    const wrap = $('psiProtos');
    UI.clear(wrap);
    protocols.forEach(function (p) {
      const btn = UI.el('button', 'psi-proto' + (p.protocol === selected ? ' on' : ''));
      btn.type = 'button';
      const radio = UI.el('span', 'psi-radio');
      radio.appendChild(UI.el('i'));
      btn.appendChild(radio);
      const text = UI.el('span', 'psi-proto-text');
      text.appendChild(UI.el('span', 'psi-proto-name', p.name));
      text.appendChild(UI.el('span', 'psi-proto-desc', p.description));
      btn.appendChild(text);
      btn.addEventListener('click', function () {
        selected = p.protocol;
        paramValues = {};
        p.params.forEach(function (pa) { paramValues[pa.key] = pa.value; });
        renderProtocols();
        renderParams();
        renderRunNote();
      });
      wrap.appendChild(btn);
    });
  }

  function renderParams() {
    const def = protoDef(selected);
    const wrap = $('psiParams');
    UI.clear(wrap);
    def.params.forEach(function (pa) {
      const row = UI.el('div', 'psi-param');
      row.appendChild(UI.el('span', 'psi-param-label', pa.label));
      if (pa.editable) {
        const input = UI.el('input', 'input');
        input.style.height = '38px';
        input.style.flexGrow = '1';
        input.value = paramValues[pa.key] !== undefined ? paramValues[pa.key] : pa.value;
        input.addEventListener('change', function () {
          const raw = input.value;
          const num = Number(raw);
          paramValues[pa.key] = (raw !== '' && !Number.isNaN(num)) ? num
            : (raw === 'true' ? true : (raw === 'false' ? false : raw));
        });
        row.appendChild(input);
      } else {
        row.appendChild(UI.el('span', 'psi-param-value', pa.display));
      }
      wrap.appendChild(row);
    });
  }

  function renderRunNote() {
    const def = protoDef(selected);
    $('psiRunNote').textContent = def.name + ' · 求交结果直接作为联邦学习的数据准备步骤';
  }

  /* ---------- 模板 ---------- */

  async function saveTemplate() {
    try {
      const def = protoDef(selected);
      const tpl = await Api.post('/projects/' + ctx.projectId + '/psi/templates', {
        name: def.name + ' · 自定义参数',
        protocol: selected,
        params: paramValues
      });
      $('psiTplNote').textContent = '已保存模板「' + tpl.name + '」（' + tpl.template_id + '）';
      UI.toast('模板已保存');
    } catch (e) { UI.fail(e); }
  }

  async function loadTemplate() {
    try {
      const res = await Api.get('/projects/' + ctx.projectId + '/psi/templates', { protocol: selected });
      if (!res.items.length) {
        $('psiTplNote').textContent = '当前协议下没有已保存的模板';
        UI.toast('没有可加载的模板', true);
        return;
      }
      const tpl = await Api.get('/psi/templates/' + res.items[res.items.length - 1].template_id);
      paramValues = Object.assign({}, tpl.params);
      renderParams();
      $('psiTplNote').textContent = '已加载模板「' + tpl.name + '」';
      UI.toast('模板已加载');
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 流水线 ---------- */

  async function run() {
    try {
      $('psiRun').disabled = true;
      const projNodes = (await Api.get('/projects/' + ctx.projectId + '/nodes')).items;
      pipeline = await Api.post('/projects/' + ctx.projectId + '/psi/pipelines', {
        protocol: selected,
        params: paramValues,
        parties: [
          { party_id: parties[0].party_id, dataset_id: $('psiDsA').value, id_column: $('psiKeyA').value },
          { party_id: parties[1].party_id, dataset_id: $('psiDsB').value, id_column: $('psiKeyB').value }
        ],
        alignment: { feature_columns: [] },
        training: {
          fl_job_config: {
            task_type: 'classification', algorithm: 'xgb', aggregation: 'he',
            node_ids: projNodes.map(function (n) { return n.node_id; })
          },
          auto_start: false
        }
      });
      listen();
      render();
    } catch (e) { UI.fail(e); $('psiRun').disabled = false; }
  }

  async function cancel() {
    if (!pipeline) return;
    try {
      pipeline = await Api.post('/psi/pipelines/' + pipeline.pipeline_id + '/cancel');
      if (sse) { sse.close(); sse = null; }
      render();
    } catch (e) { UI.fail(e); }
  }

  function listen() {
    if (sse) sse.close();
    sse = Api.subscribe('/psi/pipelines/' + pipeline.pipeline_id + '/events', {
      stage_progress: function (s) {
        const idx = pipeline.stages.findIndex(function (x) { return x.stage === s.stage; });
        if (idx >= 0) pipeline.stages[idx] = s;
        renderStages();
      },
      pipeline_finished: function (ev) {
        pipeline.status = ev.status;
        pipeline.fl_job_id = ev.fl_job_id;
        pipeline.target_project = ev.target_project;
        render();
      }
    });
  }

  function render() {
    const running = pipeline && pipeline.status === 'running';
    const finished = pipeline && pipeline.status === 'finished';
    $('psiRun').disabled = running;
    $('psiRun').textContent = running ? '执行中…' : (finished ? '重新执行' : '一键启动');
    renderStages();
    $('psiDone').hidden = !finished;
    if (finished) {
      $('psiDoneText').textContent =
        '流水线执行完成，对齐后的样本已写入联邦项目「' + pipeline.target_project.name +
        '」并生成训练任务 ' + pipeline.fl_job_id + '，可在联邦学习模块启动训练。';
    }
  }

  function renderStages() {
    const wrap = $('psiStages');
    UI.clear(wrap);
    const stages = pipeline ? pipeline.stages : placeholderStages();
    stages.forEach(function (s, i) {
      const cls = s.status === 'finished' ? 'psi-stage done' : (s.status === 'running' ? 'psi-stage on' : 'psi-stage');
      const card = UI.el('div', cls);

      const head = UI.el('div', 'psi-stage-head');
      head.appendChild(UI.el('span', 'psi-stage-n', String(i + 1)));
      head.appendChild(UI.el('span', 'psi-stage-name', s.name));
      const st = STAGE_ST[s.status] || [s.status, '#F0F2F5', '#4C5564'];
      const stEl = UI.el('span', 'psi-stage-st', st[0]);
      stEl.style.background = st[1];
      stEl.style.color = st[2];
      head.appendChild(stEl);
      card.appendChild(head);

      const bar = UI.el('span', 'bar bar-8');
      const fill = UI.el('i');
      fill.style.width = s.progress_pct + '%';
      fill.style.background = s.status === 'finished' ? '#0E6F6C' : '#1D4E89';
      bar.appendChild(fill);
      card.appendChild(bar);

      const meta = UI.el('div', 'psi-stage-meta');
      meta.appendChild(metaItem('执行时长', s.duration_sec === null || s.duration_sec === undefined ? '—' : s.duration_sec + ' 秒'));
      meta.appendChild(metaItem('数据量', statsRows(s)));
      meta.appendChild(UI.el('span', null, statsExtra(s)));
      card.appendChild(meta);

      wrap.appendChild(card);
    });
  }

  function metaItem(label, value) {
    const span = UI.el('span', null, label + ' ');
    span.appendChild(UI.el('strong', null, value));
    return span;
  }

  function statsRows(s) {
    const st = s.stats || {};
    if (s.stage === 'intersect') {
      return st.left_rows ? UI.rows(st.left_rows) + ' ↔ ' + UI.rows(st.right_rows) : '—';
    }
    if (s.stage === 'align') {
      return st.rows ? UI.rows(st.rows) + '条 / ' + st.feature_dim + ' 维' : '—';
    }
    return st.rows ? UI.rows(st.rows) + '条' : '—';
  }

  function statsExtra(s) {
    const st = s.stats || {};
    if (s.progress_pct === 0) return '等待上一步完成';
    if (s.stage === 'intersect') return '交集 ' + UI.rows(st.intersection_rows) + '条';
    if (s.stage === 'align') return '原始数据不出域';
    return '交由联邦学习模块执行';
  }

  function placeholderStages() {
    return [
      { stage: 'intersect', name: '安全求交', status: 'pending', progress_pct: 0, duration_sec: null, stats: {} },
      { stage: 'align', name: '特征对齐', status: 'pending', progress_pct: 0, duration_sec: null, stats: {} },
      { stage: 'train', name: '联合训练', status: 'pending', progress_pct: 0, duration_sec: null, stats: {} }
    ];
  }

  /* ---------- 生命周期 ---------- */

  let lastProject = null;

  async function mount(c) {
    ctx = c;
    if (lastProject !== c.projectId) {   // 换项目后清掉上一个项目的流水线展示
      if (sse) { sse.close(); sse = null; }
      pipeline = null;
      lastProject = c.projectId;
    }
    bindOnce();
    try {
      if (!protocols.length) {
        const res = await Promise.all([Api.get('/psi/protocols'), Api.get('/psi/parties')]);
        protocols = res[0].items;
        parties = res[1].items;
        protoDef(selected).params.forEach(function (pa) { paramValues[pa.key] = pa.value; });
        const pf = $('dsPartyFilter');
        parties.forEach(function (p) {
          const o = document.createElement('option');
          o.value = p.party_id; o.textContent = p.party_name;
          pf.appendChild(o);
        });
      }
      $('dsDetail').hidden = true;
      await loadDatasets();
      switchTab(tab);
      renderProtocols();
      renderParams();
      renderRunNote();
      render();
    } catch (e) { UI.fail(e); }
  }

  function unmount() {
    if (sse) { sse.close(); sse = null; }
    clearTimeout(pollTimer);
  }

  window.PSI = { mount: mount, unmount: unmount };
})();
