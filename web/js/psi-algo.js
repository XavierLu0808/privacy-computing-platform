/**
 * 隐私求交 / 算法配置（PSIA）：PSI 协议、参数调优、配置模板、自适应路由、典型场景性能参考。
 * 接口见 docs/api/psi.md。这里保存的「当前配置」由平台集成页（PSI，sub = pipe）读取后启动流水线。
 */
(function () {
  'use strict';

  const SOURCE_CN = { default: '协议默认参数', manual: '手动调整', template: '模板', route_advice: '自适应路由推荐' };
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

  let ctx = null;
  let root = null;
  let protocols = [];
  let config = null;         // 服务端当前配置
  let draft = null;          // { protocol, params } 页面上正在编辑的配置
  let errors = {};           // param key -> 错误文案
  let templates = [];
  let advice = null;
  let seq = 0;

  const $ = function (id) { return document.getElementById(id); };

  function protoDef(key) { return protocols.filter(function (p) { return p.protocol === key; })[0]; }
  function specOf(def, key) { return def.params.filter(function (pa) { return pa.key === key; })[0]; }
  function defaults(def) {
    const out = {};
    def.params.forEach(function (pa) { out[pa.key] = pa.value; });
    return out;
  }
  function num(v) { return Number(v).toLocaleString('zh-CN'); }
  function sup(v) { return String(v).split('').map(function (c) { return SUP[c] || c; }).join(''); }

  /** 参数值的展示文案；平台集成页也用它渲染配置摘要。 */
  function paramText(spec, v) {
    if (!spec) return String(v);
    if (spec.type === 'bool') return v ? '开启' : '关闭';
    if (spec.type === 'enum') {
      const o = spec.options.filter(function (x) { return x.value === v; })[0];
      return o ? o.label : String(v);
    }
    if (spec.key === 'bloom_fpr_log2') return '2' + sup(v) + '（统计安全 ' + (-v) + ' 位）';
    if (spec.key === 'preprocess_cache_ttl_hours' && v === 0) return '不缓存';
    return num(v) + (spec.unit ? ' ' + spec.unit : '');
  }

  /** [{ label, text }]，按协议参数顺序。 */
  function summary(def, params) {
    return def.params.map(function (pa) {
      return { key: pa.key, label: pa.label, text: paramText(pa, params[pa.key] !== undefined ? params[pa.key] : pa.value) };
    });
  }

  /* ---------- 骨架 ---------- */

  function build(el) {
    el.innerHTML =
      '<div class="page-head"><div class="page-head-text"><span class="crumb">隐私求交 / 算法配置</span><h1>PSI 算法配置</h1></div>' +
      '<button type="button" class="btn" id="psiaToPipe">去平台集成启动流水线</button></div>' +
      '<div class="psia-top">' +
        '<div class="card card-xl" style="gap:12px;" data-acc="PSI-ALGO-01">' +
          '<div style="display:flex; align-items:center; gap:10px;"><span class="card-title">PSI 协议</span><span class="spacer"></span><span class="hint">三种协议均满足 128 位计算安全</span></div>' +
          '<div style="display:flex; flex-direction:column; gap:8px;" id="psiaProtos"></div>' +
          '<div class="psia-sec" id="psiaSec"></div>' +
        '</div>' +
        '<div class="card card-xl" style="gap:16px;" data-acc="PSI-ALGO-02">' +
          '<div style="display:flex; align-items:center; gap:10px;"><span class="card-title">参数调优</span><span class="hint" id="psiaParamsFor">—</span><span class="spacer"></span>' +
          '<button type="button" class="btn-sm" id="psiaReset">恢复默认</button></div>' +
          '<div style="display:flex; flex-direction:column; gap:16px;" id="psiaParams"></div>' +
          '<div class="divider-h"></div>' +
          '<div class="psia-foot"><span class="hint" id="psiaCfgNote" style="flex-grow:1;">—</span>' +
          '<button type="button" class="btn-primary" id="psiaApply">保存为当前配置</button></div>' +
        '</div>' +
      '</div>' +

      '<div class="card card-lg" style="gap:12px;" data-acc="PSI-ALGO-03">' +
        '<div style="display:flex; align-items:center; gap:12px;"><span class="card-title">配置模板</span><span class="hint">保存左侧协议与参数，加载后即成为当前配置</span><span class="spacer"></span>' +
        '<div class="psia-tpl-new"><label class="field-label" for="psiaTplName">模板名称</label><input class="input" id="psiaTplName" maxlength="40">' +
        '<button type="button" class="btn-link" id="psiaTplSave">保存为模板</button></div></div>' +
        '<span class="psia-param-err" id="psiaTplErr" style="text-align:right;" hidden></span>' +
        '<div class="table-head psia-tpl-grid"><span>模板名称 / ID</span><span>协议</span><span>参数</span><span>创建时间</span><span>操作</span></div>' +
        '<div id="psiaTplList"></div>' +
      '</div>' +

      '<div class="card card-lg" style="gap:14px;" data-acc="PSI-ALGO-04">' +
        '<div style="display:flex; align-items:center; gap:12px;"><span class="card-title">求交协议自适应路由</span><span class="hint">按双方数据量与网络条件估算三种协议的耗时与通信量，推荐协议与参数</span></div>' +
        '<div class="psia-route-in">' +
          '<div class="field-col"><label for="psiaRowsA">参与方 A 数据量（行）</label><input class="input" id="psiaRowsA" type="number" min="1" step="1"></div>' +
          '<div class="field-col"><label for="psiaRowsB">参与方 B 数据量（行）</label><input class="input" id="psiaRowsB" type="number" min="1" step="1"></div>' +
          '<div class="field-col"><label for="psiaBw">网络带宽（Mbps）</label><input class="input" id="psiaBw" type="number" min="0.1" step="0.1" value="100"></div>' +
          '<div class="field-col"><label for="psiaLat">网络延迟（ms，单向）</label><input class="input" id="psiaLat" type="number" min="0" step="1" value="30"></div>' +
          '<button type="button" class="btn-primary" id="psiaAdvise" style="height:38px;">计算推荐</button>' +
        '</div>' +
        '<span class="hint" id="psiaRowsNote">—</span>' +
        '<div class="banner banner-err" id="psiaAdviseErr" hidden></div>' +
        '<div id="psiaAdvice" style="display:flex; flex-direction:column; gap:12px;" hidden>' +
          '<div class="banner banner-ok" style="align-items:flex-start;">' +
            '<span style="flex-grow:1; display:flex; flex-direction:column; gap:4px;"><strong id="psiaBest">—</strong><span id="psiaReason">—</span><span id="psiaBestParams" class="hint"></span></span>' +
            '<button type="button" class="btn-sm" id="psiaAdopt" style="color:var(--success); border-color:#A9D2BE; font-weight:600; flex-shrink:0;">采用推荐</button>' +
          '</div>' +
          '<div class="table-head psia-est-grid"><span>协议</span><span>在线预估耗时（秒）</span><span>计算（秒）</span><span>网络（秒）</span><span>通信量（MB）</span><span>离线预处理（秒）</span><span>安全强度</span></div>' +
          '<div id="psiaEst"></div>' +
        '</div>' +
        '<pre class="psia-formula" id="psiaFormula"></pre>' +
      '</div>' +

      '<div class="card card-lg" style="gap:12px;" data-acc="PSI-ALGO-04">' +
        '<div style="display:flex; align-items:center; gap:12px;"><span class="card-title">典型场景性能参考</span><span class="hint">局域网按 1000 Mbps / 1 ms，广域网按 100 Mbps / 30 ms；每格为在线预估耗时与通信量，估算值非实测</span></div>' +
        '<div class="table-head psia-bench-grid"><span>数据规模（A × B 行）</span><span>网络</span><span>ECDH-PSI</span><span>KKRT（基于 OT）</span><span>非平衡 PSI</span><span>推荐</span></div>' +
        '<div id="psiaBench"></div>' +
      '</div>';

    $('psiaFormula').textContent = [
      '估算模型（n_A、n_B 为两方行数，n_l 取较大者、n_s 取较小者，B 为带宽 Mbps，L 为单向延迟 ms）：',
      '在线耗时 = 计算耗时 + 网络耗时；网络耗时 = 通信量 × 8 ÷ (B × 10⁶) + 往返次数 × 2L ÷ 1000。',
      'ECDH-PSI：计算 = 2 (n_A + n_B) 次曲线标量乘 × 4 µs（Curve25519，8 线程；P-256 取 6 µs）；通信 ≈ (n_A + n_B) × 32 字节，两方各 n 行时即 2 × n × 32 字节；往返 = 2 × ⌈n_l ÷ 分块大小⌉。',
      'KKRT：以对称密码运算为主，计算 = (n_A + n_B) × 1.5 µs + 0.2 s 基础 OT；通信 = 1.27 n_s × 64 字节 + 3 n_l × (40 + log₂ n_A n_B) ÷ 8 字节，比 ECDH 高但计算快；往返 4 次。',
      '非平衡 PSI：大集合离线预处理 = n_l × 4 µs，缓存期内复用，不计入在线耗时；在线计算 = n_s × 40 µs + n_l × 0.05 µs，通信 = n_s × (64 + 12 ⌈log₂ n_l⌉) 字节。规模比超过 100 : 1 时优势明显。',
      '推荐取在线预估耗时最短的协议；两者耗时相差不到 10% 时取通信量更小者。'
    ].join('\n');

    $('psiaToPipe').addEventListener('click', function () { window.App.go('psi', { sub: 'pipe' }); });
    $('psiaReset').addEventListener('click', function () {
      draft.params = defaults(protoDef(draft.protocol));
      errors = {};
      renderParams();
    });
    $('psiaApply').addEventListener('click', applyDraft);
    $('psiaTplSave').addEventListener('click', saveTemplate);
    $('psiaTplName').addEventListener('input', function () { $('psiaTplErr').hidden = true; refreshFoot(); });
    $('psiaAdvise').addEventListener('click', function () { runAdvice(true); });
    $('psiaAdopt').addEventListener('click', adopt);
  }

  /* ---------- 协议 ---------- */

  function renderProtocols() {
    const wrap = $('psiaProtos');
    UI.clear(wrap);
    protocols.forEach(function (p) {
      const on = p.protocol === draft.protocol;
      const btn = UI.el('button', 'psi-proto' + (on ? ' on' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const radio = UI.el('span', 'psi-radio');
      radio.appendChild(UI.el('i'));
      btn.appendChild(radio);
      const text = UI.el('span', 'psi-proto-text');
      const nameRow = UI.el('span', 'psi-proto-name', p.name);
      text.appendChild(nameRow);
      text.appendChild(UI.el('span', 'psi-proto-desc', p.description));
      btn.appendChild(text);
      const tag = UI.el('span', 'tag tag-cls psia-sec-tag', p.security.security_bits + ' 位');
      btn.appendChild(tag);
      btn.addEventListener('click', function () {
        if (draft.protocol === p.protocol) return;
        draft.protocol = p.protocol;
        // 切回当前配置所用协议时恢复已保存的参数，否则取协议默认值
        draft.params = config.protocol === p.protocol ? Object.assign({}, config.params) : defaults(p);
        errors = {};
        renderProtocols();
        renderParams();
      });
      wrap.appendChild(btn);
    });
    const def = protoDef(draft.protocol);
    const sec = $('psiaSec');
    UI.clear(sec);
    const h = UI.el('span');
    h.appendChild(UI.el('strong', null, def.name + ' 安全强度：' + def.security.security_bits + ' 位计算安全'));
    sec.appendChild(h);
    sec.appendChild(UI.el('span', null, '安全基础：' + def.security.basis));
    sec.appendChild(UI.el('span', null, def.security.detail));
    sec.appendChild(UI.el('span', null, '敌手模型：' + def.security.threat_model));
  }

  /* ---------- 参数 ---------- */

  function validate(spec, raw) {
    if (spec.type === 'bool' || spec.type === 'enum') return null;
    if (raw === '' || raw === null) return '必填';
    const v = Number(raw);
    if (!Number.isFinite(v)) return '必须是数字';
    if (spec.type === 'int' && !Number.isInteger(v)) return '必须是整数';
    if (v < spec.min || v > spec.max) return '范围 ' + num(spec.min) + ' – ' + num(spec.max);
    return null;
  }

  function control(spec) {
    const id = 'psiaP_' + spec.key;
    const v = draft.params[spec.key];
    if (spec.type === 'bool') {
      const lb = UI.el('label', 'psia-switch');
      const cb = UI.el('input');
      cb.type = 'checkbox'; cb.id = id; cb.checked = !!v;
      cb.setAttribute('role', 'switch');
      const txt = UI.el('span', null, v ? '开启' : '关闭');
      cb.addEventListener('change', function () {
        draft.params[spec.key] = cb.checked;
        txt.textContent = cb.checked ? '开启' : '关闭';
        refreshFoot();
      });
      lb.appendChild(cb);
      lb.appendChild(txt);
      return lb;
    }
    if (spec.type === 'enum') {
      const sel = UI.selectOf(id, spec.options.map(function (o, i) { return { value: String(i), label: o.label }; }));
      sel.value = String(Math.max(0, spec.options.findIndex(function (o) { return o.value === v; })));
      sel.addEventListener('change', function () {
        draft.params[spec.key] = spec.options[Number(sel.value)].value;
        refreshFoot();
      });
      return sel;
    }
    const input = UI.inputOf(id, v, 'number');
    input.min = spec.min; input.max = spec.max; input.step = spec.step;
    return input;
  }

  function renderParams() {
    const def = protoDef(draft.protocol);
    $('psiaParamsFor').textContent = def.name + ' · ' + def.params.length + ' 项';
    const wrap = $('psiaParams');
    UI.clear(wrap);
    def.params.forEach(function (spec) {
      const row = UI.el('div', 'psia-param');
      row.dataset.key = spec.key;
      const lb = UI.el('label', 'psia-param-label', spec.label);
      lb.htmlFor = 'psiaP_' + spec.key;
      row.appendChild(lb);
      const ctl = UI.el('div', 'psia-param-ctl');
      const c = control(spec);
      ctl.appendChild(c);
      if (spec.type === 'int' || spec.type === 'float') {
        ctl.appendChild(UI.el('span', 'psia-param-unit', (spec.unit || '') + '（' + num(spec.min) + ' – ' + num(spec.max) + '）'));
      }
      row.appendChild(ctl);
      const errEl = UI.el('span', 'psia-param-err');
      errEl.hidden = true;
      row.appendChild(errEl);
      if (spec.type === 'int' || spec.type === 'float') {
        c.addEventListener('input', function () {
          const msg = validate(spec, c.value);
          if (msg) errors[spec.key] = msg; else { delete errors[spec.key]; draft.params[spec.key] = Number(c.value); }
          errEl.textContent = msg ? spec.label + '：' + msg : '';
          errEl.hidden = !msg;
          row.classList.toggle('bad', !!msg);
          refreshFoot();
        });
      }
      if (spec.hint) row.appendChild(UI.el('span', 'psia-param-note', spec.hint));
      wrap.appendChild(row);
    });
    refreshFoot();
  }

  function isDirty() {
    return draft.protocol !== config.protocol || JSON.stringify(draft.params) !== JSON.stringify(normalized(config.protocol, config.params));
  }

  /** 按协议参数顺序重排键，便于比较。 */
  function normalized(protocol, params) {
    const out = {};
    protoDef(protocol).params.forEach(function (pa) { out[pa.key] = params[pa.key]; });
    return out;
  }

  function refreshFoot() {
    const bad = Object.keys(errors).length;
    const dirty = isDirty();
    $('psiaApply').disabled = bad > 0 || !dirty;
    $('psiaTplSave').disabled = bad > 0 || !$('psiaTplName').value.trim();
    const note = $('psiaCfgNote');
    UI.clear(note);
    const def = protoDef(config.protocol);
    note.appendChild(document.createTextNode('当前配置：' + def.name + ' · 来源：' + SOURCE_CN[config.source] +
      (config.template_name ? '「' + config.template_name + '」' : '') +
      (config.updated_at ? ' · 保存于 ' + UI.datetime(config.updated_at) : '')));
    if (bad) note.appendChild(UI.el('span', 'psia-dirty', '　有 ' + bad + ' 项参数不合法'));
    else if (dirty) note.appendChild(UI.el('span', 'psia-dirty', '　有未保存的修改'));
  }

  async function putConfig(body, okText) {
    config = await Api.put('/projects/' + ctx.projectId + '/psi/config', body);
    draft = { protocol: config.protocol, params: normalized(config.protocol, config.params) };
    errors = {};
    renderProtocols();
    renderParams();
    UI.toast(okText);
  }

  async function applyDraft() {
    try {
      await putConfig({ protocol: draft.protocol, params: draft.params, source: 'manual' }, '已保存为当前配置，平台集成页启动流水线时使用');
    } catch (e) { UI.fail(e); }
  }

  /* ---------- 模板 ---------- */

  async function loadTemplates() {
    templates = (await Api.get('/projects/' + ctx.projectId + '/psi/templates')).items;
    renderTemplates();
  }

  function renderTemplates() {
    const wrap = $('psiaTplList');
    UI.clear(wrap);
    if (!templates.length) {
      wrap.appendChild(UI.el('div', 'table-empty', '暂无模板，调好参数后输入名称并点击「保存为模板」'));
      return;
    }
    templates.forEach(function (t) {
      const def = protoDef(t.protocol);
      const row = UI.el('div', 'table-row psia-tpl-grid' + (config.template_id === t.template_id ? ' current' : ''));
      const nameCell = UI.el('span');
      nameCell.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0;';
      const nm = UI.el('span', 'cell-strong', t.name);
      nameCell.appendChild(nm);
      nameCell.appendChild(UI.el('span', 'hint-2', t.template_id + (t.builtin ? ' · 内置' : '')));
      row.appendChild(nameCell);
      row.appendChild(UI.el('span', 'cell-muted', def ? def.name : t.protocol));
      const sum = def ? summary(def, t.params).map(function (s) { return s.label + ' ' + s.text; }).join('；') : '';
      const sumEl = UI.el('span', 'cell-muted', sum);
      sumEl.style.cssText = 'font-size:12px; line-height:18px;';
      row.appendChild(sumEl);
      row.appendChild(UI.el('span', 'cell-muted', UI.datetime(t.created_at)));
      const ops = UI.el('span');
      ops.style.cssText = 'display:flex; gap:6px;';
      const load = UI.el('button', 'btn-sm', config.template_id === t.template_id ? '使用中' : '加载');
      load.type = 'button';
      load.disabled = config.template_id === t.template_id;
      load.addEventListener('click', function () { loadTemplate(t); });
      const del = UI.el('button', 'btn-sm btn-kill', '删除');
      del.type = 'button';
      del.disabled = !!t.builtin;
      if (t.builtin) del.title = '内置模板不可删除';
      del.addEventListener('click', function () { removeTemplate(t); });
      ops.appendChild(load);
      ops.appendChild(del);
      row.appendChild(ops);
      wrap.appendChild(row);
    });
  }

  async function saveTemplate() {
    const errEl = $('psiaTplErr');
    errEl.hidden = true;
    try {
      const tpl = await Api.post('/projects/' + ctx.projectId + '/psi/templates', {
        name: $('psiaTplName').value.trim(), protocol: draft.protocol, params: draft.params
      });
      $('psiaTplName').value = '';
      UI.toast('已保存模板「' + tpl.name + '」');
      refreshFoot();
      await loadTemplates();
    } catch (e) {
      // 重名 / 参数越界等校验错误就地提示
      if (e.code >= 40000 && e.code < 50000) { errEl.textContent = '未保存：' + e.message; errEl.hidden = false; } else UI.fail(e);
    }
  }

  async function loadTemplate(t) {
    try {
      const tpl = await Api.get('/psi/templates/' + t.template_id);
      await putConfig({ protocol: tpl.protocol, params: tpl.params, template_id: tpl.template_id, source: 'template' },
        '已加载模板「' + tpl.name + '」并设为当前配置');
      renderTemplates();
    } catch (e) { UI.fail(e); }
  }

  function removeTemplate(t) {
    const body = UI.el('div', 'hint', '删除模板「' + t.name + '」？已按该模板保存的当前配置参数不受影响。');
    UI.modal({
      title: '删除模板', body: body, submitText: '删除', width: 440,
      onSubmit: async function () {
        await Api.del('/psi/templates/' + t.template_id);
        UI.toast('已删除模板「' + t.name + '」');
        config = await Api.get('/projects/' + ctx.projectId + '/psi/config');
        refreshFoot();
        await loadTemplates();
      }
    });
  }

  /* ---------- 自适应路由 ---------- */

  async function prefillRows() {
    // 默认取两方的截面数据集（不带时间列）行数，用户可改
    const ds = (await Api.get('/projects/' + ctx.projectId + '/datasets', { status: 'ready' })).items
      .filter(function (d) { return !d.time_column; });
    const a = ds.filter(function (d) { return d.party_id === 'party-a'; })[0];
    const b = ds.filter(function (d) { return d.party_id === 'party-b'; })[0];
    $('psiaRowsA').value = a ? a.row_count : 1000000;
    $('psiaRowsB').value = b ? b.row_count : 1000000;
    $('psiaRowsNote').textContent = (a && b)
      ? '默认取本项目已接入的截面数据集：参与方 A「' + a.name + '」' + UI.rows(a.row_count) + '行，参与方 B「' + b.name + '」' + UI.rows(b.row_count) + '行'
      : '本项目暂无两方就绪的截面数据集，默认按各 100 万行估算';
  }

  function readNum(id) {
    const raw = $(id).value.trim();
    return raw === '' ? null : Number(raw);
  }

  async function runAdvice(userClick) {
    const errEl = $('psiaAdviseErr');
    errEl.hidden = true;
    try {
      advice = await Api.post('/psi/route-advice', {
        left_rows: readNum('psiaRowsA'), right_rows: readNum('psiaRowsB'),
        bandwidth_mbps: readNum('psiaBw'), latency_ms: readNum('psiaLat')
      });
      renderAdvice();
    } catch (e) {
      if (!userClick) throw e;
      errEl.textContent = '无法估算：' + e.message;
      errEl.hidden = false;
      $('psiaAdvice').hidden = true;
    }
  }

  function renderAdvice() {
    const best = advice.recommended;
    const def = protoDef(best.protocol);
    $('psiaAdvice').hidden = false;
    $('psiaBest').textContent = '推荐协议：' + best.name + '（规模比 ' + advice.size_ratio + ' : 1）';
    $('psiaReason').textContent = advice.reason;
    $('psiaBestParams').textContent = '推荐参数：' + summary(def, best.params).map(function (s) { return s.label + ' ' + s.text; }).join('；');
    const wrap = $('psiaEst');
    UI.clear(wrap);
    advice.estimates.forEach(function (e) {
      const isBest = e.protocol === best.protocol;
      const row = UI.el('div', 'table-row psia-est-grid' + (isBest ? ' best' : ''));
      const nm = UI.el('span', 'cell-strong', e.name);
      if (isBest) {
        nm.appendChild(document.createTextNode(' '));
        nm.appendChild(UI.el('span', 'tag tag-cls', '推荐'));
      }
      row.appendChild(nm);
      row.appendChild(UI.el('span', isBest ? 'cell-strong' : 'cell-muted', UI.fixed(e.total_sec, 2)));
      row.appendChild(UI.el('span', 'cell-muted', UI.fixed(e.compute_sec, 2)));
      row.appendChild(UI.el('span', 'cell-muted', UI.fixed(e.network_sec, 2) + '（往返 ' + e.rounds + ' 次）'));
      row.appendChild(UI.el('span', 'cell-muted', UI.fixed(e.comm_mb, 2)));
      row.appendChild(UI.el('span', 'cell-muted', e.offline_sec ? UI.fixed(e.offline_sec, 1) + '（可缓存）' : '无'));
      row.appendChild(UI.el('span', 'cell-muted', e.security_bits + ' 位计算安全'));
      wrap.appendChild(row);
    });
  }

  async function adopt() {
    if (!advice) return;
    const best = advice.recommended;
    try {
      await putConfig({ protocol: best.protocol, params: best.params, source: 'route_advice' },
        '已采用推荐：' + best.name + '，并写回当前配置');
      renderTemplates();
    } catch (e) { UI.fail(e); }
  }

  async function loadBench() {
    const res = await Api.get('/psi/benchmarks');
    const wrap = $('psiaBench');
    UI.clear(wrap);
    res.items.forEach(function (b) {
      const row = UI.el('div', 'table-row psia-bench-grid');
      row.appendChild(UI.el('span', 'cell-strong', b.scale_label));
      row.appendChild(UI.el('span', 'cell-muted', b.network_label + '（' + b.bandwidth_mbps + ' Mbps / ' + b.latency_ms + ' ms）'));
      b.estimates.forEach(function (e) {
        const isBest = e.protocol === b.recommended;
        const cell = UI.el('span', isBest ? 'cell-strong' : 'cell-muted',
          UI.fixed(e.total_sec, 2) + ' 秒 · ' + UI.fixed(e.comm_mb, 1) + ' MB');
        if (isBest) cell.style.color = 'var(--primary)';
        row.appendChild(cell);
      });
      const def = protoDef(b.recommended);
      row.appendChild(UI.el('span', 'tag tag-cls', def ? def.name : b.recommended));
      wrap.appendChild(row);
    });
  }

  /* ---------- 生命周期 ---------- */

  async function mount(c, el) {
    ctx = c;
    const my = ++seq;
    if (root !== el) { root = el; build(el); }
    try {
      if (!protocols.length) protocols = (await Api.get('/psi/protocols')).items;
      const cfg = await Api.get('/projects/' + ctx.projectId + '/psi/config');
      if (my !== seq) return;
      config = cfg;
      draft = { protocol: config.protocol, params: normalized(config.protocol, config.params) };
      errors = {};
      renderProtocols();
      renderParams();
      await Promise.all([loadTemplates(), loadBench(), prefillRows()]);
      if (my !== seq) return;
      await runAdvice(false);
    } catch (e) { UI.fail(e); }
  }

  function unmount() { seq += 1; }

  window.PSIA = { mount: mount, unmount: unmount, paramText: paramText, summary: summary };
})();
