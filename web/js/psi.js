/**
 * 隐私求交 · 数据接入（opts.sub = data）与平台集成（opts.sub = pipe）。接口见 API.md §5、docs/api/psi.md。
 * 协议与参数在算法配置页（PSIA）维护，这里只读取「当前配置」或已保存模板来启动流水线。
 */
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
  const CSV_PARSE_MAX_BYTES = 256 * 1048576;   // 超过此大小不在浏览器里读全文件，改由后端按文件大小估算行数
  const COL_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /**
   * 解析 CSV 文本：首行为表头，其余非空行计为数据行；列类型按前 200 行推断（int / float / date / string）。
   * 返回 { row_count, columns, sample }（sample 为前 3 行原始值，供节点侧脱敏预览）或 { error }。不处理引号内换行。
   */
  function csvProfile(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return { error: '文件为空，至少需要表头行' };
    const split = function (l) { return l.split(',').map(function (x) { return x.trim().replace(/^"(.*)"$/, '$1'); }); };
    const head = split(lines[0]);
    const badName = head.filter(function (h) { return !COL_RX.test(h); })[0];
    if (badName !== undefined) return { error: '表头列名「' + badName + '」不合法，列名只能用英文字母、数字和下划线，且不以数字开头' };
    if (head.some(function (h, i) { return head.indexOf(h) !== i; })) return { error: '表头有重复列名' };
    const sample = lines.slice(1, 201).map(split);
    const columns = head.map(function (name, i) {
      const vals = sample.map(function (r) { return r[i]; }).filter(function (v) { return v !== undefined && v !== ''; });
      let type = 'string';
      if (vals.length && vals.every(function (v) { return /^-?\d+$/.test(v); })) type = 'int';
      else if (vals.length && vals.every(function (v) { return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v); })) type = 'float';
      else if (vals.length && vals.every(function (v) { return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v); })) type = 'date';
      return { name: name, type: type };
    });
    return { row_count: lines.length - 1, columns: columns, sample: lines.slice(1, 4).map(split) };
  }

  /** 行数展示：文件来源且后端按文件大小估算时标注「估算」。 */
  function rowsText(d) {
    if (d.row_count === null || d.row_count === undefined) return '—';
    const est = d.source && d.source.row_count_basis === 'size_estimate';
    return (est ? '约 ' : '') + UI.rows(d.row_count) + (est ? '（估算）' : '');
  }

  let ctx = null;
  let protocols = [];
  let parties = [];          // GET /psi/parties
  let datasets = [];         // 当前项目已登记数据集
  let tab = 'data';
  let pollTimer = null;
  let config = null;         // GET /projects/{id}/psi/config（算法配置页保存的当前配置）
  let templates = [];
  let pipeline = null;
  let sse = null;
  let booted = false;

  function protoDef(k) { return protocols.filter(function (p) { return p.protocol === k; })[0]; }

  function bindOnce() {
    if (booted) return;
    booted = true;
    $('psiRun').addEventListener('click', run);
    $('psiPipeReset').addEventListener('click', cancel);
    $('psiCfgSel').addEventListener('change', renderConfig);
    $('psiGoFed').addEventListener('click', function () {
      window.App.go('fed', { sub: 'proc', focusJobId: pipeline && pipeline.fl_job_id });
    });
    $('psiToData').addEventListener('click', function () { window.App.go('psi', { sub: 'data' }); });
    $('psiToAlgo').addEventListener('click', function () { window.App.go('psi', { sub: 'algo' }); });
    $('dsNew').addEventListener('click', openImport);
    $('dsPartyFilter').addEventListener('change', renderDatasets);
    $('dsDetailClose').addEventListener('click', function () { $('dsDetail').hidden = true; });
    ['psiDsA', 'psiDsB'].forEach(function (id, i) {
      $(id).addEventListener('change', function () { renderKeySel(i); renderDsNote(); });
    });
    ['psiKeyA', 'psiKeyB'].forEach(function (id) { $(id).addEventListener('change', renderDsNote); });
  }

  /** 数据接入与求交流水线分属两个二级页面（screen-psi-data / screen-psi-pipe），由 App 路由切换。 */
  function switchTab(name) {
    tab = name;
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
      row.appendChild(UI.el('span', 'cell-muted', rowsText(d)));
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
      const basis = d.source && d.source.row_count_basis;
      $('dsDetailMeta').textContent = d.party_name + ' · ' + SRC_CN[d.source_type] + ' · ' + rowsText(d) + ' 行' +
        (basis === 'parsed' ? '（按上传文件实际解析）' : (basis === 'size_estimate' ? '（按文件大小 ÷ 64 字节 / 行估算）' : '')) +
        ' · 特征 ' + d.feature_count + ' 列';
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
      if (!d.preview.length) {
        const tr = UI.el('tr');
        const td = UI.el('td', 'hint', d.preview_note || '无样例');
        tr.appendChild(td);
        tb.appendChild(tr);
      } else {
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

  function removeDataset(d) {
    const body = UI.el('div', 'hint', '删除数据集「' + d.name + '」的登记信息？参与方本地数据不受影响；被运行中的求交流水线使用时不允许删除。');
    UI.modal({
      title: '删除数据集', body: body, submitText: '删除', width: 460,
      onSubmit: async function () {
        await Api.del('/datasets/' + d.dataset_id);   // 40901 时错误留在弹窗底部
        UI.toast('已删除 ' + d.name);
        $('dsDetail').hidden = true;
        await loadDatasets();
      }
    });
  }

  function openImport() {
    let fileId = null, fileName = null, profile = null;
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
      fileId = null; profile = null;
      const file = fileIn.files[0];
      if (!file) return;
      try {
        // 先在本地解析 CSV 表头与行数，表头不合法时不上传
        let parseNote = '';
        if (/\.csv$/i.test(file.name) && file.size <= CSV_PARSE_MAX_BYTES) {
          profile = csvProfile(await file.text());
          if (profile.error) { fileNote.textContent = profile.error; profile = null; fileIn.value = ''; return; }
          parseNote = ' · 解析得到 ' + UI.rows(profile.row_count) + ' 行 × ' + profile.columns.length + ' 列（表头：' +
            profile.columns.map(function (c) { return c.name; }).join('、') + '）';
          const names = profile.columns.map(function (c) { return c.name; });
          if (names.indexOf($('diKey').value.trim()) < 0) {
            $('diKey').value = names.filter(function (n) { return /hash|_id$|^id$/i.test(n); })[0] || names[0];
          }
        } else {
          parseNote = ' · 浏览器不解析' + (/\.csv$/i.test(file.name) ? '超过 256 MB 的 CSV' : ' Parquet') + '，行数将按文件大小估算';
        }
        fileNote.textContent = '上传中…';
        const f = await Api.upload('/files', file, { purpose: 'dataset', project_id: ctx.projectId });
        fileId = f.file_id; fileName = f.file_name;
        fileNote.textContent = '已上传 ' + f.file_name + '（' + UI.bytes(f.size_bytes) + '）' + parseNote;
      } catch (e) { fileNote.textContent = e.message; }
    });

    const two2 = UI.el('div', 'form-2col');
    two2.appendChild(UI.formRow('求交键列', UI.inputOf('diKey', 'credit_code_hash'), '已做哈希的统一社会信用代码列'));
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
        if (type === 'file' && profile) {
          // 求交键按字符串、时间列按日期登记，其余列沿用推断类型
          req.row_count = profile.row_count;
          req.columns = profile.columns.map(function (c) {
            return { name: c.name, type: c.name === req.id_column ? 'string' : (c.name === t ? 'date' : c.type) };
          });
          // 前 3 行原始值随文件留在本参与方节点，由节点按列类型脱敏后给详情预览
          req.sample_rows = profile.sample.map(function (r) {
            return profile.columns.map(function (c, i) { return r[i] === undefined ? '' : r[i]; });
          });
        }
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
        const est = d.source && d.source.row_count_basis === 'size_estimate';
        o.value = d.dataset_id; o.textContent = d.name + '（' + (est ? '约 ' : '') + UI.rows(d.row_count) + ' 行' + (est ? '，估算' : '') + '）';
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

  /* ---------- 求交配置（来自算法配置页） ---------- */

  async function loadConfig() {
    const res = await Promise.all([
      Api.get('/projects/' + ctx.projectId + '/psi/config'),
      Api.get('/projects/' + ctx.projectId + '/psi/templates')
    ]);
    config = res[0];
    templates = res[1].items;
    const sel = $('psiCfgSel');
    const keep = sel.value;
    UI.clear(sel);
    const cur = document.createElement('option');
    cur.value = ''; cur.textContent = '当前算法配置（' + protoDef(config.protocol).name + '）';
    sel.appendChild(cur);
    templates.forEach(function (t) {
      const o = document.createElement('option');
      o.value = t.template_id; o.textContent = '模板：' + t.name;
      sel.appendChild(o);
    });
    sel.value = templates.some(function (t) { return t.template_id === keep; }) ? keep : '';
    renderConfig();
  }

  /** 流水线将使用的 { protocol, params, template_id }。 */
  function chosenConfig() {
    const tid = $('psiCfgSel').value;
    const tpl = templates.filter(function (t) { return t.template_id === tid; })[0];
    if (tpl) return { protocol: tpl.protocol, params: tpl.params, template_id: tpl.template_id, label: '模板「' + tpl.name + '」' };
    return { protocol: config.protocol, params: config.params, template_id: config.template_id, label: '当前算法配置' };
  }

  function renderConfig() {
    const c = chosenConfig();
    const def = protoDef(c.protocol);
    $('psiCfgName').textContent = def.name;
    $('psiCfgSec').textContent = def.security ? def.security.security_bits + ' 位计算安全' : '—';
    const list = $('psiCfgParams');
    UI.clear(list);
    const rows = window.PSIA ? window.PSIA.summary(def, c.params)
      : def.params.map(function (pa) { return { label: pa.label, text: String(c.params[pa.key]) }; });
    rows.forEach(function (r) {
      const row = UI.el('div', 'psi-cfg-row');
      row.appendChild(UI.el('span', null, r.label));
      row.appendChild(UI.el('span', null, r.text));
      list.appendChild(row);
    });
    $('psiCfgNote').textContent = $('psiCfgSel').value
      ? '使用已保存模板启动，不改变算法配置页的当前配置'
      : (config.updated_at ? '算法配置页保存于 ' + UI.datetime(config.updated_at) : '算法配置页尚未保存，使用协议默认参数');
    renderRunNote();
  }

  function renderRunNote() {
    const c = chosenConfig();
    let text = protoDef(c.protocol).name + ' · ' + c.label + ' · 求交结果直接作为联邦学习的数据准备步骤';
    if (pipeline && pipeline.status !== 'canceled') {
      const total = pipeline.stages.reduce(function (s, x) { return s + (x.duration_sec || 0); }, 0);
      text = '流水线 ' + pipeline.pipeline_id + ' · ' + protoDef(pipeline.protocol).name + ' · 各阶段执行时长合计 ' + UI.duration(total);
    }
    $('psiRunNote').textContent = text;
  }

  /* ---------- 流水线 ---------- */

  async function run() {
    try {
      $('psiRun').disabled = true;
      const projNodes = (await Api.get('/projects/' + ctx.projectId + '/nodes')).items;
      const c = chosenConfig();
      const req = {
        protocol: c.protocol,
        params: c.params,
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
      };
      if (c.template_id) req.template_id = c.template_id;
      pipeline = await Api.post('/projects/' + ctx.projectId + '/psi/pipelines', req);
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
        renderRunNote();
      },
      pipeline_finished: function (ev) {
        pipeline.status = ev.status;
        pipeline.fl_job_id = ev.fl_job_id;
        pipeline.target_project = ev.target_project;
        pipeline.error = ev.error || null;
        render();
      }
    });
  }

  function render() {
    const running = pipeline && pipeline.status === 'running';
    const finished = pipeline && pipeline.status === 'finished';
    $('psiRun').disabled = running;
    const failed = pipeline && pipeline.status === 'failed';
    $('psiRun').textContent = running ? '执行中…' : (finished || failed ? '重新执行' : '一键启动');
    $('psiFail').hidden = !failed;
    if (failed) {
      const st = pipeline.stages.filter(function (x) { return x.status === 'failed'; })[0];
      $('psiFailText').textContent = '流水线在' + (st ? st.name : '执行') + '阶段失败：' + (pipeline.error || '未返回原因');
    }
    $('psiPipeReset').disabled = !pipeline || pipeline.status === 'canceled';
    renderStages();
    renderRunNote();
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
    const stages = pipeline && pipeline.status !== 'canceled' ? pipeline.stages : placeholderStages();
    stages.forEach(function (s, i) {
      const cls = s.status === 'finished' ? 'psi-stage done' : (s.status === 'running' ? 'psi-stage on' : (s.status === 'failed' ? 'psi-stage fail' : 'psi-stage'));
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
      fill.style.background = s.status === 'finished' ? 'var(--teal)' : (s.status === 'failed' ? 'var(--danger)' : 'var(--primary)');
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
    if (s.status === 'skipped') return '上一阶段失败，未执行';
    if (s.progress_pct === 0) return '等待上一步完成';
    if (s.stage === 'intersect') return '交集 ' + UI.rows(st.intersection_rows) + '条 · ' + protoDef(pipeline.protocol).name;
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

  /** 回到平台集成页时恢复本项目最近一条流水线（运行中则重新订阅进度）。 */
  async function resumePipeline() {
    if (pipeline) pipeline = await Api.get('/psi/pipelines/' + pipeline.pipeline_id);
    else {
      const items = (await Api.get('/projects/' + ctx.projectId + '/psi/pipelines')).items;
      const last = items[items.length - 1];
      pipeline = last && last.status !== 'canceled' ? last : null;
    }
    if (pipeline && pipeline.status === 'running') listen();
  }

  async function mount(c, el, opts) {
    ctx = c;
    tab = (opts && opts.sub) || 'data';
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
      if (tab === 'pipe') {
        await loadConfig();
        await resumePipeline();
        render();
      }
    } catch (e) { UI.fail(e); }
  }

  function unmount() {
    if (sse) { sse.close(); sse = null; }
    clearTimeout(pollTimer);
  }

  window.PSI = { mount: mount, unmount: unmount, csvProfile: csvProfile };
})();
