/**
 * 多方安全计算 / 协议管理（#/mpc/proto）。接口见 docs/api/mpc.md。
 * 协议目录（MPC-PROTO-01..03）、参数默认配置（06）、参与方角色（05）、算子编排与试运行（04）、性能预估（07），
 * 创建任务后跳到运维监控页（App.go('mpc', { sub: 'ops', taskId })）。
 */
(function () {
  'use strict';
  const $ = UI.$;
  const el = UI.el;

  const ROLE_KEYS = ['input', 'compute', 'output'];
  const ROLE_CN = { input: '输入方', compute: '计算方', output: '输出方' };
  const SEC_CN = { semi_honest: '半诚实', malicious: '恶意' };
  const TEMPLATES = [
    { label: '各方求和 → 求均值（秘密共享）', steps: [
      { operator: 'secure_sum', protocol: 'ss' }, { operator: 'secure_mean', protocol: 'ss' }] },
    { label: '各方求和 → 求均值 → 与阈值比较', steps: [
      { operator: 'secure_sum', protocol: 'ss' }, { operator: 'secure_mean', protocol: 'ss' },
      { operator: 'secure_compare', protocol: 'gc', operand: { cmp: 'gt', threshold: 1266000 } }] },
    { label: '各方最大值 → 与阈值比较', steps: [
      { operator: 'secure_max', protocol: 'gc' }, { operator: 'secure_compare', protocol: 'gc', operand: { cmp: 'gt', threshold: 632000 } }] },
    { label: '两方报价比较 → 任一为真', steps: [
      { operator: 'secure_compare', protocol: 'gc' }, { operator: 'logic_op', protocol: 'gc', operand: { mode: 'or' } }] },
    { label: '向量 OT 取第 2 行', steps: [{ operator: 'vector_ot', protocol: 'ot', operand: { index: 2 } }] }
  ];

  let ctx = null;
  let root = null;
  let gen = 0, active = false, estimateRequest = 0, dryRequest = 0, createRequest = 0;
  function current(my) { return active && my === gen; }
  let cat = null;            // GET /mpc/protocols
  const S = {
    paramTab: 'ss', advanced: false,
    saved: {}, draft: {}, customized: {},
    pool: [], sel: {},       // party_id -> { on, roles: [] }
    steps: [], dry: null
  };

  /* ---------- 工具 ---------- */

  function btn(cls, text, onClick, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function protoName(p) { const x = cat && cat.protocols.filter(function (y) { return y.protocol === p; })[0]; return x ? x.name : p; }
  function opOf(key) { return cat.operators.filter(function (o) { return o.key === key; })[0]; }
  function typeName(t) { const x = cat.value_types.filter(function (y) { return y.key === t; })[0]; return x ? x.name : t; }
  function num(v) { return Number(v).toLocaleString('zh-CN'); }
  function sec(v) { return v > 0 && v < 0.01 ? '< 0.01 秒' : (v < 10 ? Number(v).toFixed(2) : Number(v).toFixed(1)) + ' 秒'; }
  function mb(bytes) { return UI.bytes(bytes); }
  function short(hex) { return hex.length > 12 ? hex.slice(0, 8) + '…' + hex.slice(-4) : hex; }
  function svg(path) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' + path + '</svg>';
  }
  function iconBtn(icon, label, onClick, disabled) {
    const b = btn('btn-sm mpc-icon-btn', null, onClick, label);
    b.innerHTML = svg(icon);
    b.setAttribute('aria-label', label);
    b.disabled = !!disabled;
    return b;
  }
  const ICON_UP = '<path d="M12 19V5M6 11l6-6 6 6"></path>';
  const ICON_DOWN = '<path d="M12 5v14M6 13l6 6 6-6"></path>';
  const ICON_DEL = '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"></path>';

  /* ---------- 骨架 ---------- */

  function skeleton() {
    UI.clear(root);
    const head = el('div', 'page-head');
    const ht = el('div', 'page-head-text');
    ht.appendChild(el('span', 'crumb', '多方安全计算 / 协议管理'));
    ht.appendChild(el('h1', null, '协议管理与计算编排'));
    head.appendChild(ht);
    head.appendChild(btn('btn', '查看运维监控', function () { App.go('mpc', { sub: 'ops' }); }));
    root.appendChild(head);

    const grid = el('div', 'mpc-proto-grid');
    grid.id = 'mpcpCatalog';
    root.appendChild(grid);

    root.appendChild(section('mpcpParams', 'MPC-PROTO-06', '协议参数'));
    root.appendChild(section('mpcpParties', 'MPC-PROTO-05', '参与方与角色'));
    root.appendChild(section('mpcpFlow', 'MPC-PROTO-04', '计算流程编排'));
    root.appendChild(section('mpcpEst', 'MPC-PROTO-07', '性能预估'));

    const submit = el('div', 'card card-lg card-row mpc-submit');
    submit.id = 'mpcpSubmit';
    const name = UI.inputOf('mpcpName', '', 'text');
    name.placeholder = '例如：三方氧化钕均价阈值核验';
    name.maxLength = 40;
    submit.appendChild(fieldInline('任务名称', name, 'mpc-submit-name'));
    const thr = UI.inputOf('mpcpThr', 50, 'number');
    thr.min = 10; thr.max = 200;
    submit.appendChild(fieldInline('异常告警阈值（偏离均值 %）', thr, 'mpc-submit-thr'));
    submit.appendChild(el('span', 'spacer'));
    const go = btn('btn-primary', '创建任务并进入监控', onCreate);
    go.id = 'mpcpCreate';
    submit.appendChild(go);
    root.appendChild(submit);
  }

  function section(id, acc, title) {
    const c = el('div', 'card card-lg');
    c.id = id;
    c.setAttribute('data-acc', acc);
    const h = el('div', 'mpc-card-head');
    h.appendChild(el('span', 'card-title', title));
    c.appendChild(h);
    const body = el('div', 'mpc-card-body');
    body.id = id + 'Body';
    c.appendChild(body);
    return c;
  }
  function fieldInline(label, control, cls) {
    const w = el('div', 'field-col ' + (cls || ''));
    const lb = el('label', null, label);
    lb.htmlFor = control.id;
    w.appendChild(lb);
    w.appendChild(control);
    return w;
  }

  /* ---------- 协议目录（PROTO-01/02/03） ---------- */

  function renderCatalog() {
    const grid = $('mpcpCatalog');
    UI.clear(grid);
    cat.protocols.forEach(function (p) {
      const c = el('div', 'card card-lg mpc-proto-card');
      c.setAttribute('data-acc', p.acc);
      c.setAttribute('data-protocol', p.protocol);
      const h = el('div', 'mpc-proto-head');
      h.appendChild(el('span', 'card-title', p.name));
      h.appendChild(el('span', 'tag tag-cls', p.protocol.toUpperCase()));
      c.appendChild(h);
      c.appendChild(el('span', 'hint', p.full_name));
      c.appendChild(kv('原理', p.principle));
      const sm = el('div', 'chip-row');
      p.security_models.forEach(function (s, i) {
        sm.appendChild(el('span', 'tag' + (i === 0 ? ' tag-cls' : ''), s.name + (i === 0 ? '（默认）' : '')));
      });
      c.appendChild(kv('安全模型', sm, p.security_note));
      const ops = el('div', 'chip-row');
      p.operators.forEach(function (o) { ops.appendChild(el('span', 'tag', opOf(o).name)); });
      c.appendChild(kv('适用算子', ops));
      c.appendChild(kv('通信轮数特征', p.rounds_note));
      const link = btn('btn-link', '查看 / 修改参数', function () {
        S.paramTab = p.protocol;
        renderParams();
        $('mpcpParams').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      c.appendChild(link);
      grid.appendChild(c);
    });
  }
  function kv(label, value, note) {
    const w = el('div', 'mpc-kv');
    w.appendChild(el('span', 'mpc-kv-label', label));
    if (typeof value === 'string') w.appendChild(el('span', 'mpc-kv-value', value));
    else w.appendChild(value);
    if (note) w.appendChild(el('span', 'hint-2', note));
    return w;
  }

  /* ---------- 参数（PROTO-06） ---------- */

  function schemaOf(p) { return cat.protocols.filter(function (x) { return x.protocol === p; })[0].params_schema; }
  function dirty(p) { return JSON.stringify(S.draft[p]) !== JSON.stringify(S.saved[p]); }

  function renderParams() {
    const body = $('mpcpParamsBody');
    UI.clear(body);
    const bar = el('div', 'mpc-toolbar');
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'tablist');
    cat.protocols.forEach(function (p) {
      const b = btn(S.paramTab === p.protocol ? 'on' : '', p.name + (S.customized[p.protocol] ? ' · 已自定义' : ''), function () {
        S.paramTab = p.protocol; renderParams();
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', S.paramTab === p.protocol ? 'true' : 'false');
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    bar.appendChild(el('span', 'spacer'));
    const sw = el('label', 'mpc-switch');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'mpcpAdvanced';
    cb.checked = S.advanced;
    cb.addEventListener('change', function () {
      S.advanced = cb.checked;
      if (!S.advanced) { S.draft = clone(S.saved); scheduleEstimate(); }
      renderParams();
    });
    sw.appendChild(cb);
    sw.appendChild(el('span', null, '高级模式（自定义参数）'));
    bar.appendChild(sw);
    body.appendChild(bar);

    const p = S.paramTab;
    const head = el('div', 'table-head mpc-param-grid');
    ['参数', '当前值', '说明与取值范围', '默认值'].forEach(function (x) { head.appendChild(el('span', null, x)); });
    body.appendChild(head);
    schemaOf(p).forEach(function (s) {
      const row = el('div', 'table-row mpc-param-grid');
      row.setAttribute('data-param', s.key);
      row.appendChild(el('span', 'cell-strong', s.label));
      row.appendChild(paramControl(p, s));
      const range = s.type === 'int' ? '范围 ' + num(s.min) + '–' + num(s.max) + ' ' + s.unit + (p === 'ss' && s.key === 'frac_bits' ? '，且 ≤ 环大小 / 2' : '')
        : s.type === 'enum' ? '可选 ' + s.options.map(function (o) { return SEC_CN[o] || o; }).join(' / ') + (s.unit ? ' ' + s.unit : '') : '开 / 关';
      const d = el('span', 'hint', s.desc + '；' + range);
      row.appendChild(d);
      row.appendChild(el('span', 'cell-muted', fmtParam(s, s.default)));
      body.appendChild(row);
    });
    body.appendChild(el('span', 'hint-2', '计算安全参数 κ = 128 bit（固定）。参数按项目保存，新建任务默认使用已保存值；高级模式下未保存的修改只用于本页预估与本次创建。'));

    const foot = el('div', 'mpc-toolbar');
    const st = el('span', S.customized[p] ? 'tag tag-ts' : 'tag', S.customized[p] ? '本项目已自定义' : '使用平台默认配置');
    foot.appendChild(st);
    if (dirty(p)) foot.appendChild(el('span', 'hint', '有未保存的修改'));
    foot.appendChild(el('span', 'spacer'));
    const reset = btn('btn', '恢复默认', onResetParams);
    reset.disabled = !S.advanced;
    reset.id = 'mpcpParamReset';
    foot.appendChild(reset);
    const save = btn('btn-primary', '保存参数', onSaveParams);
    save.disabled = !S.advanced || !dirty(p);
    save.id = 'mpcpParamSave';
    foot.appendChild(save);
    body.appendChild(foot);
  }

  function fmtParam(s, v) {
    if (s.type === 'bool') return v ? '开启' : '关闭';
    if (s.type === 'enum') return (SEC_CN[v] || v) + (s.unit ? ' ' + s.unit : '');
    return num(v) + ' ' + s.unit;
  }

  function paramControl(p, s) {
    const id = 'mpcpP_' + p + '_' + s.key;
    const v = S.draft[p][s.key];
    let c;
    if (s.type === 'bool') {
      c = el('label', 'mpc-switch');
      const cb = el('input');
      cb.type = 'checkbox'; cb.id = id; cb.checked = v; cb.disabled = !S.advanced;
      cb.addEventListener('change', function () { S.draft[p][s.key] = cb.checked; renderParams(); scheduleEstimate(); });
      c.appendChild(cb);
      c.appendChild(el('span', null, v ? '开启' : '关闭'));
      return c;
    }
    if (s.type === 'enum') {
      c = UI.selectOf(id, s.options.map(function (o) { return { value: String(o), label: (SEC_CN[o] || o) + (s.unit ? ' ' + s.unit : '') }; }), String(v));
      c.className = 'select select-sm';
      c.disabled = !S.advanced;
      c.addEventListener('change', function () {
        S.draft[p][s.key] = typeof s.options[0] === 'number' ? Number(c.value) : c.value;
        renderParams(); scheduleEstimate();
      });
      return c;
    }
    const w = el('div', 'mpc-num');
    c = UI.inputOf(id, v, 'number');
    c.min = s.min; c.max = s.max; c.step = 1;
    c.disabled = !S.advanced;
    c.setAttribute('aria-label', s.label);
    c.addEventListener('change', function () {
      S.draft[p][s.key] = c.value === '' ? null : Number(c.value);
      renderParams(); scheduleEstimate();
    });
    w.appendChild(c);
    w.appendChild(el('span', 'hint', s.unit));
    const val = S.draft[p][s.key];
    const max = (p === 'ss' && s.key === 'frac_bits') ? Math.min(s.max, S.draft.ss.ring_bits / 2) : s.max;
    if (val === null || !Number.isInteger(val) || val < s.min || val > max) {
      c.classList.add('mpc-invalid');
      c.setAttribute('aria-invalid', 'true');
      w.appendChild(el('span', 'mpc-err-text', '应为 ' + s.min + '–' + max + ' 的整数'));
    }
    return w;
  }

  async function onSaveParams() {
    const p = S.paramTab, my = gen, projectId = ctx.projectId;
    try {
      const r = await Api.put('/projects/' + projectId + '/mpc/params/' + p, { params: S.draft[p] });
      if (!current(my)) return;
      S.saved[p] = clone(r.params); S.draft[p] = clone(r.params); S.customized[p] = r.customized;
      UI.toast(protoName(p) + '参数已保存，新建任务默认使用该配置');
      renderParams(); renderCatalog(); scheduleEstimate();
    } catch (e) { if (current(my)) UI.fail(e); }
  }
  async function onResetParams() {
    const p = S.paramTab, my = gen, projectId = ctx.projectId;
    try {
      const r = await Api.del('/projects/' + projectId + '/mpc/params/' + p);
      if (!current(my)) return;
      S.saved[p] = clone(r.params); S.draft[p] = clone(r.params); S.customized[p] = r.customized;
      UI.toast(protoName(p) + '参数已恢复默认');
      renderParams(); scheduleEstimate();
    } catch (e) { if (current(my)) UI.fail(e); }
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ---------- 参与方（PROTO-05） ---------- */

  function selectedParties() {
    return S.pool.filter(function (p) { return S.sel[p.party_id].on; }).map(function (p) {
      return { party_id: p.party_id, roles: S.sel[p.party_id].roles.slice() };
    });
  }
  function partyIssues() {
    const list = selectedParties();
    const cnt = { input: 0, compute: 0, output: 0 };
    list.forEach(function (p) { p.roles.forEach(function (r) { cnt[r] += 1; }); });
    const issues = [];
    if (list.length < 3) issues.push('至少需要 3 个参与方，当前 ' + list.length + ' 个');
    list.forEach(function (p) { if (!p.roles.length) issues.push(nameOf(p.party_id) + ' 未分配角色'); });
    ROLE_KEYS.forEach(function (r) { if (!cnt[r]) issues.push('缺少' + ROLE_CN[r]); });
    const protos = S.steps.map(function (s) { return s.protocol; });
    if ((protos.indexOf('ss') >= 0 || protos.indexOf('gc') >= 0) && cnt.compute < 2) issues.push('秘密共享 / 混淆电路需要至少 2 个计算方');
    return { list: list, cnt: cnt, issues: issues };
  }
  function nameOf(id) { const p = S.pool.filter(function (x) { return x.party_id === id; })[0]; return p ? p.name : id; }

  function renderParties() {
    const body = $('mpcpPartiesBody');
    UI.clear(body);
    body.appendChild(el('span', 'hint', '勾选参与本次计算的参与方（不少于 3 方），每方可同时承担多个角色。输入方提供私有数据，计算方持有份额执行协议，输出方接收最终结果。'));
    const head = el('div', 'table-head mpc-party-cfg-grid');
    ['参与', '参与方', '节点', 'IP', '输入方', '计算方', '输出方'].forEach(function (x) { head.appendChild(el('span', null, x)); });
    body.appendChild(head);
    S.pool.forEach(function (p) {
      const st = S.sel[p.party_id];
      const row = el('div', 'table-row mpc-party-cfg-grid' + (st.on ? '' : ' mpc-off'));
      row.setAttribute('data-party', p.party_id);
      const on = el('input');
      on.type = 'checkbox'; on.checked = st.on;
      on.setAttribute('aria-label', '让' + p.name + '参与计算');
      on.addEventListener('change', function () { st.on = on.checked; renderParties(); scheduleEstimate(); });
      row.appendChild(on);
      row.appendChild(el('span', 'cell-strong', p.name));
      row.appendChild(el('span', 'cell-muted', p.node_id));
      row.appendChild(el('span', 'cell-muted', p.ip));
      ROLE_KEYS.forEach(function (r) {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = st.roles.indexOf(r) >= 0;
        cb.disabled = !st.on;
        cb.setAttribute('aria-label', p.name + ' 担任' + ROLE_CN[r]);
        cb.addEventListener('change', function () {
          st.roles = ROLE_KEYS.filter(function (k) { return k === r ? cb.checked : st.roles.indexOf(k) >= 0; });
          renderParties();
          scheduleEstimate();
        });
        row.appendChild(cb);
      });
      body.appendChild(row);
    });
    const v = partyIssues();
    const sum = el('div', 'mpc-toolbar');
    sum.appendChild(el('span', 'hint', '已选 ' + v.list.length + ' 方：输入方 ' + v.cnt.input + ' 个 · 计算方 ' + v.cnt.compute + ' 个 · 输出方 ' + v.cnt.output + ' 个'));
    if (v.issues.length) {
      const err = el('span', 'mpc-err-text', v.issues.join('；'));
      err.id = 'mpcpPartyErr';
      sum.appendChild(err);
    } else {
      sum.appendChild(el('span', 'mpc-ok-text', '角色配置满足要求'));
    }
    body.appendChild(sum);
  }

  /* ---------- 计算流程（PROTO-04） ---------- */

  /** 本地类型推导，只用于展示与就地提示；最终以服务端校验为准。 */
  function chain() {
    let t = 'parties';
    return S.steps.map(function (s) {
      const op = opOf(s.operator);
      const issues = [];
      if (op.protocols.indexOf(s.protocol) < 0) {
        issues.push(op.name + ' 不支持' + protoName(s.protocol) + '，可用：' + op.protocols.map(protoName).join(' / '));
      }
      let out = op.io[t];
      if (!out) issues.push('不能作用于' + typeName(t));
      if (s.operator === 'logic_op' && (s.operand || {}).mode === 'not') out = t;
      const r = { in_type: t, out_type: out || null, issues: issues };
      t = out || t;
      return r;
    });
  }

  function renderFlow() {
    const body = $('mpcpFlowBody');
    UI.clear(body);
    const tpl = el('div', 'chip-row');
    tpl.appendChild(el('span', 'hint', '示例流程：'));
    TEMPLATES.forEach(function (x) {
      tpl.appendChild(btn('btn-sm', x.label, function () { S.steps = clone(x.steps); S.dry = null; renderFlow(); renderParties(); scheduleEstimate(); }));
    });
    body.appendChild(tpl);

    const head = el('div', 'table-head mpc-step-grid');
    ['步骤', '算子', '协议', '算子参数', '数据形态（输入 → 输出）', '调整'].forEach(function (x) { head.appendChild(el('span', null, x)); });
    body.appendChild(head);
    const ch = chain();
    if (!S.steps.length) body.appendChild(el('div', 'table-empty', '尚未添加步骤，点「添加步骤」或选择示例流程'));
    S.steps.forEach(function (s, i) {
      const row = el('div', 'table-row mpc-step-grid');
      row.setAttribute('data-step', String(i + 1));
      row.appendChild(el('span', 'mpc-step-n', String(i + 1)));
      const opSel = UI.selectOf('mpcpOp' + i, cat.operators.map(function (o) { return { value: o.key, label: o.name }; }), s.operator);
      opSel.className = 'select select-sm';
      opSel.setAttribute('aria-label', '第 ' + (i + 1) + ' 步算子');
      opSel.addEventListener('change', function () {
        const op = opOf(opSel.value);
        S.steps[i] = { operator: op.key, protocol: op.protocols.indexOf(s.protocol) >= 0 ? s.protocol : op.protocols[0], operand: defaultOperand(op.key) };
        S.dry = null; renderFlow(); renderParties(); scheduleEstimate();
      });
      row.appendChild(opSel);
      const prSel = UI.selectOf('mpcpPr' + i, cat.protocols.map(function (p) {
        const okp = opOf(s.operator).protocols.indexOf(p.protocol) >= 0;
        return { value: p.protocol, label: p.name + (okp ? '' : '（不兼容）') };
      }), s.protocol);
      prSel.className = 'select select-sm';
      prSel.setAttribute('aria-label', '第 ' + (i + 1) + ' 步协议');
      prSel.addEventListener('change', function () { s.protocol = prSel.value; S.dry = null; renderFlow(); renderParties(); scheduleEstimate(); });
      row.appendChild(prSel);
      row.appendChild(operandEditor(s, i, ch[i]));
      const io = el('div', 'mpc-io');
      io.appendChild(el('span', null, typeName(ch[i].in_type) + ' → ' + (ch[i].out_type ? typeName(ch[i].out_type) : '—')));
      ch[i].issues.forEach(function (x) { io.appendChild(el('span', 'mpc-err-text', x)); });
      row.appendChild(io);
      const acts = el('div', 'mpc-acts');
      acts.appendChild(iconBtn(ICON_UP, '上移第 ' + (i + 1) + ' 步', function () { move(i, -1); }, i === 0));
      acts.appendChild(iconBtn(ICON_DOWN, '下移第 ' + (i + 1) + ' 步', function () { move(i, 1); }, i === S.steps.length - 1));
      acts.appendChild(iconBtn(ICON_DEL, '删除第 ' + (i + 1) + ' 步', function () { S.steps.splice(i, 1); S.dry = null; renderFlow(); renderParties(); scheduleEstimate(); }));
      row.appendChild(acts);
      body.appendChild(row);
    });

    const bar = el('div', 'mpc-toolbar');
    const add = btn('btn', '添加步骤', function () {
      if (S.steps.length >= 8) { UI.toast('计算流程最多 8 个步骤', true); return; }
      const last = ch.length ? (ch[ch.length - 1].out_type || 'parties') : 'parties';
      const pick = cat.operators.filter(function (o) { return o.io[last]; })[0] || cat.operators[0];
      S.steps.push({ operator: pick.key, protocol: pick.protocols[0], operand: defaultOperand(pick.key) });
      S.dry = null; renderFlow(); renderParties(); scheduleEstimate();
    });
    add.id = 'mpcpAddStep';
    bar.appendChild(add);
    bar.appendChild(el('span', 'hint', '共 ' + S.steps.length + ' / 8 步。中间结果始终以份额形态保存在计算方，只有最后一步的结果对输出方公开。'));
    bar.appendChild(el('span', 'spacer'));
    const dry = btn('btn-primary', '试运行', onDryRun);
    dry.id = 'mpcpDryRun';
    bar.appendChild(dry);
    body.appendChild(bar);

    const out = el('div', 'mpc-dry');
    out.id = 'mpcpDry';
    body.appendChild(out);
    renderDry();
  }

  function defaultOperand(op) {
    if (op === 'secure_compare') return { cmp: 'gt', threshold: 1266000 };
    if (op === 'secure_product') return { factor: 1.13 };
    if (op === 'logic_op') return { mode: 'and' };
    if (op === 'vector_ot') return { index: 1 };
    return {};
  }

  function operandEditor(s, i, c) {
    const w = el('div', 'mpc-operand');
    s.operand = s.operand || {};
    const numInput = function (key, label, unit, step) {
      const inp = UI.inputOf('mpcpOd' + i + key, s.operand[key], 'number');
      inp.className = 'input mpc-input-sm';
      inp.step = step || 'any';
      inp.setAttribute('aria-label', '第 ' + (i + 1) + ' 步' + label);
      inp.addEventListener('change', function () {
        s.operand[key] = inp.value === '' ? undefined : Number(inp.value);
        S.dry = null; renderDry(); scheduleEstimate();
      });
      w.appendChild(el('span', 'hint', label));
      w.appendChild(inp);
      if (unit) w.appendChild(el('span', 'hint', unit));
    };
    if (s.operator === 'secure_compare') {
      if (c.in_type === 'parties') { w.appendChild(el('span', 'hint', '逐行比较前两个输入方：x₁ > x₂')); return w; }
      const sel = UI.selectOf('mpcpCmp' + i, [{ value: 'gt', label: '大于' }, { value: 'lt', label: '小于' }], s.operand.cmp || 'gt');
      sel.className = 'select select-sm';
      sel.setAttribute('aria-label', '第 ' + (i + 1) + ' 步比较方式');
      sel.addEventListener('change', function () { s.operand.cmp = sel.value; S.dry = null; renderDry(); });
      w.appendChild(sel);
      numInput('threshold', '阈值', '元/吨');
    } else if (s.operator === 'secure_product' && c.in_type !== 'parties') {
      numInput('factor', '乘以公开系数', '');
    } else if (s.operator === 'logic_op') {
      const sel = UI.selectOf('mpcpMode' + i, [{ value: 'and', label: 'AND（全部为真）' }, { value: 'or', label: 'OR（任一为真）' }, { value: 'not', label: 'NOT（取反）' }], s.operand.mode || 'and');
      sel.className = 'select select-sm';
      sel.setAttribute('aria-label', '第 ' + (i + 1) + ' 步逻辑运算');
      sel.addEventListener('change', function () { s.operand.mode = sel.value; S.dry = null; renderFlow(); scheduleEstimate(); });
      w.appendChild(sel);
    } else if (s.operator === 'vector_ot') {
      numInput('index', '取第', '行', 1);
    } else {
      w.appendChild(el('span', 'hint-2', '无需参数'));
    }
    return w;
  }

  function move(i, d) {
    const j = i + d;
    const t = S.steps[i]; S.steps[i] = S.steps[j]; S.steps[j] = t;
    S.dry = null; renderFlow(); scheduleEstimate();
  }

  function payload() {
    const body = { steps: S.steps.map(function (s) { return { operator: s.operator, protocol: s.protocol, operand: s.operand || {} }; }), parties: selectedParties() };
    if (S.advanced) body.params = clone(S.draft);
    return body;
  }

  async function onDryRun() {
    if (!active) return;
    const my = gen, request = ++dryRequest, projectId = ctx.projectId;
    const body = payload(), signature = JSON.stringify(body);
    try {
      const r = await Api.post('/projects/' + projectId + '/mpc/flows/dry-run', body);
      if (!current(my) || request !== dryRequest || signature !== JSON.stringify(payload())) return;
      S.dry = r;
      renderDry();
    } catch (e) { if (current(my) && request === dryRequest && signature === JSON.stringify(payload())) UI.fail(e); }
  }

  /** 最后一步是阈值比较时说明判断条件，避免「是 / 否」裸值。 */
  function condNote() {
    const last = S.steps[S.steps.length - 1];
    if (!last) return '';
    if (last.operator === 'secure_compare' && last.operand && last.operand.threshold !== undefined && S.dry.steps[S.dry.steps.length - 1].in_type !== 'parties') {
      return '（判断条件：' + (last.operand.cmp === 'lt' ? '小于 ' : '大于 ') + num(last.operand.threshold) + ' 元/吨）';
    }
    if (last.operator === 'secure_compare') return '（逐行判断：输入方 1 的报价 > 输入方 2 的报价）';
    if (last.operator === 'logic_op') return '（' + ({ and: '全部为真', or: '任一为真', not: '取反' })[last.operand.mode] + '）';
    return '';
  }

  function fmtValue(v, unit) {
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (Array.isArray(v)) return v.map(function (x) { return fmtValue(x, ''); }).join('，') + (unit ? ' ' + unit : '');
    return num(v) + (unit ? ' ' + unit : '');
  }

  function renderDry() {
    const out = $('mpcpDry');
    if (!out) return;
    UI.clear(out);
    const d = S.dry;
    if (!d) { out.hidden = true; return; }
    out.hidden = false;
    out.appendChild(el('span', 'section-label', '试运行结果'));
    out.appendChild(el('span', 'hint', d.dataset_note));
    d.inputs.forEach(function (inp) {
      const box = el('div', 'mpc-dry-party');
      box.appendChild(el('span', 'cell-strong', inp.name + ' 的输入（' + inp.rows + ' 行，' + inp.unit + '）只以' + inp.share_kind + '形式离开本方'));
      const tb = el('table', 'preview-table');
      const thead = el('tr');
      thead.appendChild(el('th', null, '持有方'));
      for (let r = 0; r < inp.rows; r++) thead.appendChild(el('th', null, '第 ' + (r + 1) + ' 行份额'));
      tb.appendChild(thead);
      inp.shares.forEach(function (sh) {
        const tr = el('tr');
        tr.appendChild(el('td', null, sh.holder_name));
        sh.values.forEach(function (h) {
          const td = el('td', 'mpc-hex', '0x' + short(h));
          td.title = '0x' + h;
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      box.appendChild(tb);
      out.appendChild(box);
    });
    const trace = el('div', 'mpc-trace');
    d.steps.forEach(function (s) {
      const line = el('div', 'mpc-trace-row');
      line.appendChild(el('span', 'mpc-step-n', String(s.index)));
      line.appendChild(el('span', null, s.name + '（' + protoName(s.protocol) + '）：' + typeName(s.in_type) + ' → ' + typeName(s.out_type)));
      line.appendChild(el('span', 'hint', s.visibility === 'secret' ? '结果保持密态，首个计算方持有份额 0x' + short(s.share_preview) : '结果对输出方公开'));
      trace.appendChild(line);
    });
    out.appendChild(trace);
    const hasProduct = S.steps.some(function (s) { return s.operator === 'secure_product'; });
    const numeric = d.result.type === 'vector' || d.result.type === 'scalar';
    const unit = numeric && !hasProduct ? '元/吨' : '';
    const res = el('div', 'banner banner-ok');
    res.id = 'mpcpDryResult';
    res.appendChild(el('span', null, d.result.revealed_to_names.join('、') + ' 获得结果（' + typeName(d.result.type).replace('密态', '') + '）：' + fmtValue(d.result.value, unit) +
      (numeric && hasProduct ? '（含求积，结果为价格与系数的乘积）' : '') + condNote()));
    out.appendChild(res);
    out.appendChild(el('span', 'hint', '试运行开销：通信量 ' + mb(d.stats.comm_bytes) + '（全体参与方发送字节之和），交互 ' + d.stats.rounds + ' 轮，单方计算约 ' + sec(d.stats.compute_sec)));
    d.warnings.forEach(function (w) { out.appendChild(el('div', 'banner banner-err', w)); });
  }

  /* ---------- 性能预估（PROTO-07） ---------- */

  let estTimer = null;
  function scheduleEstimate() {
    clearTimeout(estTimer);
    if (!active) return;
    S.dry = null; renderDry();
    estTimer = setTimeout(loadEstimate, 250);
  }

  function renderEstForm() {
    const body = $('mpcpEstBody');
    UI.clear(body);
    const form = el('div', 'mpc-toolbar');
    const rows = UI.inputOf('mpcpRows', 1200000, 'number');
    rows.min = 1; rows.step = 1;
    const bw = UI.inputOf('mpcpBw', 100, 'number');
    bw.min = 1; bw.max = 10000;
    const rtt = UI.inputOf('mpcpRtt', 20, 'number');
    rtt.min = 0; rtt.max = 1000;
    [rows, bw, rtt].forEach(function (x) { x.className = 'input mpc-input-md'; x.addEventListener('change', scheduleEstimate); });
    form.appendChild(fieldInline('预估数据规模（假设每个输入方的行数）', rows));
    form.appendChild(fieldInline('单方链路带宽（Mbps）', bw));
    form.appendChild(fieldInline('往返时延 RTT（ms）', rtt));
    const pc = el('div', 'field-col');
    pc.appendChild(el('label', null, '参与方数量'));
    const pcv = el('span', 'mpc-static');
    pcv.id = 'mpcpEstN';
    pc.appendChild(pcv);
    form.appendChild(pc);
    body.appendChild(form);
    body.appendChild(el('span', 'hint', '规模、带宽与时延用于性能预估；实际任务读取已登记输入，执行行数由服务端计算，不使用这里假设的行数。'));
    const res = el('div', 'mpc-est-out');
    res.id = 'mpcpEstOut';
    body.appendChild(res);
  }

  async function loadEstimate() {
    if (!active) return;
    const out = $('mpcpEstOut');
    if (!out || !S.steps.length) {
      if (out) { UI.clear(out); out.appendChild(el('div', 'table-empty', '添加计算步骤后自动预估')); }
      return;
    }
    const my = gen, request = ++estimateRequest, projectId = ctx.projectId;
    const n = Math.max(3, selectedParties().length);
    $('mpcpEstN').textContent = n + ' 方（取自参与方配置与角色，不足 3 方按 3 方全角色估算）';
    const body = estimatePayload();
    const signature = JSON.stringify(body);
    const stillCurrent = function () { return current(my) && request === estimateRequest && signature === JSON.stringify(estimatePayload()); };
    try {
      const r = await Api.post('/projects/' + projectId + '/mpc/estimate', body);
      if (!stillCurrent()) return;
      renderEstimate(r);
    } catch (e) {
      if (!stillCurrent()) return;
      UI.clear(out);
      const b = el('div', 'banner banner-err', '无法预估：' + e.message);
      b.id = 'mpcpEstErr';
      out.appendChild(b);
    }
  }

  function renderEstimate(r) {
    const out = $('mpcpEstOut');
    UI.clear(out);
    const g = el('div', 'metric-grid');
    g.appendChild(metric('预估计算耗时', sec(r.est_compute_sec), '单方关键路径本地计算时间，各方并行'));
    g.appendChild(metric('预估通信耗时', sec(r.est_comm_sec), '传输 ' + sec(r.comm_breakdown.transfer_sec) + ' + 时延 ' + sec(r.comm_breakdown.latency_sec)));
    g.appendChild(metric('预估通信量', mb(r.est_comm_bytes), '全体参与方发送字节之和（' + num(r.est_comm_bytes) + ' 字节）'));
    g.appendChild(metric('交互轮数', r.rounds + ' 轮', '协议消息往返次数，每轮计 1 个 RTT'));
    out.appendChild(g);
    const head = el('div', 'table-head mpc-est-grid');
    ['步骤', '协议', '通信量', '计算耗时', '轮数', '计算公式'].forEach(function (x) { head.appendChild(el('span', null, x)); });
    out.appendChild(head);
    r.steps.forEach(function (s) {
      const row = el('div', 'table-row mpc-est-grid');
      row.appendChild(el('span', 'cell-strong', (Number.isInteger(s.index) && s.index > 0 ? s.index + '. ' : '') + s.name));
      row.appendChild(el('span', 'cell-muted', protoName(s.protocol)));
      row.appendChild(el('span', null, mb(s.bytes)));
      row.appendChild(el('span', null, sec(s.compute_sec)));
      row.appendChild(el('span', null, s.rounds + ' 轮'));
      row.appendChild(el('span', 'hint', s.formula));
      out.appendChild(row);
    });
    const note = el('div', 'banner-note mpc-formula');
    [r.formula.compute, r.formula.comm_volume, r.formula.comm_time,
      '假设：n = ' + r.party_count + ' 方，m = ' + num(r.data_rows) + ' 行，带宽 ' + num(r.assumptions.bandwidth_mbps) + ' Mbps，RTT ' + r.assumptions.rtt_ms + ' ms，κ = ' + r.assumptions.kappa_bits + ' bit；参数取自协议参数卡' + (S.advanced ? '当前编辑值' : '已保存值')
    ].forEach(function (t) { note.appendChild(el('span', null, t)); });
    out.appendChild(note);
  }

  function metric(name, value, sub) {
    const m = el('div', 'metric');
    m.appendChild(el('span', 'metric-name', name));
    m.appendChild(el('span', 'metric-value mpc-metric-value', value));
    m.appendChild(el('span', 'metric-sub', sub));
    return m;
  }

  /* ---------- 创建任务 ---------- */

  function estimatePayload() {
    const body = payload();
    if (body.parties.length < 3) { delete body.parties; body.party_count = Math.max(3, selectedParties().length); }
    body.data_rows = Number($('mpcpRows').value);
    body.bandwidth_mbps = Number($('mpcpBw').value);
    body.rtt_ms = Number($('mpcpRtt').value);
    return body;
  }

  function taskPayload() {
    const body = payload();
    body.name = $('mpcpName').value.trim();
    body.bandwidth_mbps = Number($('mpcpBw').value);
    body.rtt_ms = Number($('mpcpRtt').value);
    body.anomaly_threshold_pct = Number($('mpcpThr').value);
    body.auto_start = true;
    return body;
  }

  async function onCreate() {
    if (!active) return;
    const v = partyIssues();
    if (v.issues.length) { UI.toast('参与方配置不满足要求：' + v.issues[0], true); $('mpcpParties').scrollIntoView({ behavior: 'smooth' }); return; }
    const body = taskPayload(), signature = JSON.stringify(body), my = gen, request = ++createRequest, projectId = ctx.projectId;
    const stillCurrent = function () { return current(my) && request === createRequest && signature === JSON.stringify(taskPayload()); };
    const b = $('mpcpCreate');
    b.disabled = true;
    try {
      const task = await Api.post('/projects/' + projectId + '/mpc/tasks', body);
      if (!stillCurrent()) return;
      UI.toast('已创建任务 ' + task.task_id + '，执行状态以运维监控为准');
      App.go('mpc', { sub: 'ops', taskId: task.task_id });
    } catch (e) { if (stillCurrent()) UI.fail(e); }
    finally { if (current(my) && request === createRequest) b.disabled = false; }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c, section) {
    active = true; clearTimeout(estTimer); ctx = { projectId: c.projectId };
    root = section;
    gen += 1;
    const my = gen;
    try {
      const res = await Promise.all([
        cat ? Promise.resolve(cat) : Api.get('/mpc/protocols'),
        Api.get('/projects/' + ctx.projectId + '/mpc/params'),
        Api.get('/projects/' + ctx.projectId + '/mpc/parties')
      ]);
      if (!current(my)) return;
      cat = res[0];
      S.saved = {}; S.customized = {};
      res[1].items.forEach(function (x) { S.saved[x.protocol] = x.params; S.customized[x.protocol] = x.customized; });
      S.draft = clone(S.saved);
      S.advanced = false;
      S.pool = res[2].items;
      S.sel = {};
      S.pool.forEach(function (p, i) { S.sel[p.party_id] = { on: i < 3, roles: p.default_roles.slice() }; });
      S.steps = clone(TEMPLATES[0].steps);
      S.dry = null;
      skeleton();
      renderCatalog();
      renderParams();
      renderParties();
      renderFlow();
      renderEstForm();
      loadEstimate();
    } catch (e) { if (current(my)) UI.fail(e); }
  }

  function unmount() {
    active = false; gen += 1;
    clearTimeout(estTimer);
  }

  window.MPCP = { mount: mount, unmount: unmount };
})();
