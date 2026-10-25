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
  // 曲线配色取 styles.css 的 :root token（全局用 --primary，节点依次用下列 token）
  const NODE_TOKENS = ['--primary-lt', '--teal', '--amber', '--success', '--muted-3', '--danger'];
  let charts = [];       // 两张 ECharts 实例：metrics_spec[0] / [1]
  let chartObs = null;   // ResizeObserver：窗口缩放、页面显隐时 resize

  let ctx = null;        // { projectId }
  let taskTypes = [];    // GET /fl/task-types
  let jobs = [];         // 当前项目的任务列表（最新在前）
  let job = null;        // 当前查看的任务详情
  let series = {};       // key -> { label, points: [{round, <metric>...}] }
  let nodes = [];
  let sse = null;
  let booted = false;
  let active = false, projectEpoch = 0, selectionEpoch = 0, selectedJobId = null;
  let jobsRequest = 0, nodesRequest = 0, metricsRequest = 0, detailRequest = 0, historyRequest = 0;

  function projectToken() { return { epoch: projectEpoch, projectId: ctx && ctx.projectId }; }
  function projectCurrent(t) { return active && t.epoch === projectEpoch && ctx && t.projectId === ctx.projectId; }
  function selectionToken() { return Object.assign(projectToken(), { selection: selectionEpoch, jobId: selectedJobId }); }
  function selectionCurrent(t) { return projectCurrent(t) && t.selection === selectionEpoch && t.jobId === selectedJobId; }
  function closeStream() { if (sse) { sse.close(); sse = null; } }

  function clearHistory() {
    historyRequest++;
    UI.clear($('flHqRows')); $('flHqCount').textContent = '';
  }

  function clearDetails(message) {
    job = null; nodes = []; series = {};
    disableControls();
    $('flJobName').textContent = message || '当前项目暂无训练任务';
    $('flBadgeText').textContent = '未选择任务';
    $('flBadge').style.background = '#F0F2F5'; $('flBadge').style.color = '#4C5564';
    ['flJobType', 'flJobMeta', 'flAggNote', 'flCkpt', 'flRuntimeScope', 'flEtaNote', 'flChartHint'].forEach(function (id) { $(id).textContent = ''; });
    ['flM1Name', 'flM2Name', 'flM1Better', 'flM2Better', 'flLoss', 'flAcc', 'flLossPrev', 'flAccPrev',
      'flTotalRounds', 'flEta', 'flElapsed', 'flC1Label', 'flC2Label'].forEach(function (id) { $(id).textContent = '—'; });
    $('flRound').textContent = '0'; $('flProgress').style.width = '0%';
    ['flStates', 'flStateInfo', 'flWorkers', 'flNodes', 'flAlgo'].forEach(function (id) { UI.clear($(id)); });
    $('flAgg').value = ''; $('flViewKey').hidden = true;
    renderCharts(); charts.forEach(function (c) { c.__flSig = null; });
    clearHistory();
  }

  function clearSelection(message) {
    selectionEpoch++; selectedJobId = null; closeStream();
    if (booted) clearDetails(message);
    else { job = null; nodes = []; series = {}; }
  }

  /** 注册算法 / 自定义模型的任务 algorithm 为 custom，真实名称与版本在 algo_ref_name（后端任务投影返回）。 */
  function algoLabel(j) { return j.algo_ref_name || ALGO_CN[j.algorithm] || j.algorithm; }

  function typeDef(t) { return taskTypes.filter(function (x) { return x.task_type === t; })[0]; }
  function spec() { return job.metrics_spec; }

  function bindOnce() {
    if (booted) return;
    booted = true;

    ['flStart:start', 'flPause:pause', 'flResume:resume', 'flKill:terminate', 'flReset:reset']
      .forEach(function (pair) {
        const parts = pair.split(':');
        $(parts[0]).addEventListener('click', function () { parts[1] === 'terminate' ? confirmTerminate() : action(parts[1]); });
      });

    $('flAlgo').addEventListener('change', function () { patch({ algorithm: $('flAlgo').value }); });
    $('flAgg').addEventListener('change', function () { patch({ aggregation: $('flAgg').value }); });
    $('flView').addEventListener('change', function () { charts.forEach(hideTips); loadMetrics().catch(UI.fail); });
    $('flExport').addEventListener('click', exportCsv);
    $('flViewKey').addEventListener('click', viewKey);
    $('flAddNode').addEventListener('click', addNode);
    $('flNewJob').addEventListener('click', openCreate);
    $('flTypeFilter').addEventListener('change', renderJobs);
    buildProcBlocks();
  }

  /* ---------- 过程管控补充块（FL-PROC-01 至 08）：状态迁移、运行资源与断点、ETA 说明、历史指标查询 ---------- */

  const ACTION_CN = { create: '创建', start: '启动训练', pause: '暂停', resume: '恢复', terminate: '强制终止', reset: '重置', complete: '跑完全部轮次', fail: '异常失败' };
  const WORKER_CN = { running: ['运行中', 'st-importing'], suspended: ['已挂起（断点已保存）', 'cell-muted'], killed: ['已强制结束 · 资源已释放', 'st-failed'], completed: ['已完成 · 资源已释放', 'st-ready'], failed: ['异常退出 · 资源已释放', 'st-failed'] };

  function buildProcBlocks() {
    const screen = $('screen-fed-proc');
    const stateCard = $('flStates').parentNode;
    stateCard.dataset.acc = 'FL-PROC-01';
    stateCard.appendChild(UI.el('div', 'fl-state-info'));
    stateCard.lastChild.id = 'flStateInfo';
    const ctl = $('flStart').parentNode;
    ctl.dataset.acc = 'FL-PROC-01 FL-PROC-02 FL-PROC-03 FL-PROC-04';

    const rt = UI.el('div', 'card card-lg');
    rt.dataset.acc = 'FL-PROC-02 FL-PROC-03 FL-PROC-04';
    rt.innerHTML = '<div class="fl-proc-head"><span class="card-title">运行资源与断点</span>' +
      '<span class="hint">启动前校验项目配置、节点可用性与算法兼容性；当前真实训练由共享执行器承载，资源与隔离范围以运行信息为准。暂停等待断点保存，终止等待执行器确认清理与资源释放</span></div>' +
      '<div id="flRuntimeScope" class="hint"></div>' +
      '<div class="table-head fl-rt-grid"><span>节点</span><span>角色</span><span>容器 ID</span><span>进程 PID</span><span>CPU / 内存</span><span>状态</span></div>' +
      '<div id="flWorkers"></div><div id="flCkpt" class="fl-ckpt"></div>';
    ctl.parentNode.insertBefore(rt, ctl.nextSibling);

    const etaCard = $('flEta').parentNode;
    etaCard.title = '剩余时间 = 平滑后的每轮耗时 ×（总轮次 − 已完成轮次）；平滑公式 sᵣ = α·dᵣ + (1 − α)·sᵣ₋₁，α = 0.3';
    etaCard.dataset.acc = 'FL-PROC-07';
    const sub = etaCard.querySelector('.metric-sub');
    UI.clear(sub);
    sub.appendChild(document.createTextNode('已用 '));
    const el = UI.el('span', null, '0 秒');
    sub.appendChild(el);
    sub.appendChild(document.createTextNode(' · '));
    sub.appendChild(UI.el('span', null, '平滑滤波预测'));
    sub.lastChild.id = 'flEtaNote';
    el.id = 'flElapsed';   // 原 #flElapsed 已随 UI.clear 移除

    $('flView').closest('.card').dataset.acc = 'FL-PROC-05 FL-PROC-06';
    // 收敛曲线改用 ECharts：用两个容器替换原 SVG
    ['flLossLines', 'flAccLines'].forEach(function (id, i) {
      const svg = $(id).closest('svg');
      const box = UI.el('div', 'fl-chart');
      box.id = 'flChart' + (i + 1);
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', svg.getAttribute('aria-label'));
      svg.parentNode.replaceChild(box, svg);
    });
    $('flRound').closest('.metric').dataset.acc = 'FL-PROC-05';

    const hq = UI.el('div', 'card card-lg');
    hq.dataset.acc = 'FL-PROC-08';
    hq.innerHTML = '<div class="fl-proc-head"><span class="card-title">历史指标查询</span><span class="hint">按项目 ID、任务或写入时间范围查询每轮聚合后存储的全局 / 节点指标，结果可导出 CSV</span></div>' +
      '<div class="fl-proc-head fl-wrap">' +
      '<div class="field"><label class="field-label" for="flHqScope">范围</label><select class="select select-sm" id="flHqScope"><option value="job">当前任务</option><option value="project">当前项目全部任务</option><option value="all">全部项目</option></select></div>' +
      '<div class="field"><label class="field-label" for="flHqFrom">开始时间</label><input class="input fl-dt" type="datetime-local" id="flHqFrom"></div>' +
      '<div class="field"><label class="field-label" for="flHqTo">结束时间</label><input class="input fl-dt" type="datetime-local" id="flHqTo"></div>' +
      '<div class="field"><label class="field-label" for="flHqSeries">曲线</label><select class="select select-sm" id="flHqSeries"><option value="global">仅全局</option><option value="nodes">全局 + 各节点</option></select></div>' +
      '<button type="button" class="btn-sm" id="flHqRun">查询</button><button type="button" class="btn-link" id="flHqExport">导出 CSV</button>' +
      '<span class="hint" id="flHqCount"></span></div>' +
      '<div class="table-head fl-hist-grid"><span>任务</span><span>轮次</span><span>曲线</span><span>Loss</span><span>Accuracy</span><span>RMSE</span><span>MAE</span><span>写入时间</span></div>' +
      '<div id="flHqRows"></div>';
    screen.appendChild(hq);
    $('flHqRun').addEventListener('click', queryHistory);
    $('flHqExport').addEventListener('click', exportHistory);
  }

  function historyQuery() {
    const q = { scope: $('flHqSeries').value };
    const sc = $('flHqScope').value;
    if (sc === 'job' && job) q.job_id = job.job_id;
    if (sc === 'project') q.project_id = ctx.projectId;
    const from = $('flHqFrom').value, to = $('flHqTo').value;
    if (from) q.start_time = new Date(from).toISOString();
    if (to) q.end_time = new Date(to).toISOString();
    return q;
  }

  async function queryHistory() {
    if (!active || !job) return;
    const token = selectionToken(), request = ++historyRequest;
    try {
      const res = await Api.get('/fl/metrics', Object.assign({ page_size: 50 }, historyQuery()));
      if (!selectionCurrent(token) || request !== historyRequest) return;
      $('flHqCount').textContent = '共 ' + res.total + ' 条（' + res.job_count + ' 个任务）' + (res.total > res.items.length ? '，下方显示前 ' + res.items.length + ' 条，完整数据请导出' : '');
      const wrap = $('flHqRows');
      UI.clear(wrap);
      if (!res.items.length) wrap.appendChild(UI.el('div', 'table-empty', '该条件下没有指标记录'));
      res.items.forEach(function (r) {
        const row = UI.el('div', 'table-row fl-hist-grid');
        const name = UI.el('span', 'cell-muted', r.job_name);
        name.title = r.job_id;
        name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        row.appendChild(name);
        row.appendChild(UI.el('span', 'cell-muted', String(r.round)));
        row.appendChild(UI.el('span', 'cell-muted', r.series === 'global' ? '全局' : r.series));
        ['loss', 'accuracy', 'rmse', 'mae'].forEach(function (k) { row.appendChild(UI.el('span', 'cell-muted', UI.fixed(r[k], 4))); });
        row.appendChild(UI.el('span', 'cell-muted', UI.datetime(r.recorded_at)));
        wrap.appendChild(row);
      });
    } catch (e) { if (selectionCurrent(token) && request === historyRequest) UI.fail(e); }
  }

  async function exportHistory() {
    if (!active || !job) return;
    const token = selectionToken();
    try {
      const q = historyQuery();
      const n = await Api.get('/fl/metrics', Object.assign({ page_size: 1 }, q));   // 先校验条件
      if (!selectionCurrent(token)) return;
      if (!n.total) { UI.toast('该条件下没有指标记录，未导出', true); return; }
      const name = await Api.download('/fl/metrics/export', { query: q });
      UI.toast('已导出 ' + (name || 'CSV') + '（' + n.total + ' 条）');
    } catch (e) { UI.fail(e); }
  }

  function renderProc() {
    const info = $('flStateInfo');
    if (!info) return;
    UI.clear(info);
    const allowed = job.allowed_actions || [];
    info.appendChild(UI.el('span', 'hint', '当前可执行：' + (allowed.length ? allowed.map(function (a) { return ACTION_CN[a]; }).join('、') : '无') +
      '。不允许的操作由后端拒绝（409 / 40901）。'));
    if (job.status === 'Failed' && job.failure_reason) info.appendChild(UI.el('div', 'banner banner-err', '失败原因：' + job.failure_reason + '。恢复节点后可重新启动训练。'));
    const hist = (job.state_history || []).slice(-6).reverse();
    if (hist.length) {
      const list = UI.el('div', 'fl-state-log');
      hist.forEach(function (h) {
        list.appendChild(UI.el('span', 'hint', UI.datetime(h.at) + ' · ' + (h.from ? h.from + ' → ' : '') + h.to + ' · ' + ACTION_CN[h.action] + ' · ' + h.operator + (h.reason ? ' · ' + h.reason : '')));
      });
      info.appendChild(list);
    }

    const wrap = $('flWorkers');
    UI.clear(wrap);
    const rt = job.runtime;
    $('flRuntimeScope').textContent = rt && rt.shared_executor
      ? '下列节点共用同一执行器；CPU / 内存是共享容器的资源上限，不能按节点累加。节点条目不代表独立容器或独立进程。'
      : '资源清单取自后端运行信息；未提供的容器、进程或资源数值显示为 —。';
    if (!rt) wrap.appendChild(UI.el('div', 'table-empty', '尚未分配训练容器，点击「启动训练」后完成预检并分配'));
    else rt.workers.forEach(function (w) {
      const row = UI.el('div', 'table-row fl-rt-grid');
      row.appendChild(UI.el('span', 'cell-strong', w.node_id));
      row.appendChild(UI.el('span', 'cell-muted', w.role === 'aggregator' ? '聚合' : '训练'));
      row.appendChild(UI.el('span', 'cell-muted fl-mono', w.container_id || '—'));
      row.appendChild(UI.el('span', 'cell-muted', w.pid == null ? '—' : String(w.pid)));
      row.appendChild(UI.el('span', 'cell-muted', (w.cpu_cores == null ? '—' : w.cpu_cores + ' 核') + ' / ' +
        (w.memory_mb == null ? '—' : (w.memory_mb / 1024) + ' GB')));
      const st = WORKER_CN[w.status] || [w.status, 'cell-muted'];
      row.appendChild(UI.el('span', st[1], st[0]));
      wrap.appendChild(row);
    });
    const ck = job.checkpoint;
    $('flCkpt').textContent = ck
      ? '最近断点：第 ' + ck.round + ' 轮 · ' + UI.datetime(ck.saved_at) + ' · ' + ck.path + ' · ' +
        (ck.hash_scope && ck.hash_scope.indexOf('complete_resume_artifact') === 0 ? '完整恢复制品 ' : '全局模型 ') + UI.bytes(ck.global_model_bytes) +
        '（SHA-256 ' + ck.global_model_sha256.slice(0, 12) + '…）· ' +
        (ck.optimizer_state_available === false ? '优化器状态未独立解析' : ck.optimizer_state) + ' · ' +
        (ck.node_cursors_available === false ? '节点数据读取位置未提供' : ck.node_cursors.length + ' 个训练节点的数据读取位置')
      : (rt ? '暂无已确认断点：执行器完成轮次并保存恢复制品后更新，恢复范围以该制品为准' : '');

    const e = job.eta;
    $('flEtaNote').textContent = e && e.ema_round_sec !== null
      ? 'EMA 平滑（α = ' + e.alpha + '）每轮 ' + e.ema_round_sec.toFixed(1) + ' 秒'
      : '平滑滤波预测（EMA，启动后按每轮耗时计算）';
  }

  /** PATCH 等更新接口的响应不含过程管控字段，沿用上一次的值。 */
  function keepProc(prev, next) {
    if (!prev || prev.job_id !== next.job_id) return next;
    const kernelOnly = next.eta === undefined;   // 不含平滑 ETA 的响应，已用时间与剩余时间也沿用
    ['algo_ref_name', 'algo_ref', 'params', 'allowed_actions', 'state_history', 'runtime', 'checkpoint', 'eta']
      .forEach(function (k) { if (next[k] === undefined) next[k] = prev[k]; });
    if (kernelOnly) { next.elapsed_sec = prev.elapsed_sec; next.eta_sec = prev.eta_sec; }
    return next;
  }

  /** 取平滑 ETA 参数（GET /fl/jobs/{id}/eta）；之后每轮的数值直接来自 SSE 推送。 */
  async function refreshEta() {
    if (!job) return;
    const token = selectionToken();
    const id = job.job_id;
    try {
      const e = await Api.get('/fl/jobs/' + id + '/eta');
      if (!selectionCurrent(token) || !job) return;
      job.elapsed_sec = e.elapsed_sec;
      job.eta_sec = e.eta_sec;
      job.eta = { method: e.method, alpha: e.alpha, ema_round_sec: e.ema_round_sec, avg_round_sec: e.avg_round_sec, eta_naive_sec: e.eta_naive_sec };
      $('flEta').textContent = e.eta_sec === null ? '—' : UI.duration(e.eta_sec);
      $('flElapsed').textContent = UI.duration(e.elapsed_sec);
      renderProc();
    } catch (err) { /* 后端未提供平滑 ETA 时保留 SSE 中的值 */ }
  }

  /** 没有选中任务（空项目或加载中）时控制按钮不可用。 */
  function disableControls() {
    ['flStart', 'flPause', 'flResume', 'flKill', 'flReset', 'flAlgo', 'flAgg', 'flExport', 'flView', 'flViewKey', 'flHqRun', 'flHqExport'].forEach(function (id) { $(id).disabled = true; });
  }

  /** 强制终止前二次确认：写清会丢弃的内容与保留的内容。 */
  function confirmTerminate() {
    if (!job) return;
    const token = selectionToken();
    const r = job.current_round;
    const ck = job.checkpoint;
    const body = UI.el('div', 'fl-confirm');
    body.appendChild(UI.el('div', 'banner banner-err', '终止请求由当前执行器处理；清理完成并确认后释放运行资源，不承诺每个节点有独立容器。' +
      (job.status === 'Running' ? '尚未提交的轮次结果不会计入已完成指标。' : '任务处于暂停状态，终止后不能再从断点恢复。')));
    body.appendChild(UI.el('span', 'hint', '保留：已完成轮次的全局与节点指标（打开本窗口时已完成 ' + r + ' 轮）' + (ck ? '、第 ' + ck.round + ' 轮断点文件' : '') +
      '。终止后任务进入 Terminated，只能从第 0 轮重新启动。'));
    const m = UI.modal({ title: '确认强制终止「' + job.name + '」', body: body, submitText: '确认终止', onSubmit: function () {
      if (!selectionCurrent(token)) throw new Error('当前任务已变更，请重新确认终止操作');
      return action('terminate');
    } });
    const btn = document.querySelector('.modal-mask:last-of-type .modal-foot .btn-primary');
    if (btn) btn.classList.add('btn-danger');
    return m;
  }

  async function action(name) {
    if (!job) return;
    const token = selectionToken(), request = ++detailRequest;
    try {
      const next = await Api.post('/fl/jobs/' + token.jobId + '/actions', { action: name });
      if (!selectionCurrent(token) || request !== detailRequest) return;
      job = next;
      if (name === 'start' || name === 'reset') { series = {}; renderCharts(); }
      if (name === 'start' && job.preflight) {
        UI.toast('启动校验通过（' + job.preflight.map(function (c) { return c.item; }).join('、') + '）；资源分配与训练状态以执行器确认结果为准');
      } else if (name === 'pause') {
        UI.toast(job.status === 'Paused' && job.checkpoint ? '已暂停，第 ' + job.checkpoint.round + ' 轮断点已保存' : '暂停请求已提交，等待执行器保存断点并确认暂停');
      } else if (name === 'resume' && job.resumed_from_round !== undefined) {
        UI.toast('已从第 ' + job.resumed_from_round + ' 轮断点继续训练');
      } else if (name === 'terminate') {
        UI.toast(job.status === 'Terminated' && job.runtime && job.runtime.released
          ? '已终止，执行器已确认资源释放' : '终止请求已提交，资源清理与释放以执行器确认结果为准');
      }
      syncListItem();
      render();
      await loadNodes(token);
    } catch (e) { if (selectionCurrent(token)) UI.fail(e); }
  }

  async function patch(body) {
    if (!job) return;
    const token = selectionToken(), request = ++detailRequest;
    try {
      const prev = job;
      const next = await Api.patch('/fl/jobs/' + token.jobId, body);
      if (!selectionCurrent(token) || request !== detailRequest) return;
      job = keepProc(prev, next);
      // algo_ref_name 只在算法未变时沿用
      if (job.algorithm !== prev.algorithm) job.algo_ref_name = null;
      syncListItem();
      render();
      UI.toast('配置已更新');
    } catch (e) {
      if (!selectionCurrent(token) || request !== detailRequest) return;
      UI.fail(e);
      render(); // 回滚下拉框到后端真实值
    }
  }

  async function exportCsv() {
    if (!job) return;
    try {
      const name = await Api.download('/fl/jobs/' + job.job_id + '/metrics/export', {
        query: { scope: $('flView').value === 'nodes' ? 'nodes' : 'global' }
      });
      UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  async function viewKey() {
    if (!job) return;
    const token = selectionToken();
    try {
      const k = await Api.get('/fl/jobs/' + job.job_id + '/he-public-key');
      if (!selectionCurrent(token)) return;
      UI.toast('公钥 ' + k.key_id + ' · ' + k.fingerprint);
    } catch (e) { if (selectionCurrent(token)) UI.fail(e); }
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
    if (!active) return;
    const token = projectToken(), projectId = token.projectId;
    let projNodes, datasets, pipelines, project, library;
    try {
      const r = await Promise.all([
        Api.get('/projects/' + projectId + '/nodes'),
        Api.get('/projects/' + projectId + '/datasets', { status: 'ready' }),
        Api.get('/projects/' + projectId + '/psi/pipelines', { status: 'finished' }),
        Api.get('/projects/' + projectId),
        Api.get('/fl/algorithms', { project_id: projectId })
      ]);
      if (!projectCurrent(token)) return;
      projNodes = r[0].items;
      datasets = r[1].items;
      pipelines = r[2].items.filter(function (p) { return p.status === 'finished'; });
      project = r[3];
      library = r[4].items;
    } catch (e) { if (projectCurrent(token)) UI.fail(e); return; }

    // 默认值取任务编排页的项目配置：任务类型跟随训练目标、基准模型、聚合轮数、聚合策略
    let taskType = project.target.task_type || 'classification';
    let modelFileId = null, uploadRequest = 0;
    const body = UI.el('div');
    const dialogCurrent = function () { return projectCurrent(token) && body.isConnected; };
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
        if (seq !== loadSeq || !dialogCurrent()) return;
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
      } catch (e) { if (seq === loadSeq && dialogCurrent()) UI.fail(e); }
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
      const request = ++uploadRequest, file = fileIn.files[0];
      modelFileId = null;
      fileNote.textContent = '支持 .py / .zip / .pt / .onnx';
      if (!file) return;
      try {
        fileNote.textContent = '上传中…';
        const f = await Api.upload('/files', file, { purpose: 'fl_model', project_id: projectId });
        if (!dialogCurrent() || request !== uploadRequest || fileIn.files[0] !== file) return;
        modelFileId = f.file_id;
        fileNote.textContent = '已上传 ' + f.file_name + '（' + f.file_id + ' · ' + UI.bytes(f.size_bytes) + '）';
      } catch (e) { if (dialogCurrent() && request === uploadRequest && fileIn.files[0] === file) fileNote.textContent = e.message; }
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
      // One source per party. For time series, use a common time column;
      // prefer the column shared by the most parties, breaking ties by API order.
      const columns = new Map();
      if (ts) shown.forEach(function (d) {
        if (!columns.has(d.time_column)) columns.set(d.time_column, new Set());
        columns.get(d.time_column).add(d.party_id);
      });
      let defaultTimeColumn = null, coverage = 0;
      columns.forEach(function (parties, column) {
        if (parties.size > coverage) { defaultTimeColumn = column; coverage = parties.size; }
      });
      const selectedParties = new Set();
      shown.forEach(function (d) {
        const row = UI.el('label', 'check-item');
        const cb = UI.el('input');
        cb.type = 'checkbox'; cb.value = d.dataset_id; cb.name = 'njDs';
        cb.checked = !selectedParties.has(d.party_id) && (!ts || d.time_column === defaultTimeColumn);
        if (cb.checked) selectedParties.add(d.party_id);
        cb.addEventListener('change', renderTimeCols);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(d.name));
        row.appendChild(UI.el('span', 'hint', d.party_name + ' · ' + UI.rows(d.row_count) + '行' + (d.time_column ? ' · 时间列 ' + d.time_column : '')));
        dsList.appendChild(row);
      });
      if (shown.length) dsList.appendChild(UI.el('span', 'hint', ts && coverage < 2
        ? '当前没有至少两方使用同一时间列的就绪数据集，请先登记兼容数据；可手动调整选择。'
        : '默认每个参与方选择第一份兼容数据集，可手动调整；时序数据默认使用同一时间列。'));
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
        if (!dialogCurrent()) throw new Error('项目上下文已变更，请关闭弹窗后重新创建任务');
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
        const created = await Api.post('/projects/' + projectId + '/fl/jobs', req);
        if (!dialogCurrent()) return;
        UI.toast('已创建任务「' + created.name + '」，点击「启动训练」开始');
        await loadJobs();
        if (!dialogCurrent()) return;
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

    const allowed = job.allowed_actions || {
      Created: ['start', 'reset'], Running: ['pause', 'terminate'],
      Paused: ['resume', 'terminate', 'reset'], Success: ['reset'],
      Failed: ['start', 'reset'], Terminated: ['start', 'reset']
    }[st] || [];
    $('flStart').disabled = allowed.indexOf('start') < 0;
    $('flPause').disabled = allowed.indexOf('pause') < 0;
    $('flResume').disabled = allowed.indexOf('resume') < 0;
    $('flKill').disabled = allowed.indexOf('terminate') < 0;
    $('flReset').disabled = allowed.indexOf('reset') < 0;
    $('flExport').disabled = false;
    ['flView', 'flViewKey', 'flHqRun', 'flHqExport'].forEach(function (id) { $(id).disabled = false; });

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
      ? '同态加密聚合 · ' + (info.he_key_ready ? '训练公钥已就绪' : '训练公钥待后端绑定')
      : (Number.isFinite(info.threshold) && Number.isFinite(info.share_count)
        ? '秘密共享聚合 · 门限 ' + info.threshold + ' / ' + info.share_count
        : '秘密共享聚合 · 等待执行器确认实际协议');
    $('flViewKey').hidden = info.type !== 'he';
    $('flViewKey').disabled = info.type !== 'he' || !info.he_key_ready;

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

    // 曲线标题（坐标轴由 ECharts 按 metrics_spec 绘制）
    ['flC1Label', 'flC2Label'].forEach(function (id, i) {
      const m = sp[i];
      $(id).textContent = m.label + '（纵轴 ' + m.y_min + ' – ' + m.y_max + '，横轴 轮次 1 – ' + job.total_rounds + '，' + (m.better === 'lower' ? '越低越好' : '越高越好') + '）';
    });

    renderProc();
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

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function ensureCharts() {
    if (charts.length || !window.echarts) return charts.length > 0;
    charts = ['flChart1', 'flChart2'].map(function (id) { return window.echarts.init($(id), null, { renderer: 'canvas' }); });
    if (window.ResizeObserver) {
      chartObs = new ResizeObserver(function () { charts.forEach(function (c) { c.resize(); }); });
      chartObs.observe($('flChart1').parentNode.parentNode);
    }
    return true;
  }

  function hideTips(c) {
    c.dispatchAction({ type: 'hideTip' });
    c.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
  }

  function disposeCharts() {
    if (chartObs) { chartObs.disconnect(); chartObs = null; }
    charts.forEach(function (c) { c.dispose(); });
    charts = [];
  }

  /** 单张图的 ECharts 配置：横轴轮次 1 – total_rounds，纵轴按 metrics_spec 的 y_min / y_max。 */
  function chartOption(m, lines) {
    const ink = token('--muted'), grid = token('--line-soft');
    const axisLabel = { color: ink, fontSize: 11 };
    return {
      animationDurationUpdate: 300,
      grid: { left: 52, right: 16, top: 16, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          // 节点名为 [a-z0-9-] 的节点 ID，标签为固定中文，无需转义
          return '第 ' + ps[0].value[0] + ' 轮 · ' + m.label + '<br>' + ps.map(function (p) {
            const v = p.value[1];
            return p.marker + p.seriesName + '：' + (v === null || v === undefined ? '—' : Number(v).toFixed(m.digits));
          }).join('<br>');
        },
        axisPointer: { type: 'line', lineStyle: { color: token('--primary-bd') } }
      },
      xAxis: {
        type: 'value', min: 1, max: job.total_rounds, minInterval: 1, name: '轮次', nameLocation: 'middle', nameGap: 24,
        nameTextStyle: { color: ink, fontSize: 11 }, axisLabel: axisLabel,
        axisLine: { lineStyle: { color: token('--line') } }, splitLine: { show: false }
      },
      yAxis: {
        type: 'value', min: m.y_min, max: m.y_max, axisLabel: axisLabel,
        splitLine: { lineStyle: { color: grid } }
      },
      series: lines.map(function (l) {
        return {
          name: l.label, type: 'line', showSymbol: l.points.length < 2, symbolSize: 5, smooth: false,
          lineStyle: { width: l.global ? 2.4 : 1.6, color: l.color }, itemStyle: { color: l.color },
          emphasis: { focus: 'series' },
          data: l.points.map(function (p) { return [p.round, p[m.key]]; })
        };
      })
    };
  }

  function renderCharts() {
    const keys = Object.keys(series);
    const legend = $('flLegend');
    UI.clear(legend);
    if (!job) { charts.forEach(function (c) { c.clear(); }); return; }
    const sp = spec();

    let nodeIdx = 0;
    const lines = keys.map(function (key) {
      const isGlobal = key === 'global';
      const color = isGlobal ? token('--primary') : token(NODE_TOKENS[nodeIdx++ % NODE_TOKENS.length]);
      return { label: series[key].label, points: series[key].points, color: color, global: isGlobal };
    });
    if (ensureCharts()) {
      const sig = keys.join('|') + '#' + job.job_id;
      charts.forEach(function (c, i) {
        if (c.__flSig !== sig) {
          // 曲线集合变化（切换「显示」或换任务）：先收起 tooltip / 坐标指示器，再整体替换，避免 tooltip 引用已删除的序列（D32）
          hideTips(c);
          c.clear();
          c.setOption(chartOption(sp[i], lines), true);
          c.__flSig = sig;
        } else {
          c.setOption(chartOption(sp[i], lines), { replaceMerge: ['series'] });
        }
      });
    }

    lines.forEach(function (l) {
      const item = UI.el('span', 'legend-item');
      const dot = UI.el('i');
      dot.style.background = l.color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(l.label));
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
      up.appendChild(UI.el('span', 'hint', n.round_upload_kb === null ? '—'
        : (n.role === 'aggregator' ? '下发全局参数 ' : '') + n.round_upload_kb.toFixed(1) + ' KB'));
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
    const token = projectToken(), request = ++jobsRequest;
    const res = await Api.get('/projects/' + token.projectId + '/fl/jobs');
    if (!projectCurrent(token) || request !== jobsRequest) return false;
    jobs = res.items;
    if (!jobs.length) clearSelection();
    renderJobs();
    return true;
  }

  async function loadMetrics(token) {
    token = token || selectionToken();
    if (!job || !selectionCurrent(token)) return;
    const scope = $('flView').value, request = ++metricsRequest;
    let res;
    try { res = await Api.get('/fl/jobs/' + token.jobId + '/metrics', { scope: scope }); }
    catch (e) { if (selectionCurrent(token) && request === metricsRequest) throw e; return; }
    if (!selectionCurrent(token) || request !== metricsRequest || scope !== $('flView').value) return;
    series = {};
    const aggIds = nodes.filter(function (nd) { return nd.role === 'aggregator'; }).map(function (nd) { return nd.node_id; });
    res.series.filter(function (s) { return aggIds.indexOf(s.key) < 0; }).forEach(function (s) {
      series[s.key] = { label: s.label, points: s.points };
    });
    renderCharts();
  }

  async function loadNodes(token) {
    token = token || selectionToken();
    if (!job || !selectionCurrent(token)) return;
    const request = ++nodesRequest;
    let res;
    try { res = await Api.get('/fl/jobs/' + token.jobId + '/nodes'); }
    catch (e) { if (selectionCurrent(token) && request === nodesRequest) throw e; return; }
    if (!selectionCurrent(token) || request !== nodesRequest) return;
    nodes = res.items;
    renderNodes();
  }

  async function selectJob(jobId) {
    if (!active) return;
    selectionEpoch++; selectedJobId = jobId; closeStream(); clearDetails('正在加载任务…');
    const token = selectionToken(), request = ++detailRequest;
    try {
      const next = await Api.get('/fl/jobs/' + jobId);
      if (!selectionCurrent(token) || request !== detailRequest) return;
      job = next;
      render(); renderJobs();
      await loadNodes(token);
      if (!selectionCurrent(token)) return;
      await loadMetrics(token);
      if (!selectionCurrent(token)) return;
      sse = Api.subscribe('/fl/jobs/' + jobId + '/events', {
        snapshot: async function (value) {
          if (!selectionCurrent(token)) return;
          detailRequest++; job = value; render(); syncListItem();
          await Promise.all([loadNodes(token), loadMetrics(token)]);
        },
        round_completed: function (ev) { if (selectionCurrent(token)) onRound(ev); },
        status_changed: function () { if (selectionCurrent(token)) return onStatus(token); }
      });
    } catch (e) { if (selectionCurrent(token)) UI.fail(e); }
  }

  function onRound(ev) {
    job.current_round = ev.round;
    job.progress_pct = Math.round((ev.round / job.total_rounds) * 100);
    job.global_metrics_prev = job.global_metrics;
    job.global_metrics = ev.global_metrics;
    // 推送里的 eta_sec / elapsed_sec 已是 EMA 平滑结果；平滑后的每轮耗时 = 剩余时间 / 剩余轮次
    job.elapsed_sec = ev.elapsed_sec;
    job.eta_sec = ev.eta_sec;
    const left = job.total_rounds - ev.round;
    if (job.eta && left > 0 && ev.eta_sec !== null) {
      job.eta = Object.assign({}, job.eta, { ema_round_sec: ev.eta_sec / left, avg_round_sec: ev.elapsed_sec / ev.round });
    }
    render();
    syncListItem();
    if (!job.eta) refreshEta();   // 首轮补取一次平滑参数（α 与公式）

    const keys = spec().map(function (m) { return m.key; });
    const point = function (src) {
      const p = { round: ev.round };
      keys.forEach(function (k) { p[k] = src[k]; });
      return p;
    };
    if (!series.global) series.global = { label: '全局', points: [] };
    series.global.points.push(point(ev.global_metrics));
    if ($('flView').value === 'nodes') {
      const aggIds = nodes.filter(function (nd) { return nd.role === 'aggregator'; }).map(function (nd) { return nd.node_id; });
      ev.node_metrics.filter(function (n) { return aggIds.indexOf(n.node_id) < 0; }).forEach(function (n) {
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

  async function onStatus(token) {
    const request = ++detailRequest;
    try {
      const next = await Api.get('/fl/jobs/' + token.jobId);
      if (!selectionCurrent(token) || request !== detailRequest) return;
      job = next; render(); syncListItem();
      await loadNodes(token);
    } catch (e) { if (selectionCurrent(token)) UI.fail(e); }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c, focusJobId) {
    projectEpoch++; active = true; ctx = { projectId: c.projectId };
    const token = projectToken();
    bindOnce(); clearSelection(); jobs = []; renderJobs();
    $('flHqScope').value = 'job'; $('flHqSeries').value = 'global';
    $('flHqFrom').value = ''; $('flHqTo').value = ''; $('flTypeFilter').value = '';
    try {
      if (!taskTypes.length) {
        const types = await Api.get('/fl/task-types');
        if (!projectCurrent(token)) return;
        taskTypes = types.items;
        const f = $('flTypeFilter');
        taskTypes.forEach(function (t) {
          const o = document.createElement('option');
          o.value = t.task_type; o.textContent = t.name; f.appendChild(o);
        });
      }
      if (!await loadJobs() || !projectCurrent(token)) return;
      const target = focusJobId || (jobs[0] && jobs[0].job_id);
      if (target) await selectJob(target);
    } catch (e) { if (projectCurrent(token)) UI.fail(e); }
  }

  async function refresh(focusJobId) {
    if (!active) return;
    const token = projectToken();
    try {
      if (!await loadJobs() || !projectCurrent(token)) return;
      if (focusJobId && (!job || job.job_id !== focusJobId)) await selectJob(focusJobId);
    } catch (e) { if (projectCurrent(token)) UI.fail(e); }
  }

  function unmount() {
    active = false; projectEpoch++;
    clearSelection(); jobs = []; if (booted) renderJobs(); disposeCharts();
  }

  function currentJobId() { return job ? job.job_id : null; }

  window.FL = { mount: mount, refresh: refresh, unmount: unmount, currentJobId: currentJobId };
})();
