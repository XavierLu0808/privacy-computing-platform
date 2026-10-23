/**
 * 多方安全计算 / 运维监控（#/mpc/ops）。接口见 API.md §4 与 docs/api/mpc.md。
 * 每方通信量（MPC-OPS-01）、计算耗时（02）、轮次交互数（03）、异常节点检测（04）、历史任务查询 / 对比 / 导出（05）。
 * opts.taskId 由协议管理页创建任务后传入；未传时监控最近一个执行中的任务，没有则取最近结束的任务。
 * 首次 mount 时用 JS 重建本 section 的 DOM（index.html 里的静态骨架会被替换）。
 */
(function () {
  'use strict';
  const $ = UI.$;
  const el = UI.el;

  const PROTO_CN = { ss: '秘密共享', gc: '混淆电路', ot: '不经意传输扩展' };
  const ROLE_CN = { input: '输入方', compute: '计算方', output: '输出方' };
  const TASK_ST = { pending: '待执行', running: '执行中', stopped: '已停止', finished: '已结束', failed: '失败' };
  const PARTY_ST = { pending: '待执行', running: '执行中', stopped: '已停止', finished: '已结束', abnormal: '异常' };

  let ctx = null;
  let root = null;
  let gen = 0;
  let task = null;
  let tasks = [];
  let sse = null;
  let picked = [];          // 历史对比勾选的 task_id（最多 2 个）
  let cmpData = null;
  let flashTimer = null;
  let flashPid = null;      // 「定位节点」高亮的参与方，跨心跳重绘保留 1.6 秒
  const F = { protocol: '', start: '', end: '' };

  function btn(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function sec(v) { return v > 0 && v < 0.01 ? '< 0.01 秒' : (v < 10 ? Number(v).toFixed(2) : Number(v).toFixed(1)) + ' 秒'; }
  function pct(v) { return (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%'; }
  function num(v) { return Number(v).toLocaleString('zh-CN'); }
  function protos(list) { return list.map(function (p) { return PROTO_CN[p] || p; }).join(' + '); }

  /* ---------- 骨架 ---------- */

  function skeleton() {
    UI.clear(root);
    const head = el('div', 'page-head');
    const ht = el('div', 'page-head-text');
    ht.appendChild(el('span', 'crumb', '多方安全计算 / 运维监控'));
    ht.appendChild(el('h1', null, '协议执行监控'));
    head.appendChild(ht);
    const f = el('div', 'field');
    const lb = el('label', 'field-label', '监控任务');
    lb.htmlFor = 'mpcTaskSel';
    f.appendChild(lb);
    const sel = el('select', 'select select-lg mpc-task-sel');
    sel.id = 'mpcTaskSel';
    sel.addEventListener('change', function () { openTask(sel.value); });
    f.appendChild(sel);
    head.appendChild(f);
    const run = btn('btn-primary', '开始执行', onRun);
    run.id = 'mpcRun';
    head.appendChild(run);
    const reset = btn('btn', '重置', onReset);
    reset.id = 'mpcReset';
    head.appendChild(reset);
    head.appendChild(btn('btn-link', '新建任务', function () { App.go('mpc', { sub: 'proto' }); }));
    root.appendChild(head);

    const sum = el('div', 'card card-lg');
    sum.id = 'mpcSummary';
    sum.setAttribute('data-acc', 'MPC-OPS-01 MPC-OPS-02 MPC-OPS-03');
    root.appendChild(sum);

    const metrics = el('div', 'metric-grid');
    metrics.id = 'mpcMetrics';
    metrics.setAttribute('data-acc', 'MPC-OPS-01 MPC-OPS-02 MPC-OPS-03 MPC-OPS-04');
    root.appendChild(metrics);

    const alarm = el('div', 'mpc-alarm-wrap');
    alarm.id = 'mpcAlarmWrap';
    alarm.setAttribute('data-acc', 'MPC-OPS-04');
    root.appendChild(alarm);

    const parties = el('div', 'mpc-party-grid');
    parties.id = 'mpcParties';
    parties.setAttribute('data-acc', 'MPC-OPS-01 MPC-OPS-02 MPC-OPS-03 MPC-OPS-04');
    root.appendChild(parties);

    const hist = el('div', 'card card-lg');
    hist.id = 'mpcHistoryCard';
    hist.setAttribute('data-acc', 'MPC-OPS-05');
    root.appendChild(hist);
    renderHistoryShell();
  }

  /* ---------- 任务选择与控制 ---------- */

  async function loadTasks() {
    const res = await Api.get('/projects/' + ctx.projectId + '/mpc/tasks', { status: 'all', page_size: 100 });
    tasks = res.items;
    const sel = $('mpcTaskSel');
    UI.clear(sel);
    if (!tasks.length) {
      const o = el('option', null, '暂无任务');
      o.value = '';
      sel.appendChild(o);
    }
    tasks.forEach(function (t) {
      const o = el('option', null, t.task_id + ' · ' + (t.name || t.flow) + ' · ' + (TASK_ST[t.status] || t.status));
      o.value = t.task_id;
      sel.appendChild(o);
    });
    if (task) sel.value = task.task_id;
  }

  async function openTask(id) {
    if (sse) { sse.close(); sse = null; }
    const my = gen;
    if (!id) { task = null; render(); return; }
    try {
      const t = await Api.get('/mpc/tasks/' + id);
      if (my !== gen) return;
      task = t;
      $('mpcTaskSel').value = id;
      if (task.status !== 'finished') listen();
      render();
    } catch (e) { UI.fail(e); }
  }

  function listen() {
    if (sse) sse.close();
    const id = task.task_id;
    sse = Api.subscribe('/mpc/tasks/' + id + '/events', {
      metrics: function (ev) {
        if (!task || task.task_id !== id) return;
        task.parties = ev.parties;
        task.summary = ev.summary;
        task.progress_pct = ev.progress_pct;
        if (ev.alarms) task.alarms = ev.alarms;   // 告警文案里的累计值随心跳刷新
        renderBody();
      },
      alarm_raised: function (a) {
        if (!task || task.task_id !== id) return;
        if (!task.alarms.some(function (x) { return x.alarm_id === a.alarm_id; })) task.alarms.push(a);
        renderAlarm();
      },
      status_changed: async function (ev) {
        if (!task || task.task_id !== id) return;
        task.status = ev.status;
        if (ev.status === 'finished') {
          await openTask(id);
          await loadTasks();
          loadHistory();
        } else {
          render();
        }
      }
    });
  }

  async function onRun() {
    if (!task) return;
    const action = task.status === 'running' ? 'stop' : 'start';
    try {
      task = await Api.post('/mpc/tasks/' + task.task_id + '/actions', { action: action });
      if (action === 'start' && !sse) listen();
      render();
      loadTasks();
    } catch (e) { UI.fail(e); }
  }

  async function onReset() {
    if (!task) return;
    try {
      task = await Api.post('/mpc/tasks/' + task.task_id + '/actions', { action: 'reset' });
      if (!sse) listen();
      render();
      loadTasks();
    } catch (e) { UI.fail(e); }
  }

  function locate(pid) {
    const card = root.querySelector('.party[data-party="' + pid + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashPid = pid;
    card.classList.add('mpc-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashPid = null;
      const c = root.querySelector('.party.mpc-flash');
      if (c) c.classList.remove('mpc-flash');
    }, 1600);
    const p = task.parties.filter(function (x) { return x.party_id === pid; })[0];
    UI.toast('已定位到 ' + (p ? p.name + '（' + p.node_id + '）' : pid));
  }

  /* ---------- 渲染：当前任务 ---------- */

  function render() {
    const running = task && task.status === 'running';
    const started = task && task.progress_pct > 0;
    const run = $('mpcRun');
    run.textContent = !task ? '开始执行' : task.status === 'finished' ? '已结束' : running ? '停止执行' : (started ? '继续执行' : '开始执行');
    run.className = running ? 'btn-primary btn-danger' : 'btn-primary';
    run.disabled = !task || task.status === 'finished';
    $('mpcReset').disabled = !task || task.readonly || task.status === 'pending';
    renderSummary();
    renderBody();
  }

  function renderBody() {
    renderMetrics();
    renderAlarm();
    renderParties();
  }

  function renderSummary() {
    const box = $('mpcSummary');
    UI.clear(box);
    if (!task) {
      box.appendChild(el('div', 'table-empty', '本项目还没有 MPC 任务，请到「协议管理」编排计算流程并创建任务'));
      return;
    }
    const top = el('div', 'mpc-toolbar');
    top.appendChild(el('span', 'card-title', task.name || task.task_id));
    top.appendChild(el('span', 'hint', task.task_id));
    top.appendChild(el('span', 'mpc-st mpc-st-' + task.status, TASK_ST[task.status] || task.status));
    if (task.readonly) top.appendChild(el('span', 'tag', '历史任务（只读）'));
    top.appendChild(el('span', 'spacer'));
    top.appendChild(el('span', 'hint', '开始 ' + UI.datetime(task.started_at) + (task.finished_at ? ' · 结束 ' + UI.datetime(task.finished_at) : '')));
    box.appendChild(top);

    const flow = el('div', 'chip-row');
    flow.appendChild(el('span', 'hint', '计算流程'));
    task.steps.forEach(function (s, i) {
      if (i) flow.appendChild(el('span', 'hint-2', '→'));
      flow.appendChild(el('span', 'tag tag-cls', s.name + ' · ' + PROTO_CN[s.protocol]));
    });
    flow.appendChild(el('span', 'divider-v'));
    flow.appendChild(el('span', 'hint', task.parties.length + ' 方 · 每个输入方 ' + num(task.data_rows) + ' 行'));
    box.appendChild(flow);

    const prog = el('div', 'mpc-progress');
    prog.appendChild(el('span', 'hint', '执行进度'));
    const bar = el('span', 'bar bar-8');
    const fill = el('i');
    fill.id = 'mpcProgFill';
    bar.appendChild(fill);
    prog.appendChild(bar);
    const pv = el('strong', null, '');
    pv.id = 'mpcProgText';
    prog.appendChild(pv);
    box.appendChild(prog);
    box.appendChild(el('span', 'hint-2', '预估（来自协议管理页的性能预估模型）：计算 ' + sec(task.estimate.est_compute_sec) + '，通信 ' + sec(task.estimate.est_comm_sec) +
      '，通信量 ' + num(task.estimate.est_comm_mb) + ' MB，' + task.estimate.rounds + ' 轮。演示环境按该模型逐心跳推进指标。'));
  }

  function renderMetrics() {
    const g = $('mpcMetrics');
    UI.clear(g);
    const fill = $('mpcProgFill');
    if (fill && task) { fill.style.width = task.progress_pct + '%'; $('mpcProgText').textContent = task.progress_pct.toFixed(1) + '%'; }
    if (!task) return;
    const s = task.summary;
    const n = task.parties.length;
    g.appendChild(metric('总通信量', UI.bytes(s.total_comm_bytes), '各方累计发送之和；单方均值 ' + UI.bytes(s.mean_comm_bytes)));
    g.appendChild(metric('最长计算耗时', sec(s.max_compute_sec), '最慢一方的累计本地计算时间；各方均值 ' + sec(s.mean_compute_sec)));
    g.appendChild(metric('轮次交互数', s.interaction_rounds + ' 轮', '已完成的协议消息往返；预估共 ' + task.estimate.rounds + ' 轮'));
    const m = metric('异常节点', s.abnormal_parties + ' / ' + n + ' 方', '偏离全部参与方均值超过 ±' + task.anomaly_rule.threshold_pct + '% 判为异常');
    if (s.abnormal_parties) m.classList.add('mpc-metric-bad');
    g.appendChild(m);
  }

  function metric(name, value, sub) {
    const m = el('div', 'metric');
    m.appendChild(el('span', 'metric-name', name));
    m.appendChild(el('span', 'metric-value mpc-metric-value', value));
    m.appendChild(el('span', 'metric-sub', sub));
    return m;
  }

  function renderAlarm() {
    const wrap = $('mpcAlarmWrap');
    UI.clear(wrap);
    if (!task) return;
    task.alarms.forEach(function (a) {
      const b = el('div', 'banner banner-err');
      b.setAttribute('data-alarm', a.type);
      b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;" aria-hidden="true"><path d="M12 4.5 21 20H3z"></path><path d="M12 10.5v4M12 17.2v.5"></path></svg>';
      b.appendChild(el('span', 'spacer', a.message + '（' + UI.datetime(a.raised_at) + '）'));
      const loc = btn('btn-sm btn-kill', '定位节点', function () { locate(a.party_id); });
      b.appendChild(loc);
      wrap.appendChild(b);
    });
    const rule = el('div', 'banner-note');
    rule.appendChild(el('span', null, '异常判定规则：' + task.anomaly_rule.description + '。偏离率 = (本方累计值 − 全部参与方均值) / 全部参与方均值，通信量与计算耗时分别判定。'));
    wrap.appendChild(rule);
  }

  function renderParties() {
    const wrap = $('mpcParties');
    UI.clear(wrap);
    if (!task) return;
    const maxComm = Math.max.apply(null, task.parties.map(function (p) { return p.comm_bytes; }).concat([1]));
    const maxTime = Math.max.apply(null, task.parties.map(function (p) { return p.compute_sec; }).concat([0.001]));
    const thr = task.anomaly_rule.threshold_pct;
    task.parties.forEach(function (p) {
      const anom = p.status === 'abnormal';
      const card = el('div', 'party' + (anom ? ' anom' : '') + (flashPid === p.party_id ? ' mpc-flash' : ''));
      card.setAttribute('data-party', p.party_id);
      const head = el('div', 'party-head');
      head.appendChild(el('span', 'party-av', p.tag));
      const id = el('span', 'party-id');
      id.appendChild(el('span', 'party-name', p.name));
      id.appendChild(el('span', 'party-role', p.roles.map(function (r) { return ROLE_CN[r]; }).join(' / ')));
      id.appendChild(el('span', 'party-role', p.node_id + ' · ' + p.ip));
      head.appendChild(id);
      head.appendChild(el('span', 'mpc-st mpc-st-' + p.status, PARTY_ST[p.status] || p.status));
      card.appendChild(head);
      card.appendChild(statBlock('累计通信量', p.comm_bytes ? UI.bytes(p.comm_bytes) : '0 B', p.comm_bytes / maxComm * 100,
        p.comm_deviation_pct, Math.abs(p.comm_deviation_pct) > thr && anom));
      card.appendChild(statBlock('累计计算耗时', sec(p.compute_sec), p.compute_sec / maxTime * 100,
        p.compute_deviation_pct, Math.abs(p.compute_deviation_pct) > thr && anom));
      const rounds = el('div', 'party-rounds');
      rounds.appendChild(el('span', null, '轮次交互次数'));
      rounds.appendChild(el('strong', null, p.interaction_rounds + ' 轮'));
      card.appendChild(rounds);
      wrap.appendChild(card);
    });
  }

  function statBlock(name, value, width, dev, bad) {
    const block = el('div', 'party-stat');
    const head = el('div', 'party-stat-head');
    head.appendChild(el('span', null, name));
    head.appendChild(el('strong', null, value));
    block.appendChild(head);
    const bar = el('span', 'bar bar-6');
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, width || 0)) + '%';
    if (bad) fill.className = 'mpc-bar-bad';
    bar.appendChild(fill);
    block.appendChild(bar);
    block.appendChild(el('span', bad ? 'mpc-err-text' : 'hint-2', '偏离均值 ' + pct(dev)));
    return block;
  }

  /* ---------- 历史任务（OPS-05） ---------- */

  function renderHistoryShell() {
    const card = $('mpcHistoryCard');
    UI.clear(card);
    const top = el('div', 'mpc-toolbar');
    top.appendChild(el('span', 'card-title', '历史 MPC 任务'));
    top.appendChild(el('span', 'spacer'));
    const cmp = btn('btn', '对比所选（0 / 2）', onCompare);
    cmp.id = 'mpcCmpBtn';
    cmp.disabled = true;
    top.appendChild(cmp);
    const exp = btn('btn-link', '导出报表', onExport);
    exp.id = 'mpcExport';
    top.appendChild(exp);
    card.appendChild(top);

    const filt = el('div', 'mpc-toolbar');
    const ps = UI.selectOf('mpcFProto', [{ value: '', label: '全部协议' }, { value: 'ss', label: '秘密共享' }, { value: 'gc', label: '混淆电路' }, { value: 'ot', label: '不经意传输扩展' }], F.protocol);
    ps.className = 'select select-sm';
    filt.appendChild(labeled('协议', ps));
    const s = UI.inputOf('mpcFStart', F.start, 'date');
    s.className = 'input mpc-input-md';
    filt.appendChild(labeled('结束日期 从', s));
    const e = UI.inputOf('mpcFEnd', F.end, 'date');
    e.className = 'input mpc-input-md';
    filt.appendChild(labeled('至', e));
    filt.appendChild(btn('btn-sm', '查询', function () {
      F.protocol = ps.value; F.start = s.value; F.end = e.value;
      picked = []; cmpData = null;
      loadHistory();
    }));
    filt.appendChild(btn('btn-sm', '清空筛选', function () {
      F.protocol = ''; F.start = ''; F.end = '';
      ps.value = ''; s.value = ''; e.value = '';
      picked = []; cmpData = null;
      loadHistory();
    }));
    const cnt = el('span', 'hint');
    cnt.id = 'mpcHistCount';
    filt.appendChild(cnt);
    card.appendChild(filt);

    const head = el('div', 'table-head mpc-hist-grid');
    ['对比', '任务', '计算流程 / 协议', '参与方', '数据规模', '总通信量', '总耗时', '告警', '结束时间', ''].forEach(function (x) { head.appendChild(el('span', null, x)); });
    card.appendChild(head);
    const list = el('div');
    list.id = 'mpcHistory';
    card.appendChild(list);
    const cmpBox = el('div', 'mpc-cmp');
    cmpBox.id = 'mpcCompare';
    cmpBox.hidden = true;
    card.appendChild(cmpBox);
  }

  function labeled(text, control) {
    const w = el('div', 'field');
    const lb = el('label', 'field-label', text);
    lb.htmlFor = control.id;
    w.appendChild(lb);
    w.appendChild(control);
    return w;
  }

  function query() {
    return { protocol: F.protocol, start_time: F.start, end_time: F.end, page_size: 100 };
  }

  async function loadHistory() {
    const my = gen;
    try {
      const res = await Api.get('/projects/' + ctx.projectId + '/mpc/tasks', query());
      if (my !== gen) return;
      const wrap = $('mpcHistory');
      UI.clear(wrap);
      $('mpcHistCount').textContent = '共 ' + res.total + ' 条（总耗时 = 最慢一方的计算 + 通信耗时）';
      if (!res.items.length) wrap.appendChild(el('div', 'table-empty', '没有符合条件的历史任务'));
      res.items.forEach(function (t) {
        const row = el('div', 'table-row mpc-hist-grid' + (task && task.task_id === t.task_id ? ' current' : ''));
        row.setAttribute('data-task', t.task_id);
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = picked.indexOf(t.task_id) >= 0;
        cb.setAttribute('aria-label', '选择 ' + t.task_id + ' 参与对比');
        cb.addEventListener('change', function () {
          if (cb.checked) {
            if (picked.length >= 2) { cb.checked = false; UI.toast('最多选择 2 个任务进行对比', true); return; }
            picked.push(t.task_id);
          } else {
            picked = picked.filter(function (x) { return x !== t.task_id; });
          }
          updateCmpBtn();
        });
        row.appendChild(cb);
        const idc = el('span', 'mpc-cell-2');
        idc.appendChild(el('span', 'cell-strong', t.name || t.task_id));
        idc.appendChild(el('span', 'hint-2', t.task_id));
        row.appendChild(idc);
        const fl = el('span', 'mpc-cell-2');
        fl.appendChild(el('span', 'cell-muted', t.flow));
        fl.appendChild(el('span', 'hint-2', protos(t.protocols)));
        row.appendChild(fl);
        row.appendChild(el('span', 'cell-muted', t.party_count + ' 方'));
        row.appendChild(el('span', 'cell-muted', UI.rows(t.data_rows) + ' 行'));
        row.appendChild(el('span', 'cell-muted', UI.bytes(t.total_comm_bytes)));
        row.appendChild(el('span', 'cell-muted', sec(t.total_duration_sec)));
        row.appendChild(el('span', t.alarm_count ? 'mpc-err-text' : 'cell-muted', t.alarm_count + ' 条'));
        row.appendChild(el('span', 'hint', UI.datetime(t.finished_at)));
        row.appendChild(btn('btn-sm', '查看', function () { openTask(t.task_id).then(loadHistory); }));
        wrap.appendChild(row);
      });
      updateCmpBtn();
      renderCompare();
    } catch (e) { UI.fail(e); }
  }

  function updateCmpBtn() {
    const b = $('mpcCmpBtn');
    b.textContent = '对比所选（' + picked.length + ' / 2）';
    b.disabled = picked.length !== 2;
  }

  async function onCompare() {
    try {
      cmpData = await Api.get('/projects/' + ctx.projectId + '/mpc/tasks/compare', { task_ids: picked.join(',') });
      renderCompare();
      $('mpcCompare').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { UI.fail(e); }
  }

  function renderCompare() {
    const box = $('mpcCompare');
    UI.clear(box);
    box.hidden = !cmpData;
    if (!cmpData) return;
    const top = el('div', 'mpc-toolbar');
    top.appendChild(el('span', 'section-label', '任务对比'));
    top.appendChild(el('span', 'hint', '差异 = (任务 B − 任务 A) / 任务 A'));
    top.appendChild(el('span', 'spacer'));
    top.appendChild(btn('btn-link', '导出对比报表', function () { onExport(cmpData.tasks.map(function (t) { return t.task_id; })); }));
    top.appendChild(btn('btn-sm', '关闭', function () { cmpData = null; renderCompare(); }));
    box.appendChild(top);
    const head = el('div', 'table-head mpc-cmp-grid');
    head.appendChild(el('span', null, '指标'));
    cmpData.tasks.forEach(function (t, i) { head.appendChild(el('span', null, (i ? '任务 B：' : '任务 A：') + (t.name || t.task_id))); });
    head.appendChild(el('span', null, '差异'));
    head.appendChild(el('span', null, '说明'));
    box.appendChild(head);
    const flowRow = el('div', 'table-row mpc-cmp-grid');
    flowRow.appendChild(el('span', 'cell-strong', '计算流程'));
    cmpData.tasks.forEach(function (t) { flowRow.appendChild(el('span', 'cell-muted', t.flow + '（' + protos(t.protocols) + '）')); });
    flowRow.appendChild(el('span', 'hint-2', '—'));
    flowRow.appendChild(el('span', 'hint-2', ''));
    box.appendChild(flowRow);
    cmpData.metrics.forEach(function (m) {
      const row = el('div', 'table-row mpc-cmp-grid');
      row.setAttribute('data-metric', m.key);
      row.appendChild(el('span', 'cell-strong', m.label));
      m.values.forEach(function (v) { row.appendChild(el('span', null, num(v) + ' ' + m.unit)); });
      row.appendChild(el('span', m.diff_pct > 0 ? 'mpc-up' : (m.diff_pct < 0 ? 'mpc-down' : 'hint-2'), m.diff_pct === null ? '—' : pct(m.diff_pct)));
      row.appendChild(el('span', 'hint', m.note));
      box.appendChild(row);
    });
  }

  async function onExport(ids) {
    const q = Object.assign({ format: 'csv' }, query());
    delete q.page_size;
    if (Array.isArray(ids)) q.task_ids = ids.join(',');
    try {
      const name = await Api.download('/projects/' + ctx.projectId + '/mpc/reports/export', { query: q });
      UI.toast(name ? '已导出 ' + name : '已在新窗口打开导出链接');
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c, section, opts) {
    ctx = c;
    root = section;
    gen += 1;
    const my = gen;
    if (sse) { sse.close(); sse = null; }
    task = null;
    picked = [];
    cmpData = null;
    if (!root.getAttribute('data-mpc-built')) {
      skeleton();
      root.setAttribute('data-mpc-built', '1');
    }
    try {
      await loadTasks();
      if (my !== gen) return;
      const want = opts && opts.taskId;
      const running = tasks.filter(function (t) { return t.status === 'running'; })[0];
      const target = want || (running || tasks[0] || {}).task_id;
      await openTask(target);
      if (my !== gen) return;
      if (!target) render();
      loadHistory();
    } catch (e) { UI.fail(e); }
  }

  function unmount() {
    gen += 1;
    if (sse) { sse.close(); sse = null; }
    clearTimeout(flashTimer);
    flashPid = null;
  }

  window.MPC = { mount: mount, unmount: unmount };
})();
