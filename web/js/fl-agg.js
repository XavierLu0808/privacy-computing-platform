/**
 * 联邦学习 · 聚合与安全（FL-AGG-01–07）。接口见 docs/api/fed-sec.md §1。
 *
 * 页面持有一份「表单副本」form，任何改动都实时调 /fl/aggregation/estimate 校验并估算通信量（不落库），
 * 点「保存到项目」才 PUT。参数范围与跨字段约束只在后端校验一处，前端按返回的 data.field 定位到输入框。
 */
(function () {
  'use strict';

  const STRATEGY = {
    ss: {
      label: '秘密共享聚合',
      desc: '轻量化聚合：各参与方给本地梯度加成对随机掩码后上传，掩码在求和时相互抵消，服务端只得到 n 方之和；少于门限 t 方合谋无法还原任一方的梯度。计算开销低，适合带宽受限的多方训练。'
    },
    he: {
      label: '同态加密聚合',
      desc: '高安全聚合：参与方用本项目公钥加密梯度，服务端直接在密文上做加法聚合，聚合结果由平台密钥服务解密后下发。单方梯度对服务端全程不可见，代价是密文膨胀带来的通信与计算开销。'
    }
  };
  const SCHEME_CN = { paillier: 'Paillier', ckks: 'CKKS' };
  const KEY_ST = { active: ['有效', 'st-ready'], rotated: ['已轮换', 'cell-muted'], destroyed: ['已销毁', 'st-failed'] };

  const SS_FIELDS = [
    { key: 'parties', label: '参与方数量 n', unit: '方', hint: '2 至 16，默认取本项目训练节点数' },
    { key: 'threshold', label: '门限 t', unit: '方', hint: '2 ≤ t ≤ n：任意 t 方即可恢复聚合结果' },
    { key: 'dropout_tolerance', label: '掉线容忍数 d', unit: '方', hint: '0 ≤ d ≤ n − t：单轮最多 d 方掉线仍可完成聚合' },
    { key: 'field_bits', label: '有限域位数', unit: 'bit', hint: '16 至 64，且 ≥ 量化位数 + ⌈log₂n⌉，保证 n 方求和不溢出' },
    { key: 'mask_rotation_rounds', label: '掩码种子轮换周期', unit: '轮', hint: '1 至 100：每隔多少轮重新协商成对掩码种子' }
  ];
  const HE_FIELDS = {
    paillier: [
      { key: 'key_size_bits', label: '密钥长度', unit: 'bit', options: [2048, 3072, 4096], hint: '模数 n 的位数：2048 bit 约 112 bit 安全强度，3072 bit 约 128 bit' },
      { key: 'precision_bits', label: '定点编码精度', unit: 'bit', hint: '梯度小数部分保留的二进制位数，8 至 53' },
      { key: 'batch_size', label: '批打包大小', unit: '个/密文', hint: '每个密文打包的梯度数：批打包 × (精度 + ⌈log₂n⌉ + 1) ≤ 密钥长度 − 1' }
    ],
    ckks: [
      { key: 'poly_modulus_degree', label: '多项式阶数 N', unit: '', options: [4096, 8192, 16384, 32768], hint: '决定槽位数（N/2）与安全上限' },
      { key: 'coeff_modulus_bits', label: '系数模数总位数', unit: 'bit', hint: '≤ 128 bit 安全上限（N=4096: 109，8192: 218，16384: 438，32768: 881），且 ≥ 缩放因子位数 + 20' },
      { key: 'scale_bits', label: '缩放因子位数', unit: 'bit', hint: '缩放因子 Δ = 2^位数，20 至 60' },
      { key: 'batch_size', label: '批打包大小（槽位数）', unit: '个/密文', hint: '1 至 N/2' }
    ]
  };

  let ctx = null, root = null;
  let view = null;      // GET /fl/aggregation 的结果
  let form = null;      // 当前编辑中的配置 { strategy, ss, he, sparsification }
  let savedSnap = '';   // 已保存配置的快照，用于判断是否有未保存修改
  let keys = [];
  let estSeq = 0;
  let alive = false;
  let fieldEls = {};    // 'ss.threshold' -> { input, err }

  function $(id) { return root.querySelector('#' + id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pick(cfg) { return { strategy: cfg.strategy, ss: clone(cfg.ss), he: clone(cfg.he), sparsification: clone(cfg.sparsification) }; }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function pctText(r) { return Number((r * 100).toFixed(2)) + '%'; }
  function activeKey() { return keys.filter(function (x) { return x.status === 'active'; })[0] || null; }
  function keyMatches(key, he) {
    if (!key || key.scheme !== he.scheme) return false;
    if (he.scheme === 'paillier') return key.key_size_bits === he.key_size_bits;
    return key.poly_modulus_degree === he.poly_modulus_degree && key.coeff_modulus_bits === he.coeff_modulus_bits;
  }
  function keyParams(k) {
    return k.scheme === 'paillier' ? k.key_size_bits + ' bit' : 'N = ' + k.poly_modulus_degree + '，log₂Q = ' + k.coeff_modulus_bits;
  }

  /* ---------- 骨架 ---------- */

  function skeleton() {
    root.innerHTML =
      '<div class="page-head">' +
        '<div class="page-head-text"><span class="crumb">联邦学习 / 聚合与安全</span><h1>梯度安全聚合与稀疏化</h1></div>' +
        '<span class="hint" id="flaSaved">—</span>' +
        '<button type="button" class="btn" id="flaReset" data-acc="FL-AGG-05">恢复默认</button>' +
        '<button type="button" class="btn-primary" id="flaSave" data-acc="FL-AGG-06">保存到项目</button>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-AGG-01">' +
        '<div class="fla-row">' +
          '<span class="card-title">聚合策略</span>' +
          '<span class="spacer"></span>' +
          '<div class="field"><label class="field-label" for="flaStrategy">策略</label>' +
            '<select class="select select-lg" id="flaStrategy"><option value="ss">秘密共享聚合</option><option value="he">同态加密聚合</option></select></div>' +
          '<button type="button" class="btn-link" id="flaApplyRec">套用推荐配置</button>' +
        '</div>' +
        '<span class="fla-desc" id="flaStratDesc">—</span>' +
        '<span class="hint-2" id="flaRecNote">—</span>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-AGG-02" id="flaSsCard">' +
        '<div class="fla-row"><span class="card-title">秘密共享聚合参数</span><span class="hint" id="flaSsNote">—</span></div>' +
        '<div class="form-3col" id="flaSsForm"></div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-AGG-03" id="flaHeCard">' +
        '<div class="fla-row"><span class="card-title">同态加密聚合参数</span><span class="hint">参数改动后需重新生成密钥对才能保存</span></div>' +
        '<div class="form-3col" id="flaHeForm"></div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-AGG-04" id="flaKeyCard">' +
        '<div class="fla-row">' +
          '<span class="card-title">同态加密密钥对</span>' +
          '<span class="hint">私钥由平台密钥服务托管、不可导出，界面与接口只出现 key_id</span>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn-sm" id="flaKeyView">查看公钥</button>' +
          '<button type="button" class="btn-primary" id="flaKeyGen">生成密钥对</button>' +
        '</div>' +
        '<div class="banner-note" id="flaKeyStatus">—</div>' +
        '<div class="table-head fla-key-grid"><span>密钥 ID</span><span>方案</span><span>长度 / 参数</span><span>公钥指纹</span><span>生成时间</span><span>状态</span></div>' +
        '<div id="flaKeys"></div>' +
      '</div>' +

      '<div class="card card-lg" data-acc="FL-AGG-07">' +
        '<div class="fla-row"><span class="card-title">梯度稀疏化</span>' +
          '<span class="hint">Top-k 稀疏化 + 误差反馈 + 量化，动态裁剪冗余梯度；改动参数后下方估算实时刷新</span></div>' +
        '<div class="fla-sp-form" id="flaSpForm"></div>' +
        '<div class="metric-grid" id="flaEst"></div>' +
        '<div class="banner-note fla-formula" id="flaFormula">—</div>' +
      '</div>';
  }

  /* ---------- 表单控件 ---------- */

  function numField(path, def, value, control) {
    const wrap = UI.el('div', 'field-col');
    const id = 'fla_' + path.replace('.', '_');
    let input = control;
    if (!input && def.options) {
      input = UI.selectOf(id, def.options.map(function (o) { return { value: String(o), label: String(o) + (def.unit ? ' ' + def.unit : '') }; }), String(value));
    } else if (!input) {
      input = UI.inputOf(id, value, 'number');
      input.step = '1';
    }
    input.id = id;
    const lb = UI.el('label', null, def.label + (def.unit && !def.options ? '（' + def.unit + '）' : ''));
    lb.htmlFor = id;
    wrap.appendChild(lb);
    wrap.appendChild(input);
    if (def.hint) wrap.appendChild(UI.el('span', 'hint', def.hint));
    const err = UI.el('span', 'fla-err');
    err.hidden = true;
    wrap.appendChild(err);
    fieldEls[path] = { input: input, err: err };
    return wrap;
  }

  function readNum(input) {
    const v = input.value.trim();
    return v === '' ? null : Number(v);
  }

  function renderSsForm() {
    const box = $('flaSsForm');
    UI.clear(box);
    SS_FIELDS.forEach(function (def) {
      const row = numField('ss.' + def.key, def, form.ss[def.key]);
      fieldEls['ss.' + def.key].input.addEventListener('input', function (e) {
        form.ss[def.key] = readNum(e.target);
        changed();
      });
      box.appendChild(row);
    });
    $('flaSsNote').textContent = '本项目训练节点 ' + view.trainer_count + ' 个';
  }

  function renderHeForm() {
    const box = $('flaHeForm');
    UI.clear(box);
    const sch = UI.selectOf('fla_he_scheme', [{ value: 'paillier', label: 'Paillier（加法同态，整数精确）' }, { value: 'ckks', label: 'CKKS（近似同态，浮点向量）' }], form.he.scheme);
    box.appendChild(numField('he.scheme', { label: '同态方案', hint: '联邦聚合只需密文加法；Paillier 结果精确，CKKS 单密文可打包更多梯度' }, null, sch));
    sch.addEventListener('change', function () {
      form.he.scheme = sch.value;
      // 两种方案的批打包含义不同，切换时取该方案的平台默认值
      form.he.batch_size = sch.value === 'paillier' ? view.defaults.he.batch_size : view.recommended.he.ckks.batch_size;
      renderHeForm();
      changed();
    });
    HE_FIELDS[form.he.scheme].forEach(function (def) {
      const path = 'he.' + def.key;
      box.appendChild(numField(path, def, form.he[def.key]));
      const input = fieldEls[path].input;
      input.addEventListener(def.options ? 'change' : 'input', function () {
        form.he[def.key] = readNum(input);
        changed();
      });
    });
  }

  function renderSpForm() {
    const box = $('flaSpForm');
    UI.clear(box);
    const sp = form.sparsification;

    const en = UI.el('label', 'check-item fla-check');
    const enBox = UI.el('input'); enBox.type = 'checkbox'; enBox.id = 'fla_sp_enabled'; enBox.checked = sp.enabled;
    en.appendChild(enBox); en.appendChild(UI.el('span', null, '启用 Top-k 稀疏化'));
    const ef = UI.el('label', 'check-item fla-check');
    const efBox = UI.el('input'); efBox.type = 'checkbox'; efBox.id = 'fla_sp_ef'; efBox.checked = sp.error_feedback;
    ef.appendChild(efBox); ef.appendChild(UI.el('span', null, '误差反馈（error feedback）'));
    const checks = UI.el('div', 'field-col');
    checks.appendChild(UI.el('label', null, '开关'));
    checks.appendChild(en);
    checks.appendChild(ef);
    checks.appendChild(UI.el('span', 'hint', '误差反馈：未上传的梯度残差累积到下一轮，弥补稀疏化带来的精度损失'));
    box.appendChild(checks);

    const ratio = UI.inputOf('fla_sp_ratio', Number((sp.topk_ratio * 100).toFixed(3)), 'number');
    ratio.step = '0.5'; ratio.min = '0.1'; ratio.max = '100';
    box.appendChild(numField('sparsification.topk_ratio', { label: 'Top-k 保留比例', unit: '%', hint: '0.1% 至 100%：每轮只上传绝对值最大的 ρ × P 个梯度' }, null, ratio));

    box.appendChild(numField('sparsification.quant_bits', { label: '量化位数', unit: 'bit', options: [4, 8, 16, 32], hint: '保留梯度的随机量化位宽；32 bit 即不量化' }, sp.quant_bits));
    const qb = fieldEls['sparsification.quant_bits'].input;

    enBox.addEventListener('change', function () { sp.enabled = enBox.checked; ratio.disabled = !sp.enabled; changed(); });
    efBox.addEventListener('change', function () { sp.error_feedback = efBox.checked; changed(); });
    ratio.addEventListener('input', function () {
      const v = readNum(ratio);
      sp.topk_ratio = v === null ? null : Number((v / 100).toFixed(6));
      changed();
    });
    qb.addEventListener('change', function () { sp.quant_bits = Number(qb.value); changed(); });
    ratio.disabled = !sp.enabled;
  }

  /* ---------- 渲染 ---------- */

  function renderAll() {
    fieldEls = {};
    $('flaStrategy').value = form.strategy;
    renderSsForm();
    renderHeForm();
    renderSpForm();
    renderStrategy();
    renderKeys();
    renderSaved();
    estimate();
  }

  function renderStrategy() {
    const s = form.strategy;
    $('flaStratDesc').textContent = STRATEGY[s].desc;
    $('flaSsCard').hidden = s !== 'ss';
    $('flaHeCard').hidden = s !== 'he';
    $('flaKeyCard').hidden = s !== 'he';
    const rec = view.recommended;
    $('flaRecNote').textContent = s === 'ss'
      ? '推荐配置：n = ' + rec.ss.parties + ' 方，门限 t = ⌊n/2⌋ + 1 = ' + rec.ss.threshold + '，掉线容忍 d = n − t = ' + rec.ss.dropout_tolerance +
        '，有限域 ' + rec.ss.field_bits + ' bit，掩码种子每 ' + rec.ss.mask_rotation_rounds + ' 轮轮换；稀疏化保留 ' + pctText(rec.sparsification.topk_ratio) +
        '，量化 ' + rec.sparsification.quant_bits + ' bit，开启误差反馈'
      : (form.he.scheme === 'paillier'
        ? '推荐配置：Paillier ' + rec.he.paillier.key_size_bits + ' bit，定点精度 ' + rec.he.paillier.precision_bits + ' bit，批打包 ' +
          rec.he.paillier.batch_size + ' 个/密文（明文空间打满）'
        : '推荐配置：CKKS N = ' + rec.he.ckks.poly_modulus_degree + '，系数模数 ' + rec.he.ckks.coeff_modulus_bits + ' bit，缩放因子 2^' +
          rec.he.ckks.scale_bits + '，批打包 ' + rec.he.ckks.batch_size + ' 槽') +
        '；稀疏化保留 ' + pctText(rec.sparsification.topk_ratio) + '，量化 ' + rec.sparsification.quant_bits + ' bit';
  }

  function renderSaved() {
    const dirty = JSON.stringify(pick(form)) !== savedSnap;
    const base = view.saved
      ? '已保存到「' + view.project_name + '」· ' + UI.datetime(view.updated_at)
      : '「' + view.project_name + '」尚未保存，当前为平台默认配置';
    $('flaSaved').textContent = dirty ? base + ' · 有未保存的修改' : base;
    $('flaSaved').className = dirty ? 'hint fla-dirty' : 'hint';
  }

  function renderKeys() {
    const list = $('flaKeys');
    UI.clear(list);
    if (!keys.length) list.appendChild(UI.el('div', 'table-empty', '尚未生成密钥对'));
    keys.forEach(function (k) {
      const row = UI.el('div', 'table-row fla-key-grid');
      row.appendChild(UI.el('span', 'cell-strong', k.key_id));
      row.appendChild(UI.el('span', null, SCHEME_CN[k.scheme]));
      row.appendChild(UI.el('span', null, keyParams(k)));
      row.appendChild(UI.el('span', 'fla-mono', k.fingerprint.slice(0, 30) + '…'));
      row.appendChild(UI.el('span', 'cell-muted', UI.datetime(k.created_at)));
      const st = KEY_ST[k.status] || [k.status, ''];
      row.appendChild(UI.el('span', st[1], st[0]));
      list.appendChild(row);
    });
    const ak = activeKey();
    const ok = keyMatches(ak, form.he);
    $('flaKeyView').disabled = !ak;
    const s = $('flaKeyStatus');
    if (!ak) s.textContent = '本项目尚未生成密钥对。按上方同态参数点击「生成密钥对」，生成后才能保存同态加密聚合配置。';
    else if (ok) s.textContent = '当前有效密钥 ' + ak.key_id + '（' + SCHEME_CN[ak.scheme] + '，' + keyParams(ak) + '）与上方参数一致，可直接保存。';
    else s.textContent = '当前有效密钥 ' + ak.key_id + '（' + SCHEME_CN[ak.scheme] + '，' + keyParams(ak) + '）与上方参数不一致，请重新生成密钥对后再保存；旧密钥将自动轮换。';
    s.classList.toggle('fla-warn', !!ak && !ok);
  }

  function showFieldError(field, msg) {
    Object.keys(fieldEls).forEach(function (p) {
      const f = fieldEls[p];
      const on = p === field;
      f.err.hidden = !on;
      f.err.textContent = on ? msg : '';
      f.input.classList.toggle('fla-invalid', on);
      f.input.setAttribute('aria-invalid', on ? 'true' : 'false');
    });
  }

  function changed() {
    renderSaved();
    renderKeys();
    if (form.strategy === 'he') renderStrategy();
    estimateDebounced();
  }

  /* ---------- 实时估算（FL-AGG-07） ---------- */

  async function estimate() {
    const seq = ++estSeq;
    const box = $('flaEst');
    try {
      const e = await Api.post('/projects/' + ctx.projectId + '/fl/aggregation/estimate', pick(form));
      if (!alive || seq !== estSeq) return;
      showFieldError(null);
      renderEstimate(e);
    } catch (err) {
      if (!alive || seq !== estSeq) return;
      const field = err.data && err.data.field;
      if (field && fieldEls[field]) showFieldError(field, err.message);
      else showFieldError(null);
      UI.clear(box);
      box.appendChild(UI.el('div', 'table-empty fla-est-err', '参数不合法，暂不能估算：' + err.message));
      $('flaFormula').hidden = true;
    }
  }
  const estimateDebounced = UI.debounce(estimate, 220);

  function metric(name, value, sub, extra) {
    const m = UI.el('div', 'metric');
    m.appendChild(UI.el('span', 'metric-name', name));
    const v = UI.el('span', 'metric-value', value);
    if (extra) v.appendChild(extra);
    m.appendChild(v);
    m.appendChild(UI.el('span', 'metric-sub', sub));
    return m;
  }

  function renderEstimate(e) {
    const box = $('flaEst');
    UI.clear(box);
    const sp = form.sparsification;
    const he = e.strategy === 'he';
    const upSub = he
      ? e.ciphertext_count + ' 个密文 × ' + fmtInt(e.ciphertext_bits) + ' bit（保留 ' + fmtInt(e.kept) + ' 个梯度）'
      : '保留 k = ' + fmtInt(e.kept) + ' 个梯度 × 有限域 ' + form.ss.field_bits + ' bit';
    box.appendChild(metric('每客户端每轮上传数据量', UI.bytes(e.upload_bytes_per_client), upSub));
    box.appendChild(metric('本算法单轮通信总量', UI.bytes(e.ours_bytes), e.client_count + ' 方上行 + 下行' + (he ? '' : ' + 掩码种子协商')));
    box.appendChild(metric('FedAvg 单轮通信总量', UI.bytes(e.fedavg_bytes), e.client_count + ' 方 × (上行 + 下行) × P × 32 bit'));
    const tag = UI.el('span', 'tag fs-verdict ' + (e.meets_contract ? 'fs-pass' : 'fs-fail'), e.meets_contract ? '达标' : '未达标');
    box.appendChild(metric('相对 FedAvg 通信压缩比', e.ratio.toFixed(2) + ' 倍', '合同要求 ≥ 6 倍 · 按当前' + (he ? '同态加密' : '秘密共享') + '聚合参数估算', tag));

    const P = fmtInt(e.model_params);
    const up = he
      ? '⌈k / 批打包⌉ × 单密文位数 = ' + e.ciphertext_count + ' × ' + fmtInt(e.ciphertext_bits) + ' bit'
      : 'k × 有限域位数 = ' + fmtInt(e.kept) + ' × ' + form.ss.field_bits + ' bit';
    const idx = sp.enabled ? ' + 下标集合 min(k × ' + e.index_bits + ', P) bit' : '';
    $('flaFormula').innerHTML = '';
    $('flaFormula').hidden = false;
    [
      '估算口径：模型 ' + e.model + '，参数量 P = ' + P + '；n = ' + e.client_count + ' 个客户端；k = ⌈ρ × P⌉ = ' + fmtInt(e.kept) +
        (sp.enabled ? '（ρ = ' + pctText(e.rho) + '）' : '（未开启稀疏化，ρ = 100%，不传下标）') + '。',
      '每客户端上行 = ' + up + '；下行 = k × 32 bit（聚合后的明文更新）' + idx + '（服务端统一下发全局 Top-k 下标，客户端上行不带下标）。',
      '本算法单轮通信总量 = n × (上行 + 下行)' + (he ? '' : ' + 掩码种子协商 n(n−1) × 512 bit / 轮换周期') + '；FedAvg 单轮通信总量 = n × 2 × P × 32 bit。',
      '通信压缩比 = FedAvg 单轮平均通信总量 ÷ 本算法单轮平均通信总量 = ' + UI.bytes(e.fedavg_bytes) + ' ÷ ' + UI.bytes(e.ours_bytes) + ' = ' + e.ratio.toFixed(2) + ' 倍。' +
        (he ? '同态加密聚合下密文膨胀，压缩比明显低于秘密共享聚合。' : '')
    ].forEach(function (t) { $('flaFormula').appendChild(UI.el('span', null, t)); });
  }

  /* ---------- 动作 ---------- */

  function applyView(v) {
    view = v;
    form = pick(v);
    savedSnap = JSON.stringify(pick(v));
    renderAll();
  }

  async function load() {
    const pid = ctx.projectId;
    try {
      const res = await Promise.all([
        Api.get('/projects/' + pid + '/fl/aggregation'),
        Api.get('/projects/' + pid + '/fl/aggregation/keys')
      ]);
      if (!alive || pid !== ctx.projectId) return;
      keys = res[1].items;
      applyView(res[0]);
    } catch (e) { UI.fail(e); }
  }

  async function save() {
    try {
      const v = await Api.put('/projects/' + ctx.projectId + '/fl/aggregation', pick(form));
      applyView(v);
      UI.toast('已保存' + STRATEGY[v.strategy].label + '配置到「' + v.project_name + '」');
    } catch (e) {
      const field = e.data && e.data.field;
      if (field && fieldEls[field]) showFieldError(field, e.message);
      UI.fail(e);
    }
  }

  function reset() {
    UI.modal({
      title: '恢复默认聚合策略',
      body: UI.el('div', 'hint', '将把「' + view.project_name + '」的聚合策略恢复为平台默认（秘密共享聚合，门限 2，有限域 16 bit，Top-k 保留 15%，量化 8 bit，开启误差反馈）并立即保存。已生成的密钥对保留不动。'),
      submitText: '恢复默认',
      onSubmit: async function () {
        const v = await Api.post('/projects/' + ctx.projectId + '/fl/aggregation/reset', {});
        applyView(v);
        UI.toast('已恢复默认聚合策略');
        return true;
      }
    });
  }

  function applyRecommended() {
    const rec = view.recommended;
    if (form.strategy === 'ss') form.ss = clone(rec.ss);
    else form.he = Object.assign(form.he, clone(rec.he[form.he.scheme]));
    form.sparsification = clone(rec.sparsification);
    fieldEls = {};
    renderSsForm(); renderHeForm(); renderSpForm();
    changed();
    UI.toast('已套用' + STRATEGY[form.strategy].label + '推荐配置，点击「保存到项目」生效');
  }

  async function genKey() {
    try {
      const k = await Api.post('/projects/' + ctx.projectId + '/fl/aggregation/keys', { he: form.he });
      const res = await Api.get('/projects/' + ctx.projectId + '/fl/aggregation/keys');
      keys = res.items;
      renderKeys();
      UI.toast('已生成密钥对 ' + k.key_id + (keys.length > 1 ? '，旧密钥已轮换' : ''));
    } catch (e) {
      const field = e.data && e.data.field;
      if (field && fieldEls[field]) showFieldError(field, e.message);
      UI.fail(e);
    }
  }

  async function viewKey() {
    try {
      const k = await Api.get('/projects/' + ctx.projectId + '/fl/aggregation/public-key');
      const body = UI.el('div', 'fla-key-detail');
      const rows = [
        ['密钥 ID', k.key_id],
        ['所属项目', k.project_name + '（' + k.project_id + '）'],
        ['方案', SCHEME_CN[k.scheme] + (k.generator ? '，生成元 ' + k.generator : '')],
        ['密钥长度 / 参数', keyParams(k) + '，约 ' + k.security_bits + ' bit 安全强度'],
        ['公钥大小', UI.bytes(k.public_key_bytes)],
        ['公钥指纹', k.fingerprint],
        ['生成时间', UI.datetime(k.created_at)],
        ['私钥', '托管于平台密钥服务（' + k.private_key_ref + '），不可导出、不经接口传输']
      ];
      rows.forEach(function (r) {
        const line = UI.el('div', 'fla-kv');
        line.appendChild(UI.el('span', 'fla-k', r[0]));
        line.appendChild(UI.el('span', r[0] === '公钥指纹' ? 'fla-mono' : null, r[1]));
        body.appendChild(line);
      });
      body.appendChild(UI.el('span', 'section-label', k.public_key_truncated ? '公钥（前 512 bit 预览，完整公钥 ' + UI.bytes(k.public_key_bytes) + '）' : '公钥（模数 n，十六进制）'));
      const pre = UI.el('div', 'fla-pk fla-mono', k.public_key);
      body.appendChild(pre);
      UI.modal({ title: '查看公钥 · ' + k.key_id, body: body, submitText: '确定', width: 620, onSubmit: function () { return true; } });
    } catch (e) { UI.fail(e); }
  }

  function bind() {
    $('flaStrategy').addEventListener('change', function () {
      form.strategy = $('flaStrategy').value;
      renderStrategy();
      changed();
    });
    $('flaApplyRec').addEventListener('click', applyRecommended);
    $('flaSave').addEventListener('click', save);
    $('flaReset').addEventListener('click', reset);
    $('flaKeyGen').addEventListener('click', genKey);
    $('flaKeyView').addEventListener('click', viewKey);
  }

  window.FLA = {
    mount: function (c, el) {
      ctx = c;
      root = el;
      alive = true;
      view = null; form = null; keys = []; fieldEls = {};
      skeleton();
      bind();
      load();
    },
    unmount: function () {
      alive = false;
      estSeq += 1;
    }
  };
})();
