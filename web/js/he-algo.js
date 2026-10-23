/**
 * 同态加密 / 算法管理（#/he/algo）。接口见 docs/api/he.md。
 * 功能块：算法目录（HE-ALGO-01/02）、底层库配置（03）、运算验证（04/05）、数据类型转换与精度（06/07）、参数寻优（08）。
 */
(function () {
  'use strict';
  const el = UI.el;

  const OPS_CN = { add_ct_ct: '密文 + 密文', mul_ct_pt: '密文 × 明文', mul_ct_ct: '密文 × 密文' };
  const MODE_CN = { integer: '整数直接加密', fixed_point: '浮点自动定点化', ckks_native: 'CKKS 原生浮点编码', native: 'CKKS 原生浮点编码' };
  const PRESETS = {
    int: { a: '1200, 860, 455', b: '3, 2, 5', note: '整数示例：三家冶炼厂月产量（吨）× 系数' },
    float: { a: '41.2356, 0.6821, 0.3957', b: '1.035, 0.982, 1.012', note: '浮点示例：氧化钕 Nd₂O₃ / 氧化铈 CeO₂ / 氧化镧 La₂O₃ 均价（万元/吨）× 调价系数' }
  };
  const ICON_OK = '<svg class="he-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"></path></svg>';

  let ctx = null, root = null, built = false;
  let algos = [], libs = null, config = null;
  const $q = function (sel) { return root.querySelector(sel); };

  /* ---------- 工具 ---------- */

  function num(x) {
    if (x === null || x === undefined) return '—';
    return String(Number(Number(x).toPrecision(12)));
  }
  function errStr(e) { return e === 0 ? '0' : Number(e).toExponential(2); }
  /** 工具类操作的校验失败直接写在结果区，不弹 toast（输入改一下就会重算）。 */
  function showErr(out, e) {
    UI.clear(out);
    out.appendChild(el('div', 'banner banner-err', '未能完成：' + ((e && e.message) || '请求失败') + (e && e.code ? '（错误码 ' + e.code + '）' : '')));
  }
  function algoOf(s) { return algos.filter(function (a) { return a.scheme === s; })[0]; }
  function libOf(l) { return libs.items.filter(function (x) { return x.library === l; })[0]; }
  function splitList(s) { return String(s).split(/[,，\s]+/).filter(function (x) { return x !== ''; }); }
  function head(cls, cols) {
    const h = el('div', 'table-head ' + cls);
    cols.forEach(function (c) { h.appendChild(el('span', null, c)); });
    return h;
  }
  function row(cls, cells) {
    const r = el('div', 'table-row ' + cls);
    cells.forEach(function (c) { r.appendChild(c instanceof Node ? c : el('span', null, c)); });
    return r;
  }
  function selectEl(id, options, value, cls) {
    const s = UI.selectOf(id, options, value);
    if (cls) s.className = cls;
    return s;
  }
  function field(label, control, hint) { return UI.formRow(label, control, hint); }
  function card(acc, title, desc) {
    const c = el('div', 'card card-lg');
    c.dataset.acc = acc;
    const h = el('div', 'he-card-head');
    h.appendChild(el('span', 'card-title', title));
    if (desc) h.appendChild(el('span', 'hint', desc));
    c.appendChild(h);
    return c;
  }

  /* ---------- 骨架 ---------- */

  function build() {
    built = true;
    UI.clear(root);
    const ph = el('div', 'page-head');
    const pt = el('div', 'page-head-text');
    pt.appendChild(el('span', 'crumb', '同态加密 / 算法管理'));
    pt.appendChild(el('h1', null, '同态加密算法管理'));
    ph.appendChild(pt);
    root.appendChild(ph);

    // 算法目录
    const cat = card('HE-ALGO-01 HE-ALGO-02', '算法目录', '半同态 Paillier 与全同态 CKKS / BGV / TFHE，安全强度按经典攻击下的等效比特数');
    cat.appendChild(el('div', null)).id = 'heaCatalog';
    root.appendChild(cat);

    // 底层库配置
    const cfg = card('HE-ALGO-03', '加密算法配置', '切换底层库，保存为当前项目的默认方案；库不支持的方案会被拒绝');
    const f = el('div', 'he-form');
    f.appendChild(field('默认方案', selectEl('heaCfgScheme', [], undefined)));
    f.appendChild(field('底层库', selectEl('heaCfgLib', [], undefined)));
    const pin = UI.inputOf('heaCfgPrec', 4, 'number');
    pin.min = 0; pin.max = 8; pin.className = 'input input-sm';
    f.appendChild(field('默认保留小数位', pin));
    const save = el('button', 'btn-primary', '保存为项目默认');
    save.type = 'button'; save.id = 'heaCfgSave';
    f.appendChild(save);
    cfg.appendChild(f);
    cfg.appendChild(el('span', 'hint', '')).id = 'heaCfgNote';
    cfg.appendChild(el('div', null)).id = 'heaMatrix';
    root.appendChild(cfg);

    // 运算验证
    const ver = card('HE-ALGO-04 HE-ALGO-05', '运算验证', '输入一组数，走 加密 → 密态运算 → 解密，与明文直接计算比较误差');
    const vf = el('div', 'he-form');
    vf.appendChild(field('方案', selectEl('heaVScheme', [], undefined)));
    vf.appendChild(field('密态运算', selectEl('heaVOp', [
      { value: 'add', label: '密文加法 A ⊕ B' }, { value: 'mul', label: '密文乘法 A ⊗ B' }, { value: 'mul_plain', label: '明文数乘 A ⊗ b' }
    ], 'mul')));
    const vp = UI.inputOf('heaVPrec', 4, 'number');
    vp.min = 0; vp.max = 8; vp.className = 'input input-sm';
    vf.appendChild(field('定点精度（小数位）', vp));
    const va = UI.inputOf('heaVA', PRESETS.float.a); va.className = 'input input-wide';
    const vb = UI.inputOf('heaVB', PRESETS.float.b); vb.className = 'input input-wide';
    vf.appendChild(field('操作数 A（逗号分隔）', va));
    vf.appendChild(field('操作数 B（与 A 等长；数乘可只填 1 个）', vb));
    ver.appendChild(vf);
    const vb2 = el('div', 'chip-row');
    [['int', '整数示例'], ['float', '浮点示例']].forEach(function (p) {
      const b = el('button', 'btn-sm', p[1]);
      b.type = 'button'; b.dataset.preset = p[0];
      vb2.appendChild(b);
    });
    const run = el('button', 'btn-primary', '运行验证');
    run.type = 'button'; run.id = 'heaVRun';
    vb2.appendChild(run);
    vb2.appendChild(el('span', 'hint', PRESETS.float.note)).id = 'heaVPresetNote';
    ver.appendChild(vb2);
    ver.appendChild(el('div', null)).id = 'heaVOut';
    root.appendChild(ver);

    // 数据类型自动转换 + 精度
    const enc = card('HE-ALGO-06 HE-ALGO-07', '数据类型自动转换与精度设置', '底层只支持整数的方案收到浮点数时，平台自动转为定点整数');
    const ef = el('div', 'he-form');
    ef.appendChild(field('目标方案', selectEl('heaEScheme', [], 'bgv')));
    const ev = UI.inputOf('heaEVals', PRESETS.float.a); ev.className = 'input input-wide';
    ef.appendChild(field('输入数值（逗号分隔）', ev));
    const rg = el('div', 'he-prec-row');
    const range = UI.inputOf('heaEPrec', 4, 'range');
    range.className = ''; range.min = 0; range.max = 8; range.step = 1; range.style.width = '200px';
    range.setAttribute('aria-label', '保留小数位');
    rg.appendChild(range);
    rg.appendChild(el('span', 'he-prec-val', '4')).id = 'heaEPrecVal';
    ef.appendChild(field('保留小数位（0 – 8）', rg));
    const setDef = el('button', 'btn-link', '设为项目默认精度');
    setDef.type = 'button'; setDef.id = 'heaESetDefault';
    ef.appendChild(setDef);
    enc.appendChild(ef);
    enc.appendChild(el('div', null)).id = 'heaEOut';
    root.appendChild(enc);

    // 参数寻优
    const opt = card('HE-ALGO-08', '密态计算参数智能寻优（CKKS）', '按安全强度、乘法深度、精度需求与批大小推荐多项式阶数 N、模数链与缩放因子 Δ');
    const of = el('div', 'he-form');
    of.appendChild(field('安全强度', selectEl('heaOSec', [
      { value: '128', label: '128 位' }, { value: '192', label: '192 位' }, { value: '256', label: '256 位' }
    ], '128', 'select select-lg')));
    [['heaODepth', '乘法深度（1 – 30）', 2, 1, 30], ['heaODigits', '精度需求（小数位 1 – 8）', 6, 1, 8], ['heaOBatch', '批大小（每条密文的数值个数）', 4096, 1, 16384]].forEach(function (x) {
      const i = UI.inputOf(x[0], x[2], 'number');
      i.min = x[3]; i.max = x[4]; i.className = 'input input-sm';
      of.appendChild(field(x[1], i));
    });
    const go = el('button', 'btn-primary', '开始寻优');
    go.type = 'button'; go.id = 'heaORun';
    of.appendChild(go);
    opt.appendChild(of);
    opt.appendChild(el('div', null)).id = 'heaOOut';
    root.appendChild(opt);

    bind();
  }

  function bind() {
    $q('#heaCfgScheme').addEventListener('change', function () { fillLibSelect(); renderCfgNote(); renderMatrix(); });
    $q('#heaCfgLib').addEventListener('change', function () { renderCfgNote(); renderMatrix(); });
    $q('#heaCfgSave').addEventListener('click', saveConfig);
    $q('#heaVRun').addEventListener('click', runVerify);
    $q('#heaVScheme').addEventListener('change', syncOps);
    root.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        const p = PRESETS[b.dataset.preset];
        $q('#heaVA').value = p.a; $q('#heaVB').value = p.b;
        $q('#heaVPresetNote').textContent = p.note;
        runVerify();
      });
    });
    const encDebounced = UI.debounce(runEncode, 250);
    $q('#heaEScheme').addEventListener('change', runEncode);
    $q('#heaEVals').addEventListener('input', encDebounced);
    $q('#heaEPrec').addEventListener('input', function () { $q('#heaEPrecVal').textContent = $q('#heaEPrec').value; encDebounced(); });
    $q('#heaESetDefault').addEventListener('click', savePrecision);
    $q('#heaORun').addEventListener('click', runOptimize);
  }

  /* ---------- 算法目录 ---------- */

  function renderCatalog() {
    const box = $q('#heaCatalog');
    UI.clear(box);
    box.appendChild(head('hea-algo-grid', ['方案', '类型', '支持运算', '明文类型', '安全强度', '可用底层库', '典型参数']));
    algos.forEach(function (a) {
      const sec = el('span', 'field-col');
      sec.style.gap = '2px';
      sec.appendChild(el('span', 'cell-strong', a.security_bits + ' 位'));
      sec.appendChild(el('span', 'hint-2', a.security_note));
      const fam = el('span', 'tag ' + (a.family === 'phe' ? 'tag-ts' : 'tag-cls'), a.family_label);
      box.appendChild(row('hea-algo-grid', [
        el('span', 'cell-strong', a.name), fam,
        a.supported_ops.map(function (o) { return OPS_CN[o]; }).join('、'),
        a.plaintext_label, sec,
        a.libraries.map(function (l) { return libOf(l).name; }).join('；'),
        el('span', 'cell-muted', a.typical_params)
      ]));
    });
  }

  /* ---------- 底层库配置 ---------- */

  function fillSchemeSelect(id, value, filter) {
    const s = $q('#' + id);
    const cur = value || s.value;
    UI.clear(s);
    algos.filter(filter || function () { return true; }).forEach(function (a) {
      const o = document.createElement('option');
      o.value = a.scheme; o.textContent = a.name + '（' + a.family_label + '）';
      s.appendChild(o);
    });
    if (cur && algoOf(cur)) s.value = cur;
  }
  function fillLibSelect(value) {
    const s = $q('#heaCfgLib');
    const cur = value || s.value;
    UI.clear(s);
    const scheme = $q('#heaCfgScheme').value;
    libs.items.forEach(function (l) {
      const o = document.createElement('option');
      o.value = l.library;
      o.textContent = l.name + (l.matrix[scheme] ? '' : '（不支持该方案）');
      s.appendChild(o);
    });
    s.value = cur && libOf(cur) ? cur : algoOf(scheme).default_library;
  }
  function renderCfgNote() {
    const note = $q('#heaCfgNote');
    const s = $q('#heaCfgScheme').value, l = libOf($q('#heaCfgLib').value);
    const saved = config.updated_at ? '（最近保存 ' + UI.datetime(config.updated_at) + '）' : '（尚未保存，使用平台默认）';
    note.className = 'hint';
    if (!l.matrix[s]) {
      note.className = 'hint he-bad';
      note.textContent = l.name + ' 不支持 ' + algoOf(s).name + '，保存会被拒绝。可选：' +
        libs.items.filter(function (x) { return x.matrix[s]; }).map(function (x) { return x.name; }).join(' / ');
      return;
    }
    note.textContent = '当前项目默认：' + algoOf(config.scheme).name + ' · ' + libOf(config.library).name +
      ' · 保留 ' + config.precision + ' 位小数' + saved;
  }
  function renderMatrix() {
    const box = $q('#heaMatrix');
    UI.clear(box);
    const cols = ['底层库', '语言'].concat(libs.schemes.map(function (s) { return algoOf(s).name; })).concat(['说明']);
    box.appendChild(head('hea-lib-grid', cols));
    const selS = $q('#heaCfgScheme').value, selL = $q('#heaCfgLib').value;
    libs.items.forEach(function (l) {
      const cells = [el('span', 'cell-strong', l.name), el('span', 'cell-muted', l.language)];
      libs.schemes.forEach(function (s) {
        if (!l.matrix[s]) { cells.push(el('span', 'hea-cell-no', '不支持')); return; }
        const b = el('button', 'hea-cell-btn' + (s === selS && l.library === selL ? ' on' : ''));
        b.type = 'button';
        b.innerHTML = ICON_OK;
        b.appendChild(document.createTextNode('支持'));
        b.setAttribute('aria-label', '选择 ' + l.name + ' · ' + algoOf(s).name);
        b.addEventListener('click', function () {
          $q('#heaCfgScheme').value = s;
          fillLibSelect(l.library);
          renderCfgNote(); renderMatrix();
        });
        cells.push(b);
      });
      cells.push(el('span', 'hint', l.note));
      box.appendChild(row('hea-lib-grid', cells));
    });
  }
  async function saveConfig() {
    try {
      config = await Api.put('/projects/' + ctx.projectId + '/he/config', {
        scheme: $q('#heaCfgScheme').value, library: $q('#heaCfgLib').value, precision: Number($q('#heaCfgPrec').value)
      });
      UI.toast('已保存为项目默认：' + algoOf(config.scheme).name + ' · ' + libOf(config.library).name);
      renderCfgNote();
    } catch (e) { UI.fail(e); }
  }
  async function savePrecision() {
    try {
      config = await Api.put('/projects/' + ctx.projectId + '/he/config', {
        scheme: config.scheme, library: config.library, precision: Number($q('#heaEPrec').value)
      });
      $q('#heaCfgPrec').value = config.precision;
      UI.toast('项目默认精度已设为保留 ' + config.precision + ' 位小数');
      renderCfgNote();
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 运算验证 ---------- */

  function syncOps() {
    const a = algoOf($q('#heaVScheme').value);
    const op = $q('#heaVOp');
    const mulOpt = op.querySelector('option[value="mul"]');
    mulOpt.disabled = a.supported_ops.indexOf('mul_ct_ct') < 0;
    mulOpt.textContent = mulOpt.disabled ? '密文乘法 A ⊗ B（' + a.name + ' 不支持）' : '密文乘法 A ⊗ B';
    if (mulOpt.disabled && op.value === 'mul') op.value = 'mul_plain';
  }
  async function runVerify() {
    const out = $q('#heaVOut');
    const scheme = $q('#heaVScheme').value;
    const body = {
      scheme: scheme, op: $q('#heaVOp').value, precision: Number($q('#heaVPrec').value),
      a: splitList($q('#heaVA').value), b: splitList($q('#heaVB').value)
    };
    if (config && config.scheme === scheme) body.library = config.library;
    try {
      const r = await Api.post('/he/verify', body);
      renderVerify(out, r);
    } catch (e) { showErr(out, e); }
  }
  function renderVerify(out, r) {
    UI.clear(out);
    const steps = el('div', 'he-steps-row');
    r.steps.forEach(function (s, i) {
      const st = el('div', 'he-flow-step');
      st.appendChild(el('b', null, (i + 1) + '. ' + s.label + '　' + s.elapsed_ms + ' ms'));
      st.appendChild(el('span', null, s.detail + (s.size_kb !== null ? '；密文 ' + s.size_kb + ' KB' : '')));
      steps.appendChild(st);
    });
    out.appendChild(steps);

    const lib = libOf(r.library);
    let how = MODE_CN[r.mode];
    if (r.mode === 'fixed_point') {
      how += '：A × 10^' + r.scale_exponent_a + '、B × 10^' + r.scale_exponent_b + ' 取整后加密，结果缩放 10^' + r.result_scale_exponent + '，解密后除回';
    } else if (r.mode === 'ckks_native') {
      how += '：缩放因子 Δ = 2^' + r.ckks_scale_bits + '，结果为近似值';
    }
    const ban = el('div', 'banner-note');
    ban.appendChild(el('span', null, algoOf(r.scheme).name + ' · ' + (lib ? lib.name : r.library) + ' · ' + r.op_label + '。' + how +
      '。最大绝对误差 ' + errStr(r.max_abs_error) + '（逐元素 |解密值 − 明文直接计算值| 的最大值）；五步合计耗时 ' + r.total_elapsed_ms + ' ms。'));
    out.appendChild(ban);

    const fixed = r.mode === 'fixed_point';
    out.appendChild(head('hea-verify-grid', ['#', 'A', 'B', '明文直接计算', fixed ? '编码后整数（A, B → 结果）' : '编码', '解密还原值', '绝对误差']));
    r.rows.forEach(function (x) {
      out.appendChild(row('hea-verify-grid he-num', [
        String(x.index), x.a, x.b, num(x.expected),
        el('span', 'he-mono', fixed ? x.encoded_a + ', ' + x.encoded_b + ' → ' + x.encoded_result : (r.mode === 'integer' ? '原整数' : 'CKKS 槽位')),
        el('span', 'cell-strong', num(x.decrypted)),
        el('span', x.abs_error === 0 ? 'he-ok' : 'cell-muted', errStr(x.abs_error))
      ]));
    });
  }

  /* ---------- 数据类型转换与精度 ---------- */

  async function runEncode() {
    const out = $q('#heaEOut');
    const p = Number($q('#heaEPrec').value);
    try {
      const r = await Api.post('/he/encode', { scheme: $q('#heaEScheme').value, values: splitList($q('#heaEVals').value), precision: p });
      renderEncode(out, r);
    } catch (e) { showErr(out, e); }
  }
  function renderEncode(out, r) {
    UI.clear(out);
    const a = algoOf(r.scheme);
    const ban = el('div', r.converted ? 'banner-note' : 'banner-note');
    let text = r.note + '。';
    if (r.plaintext_space) text += a.name + ' 明文空间 ' + r.plaintext_space.label + '。';
    if (r.overflow) text += '当前精度下编码整数超出明文空间，加密会被拒绝，请降低精度。';
    ban.appendChild(el('span', r.overflow ? 'he-bad' : null, text));
    out.appendChild(ban);
    if (r.mode === 'native') return;

    const split = el('div', 'hea-split');
    const left = el('div', 'card');
    left.appendChild(el('span', 'card-label', '当前精度：保留 ' + r.precision + ' 位小数，缩放因子 ' + r.scale_factor.toLocaleString('zh-CN')));
    left.appendChild(head('hea-enc-grid', ['输入值', '缩放因子', '编码后整数', '位数', '解码还原值', '量化误差']));
    r.items.forEach(function (x) {
      left.appendChild(row('hea-enc-grid he-num', [x.input, r.scale_factor.toLocaleString('zh-CN'), el('span', 'he-mono', x.encoded_integer),
        x.encoded_bits + ' bit', el('span', 'cell-strong', x.decoded), el('span', x.abs_error === 0 ? 'he-ok' : 'cell-muted', errStr(x.abs_error))]));
    });
    left.appendChild(el('span', 'hint', '量化误差 = |解码还原值 − 输入值|，四舍五入保证不超过 0.5 × 10^-p'));
    split.appendChild(left);

    const right = el('div', 'card');
    right.dataset.acc = 'HE-ALGO-07';
    right.appendChild(el('span', 'card-label', '精度对误差的影响（同一组输入，0 – 8 位逐档计算）'));
    right.appendChild(head('hea-sweep-grid', ['保留小数位', '缩放因子', '最大量化误差', '理论上界', '编码最大位数', '加法（不溢出）', '同精度相乘后']));
    r.sweep.forEach(function (s) {
      const bar = el('span', 'bar hea-errbar');
      const fill = el('i');
      // 误差量级条：10^0 → 0%，10^-9 → 100%，越长代表误差越小
      const lv = s.max_abs_error === 0 ? 1 : Math.min(1, Math.max(0, -Math.log10(s.max_abs_error) / 9));
      fill.style.width = (lv * 100).toFixed(0) + '%';
      bar.appendChild(fill);
      const errCell = el('span', 'field-col');
      errCell.style.gap = '4px';
      errCell.appendChild(el('span', null, errStr(s.max_abs_error)));
      errCell.appendChild(bar);
      right.appendChild(row('hea-sweep-grid he-num' + (s.precision === r.precision ? ' he-hl' : ''), [
        String(s.precision), s.scale_factor.toLocaleString('zh-CN'), errCell, errStr(s.error_bound), s.max_encoded_bits + ' bit',
        el('span', s.overflow ? 'he-bad' : 'he-ok', s.overflow ? '溢出，拒绝加密' : '可表示'),
        el('span', s.mul_overflow ? 'he-warn' : 'he-ok', s.mul_overflow ? '乘积溢出，仅可做加法' : '可表示')
      ]));
    });
    right.appendChild(el('span', 'hint', '精度每加 1 位，误差上界缩小 10 倍，编码位数约增加 3.3 bit；高亮行为当前选择。'));
    split.appendChild(right);
    out.appendChild(split);
  }

  /* ---------- 参数寻优 ---------- */

  async function runOptimize() {
    const out = $q('#heaOOut');
    try {
      const r = await Api.post('/he/param-optimize', {
        security_bits: Number($q('#heaOSec').value), mult_depth: Number($q('#heaODepth').value),
        precision_digits: Number($q('#heaODigits').value), batch_size: Number($q('#heaOBatch').value)
      });
      renderOptimize(out, r);
    } catch (e) { showErr(out, e); }
  }
  function metric(name, value, sub) {
    const m = el('div', 'metric');
    m.appendChild(el('span', 'metric-name', name));
    m.appendChild(el('span', 'metric-value he-num', value));
    m.appendChild(el('span', 'metric-sub', sub));
    return m;
  }
  function renderOptimize(out, r) {
    UI.clear(out);
    const b = r.recommended;
    const g = el('div', 'hea-metric5');
    g.appendChild(metric('多项式阶数 N', b.poly_modulus_degree.toLocaleString('zh-CN'), '槽位 ' + b.slots.toLocaleString('zh-CN') + ' 个（N / 2），满足批大小 ' + r.input.batch_size));
    g.appendChild(metric('模数链（bit）', '[' + b.coeff_modulus_bits.join(', ') + ']', '总模数 ' + b.total_modulus_bits + ' bit，' + r.input.security_bits + ' 位安全上限 ' + b.max_modulus_bits + ' bit'));
    g.appendChild(metric('缩放因子 Δ', '2^' + b.scale_bits, '整数部分可用 ' + b.integer_bits + ' bit，小数精度 ' + r.input.precision_digits + ' 位'));
    g.appendChild(metric('单次运算耗时（估算）', b.est_add_ms + ' / ' + b.est_mul_ms + ' ms', '密文加法 / 密文乘法（含重线性化、重缩放）'));
    g.appendChild(metric('单条密文大小', b.ciphertext_kb + ' KB', '2 × N × ' + (b.coeff_modulus_bits.length - 1) + ' 个素数 × 8 字节'));
    out.appendChild(g);

    out.appendChild(el('span', 'card-label', '候选方案对比'));
    out.appendChild(head('hea-cand-grid', ['N', '模数链（bit）', '总模数 / 上限', '余量', '槽位', '加法（ms）', '乘法（ms）', '密文（KB）', '结论']));
    r.candidates.forEach(function (c) {
      const verdict = c.recommended ? el('span', 'he-ok', '推荐：满足约束的最小 N，性能最优')
        : (c.feasible ? el('span', 'cell-muted', '可行：安全余量更大，耗时与密文约增加 1 倍以上') : el('span', 'he-bad', '不可行：' + c.reasons.join('；')));
      out.appendChild(row('hea-cand-grid he-num' + (c.recommended ? ' he-hl' : ''), [
        el('span', 'cell-strong', c.poly_modulus_degree.toLocaleString('zh-CN')), '[' + c.coeff_modulus_bits.join(', ') + ']',
        c.total_modulus_bits + ' / ' + c.max_modulus_bits + ' bit', el('span', c.margin_bits < 0 ? 'he-bad' : null, c.margin_bits + ' bit'),
        c.slots.toLocaleString('zh-CN'), String(c.est_add_ms), String(c.est_mul_ms), String(c.ciphertext_kb), verdict
      ]));
    });

    const basis = el('div', 'banner-note');
    basis.style.flexDirection = 'column';
    basis.appendChild(el('b', null, '寻优依据'));
    const ul = el('ul', 'he-rules');
    r.rules.forEach(function (t) { ul.appendChild(el('li', null, t)); });
    ul.appendChild(el('li', null, 'HomomorphicEncryption.org 安全标准（三元秘密、经典攻击）' + r.input.security_bits + ' 位安全下总模数上限：' +
      r.security_table.map(function (x) { return 'N = ' + x.poly_modulus_degree + ' → ' + x.max_modulus_bits + ' bit'; }).join('，')));
    basis.appendChild(ul);
    out.appendChild(basis);
  }

  /* ---------- 生命周期 ---------- */

  async function load() {
    try {
      if (!algos.length) {
        const res = await Promise.all([Api.get('/he/algorithms'), Api.get('/he/libraries')]);
        algos = res[0].items; libs = res[1];
        fillSchemeSelect('heaVScheme', 'ckks');
        fillSchemeSelect('heaEScheme', 'bgv');
        renderCatalog();
      }
      config = await Api.get('/projects/' + ctx.projectId + '/he/config');
      fillSchemeSelect('heaCfgScheme', config.scheme);
      fillLibSelect(config.library);
      $q('#heaCfgPrec').value = config.precision;
      $q('#heaVScheme').value = config.scheme;
      $q('#heaVPrec').value = config.precision;
      $q('#heaEPrec').value = config.precision;
      $q('#heaEPrecVal').textContent = String(config.precision);
      syncOps();
      renderCfgNote();
      renderMatrix();
      await Promise.all([runVerify(), runEncode(), runOptimize()]);
    } catch (e) { UI.fail(e); }
  }

  function mount(c, sectionEl) {
    ctx = c;
    if (root !== sectionEl) { root = sectionEl; built = false; }
    if (!built) build();
    load();
  }

  function unmount() { /* 无定时器、无长连接 */ }

  window.HEA = { mount: mount, unmount: unmount };
})();
