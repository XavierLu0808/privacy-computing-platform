/** 同态加密模块。接口见 API.md §3。 */
(function () {
  'use strict';
  const $ = UI.$;

  const STEP_NAMES = ['密钥对生成', '加密', '密态运算', '解密'];

  let ctx = null;
  let schemes = [];
  let stage = 0;           // 0..4
  let key = null;
  let cipherA = null, cipherB = null, resultCt = null;
  let logs = [];
  let totalMs = 0;
  let booted = false;

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
          (res.session_summary.logged ? '已记入训练日志。' : '未记入日志。');
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

  /* ---------- 生命周期 ---------- */

  async function mount(c) {
    ctx = c;
    bindOnce();
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
