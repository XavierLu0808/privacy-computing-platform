/** 多方安全计算模块。接口见 API.md §4。 */
(function () {
  'use strict';
  const $ = UI.$;

  const PROTO_CN = { ss: '秘密共享', gc: '混淆电路', ot: '不经意传输扩展' };
  const OP_CN = {
    secure_product: '安全求积', secure_mean: '安全求均值',
    secure_compare: '安全比较', logic_op: '逻辑运算', vector_ot: '向量 OT'
  };
  const ROLE_CN = { input: '输入方', compute: '计算方', output: '输出方' };
  const PARTY_ST = {
    pending: ['待执行', '#F0F2F5', '#4C5564'],
    running: ['执行中', '#E7F0FA', '#1A4F8A'],
    finished: ['已结束', '#F0F2F5', '#4C5564'],
    abnormal: ['异常', '#FBEDEA', '#A33B21']
  };

  let ctx = null;
  let task = null;
  let estimate = null;
  let sse = null;
  let booted = false;

  function bindOnce() {
    if (booted) return;
    booted = true;
    $('mpcProto').addEventListener('change', function () { loadEstimate(); });
    $('mpcRun').addEventListener('click', onRun);
    $('mpcReset').addEventListener('click', onReset);
    $('mpcExport').addEventListener('click', onExport);
    $('mpcLocate').addEventListener('click', onLocate);
  }

  async function loadEstimate() {
    try {
      estimate = await Api.get('/projects/' + ctx.projectId + '/mpc/estimate', {
        protocol: $('mpcProto').value
      });
      $('mpcPartyCount').textContent = estimate.party_count;
      $('mpcRows').textContent = UI.rows(estimate.data_rows) + '条';
      $('mpcEstCalc').textContent = '约 ' + estimate.est_compute_sec + ' s';
      $('mpcEstComm').textContent = '约 ' + estimate.est_comm_sec + ' s';
      $('mpcOpNote').textContent = '当前算子：' + estimate.operators.map(function (o) { return o.name; }).join(' / ');
    } catch (e) { UI.fail(e); }
  }

  async function onRun() {
    try {
      if (!task) {
        task = await Api.post('/projects/' + ctx.projectId + '/mpc/tasks', {
          protocol: $('mpcProto').value,
          operator: estimate.operators[0].key,
          parties: [
            { party_id: 'party-a', role: 'input' },
            { party_id: 'party-b', role: 'compute' },
            { party_id: 'party-c', role: 'output' }
          ],
          auto_start: true
        });
        listen();
      } else {
        task = await Api.post('/mpc/tasks/' + task.task_id + '/actions', {
          action: task.status === 'running' ? 'stop' : 'start'
        });
      }
      render();
    } catch (e) { UI.fail(e); }
  }

  async function onReset() {
    if (!task) return;
    try {
      task = await Api.post('/mpc/tasks/' + task.task_id + '/actions', { action: 'reset' });
      render();
    } catch (e) { UI.fail(e); }
  }

  async function onExport() {
    try {
      const name = await Api.download('/projects/' + ctx.projectId + '/mpc/tasks/export', {
        query: { format: 'csv' }
      });
      UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  function onLocate() {
    if (!task || !task.alarms.length) return;
    const pid = task.alarms[0].party_id;
    const card = document.querySelector('[data-party="' + pid + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.transition = 'box-shadow .2s';
      card.style.boxShadow = '0 0 0 3px rgba(163,59,33,.35)';
      setTimeout(function () { card.style.boxShadow = 'none'; }, 1600);
    }
    UI.toast('已定位到 ' + pid);
  }

  function listen() {
    if (sse) sse.close();
    sse = Api.subscribe('/mpc/tasks/' + task.task_id + '/events', {
      metrics: function (ev) { task.parties = ev.parties; renderParties(); },
      alarm_raised: function (a) {
        const exists = task.alarms.some(function (x) { return x.party_id === a.party_id; });
        if (!exists) task.alarms.push(a);
        renderAlarm();
      },
      status_changed: function (ev) { task.status = ev.status; render(); }
    });
  }

  /* ---------- 渲染 ---------- */

  function render() {
    const running = task && task.status === 'running';
    const started = task && task.parties.some(function (p) { return p.interaction_rounds > 0; });
    $('mpcRun').textContent = running ? '停止执行' : (started ? '继续执行' : '开始执行');
    $('mpcRun').className = running ? 'btn-primary btn-danger' : 'btn-primary';
    $('mpcProto').disabled = !!task && task.status !== 'pending';
    renderParties();
    renderAlarm();
  }

  function renderParties() {
    const wrap = $('mpcParties');
    UI.clear(wrap);
    const parties = task ? task.parties : placeholderParties();
    const maxComm = Math.max.apply(null, parties.map(function (p) { return p.comm_bytes; }).concat([1]));
    const maxTime = Math.max.apply(null, parties.map(function (p) { return p.compute_sec; }).concat([0.001]));

    parties.forEach(function (p) {
      const anom = p.status === 'abnormal';
      const card = UI.el('div', 'party' + (anom ? ' anom' : ''));
      card.setAttribute('data-party', p.party_id);

      const head = UI.el('div', 'party-head');
      head.appendChild(UI.el('span', 'party-av', p.tag));
      const id = UI.el('span', 'party-id');
      id.appendChild(UI.el('span', 'party-name', p.name));
      id.appendChild(UI.el('span', 'party-role', ROLE_CN[p.role] + ' · ' + p.ip));
      head.appendChild(id);
      const st = PARTY_ST[p.status] || [p.status, '#F0F2F5', '#4C5564'];
      const stEl = UI.el('span', 'party-st', st[0]);
      stEl.style.background = st[1];
      stEl.style.color = st[2];
      head.appendChild(stEl);
      card.appendChild(head);

      card.appendChild(statBlock('通信量', p.comm_bytes ? UI.bytes(p.comm_bytes) : '— MB',
        (p.comm_bytes / maxComm) * 100, anom));
      card.appendChild(statBlock('计算耗时', p.compute_sec ? p.compute_sec.toFixed(1) + ' s' : '— s',
        (p.compute_sec / maxTime) * 100, anom));

      const rounds = UI.el('div', 'party-rounds');
      rounds.appendChild(UI.el('span', null, '轮次交互次数'));
      rounds.appendChild(UI.el('strong', null, p.interaction_rounds ? String(p.interaction_rounds) : '—'));
      card.appendChild(rounds);

      wrap.appendChild(card);
    });
  }

  function statBlock(name, value, pct, anom) {
    const block = UI.el('div', 'party-stat');
    const head = UI.el('div', 'party-stat-head');
    head.appendChild(UI.el('span', null, name));
    head.appendChild(UI.el('strong', null, value));
    block.appendChild(head);
    const bar = UI.el('span', 'bar bar-6');
    const fill = UI.el('i');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    fill.style.background = anom ? '#A33B21' : '#1D4E89';
    bar.appendChild(fill);
    block.appendChild(bar);
    return block;
  }

  function placeholderParties() {
    return [
      { party_id: 'party-a', tag: 'A', name: '参与方 A', role: 'input', ip: '10.22.6.14', status: 'pending', comm_bytes: 0, compute_sec: 0, interaction_rounds: 0 },
      { party_id: 'party-b', tag: 'B', name: '参与方 B', role: 'compute', ip: '10.31.8.27', status: 'pending', comm_bytes: 0, compute_sec: 0, interaction_rounds: 0 },
      { party_id: 'party-c', tag: 'C', name: '参与方 C', role: 'output', ip: '10.44.2.61', status: 'pending', comm_bytes: 0, compute_sec: 0, interaction_rounds: 0 }
    ];
  }

  function renderAlarm() {
    const has = task && task.alarms && task.alarms.length;
    $('mpcAlarm').hidden = !has;
    if (has) $('mpcAlarmText').textContent = task.alarms[0].message;
  }

  async function loadHistory() {
    try {
      const res = await Api.get('/projects/' + ctx.projectId + '/mpc/tasks', { status: 'finished' });
      const wrap = $('mpcHistory');
      UI.clear(wrap);
      if (!res.items.length) {
        wrap.appendChild(UI.el('div', 'table-empty', '暂无历史任务'));
        return;
      }
      res.items.forEach(function (t) {
        const row = UI.el('div', 'table-row mpc-history-grid');
        row.appendChild(UI.el('span', 'cell-strong', t.task_id));
        row.appendChild(UI.el('span', 'cell-muted', PROTO_CN[t.protocol] + ' / ' + (OP_CN[t.operator] || t.operator)));
        row.appendChild(UI.el('span', 'cell-muted', t.party_count + ' 方'));
        row.appendChild(UI.el('span', 'cell-muted', UI.bytes(t.total_comm_bytes)));
        row.appendChild(UI.el('span', 'cell-muted', UI.duration(t.total_duration_sec)));
        row.appendChild(UI.el('span', 'hint', UI.datetime(t.finished_at)));
        wrap.appendChild(row);
      });
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c) {
    ctx = c;
    bindOnce();
    task = null;
    if (sse) { sse.close(); sse = null; }
    await loadEstimate();
    render();
    loadHistory();
  }

  function unmount() {
    if (sse) { sse.close(); sse = null; }
  }

  window.MPC = { mount: mount, unmount: unmount };
})();
