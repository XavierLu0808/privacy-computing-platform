/** 同态加密模块。接口见 API.md §3。 */
(function () {
  'use strict';
  const $ = UI.$;

  const STEP_NAMES = ['密钥对生成', '加密', '密态运算', '解密'];
  const GUIDE = [
    ['① 生成密钥对', '选择加密算法后生成公私钥，私钥由平台密钥服务托管，页面只拿到 key_id 与公钥摘要'],
    ['② 加密', '用公钥加密明文 A、B；Paillier 先按保留小数位定点化为整数'],
    ['③ 密态运算', '在密文上直接计算所选运算，服务端全程不接触明文'],
    ['④ 解密', '用私钥解密结果并与明文直接计算的结果比对'],
    ['全流程', '可修改明文、运算或精度后重新执行，或点「重置」销毁本次密钥']
  ];

  let ctx = null;
  let schemes = [];
  let stage = 0;           // 0..4
  let key = null;
  let cipherA = null, cipherB = null, resultCt = null;
  let logs = [];
  let totalMs = 0;
  let booted = false;
  let projectId = null;

  function scheme() {
    return schemes.filter(function (s) { return s.scheme === $('heAlgo').value; })[0] || schemes[0];
  }
  function isPaillier() { return $('heAlgo').value === 'paillier'; }

  function bindOnce() {
    if (booted) return;
    booted = true;
    $('heAlgo').addEventListener('change', function () { resetFlow(); renderConfig(); });
    $('heA').addEventListener('input', resetFlow);
    $('heB').addEventListener('input', resetFlow);
    $('heOp').addEventListener('change', function () { if (stage > 2) { stage = 2; renderSteps(); } });
    $('hePrec').addEventListener('input', function () {
      $('hePrecVal').textContent = $('hePrec').value;
      resetFlow();
      renderConfig();
    });
    $('heKeygen').addEventListener('click', doKeygen);
    $('heEnc').addEventListener('click', doEncrypt);
    $('heCalc').addEventListener('click', doEvaluate);
    $('heDec').addEventListener('click', doDecrypt);
    $('heReset').addEventListener('click', function () { destroyKey(); resetFlow(); });
  }

  function resetFlow() {
    stage = 0; logs = []; totalMs = 0;
    cipherA = cipherB = resultCt = null;
    renderSteps(); renderLogs();
  }

  async function destroyKey() {
    if (!key) return;
    const id = key.key_id;
    key = null;
    try { await Api.del('/he/keys/' + id); } catch (e) { /* 重置时忽略 */ }
    if (appBuilt) loadKeys();
  }

  /* ---------- 四步 ---------- */

  async function doKeygen() {
    try {
      await destroyKey();
      key = await Api.post('/he/keys', { scheme: $('heAlgo').value, project_id: ctx.projectId });
      const params = key.key_params.key_size_bits
        ? '密钥长度 ' + key.key_params.key_size_bits + ' bit'
        : 'poly_modulus_degree ' + key.key_params.poly_modulus_degree;
      pushLog('① 密钥对生成', scheme().name + ' · ' + params,
        '公钥 pk = ' + key.public_key_preview + '…　（私钥由平台密钥服务托管，不出示）', key.elapsed_ms);
      stage = 1;
      renderSteps(); renderLogs();
      if (appBuilt) loadKeys();
    } catch (e) { UI.fail(e); }
  }

  async function doEncrypt() {
    try {
      const res = await Api.post('/he/encrypt', {
        key_id: key.key_id,
        precision: Number($('hePrec').value),
        values: [{ name: 'A', value: $('heA').value }, { name: 'B', value: $('heB').value }]
      });
      cipherA = res.ciphertexts[0];
      cipherB = res.ciphertexts[1];
      let body = 'Enc(A) = ' + cipherA.preview + '…\nEnc(B) = ' + cipherB.preview + '…';
      if (cipherA.encoded_integer) {
        body += '\n定点化：A → ' + cipherA.encoded_integer + '，B → ' + cipherB.encoded_integer +
          '（×10^' + res.scale_exponent + '）';
      }
      pushLog('② 加密', '耗时 ' + res.elapsed_ms.toFixed(1) + ' ms · 单条密文 ' + cipherA.size_kb + ' KB',
        body, res.elapsed_ms);
      stage = 2;
      renderSteps(); renderLogs();
    } catch (e) { UI.fail(e); }
  }

  async function doEvaluate() {
    const op = $('heOp').value;
    const body = { key_id: key.key_id, op: op, left_ciphertext_id: cipherA.ciphertext_id };
    if (op === 'mul' && isPaillier()) {
      body.right_plaintext = $('heB').value;   // Paillier 只支持密文 × 明文
    } else {
      body.right_ciphertext_id = cipherB.ciphertext_id;
    }
    try {
      const res = await Api.post('/he/evaluate', body);
      resultCt = res.result_ciphertext_id;
      const noise = res.noise_budget_remaining === null ? '' : ' · 剩余噪声预算 ' + res.noise_budget_remaining + ' bit';
      pushLog('③ 密态运算',
        '耗时 ' + res.elapsed_ms.toFixed(1) + ' ms · 结果密文 ' + res.size_kb + ' KB' + noise,
        res.expression + ' = ' + res.preview + '…　全程未解密，服务端不接触明文', res.elapsed_ms);
      stage = 3;
      renderSteps(); renderLogs();
    } catch (e) { UI.fail(e); }
  }

  async function doDecrypt() {
    try {
      const res = await Api.post('/he/decrypt', {
        key_id: key.key_id, ciphertext_id: resultCt, verify: true
      });
      pushLog('④ 解密', '耗时 ' + res.elapsed_ms.toFixed(1) + ' ms',
        'Dec(结果) = ' + res.plaintext, res.elapsed_ms, true);
      stage = 4;
      totalMs = res.session_summary.total_elapsed_ms;
      renderSteps(); renderLogs();

      if (res.verification) {
        $('heVerify').hidden = false;
        $('heVerifyText').textContent =
          '密文运算结果 ' + res.plaintext + ' 与明文直接计算结果 ' + res.verification.expected +
          ' 一致（绝对误差 ' + res.verification.abs_error + '）；累计密文体积 ' +
          res.session_summary.total_ciphertext_kb + ' KB，' +
          (res.session_summary.logged ? '已记入下方「加解密性能日志」（来源：全流程配置）。' : '未记入日志。');
        if (appBuilt) loadLogs();
      }
    } catch (e) { UI.fail(e); }
  }

  function pushLog(title, meta, body, ms, final) {
    logs.push({ title: title, meta: meta, body: body, final: !!final });
    totalMs += ms || 0;
  }

  /* ---------- 渲染 ---------- */

  function renderSteps() {
    const wrap = $('heSteps');
    UI.clear(wrap);
    STEP_NAMES.forEach(function (name, i) {
      const cls = stage > i + 1 ? 'he-step done' : (stage === i + 1 ? 'he-step on' : 'he-step');
      const step = UI.el('span', cls);
      step.appendChild(UI.el('span', 'he-step-n', String(i + 1)));
      step.appendChild(UI.el('span', 'he-step-name', name));
      step.appendChild(UI.el('span', 'he-step-line'));
      wrap.appendChild(step);
    });

    const btns = [
      { el: $('heKeygen'), active: stage === 0, done: stage >= 1, disabled: false },
      { el: $('heEnc'), active: stage === 1, done: stage >= 2, disabled: stage < 1 },
      { el: $('heCalc'), active: stage === 2, done: stage >= 3, disabled: stage < 2 },
      { el: $('heDec'), active: stage === 3, done: stage >= 4, disabled: stage < 3 }
    ];
    btns.forEach(function (b) {
      b.el.className = 'he-btn' + (b.active ? ' next' : (b.done ? ' done' : ''));
      b.el.disabled = b.disabled;
    });
    const guide = $('heGuide');
    if (guide) {
      guide.textContent = '';
      guide.appendChild(document.createTextNode(stage < 4 ? '下一步：' : '已完成：'));
      guide.appendChild(UI.el('b', null, GUIDE[stage][0]));
      guide.appendChild(document.createTextNode('　' + GUIDE[stage][1]));
    }
  }

  function renderLogs() {
    const wrap = $('heLogs');
    UI.clear(wrap);
    logs.forEach(function (lg) {
      const card = UI.el('div', 'he-log' + (lg.final ? ' final' : ''));
      const head = UI.el('div', 'he-log-head');
      head.appendChild(UI.el('span', 'he-log-title', lg.title));
      head.appendChild(UI.el('span', 'spacer'));
      head.appendChild(UI.el('span', 'he-log-meta', lg.meta));
      card.appendChild(head);
      card.appendChild(UI.el('span', 'he-log-body', lg.body));
      wrap.appendChild(card);
    });
    $('heEmpty').hidden = logs.length > 0;
    $('heTotal').textContent = logs.length ? totalMs.toFixed(1) + ' ms' : '—';
    if (stage < 4) $('heVerify').hidden = true;
  }

  function renderConfig() {
    const s = scheme();
    if (!s) return;
    $('heLib').textContent = s.library;
    const prec = Number($('hePrec').value);
    const a = parseFloat($('heA').value) || 0;
    const b = parseFloat($('heB').value) || 0;
    const scale = Math.pow(10, prec);

    $('heMulOpt').textContent = isPaillier()
      ? '明文数乘　A ⊗ b（Paillier 不支持密文乘）'
      : '密文乘法　A ⊗ B';
    $('heConvNote').textContent = isPaillier()
      ? 'Paillier 仅支持整数，平台自动定点化：A → ' + Math.round(a * scale) +
        '，B → ' + Math.round(b * scale) + '（×10^' + prec + '）'
      : s.name + ' 支持浮点输入；精度设置影响结果保留位数与噪声预算消耗';
  }

  /* ================= 应用集成扩展：HE-APP-02 – 05（DOM 由 JS 追加到本页 section 末尾） ================= */

  const JOB_ST = {
    Created: '已创建', Running: '运行中', Paused: '已暂停', Success: '已完成', Failed: '失败', Terminated: '已终止'
  };
  const HE_SWITCHABLE = ['Created', 'Terminated', 'Failed'];
  const KEY_ST = { active: ['使用中', 'he-st-active'], rotated: ['已轮换', 'he-st-rotated'], destroyed: ['已销毁', 'he-st-destroyed'] };
  const ROTATE_CN = { auto: '自动', manual: '手动', superseded: '被新钥替代' };
  const PURPOSE_CN = { fl_aggregation: '联邦聚合', session: '流程会话' };
  const SCHEME_CN = { paillier: 'Paillier', ckks: 'CKKS', bgv: 'BGV', tfhe: 'TFHE' };
  const ICON_OK = '<svg class="he-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"></path></svg>';
  const ICON_NO = '<svg class="he-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

  let appBuilt = false;
  let jobs = [], nodes = [], keyFilter = '', logRefs = [];
  const $s = function (sel) { return $('screen-he-app').querySelector(sel); };

  function appCard(acc, title, desc) {
    const c = UI.el('div', 'card card-lg');
    c.dataset.acc = acc;
    const h = UI.el('div', 'he-card-head');
    h.appendChild(UI.el('span', 'card-title', title));
    if (desc) h.appendChild(UI.el('span', 'hint', desc));
    c.appendChild(h);
    return c;
  }
  function btn(cls, text, id) {
    const b = UI.el('button', cls, text);
    b.type = 'button';
    if (id) b.id = id;
    return b;
  }
  function gridHead(cls, cols) {
    const h = UI.el('div', 'table-head ' + cls);
    cols.forEach(function (c) { h.appendChild(UI.el('span', null, c)); });
    return h;
  }
  function gridRow(cls, cells) {
    const r = UI.el('div', 'table-row ' + cls);
    cells.forEach(function (c) { r.appendChild(c instanceof Node ? c : UI.el('span', null, c === null || c === undefined ? '—' : String(c))); });
    return r;
  }
  function segOf(id, options, value) {
    const s = UI.el('div', 'seg');
    s.id = id;
    s.setAttribute('role', 'group');
    options.forEach(function (o) {
      const b = btn(o.value === value ? 'on' : '', o.label);
      b.dataset.value = o.value;
      b.setAttribute('aria-pressed', o.value === value ? 'true' : 'false');
      b.addEventListener('click', function () {
        s.querySelectorAll('button').forEach(function (x) { x.className = x === b ? 'on' : ''; x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        s.dispatchEvent(new Event('change'));
      });
      s.appendChild(b);
    });
    s.value = function () { const on = s.querySelector('button.on'); return on ? on.dataset.value : null; };
    return s;
  }
  function inlineErr(box, e) {
    UI.clear(box);
    box.appendChild(UI.el('div', 'banner banner-err', '未能完成：' + ((e && e.message) || '请求失败') + (e && e.code ? '（错误码 ' + e.code + '）' : '')));
  }
  function nodeChecks(selected) {
    const list = UI.el('div', 'check-list');
    nodes.forEach(function (n) {
      const lb = UI.el('label', 'check-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = n.node_id; cb.checked = selected.indexOf(n.node_id) >= 0;
      lb.appendChild(cb);
      lb.appendChild(UI.el('span', null, n.node_id));
      lb.appendChild(UI.el('span', 'hint', n.role_label));
      list.appendChild(lb);
    });
    list.picked = function () {
      return Array.prototype.filter.call(list.querySelectorAll('input'), function (x) { return x.checked; }).map(function (x) { return x.value; });
    };
    return list;
  }

  function buildApp() {
    if (appBuilt) return;
    appBuilt = true;
    const sec = $('screen-he-app');
    $('heSteps').parentNode.dataset.acc = 'HE-APP-01';
    sec.querySelector('.he-split').dataset.acc = 'HE-APP-01';
    const guide = UI.el('div', 'he-guide');
    guide.id = 'heGuide';
    $('heSteps').parentNode.appendChild(guide);

    const grid = UI.el('div', 'he-app-grid2');

    // HE-APP-02 联邦学习一键配置
    const fl = appCard('HE-APP-02', '联邦学习一键配置', '为当前项目的训练任务一键切换为同态加密聚合');
    const ff = UI.el('div', 'he-form');
    const jobSel = UI.selectOf('heFlJob', [], undefined);
    jobSel.style.minWidth = '320px';
    ff.appendChild(UI.formRow('训练任务', jobSel));
    ff.appendChild(btn('btn-primary', '一键启用同态加密聚合', 'heFlEnable'));
    fl.appendChild(ff);
    fl.appendChild(UI.el('div', null)).id = 'heFlInfo';
    grid.appendChild(fl);

    // HE-APP-04 流程测试模拟
    const sim = appCard('HE-APP-04', '流程测试模拟', '正式训练前用模拟梯度走一遍 加密 → 聚合 → 解密，逐项校验');
    const sf = UI.el('div', 'he-form');
    sf.appendChild(UI.formRow('加密方案', segOf('heSimScheme', [{ value: 'paillier', label: 'Paillier' }, { value: 'ckks', label: 'CKKS' }], 'paillier')));
    sf.appendChild(UI.formRow('梯度维度', segOf('heSimDim', [{ value: '1000', label: '1 000 维' }, { value: '10000', label: '10 000 维' }], '10000')));
    sf.appendChild(UI.formRow('参与方数', UI.selectOf('heSimParties', [2, 3, 4, 5].map(function (n) { return { value: String(n), label: n + ' 方' }; }), '3')));
    sf.appendChild(UI.formRow('定点精度', UI.selectOf('heSimPrec', [2, 4, 6, 8].map(function (n) { return { value: String(n), label: '保留 ' + n + ' 位' }; }), '6')));
    sf.appendChild(UI.formRow('误差容差', UI.selectOf('heSimTol', [
      { value: '1e-3', label: '1e-3' }, { value: '1e-4', label: '1e-4' }, { value: '1e-6', label: '1e-6' }
    ], '1e-4')));
    sf.appendChild(btn('btn-primary', '运行模拟', 'heSimRun'));
    sim.appendChild(sf);
    sim.appendChild(UI.el('span', 'hint', '模拟梯度：每个参与方各生成一组 N(0, 0.02²) 随机梯度（同参数同结果），聚合结果与明文求和逐元素比较。定点精度只对 Paillier 生效。'));
    sim.appendChild(UI.el('div', null)).id = 'heSimOut';
    grid.appendChild(sim);
    sec.appendChild(grid);

    // HE-APP-03 密钥管理
    const km = appCard('HE-APP-03', '密钥管理', '生成、分发、存储、轮换、销毁全生命周期；私钥由平台密钥服务托管');
    const kh = km.querySelector('.he-card-head');
    kh.appendChild(UI.el('span', 'spacer'));
    kh.appendChild(btn('btn-primary', '生成密钥', 'heKeyNew'));
    const pol = UI.el('div', 'he-form');
    const enLb = UI.el('label', 'check-item');
    const en = document.createElement('input');
    en.type = 'checkbox'; en.id = 'hePolEnabled';
    enLb.appendChild(en);
    enLb.appendChild(UI.el('span', null, '启用自动轮换'));
    pol.appendChild(enLb);
    const days = UI.inputOf('hePolDays', 30, 'number');
    days.min = 1; days.max = 365; days.className = 'input input-sm';
    pol.appendChild(UI.formRow('轮换周期（天，1 – 365）', days));
    pol.appendChild(btn('btn-link', '保存策略', 'hePolSave'));
    pol.appendChild(segOf('heKeyFilter', [
      { value: '', label: '全部' }, { value: 'active', label: '使用中' }, { value: 'rotated', label: '已轮换' }, { value: 'destroyed', label: '已销毁' }
    ], ''));
    km.appendChild(pol);
    km.appendChild(UI.el('span', 'hint', '')).id = 'hePolNote';
    km.appendChild(UI.el('div', null)).id = 'heKeyList';
    sec.appendChild(km);

    // HE-APP-05 日志
    const lg = appCard('HE-APP-05', '加解密性能日志', '每个环节的耗时与密文大小，来源为四步全流程、流程测试与同态聚合训练任务');
    const lf = UI.el('div', 'he-form');
    lf.appendChild(UI.formRow('来源', UI.selectOf('heLogSource', [
      { value: '', label: '全部来源' }, { value: 'session', label: '全流程配置' }, { value: 'simulation', label: '流程测试' }, { value: 'fl_job', label: '训练任务' }
    ], '')));
    const refSel = UI.selectOf('heLogRef', [{ value: '', label: '全部任务 / 测试' }], '');
    refSel.style.minWidth = '300px';
    lf.appendChild(UI.formRow('任务 / 测试', refSel));
    lf.appendChild(btn('btn', '刷新', 'heLogRefresh'));
    lf.appendChild(btn('btn-link', '导出 CSV', 'heLogExport'));
    lg.appendChild(lf);
    lg.appendChild(UI.el('div', 'chip-row')).id = 'heLogSummary';
    lg.appendChild(UI.el('div', null)).id = 'heLogList';
    sec.appendChild(lg);

    jobSel.addEventListener('change', renderFl);
    $('heFlEnable').addEventListener('click', enableHe);
    $('heSimRun').addEventListener('click', runSim);
    $('heKeyNew').addEventListener('click', newKeyModal);
    $('hePolSave').addEventListener('click', savePolicy);
    $('heKeyFilter').addEventListener('change', function () { keyFilter = $('heKeyFilter').value(); loadKeys(); });
    $('heLogSource').addEventListener('change', function () { $('heLogRef').value = ''; loadLogs(); });
    $('heLogRef').addEventListener('change', loadLogs);
    $('heLogRefresh').addEventListener('click', function () { loadJobs(); loadLogs(); });
    $('heLogExport').addEventListener('click', exportLogs);
  }

  async function loadApp() {
    try {
      nodes = (await Api.get('/projects/' + projectId + '/nodes')).items || [];
    } catch (e) { nodes = []; }
    UI.clear($('heSimOut'));
    await Promise.all([loadJobs(), loadKeys(), loadLogs()]);
  }

  /* ---------- HE-APP-02 ---------- */

  async function loadJobs(focusId) {
    try {
      jobs = (await Api.get('/projects/' + projectId + '/fl/jobs')).items;
      const sel = $('heFlJob');
      const cur = focusId || sel.value;
      UI.clear(sel);
      jobs.forEach(function (j) {
        const o = document.createElement('option');
        o.value = j.job_id;
        o.textContent = j.name + ' · ' + JOB_ST[j.status] + ' · ' + (j.aggregation === 'he' ? '同态加密聚合' : '秘密共享聚合');
        sel.appendChild(o);
      });
      if (cur && jobs.some(function (j) { return j.job_id === cur; })) sel.value = cur;
      await renderFl();
    } catch (e) { inlineErr($('heFlInfo'), e); }
  }
  function jobOf(id) { return jobs.filter(function (j) { return j.job_id === id; })[0]; }

  async function renderFl() {
    const box = $('heFlInfo');
    const job = jobOf($('heFlJob').value);
    UI.clear(box);
    const b = $('heFlEnable');
    if (!job) { box.appendChild(UI.el('div', 'table-empty', '当前项目还没有训练任务，可在「联邦学习 / 任务编排」新建')); b.disabled = true; return; }
    const isHe = job.aggregation === 'he';
    const switchable = HE_SWITCHABLE.indexOf(job.status) >= 0;
    b.disabled = isHe || !switchable;
    b.textContent = isHe ? '已启用同态加密聚合' : '一键启用同态加密聚合';

    const kv = UI.el('dl', 'he-kv');
    const add = function (k, v) { kv.appendChild(UI.el('dt', null, k)); const dd = UI.el('dd'); dd.appendChild(v instanceof Node ? v : document.createTextNode(v)); kv.appendChild(dd); };
    add('任务状态', JOB_ST[job.status] + '（第 ' + job.current_round + ' / ' + job.total_rounds + ' 轮）');
    add('聚合方式', isHe ? '同态加密聚合（Paillier，各节点上传密文梯度，聚合方密态求和）' : '秘密共享聚合');
    add('参与节点', job.node_ids.join('、'));
    box.appendChild(kv);

    if (!isHe && !switchable) {
      const n = UI.el('div', 'banner-note');
      n.appendChild(UI.el('span', null, '任务当前为「' + JOB_ST[job.status] + '」，只有「已创建 / 已终止 / 失败」状态的任务可以切换聚合方式。' +
        (job.status === 'Success' ? '已完成的任务请在过程管控页重置后再启用。' : '请先在过程管控页终止任务。')));
      const go = btn('btn-link', '去过程管控');
      go.addEventListener('click', function () { App.go('fed', { sub: 'proc', focusJobId: job.job_id }); });
      n.appendChild(go);
      box.appendChild(n);
    }
    if (isHe) {
      try {
        const pk = await Api.get('/fl/jobs/' + job.job_id + '/he-public-key');
        const kk = UI.el('dl', 'he-kv');
        const add2 = function (k, v, cls) { kk.appendChild(UI.el('dt', null, k)); kk.appendChild(UI.el('dd', cls, v)); };
        add2('聚合公钥 ID', pk.key_id);
        // CKKS 的顶层 key_size_bits 是 log₂Q 兼容字段，展示按 N / log₂Q；Paillier 按密钥长度
        add2('方案', (SCHEME_CN[pk.scheme] || pk.scheme) + '，' + keyParamsText({ key_params: pk.poly_modulus_degree
          ? { poly_modulus_degree: pk.poly_modulus_degree, coeff_modulus_bits: pk.coeff_modulus_bits }
          : { key_size_bits: pk.key_size_bits } }));
        add2('公钥指纹', pk.fingerprint, 'he-mono');
        add2('公钥（前 64 位）', pk.public_key.slice(0, 64) + '…', 'he-mono');
        add2('生成时间', UI.datetime(pk.created_at));
        box.appendChild(UI.el('span', 'card-label', '本任务同态聚合公钥（训练开始时下发到各参与节点）'));
        box.appendChild(kk);
      } catch (e) { inlineErr(box, e); }
    }
  }

  async function enableHe() {
    const job = jobOf($('heFlJob').value);
    if (!job) return;
    if (HE_SWITCHABLE.indexOf(job.status) < 0) {
      UI.toast('任务当前为「' + JOB_ST[job.status] + '」，不能切换聚合方式', true);
      return;
    }
    try {
      await Api.patch('/fl/jobs/' + job.job_id, { aggregation: 'he' });
      UI.toast('已为「' + job.name + '」启用同态加密聚合');
      await loadJobs(job.job_id);
      loadLogs();
    } catch (e) { UI.fail(e); }
  }

  /* ---------- HE-APP-03 ---------- */

  async function loadKeys() {
    const box = $('heKeyList');
    try {
      const res = await Api.get('/he/keys', { project_id: projectId, status: keyFilter || undefined });
      $('hePolEnabled').checked = res.policy.enabled;
      $('hePolDays').value = res.policy.period_days;
      $('hePolNote').textContent = res.policy.enabled
        ? '自动轮换已启用：联邦聚合密钥生成满 ' + res.policy.period_days + ' 天自动轮换，新钥继承原分发节点，旧钥只保留用于解密历史密文。流程会话密钥 24 小时后过期。'
        : '自动轮换已关闭：联邦聚合密钥只在手动轮换时更换。';
      renderKeys(box, res.items);
    } catch (e) { inlineErr(box, e); }
  }
  function renderKeys(box, items) {
    UI.clear(box);
    box.appendChild(gridHead('he-key-grid', ['密钥 ID', '方案', '用途', '生成时间', '状态', '已分发节点', '下次自动轮换', '操作']));
    if (!items.length) { box.appendChild(UI.el('div', 'table-empty', '没有符合条件的密钥')); return; }
    const wrap = UI.el('div', 'he-table-scroll');
    items.forEach(function (k) {
      const st = UI.el('span', 'field-col');
      st.style.gap = '2px';
      const ks = KEY_ST[k.status] || KEY_ST.active;
      st.appendChild(UI.el('span', ks[1], ks[0]));
      if (k.rotated_to) st.appendChild(UI.el('span', 'hint-2', '→ ' + k.rotated_to + (ROTATE_CN[k.rotate_reason] ? '（' + ROTATE_CN[k.rotate_reason] + '）' : '')));
      if (k.rotated_from && k.status === 'active') st.appendChild(UI.el('span', 'hint-2', '← ' + k.rotated_from));
      const dist = (k.distributed_to || []).length ? k.distributed_to.map(function (d) { return d.node_id; }).join('、') : '未分发';
      const ops = UI.el('span', 'he-ops');
      if (k.status === 'active') {
        const d = btn('btn-sm', '分发');
        d.addEventListener('click', function () { distributeModal(k); });
        const r = btn('btn-sm', '轮换');
        r.addEventListener('click', function () { rotateKey(k); });
        ops.appendChild(d); ops.appendChild(r);
      }
      if (k.status !== 'destroyed') {
        const x = btn('btn-sm btn-kill', '销毁');
        x.addEventListener('click', function () { destroyModal(k); });
        ops.appendChild(x);
      } else {
        ops.appendChild(UI.el('span', 'hint-2', UI.datetime(k.destroyed_at) + ' 销毁'));
      }
      const params = keyParamsText(k);
      const sch = UI.el('span', 'field-col');
      sch.style.gap = '2px';
      sch.appendChild(UI.el('span', null, SCHEME_CN[k.scheme] || k.scheme_name || k.scheme || '—'));
      sch.appendChild(UI.el('span', 'hint-2', params));
      wrap.appendChild(gridRow('he-key-grid', [
        UI.el('span', 'cell-strong he-mono', k.key_id), sch, PURPOSE_CN[k.purpose] || '—', UI.datetime(k.created_at), st,
        UI.el('span', 'cell-muted', dist), k.next_rotation_at ? UI.datetime(k.next_rotation_at) : '—', ops
      ]));
    });
    box.appendChild(wrap);
  }
  /**
   * 密钥参数展示：CKKS / BGV 显示「N=8192 · log₂Q=200 bit」（coeff_modulus_bits 可为总位数或各素数位数数组），
   * Paillier 显示密钥长度。不读顶层 key_size_bits（CKKS 时它是 log₂Q 的兼容字段）。
   */
  function keyParamsText(k) {
    const kp = k.key_params || {};
    if (kp.poly_modulus_degree) {
      const q = Array.isArray(kp.coeff_modulus_bits)
        ? kp.coeff_modulus_bits.reduce(function (s, x) { return s + Number(x || 0); }, 0) : kp.coeff_modulus_bits;
      return 'N=' + kp.poly_modulus_degree + (q ? ' · log₂Q=' + q + ' bit' : '');
    }
    if (kp.key_size_bits) return '密钥长度 ' + kp.key_size_bits + ' bit';
    return kp.parameter_set || '默认参数';
  }
  function newKeyModal() {
    const body = UI.el('div', 'field-col');
    body.style.gap = '14px';
    const sch = UI.selectOf('heNkScheme', [
      { value: 'paillier', label: 'Paillier（半同态，联邦聚合默认）' }, { value: 'ckks', label: 'CKKS（全同态，浮点）' },
      { value: 'bgv', label: 'BGV（全同态，整数）' }, { value: 'tfhe', label: 'TFHE（全同态，整数电路）' }
    ], 'paillier');
    const size = UI.selectOf('heNkSize', [{ value: '2048', label: '2048 bit（约 112 位安全）' }, { value: '3072', label: '3072 bit（128 位安全）' }, { value: '4096', label: '4096 bit' }], '3072');
    const sizeRow = UI.formRow('Paillier 密钥长度', size);
    sch.addEventListener('change', function () { sizeRow.hidden = sch.value !== 'paillier'; });
    const checks = nodeChecks(nodes.map(function (n) { return n.node_id; }));
    body.appendChild(UI.formRow('加密方案', sch));
    body.appendChild(sizeRow);
    body.appendChild(UI.formRow('分发到节点', checks, '生成后立即把公钥分发到所选节点；私钥留在平台密钥服务'));
    UI.modal({
      title: '生成联邦聚合密钥', body: body, submitText: '生成',
      onSubmit: async function () {
        const req = { scheme: sch.value, project_id: projectId, purpose: 'fl_aggregation', node_ids: checks.picked() };
        if (sch.value === 'paillier') req.key_params = { key_size_bits: Number(size.value) };
        const k = await Api.post('/he/keys', req);
        const sup = k.superseded_key_ids || [];
        UI.toast('已生成密钥 ' + k.key_id + '，分发到 ' + k.distributed_to.length + ' 个节点' +
          (sup.length ? '；原在用聚合密钥 ' + sup.join('、') + ' 已标记为已轮换（一个项目只保留一把在用聚合密钥）' : ''));
        loadKeys();
      }
    });
  }
  function distributeModal(k) {
    const have = (k.distributed_to || []).map(function (d) { return d.node_id; });
    const checks = nodeChecks(have);
    const body = UI.formRow('分发到节点', checks, '已分发的节点保持不变，新勾选的节点追加分发');
    UI.modal({
      title: '分发公钥 · ' + k.key_id, body: body, submitText: '分发',
      onSubmit: async function () {
        const r = await Api.post('/he/keys/' + k.key_id + '/distribute', { node_ids: checks.picked() });
        UI.toast(k.key_id + ' 已分发到 ' + r.distributed_to.length + ' 个节点');
        loadKeys();
      }
    });
  }
  async function rotateKey(k) {
    try {
      const r = await Api.post('/he/keys/' + k.key_id + '/rotate', {});
      UI.toast('已轮换：新密钥 ' + r.new_key.key_id + ' 生效，' + k.key_id + ' 标记为已轮换');
      loadKeys();
    } catch (e) { UI.fail(e); }
  }
  function destroyModal(k) {
    const body = UI.el('div', 'hint', '销毁后 ' + k.key_id + ' 及其下所有密文被删除，用它加密的数据将无法再解密。此操作不可撤销。');
    body.style.fontSize = '13px';
    body.style.lineHeight = '22px';
    UI.modal({
      title: '确认销毁密钥', body: body, submitText: '确认销毁',
      onSubmit: async function () {
        await Api.del('/he/keys/' + k.key_id);
        if (key && key.key_id === k.key_id) { key = null; resetFlow(); }
        UI.toast('已销毁密钥 ' + k.key_id);
        loadKeys();
      }
    });
  }
  async function savePolicy() {
    try {
      await Api.put('/projects/' + projectId + '/he/rotation-policy', {
        enabled: $('hePolEnabled').checked, period_days: Number($('hePolDays').value)
      });
      UI.toast('轮换策略已保存');
      loadKeys();
    } catch (e) { UI.fail(e); }
  }

  /* ---------- HE-APP-04 ---------- */

  async function runSim() {
    const out = $('heSimOut');
    const scheme = $('heSimScheme').value();
    const body = {
      scheme: scheme, dim: Number($('heSimDim').value()), parties: Number($('heSimParties').value),
      tolerance: Number($('heSimTol').value)
    };
    if (scheme === 'paillier') body.precision = Number($('heSimPrec').value);
    try {
      const r = await Api.post('/projects/' + projectId + '/he/simulations', body);
      renderSim(out, r);
      loadLogs();
    } catch (e) { inlineErr(out, e); }
  }
  function renderSim(out, r) {
    UI.clear(out);
    const ban = UI.el('div', 'banner ' + (r.passed ? 'banner-ok' : 'banner-err'));
    ban.style.flexDirection = 'column';
    ban.style.alignItems = 'flex-start';
    ban.style.gap = '4px';
    ban.appendChild(UI.el('b', null, r.passed ? '模拟通过，可以正式训练' : '模拟未通过，请调整参数'));
    ban.appendChild(UI.el('span', null, r.conclusion));
    out.appendChild(ban);
    const steps = UI.el('div', 'he-steps-row he-steps-2');
    r.steps.forEach(function (s, i) {
      const st = UI.el('div', 'he-flow-step');
      st.appendChild(UI.el('b', null, (i + 1) + '. ' + s.label + '　' + s.elapsed_ms + ' ms'));
      st.appendChild(UI.el('span', null, s.detail + (s.ciphertext_kb !== null ? '；' + s.ciphertext_count + ' 条密文共 ' + s.ciphertext_kb + ' KB' : '')));
      steps.appendChild(st);
    });
    out.appendChild(steps);
    r.checks.forEach(function (c) {
      const line = UI.el('div', 'he-check-row');
      const ic = UI.el('span', c.passed ? 'he-ok' : 'he-bad');
      ic.innerHTML = c.passed ? ICON_OK : ICON_NO;
      line.appendChild(ic);
      line.appendChild(UI.el('span', 'cell-strong', c.name));
      line.appendChild(UI.el('span', 'cell-muted', c.detail));
      out.appendChild(line);
    });
    out.appendChild(UI.el('span', 'hint', '平均绝对误差 ' + r.mean_abs_error.toExponential(2) + '（' + r.dim.toLocaleString('zh-CN') + ' 维逐元素 |聚合解密值 − 明文求和| 的均值）；' +
      '全流程墙钟耗时 ' + r.total_elapsed_ms + ' ms（' + r.parties + ' 个参与方在各自节点同时加密，加密计一次' +
      (r.scheme === 'paillier' ? '；Paillier 按节点 16 线程批处理、CRT 解密' : '') + '）。'));
  }

  /* ---------- HE-APP-05 ---------- */

  function logQuery() {
    return { source: $('heLogSource').value || undefined, ref_id: $('heLogRef').value || undefined };
  }
  async function loadLogs() {
    const box = $('heLogList');
    try {
      const res = await Api.get('/projects/' + projectId + '/he/logs', logQuery());
      logRefs = res.refs;
      const sel = $('heLogRef');
      const cur = sel.value;
      UI.clear(sel);
      const all = document.createElement('option');
      all.value = ''; all.textContent = '全部任务 / 测试';
      sel.appendChild(all);
      const src = $('heLogSource').value;
      logRefs.filter(function (r) { return !src || r.source === src; }).forEach(function (r) {
        const o = document.createElement('option');
        o.value = r.ref_id;
        o.textContent = LOG_SRC[r.source][0] + '：' + r.ref_name;
        sel.appendChild(o);
      });
      sel.value = cur && logRefs.some(function (r) { return r.ref_id === cur; }) ? cur : '';
      renderLogs2(box, res);
    } catch (e) { inlineErr(box, e); }
  }
  const LOG_SRC = { fl_job: ['训练任务', 'tag tag-cls'], simulation: ['流程测试', 'tag tag-ts'], session: ['全流程配置', 'tag'] };
  const STAGE_CN = { keygen: '密钥生成', encrypt: '加密', aggregate: '密态聚合', decrypt: '解密', evaluate: '密态运算' };
  function renderLogs2(box, res) {
    const sum = $('heLogSummary');
    UI.clear(sum);
    res.summary.forEach(function (s) {
      sum.appendChild(UI.el('span', 'chip', STAGE_CN[s.stage] + ' ' + s.count + ' 次，平均 ' + s.avg_elapsed_ms + ' ms / 次' +
        (s.total_ciphertext_kb ? '，密文合计 ' + s.total_ciphertext_kb.toLocaleString('zh-CN') + ' KB' : '')));
    });
    UI.clear(box);
    box.appendChild(gridHead('he-log-grid', ['来源', '任务 / 测试', '轮次', '环节', '节点 / 参与方', '耗时（ms）', '密文大小（KB）', '密文条数', '记录时间']));
    if (!res.items.length) {
      box.appendChild(UI.el('div', 'table-empty', '暂无日志：完成页面顶部四步流程、运行「流程测试模拟」，或启动已启用同态加密聚合的训练任务后自动记录'));
      return;
    }
    const items = res.items.slice().sort(function (a, b) {
      return Date.parse(b.recorded_at) - Date.parse(a.recorded_at) || (b.round || 0) - (a.round || 0);
    });
    const LIMIT = 200;
    const wrap = UI.el('div', 'he-table-scroll');
    items.slice(0, LIMIT).forEach(function (x) {
      wrap.appendChild(gridRow('he-log-grid he-num', [
        UI.el('span', LOG_SRC[x.source][1], LOG_SRC[x.source][0]),
        UI.el('span', 'cell-muted', x.ref_name), x.round === null ? '—' : String(x.round), x.stage_label, x.party,
        UI.el('span', 'cell-strong', String(x.elapsed_ms)), x.ciphertext_kb === null ? '—' : String(x.ciphertext_kb),
        x.ciphertext_count === null ? '—' : String(x.ciphertext_count), UI.datetime(x.recorded_at)
      ]));
    });
    box.appendChild(wrap);
    box.appendChild(UI.el('span', 'hint', '共 ' + res.total + ' 条' + (res.total > LIMIT ? '，页面显示最近 ' + LIMIT + ' 条，完整数据请导出 CSV' : '') +
      '。计算口径：' + res.timing_basis + '。'));
  }
  async function exportLogs() {
    try {
      const name = await Api.download('/projects/' + projectId + '/he/logs/export', { query: logQuery() });
      if (name) UI.toast('已导出 ' + name);
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c) {
    // App 的 ctx 是同一个对象，换项目时 projectId 已被改写，用上次 mount 记下的值判断
    if (projectId && projectId !== c.projectId && stage > 0) { destroyKey(); resetFlow(); }
    ctx = c;
    projectId = c.projectId;
    bindOnce();
    buildApp();
    loadApp();
    try {
      if (!schemes.length) {
        const res = await Api.get('/he/schemes');
        schemes = res.items;
        const sel = $('heAlgo');
        UI.clear(sel);
        schemes.forEach(function (s) {
          const o = document.createElement('option');
          o.value = s.scheme;
          o.textContent = s.name + '（' + s.description + '）';
          sel.appendChild(o);
        });
        sel.value = 'ckks';
      }
      renderConfig();
      renderSteps();
      renderLogs();
    } catch (e) { UI.fail(e); }
  }

  function unmount() { /* 无长连接 */ }

  window.HE = { mount: mount, unmount: unmount };
})();
