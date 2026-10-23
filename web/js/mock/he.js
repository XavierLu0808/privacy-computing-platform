/**
 * mock 扩展：同态加密（算法管理 #/he/algo + 应用集成 #/he/app）。接口见 docs/api/he.md。
 *
 * 自有数据挂在 k.db.he；写内核数据的地方：
 *   - db.heKeys：POST /he/keys（routeFirst 重写，响应字段与内核一致并补充生命周期字段）、轮换生成新钥、播种托管密钥；
 *   - DELETE /he/keys/{key_id}（routeFirst 重写）：与内核一样删 db.heKeys 及其密文，同时在 k.db.he 留销毁记录。
 * 其余内核数据（项目、节点、训练任务）只读。
 */
(function () {
  'use strict';
  window.MockServer.extend(function (k) {
    const db = k.db.he = { keys: {}, config: {}, policy: {}, sims: [], seeded: {} };
    const DAY = 86400000;

    /* ================= 静态目录 ================= */

    const ALGORITHMS = [
      {
        scheme: 'paillier', name: 'Paillier', family: 'phe', family_label: '半同态',
        supported_ops: ['add_ct_ct', 'mul_ct_pt'], plaintext_type: 'integer',
        plaintext_label: '整数（浮点数自动定点化）', security_bits: 112,
        security_note: 'n = 2048 bit 约 112 位安全（NIST SP 800-57），n = 3072 bit 为 128 位',
        default_library: 'phe',
        typical_params: '模数 n = 2048 bit，密文 4096 bit（0.5 KB / 条）',
        plaintext_space: { bits: 2046, label: '|m| < 2^2045（n = 2048 bit 的一半区间表示负数）' }
      },
      {
        scheme: 'ckks', name: 'CKKS', family: 'fhe', family_label: '全同态',
        supported_ops: ['add_ct_ct', 'mul_ct_ct', 'mul_ct_pt'], plaintext_type: 'float',
        plaintext_label: '浮点数（近似计算）', security_bits: 128,
        security_note: 'N = 8192、总模数 200 bit ≤ 218 bit 上限（HomomorphicEncryption.org 标准表）',
        default_library: 'seal',
        typical_params: 'N = 8192，模数链 [60, 40, 40, 60] bit，缩放因子 Δ = 2^40，4096 个槽位',
        plaintext_space: null
      },
      {
        scheme: 'bgv', name: 'BGV', family: 'fhe', family_label: '全同态',
        supported_ops: ['add_ct_ct', 'mul_ct_ct', 'mul_ct_pt'], plaintext_type: 'integer_exact',
        plaintext_label: '整数（模 t 精确计算）', security_bits: 128,
        security_note: 'N = 8192、总模数 218 bit，恰为 128 位安全上限',
        default_library: 'seal',
        typical_params: 'N = 8192，明文模数 t = 1032193（20 bit 批处理素数），8192 个槽位',
        plaintext_space: { bits: 20, max_abs: 516096, label: '|m| ≤ 516096（t = 1032193 的对称区间）' }
      },
      {
        scheme: 'tfhe', name: 'TFHE', family: 'fhe', family_label: '全同态（可编程自举）',
        supported_ops: ['add_ct_ct', 'mul_ct_ct', 'mul_ct_pt'], plaintext_type: 'integer_exact',
        plaintext_label: '32 位有符号整数（精确计算）', security_bits: 128,
        security_note: 'TFHE-rs 默认参数集 PARAM_MESSAGE_2_CARRY_2，128 位安全',
        default_library: 'tfhe-rs',
        typical_params: 'FheInt32 = 16 个 2 bit 消息块，每次运算后自举，无乘法深度限制',
        plaintext_space: { bits: 32, max_abs: 2147483647, label: '|m| ≤ 2^31 − 1（FheInt32）' }
      }
    ];
    const LIBRARIES = [
      { library: 'seal', name: 'Microsoft SEAL 4.1 / TenSEAL 0.3', language: 'C++ / Python',
        schemes: ['ckks', 'bgv'], note: 'TenSEAL 封装 CKKS 向量运算；BGV 直接调用 SEAL 4.1 原生接口' },
      { library: 'pyfhel', name: 'Pyfhel 3.4', language: 'Python（底层 SEAL）',
        schemes: ['ckks', 'bgv'], note: 'Pyfhel 3.4 起支持 BGV；不提供 Paillier' },
      { library: 'openfhe', name: 'OpenFHE 1.2', language: 'C++',
        schemes: ['ckks', 'bgv', 'tfhe'], note: 'TFHE 由 BinFHE 模块提供（布尔门级，整数运算按位组合）' },
      { library: 'tfhe-rs', name: 'TFHE-rs 0.7', language: 'Rust',
        schemes: ['tfhe'], note: '只实现 TFHE，不提供 Paillier / CKKS / BGV' },
      { library: 'phe', name: 'python-paillier (phe) 1.5', language: 'Python',
        schemes: ['paillier'], note: 'Paillier 半同态，仅支持密文加与明文数乘' }
    ];
    const DEFAULT_CONFIG = { scheme: 'ckks', library: 'seal', precision: 4 };

    // 单次运算的基准耗时（ms）与单条密文大小（KB）。CKKS / BGV 一条密文打包整组向量，Paillier / TFHE 每个数一条。
    const PERF = {
      paillier: { keygen: 8.5, enc: 3.4, add: 0.8, mul: 1.1, dec: 4.2, ct_kb: 0.52, packed: false },
      ckks: { keygen: 8.5, enc: 18.6, add: 7.4, mul: 46.3, dec: 12.8, ct_kb: 262.1, packed: true, slots: 4096 },
      bgv: { keygen: 8.5, enc: 24.1, add: 7.4, mul: 46.3, dec: 16.5, ct_kb: 318.4, packed: true, slots: 8192 },
      tfhe: { keygen: 1260, enc: 0.12, add: 68, mul: 410, dec: 0.05, ct_kb: 262.2, packed: false }
    };
    // CKKS 默认缩放因子 Δ = 2^40；新鲜密文误差约 2^-28、乘法重缩放后约 2^-22（相对于 1 + |结果|）
    const CKKS_SCALE_BITS = 40;

    // HomomorphicEncryption.org 安全标准（Albrecht et al. 2018）表 1：三元秘密、经典攻击，
    // 给定多项式阶数 N 时总模数 log2(q) 的上限（bit）。SEAL 的 CoeffModulus::MaxBitCount 采用同一张表。
    const HE_STD = {
      128: { 1024: 27, 2048: 54, 4096: 109, 8192: 218, 16384: 438, 32768: 881 },
      192: { 1024: 19, 2048: 37, 4096: 75, 8192: 152, 16384: 305, 32768: 611 },
      256: { 1024: 14, 2048: 29, 4096: 58, 8192: 118, 16384: 237, 32768: 476 }
    };
    const N_LIST = [2048, 4096, 8192, 16384, 32768];

    // Paillier 打包：2048 bit 明文空间按 64 bit 槽位放 32 个定点数（高位留作多方求和的进位保护）
    const PAILLIER_SLOTS = 32;
    const FL_PARAMS = { lr: 1200, xgb: 4096, cnn: 61706, lstm: 52000, tcn: 38000, custom: 20000 };

    /* ================= 工具 ================= */

    function algo(s) { return ALGORITHMS.filter(function (a) { return a.scheme === s; })[0]; }
    function lib(l) { return LIBRARIES.filter(function (x) { return x.library === l; })[0]; }
    function project(pid) { return k.db.projects.filter(function (p) { return p.project_id === pid; })[0]; }
    function r1(x) { return Number(x.toFixed(1)); }
    function r2(x) { return Number(x.toFixed(2)); }

    /** 同种子同序列的 [0,1) 伪随机数，用于仿真噪声与模拟梯度。 */
    function rng(seed) {
      let x = parseInt(k.hashHex(seed, 1), 16) >>> 0;
      return function () { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
    }
    function jitter(seed) { return 1 + (rng(seed)() - 0.5) * 0.12; }   // ±6%

    function isNumStr(v) { return typeof v === 'string' || typeof v === 'number' ? !Number.isNaN(Number(v)) && String(v).trim() !== '' : false; }
    function isIntStr(v) { return /^[+-]?\d+$/.test(String(v).trim()); }

    /**
     * 十进制字符串 → round(x · 10^p) 的 BigInt，按十进制逐位四舍五入（不经过二进制浮点，1.005 → 101 @p=2）。
     */
    function toFixedBig(v, p) {
      const s = String(v).trim();
      const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
      if (!m) return BigInt(Math.round(Number(s) * Math.pow(10, p)));   // 科学计数法兜底
      const neg = m[1] === '-';
      const frac = (m[3] || '') + '0'.repeat(p + 1);
      let n = BigInt((m[2] || '0') + frac.slice(0, p));
      if (Number(frac[p]) >= 5) n += 1n;
      return neg ? -n : n;
    }
    /** BigInt 定点数 → 十进制字符串（scaleExp 位小数）。 */
    function fromFixedBig(n, scaleExp) {
      const neg = n < 0n;
      let s = (neg ? -n : n).toString();
      if (scaleExp === 0) return (neg && s !== '0' ? '-' : '') + s;
      s = s.padStart(scaleExp + 1, '0');
      const out = s.slice(0, s.length - scaleExp) + '.' + s.slice(s.length - scaleExp);
      return (neg ? '-' : '') + out;
    }
    function bitLen(n) { const a = n < 0n ? -n : n; return a === 0n ? 0 : a.toString(2).length; }
    function absBig(n) { return n < 0n ? -n : n; }
    function overflowOf(scheme, n) {
      const sp = algo(scheme).plaintext_space;
      if (!sp) return false;
      if (sp.max_abs) return absBig(n) > BigInt(sp.max_abs);
      return bitLen(n) > sp.bits - 1;
    }
    function opLabel(op) { return op === 'add' ? '密文加法 A ⊕ B' : (op === 'mul' ? '密文乘法 A ⊗ B' : '明文数乘 A ⊗ b'); }

    /* ================= 算法目录与配置（HE-ALGO-01/02/03） ================= */

    k.route('GET', '/he/algorithms', function () {
      return k.ok({ items: ALGORITHMS.map(function (a) {
        return Object.assign({}, a, { libraries: LIBRARIES.filter(function (l) { return l.schemes.indexOf(a.scheme) >= 0; }).map(function (l) { return l.library; }) });
      }) });
    });
    k.route('GET', '/he/libraries', function () {
      return k.ok({
        schemes: ALGORITHMS.map(function (a) { return a.scheme; }),
        items: LIBRARIES.map(function (l) {
          const m = {};
          ALGORITHMS.forEach(function (a) { m[a.scheme] = l.schemes.indexOf(a.scheme) >= 0; });
          return Object.assign({}, l, { matrix: m });
        })
      });
    });

    function configOf(pid) {
      return db.config[pid] || Object.assign({ project_id: pid, updated_at: null }, DEFAULT_CONFIG);
    }
    k.route('GET', '/projects/{project_id}/he/config', function (p) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      return k.ok(configOf(p.project_id));
    });
    k.route('PUT', '/projects/{project_id}/he/config', function (p, q, body) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      const a = algo(body.scheme);
      if (!a) return k.err(40000, '未知加密方案 ' + body.scheme);
      const l = lib(body.library);
      if (!l) return k.err(40000, '未知底层库 ' + body.library);
      if (l.schemes.indexOf(a.scheme) < 0) {
        return k.err(40001, l.name + ' 不支持 ' + a.name + '，可选：' + LIBRARIES.filter(function (x) {
          return x.schemes.indexOf(a.scheme) >= 0;
        }).map(function (x) { return x.name; }).join(' / '), { scheme: a.scheme, library: l.library });
      }
      const prec = body.precision === undefined ? configOf(p.project_id).precision : body.precision;
      if (!Number.isInteger(prec) || prec < 0 || prec > 8) return k.err(40003, '精度必须是 0 – 8 的整数');
      db.config[p.project_id] = { project_id: p.project_id, scheme: a.scheme, library: l.library, precision: prec, updated_at: k.NOW() };
      return k.ok(db.config[p.project_id]);
    });

    /* ================= 数据编码（HE-ALGO-06/07） ================= */

    /** 一组数在精度 p 下的定点化结果。 */
    function encodeAt(scheme, values, p) {
      const scale = Math.pow(10, p);
      let maxErr = 0, maxBits = 0, overflow = false;
      const items = values.map(function (v) {
        const enc = toFixedBig(v, p);
        const decoded = fromFixedBig(enc, p);
        const e = Math.abs(Number(decoded) - Number(v));
        if (e > maxErr) maxErr = e;
        maxBits = Math.max(maxBits, bitLen(enc));
        if (overflowOf(scheme, enc)) overflow = true;
        return { input: String(v).trim(), encoded_integer: enc.toString(), encoded_bits: bitLen(enc), decoded: decoded, abs_error: e };
      });
      return { precision: p, scale_factor: scale, items: items, max_abs_error: maxErr, max_encoded_bits: maxBits, overflow: overflow, error_bound: 0.5 / scale };
    }

    k.route('POST', '/he/encode', function (p, q, body) {
      const a = algo(body.scheme);
      if (!a) return k.err(40000, '未知加密方案 ' + body.scheme);
      const values = body.values;
      if (!Array.isArray(values) || !values.length) return k.err(40000, 'values 至少 1 个');
      if (values.length > 64) return k.err(40003, '一次最多编码 64 个数');
      for (let i = 0; i < values.length; i++) {
        if (!isNumStr(values[i])) return k.err(40002, '第 ' + (i + 1) + ' 个值不是合法数值：' + values[i]);
      }
      const prec = body.precision;
      if (!Number.isInteger(prec) || prec < 0 || prec > 8) return k.err(40003, '精度必须是 0 – 8 的整数');
      const allInt = values.every(isIntStr);
      if (a.plaintext_type === 'float') {
        return k.ok({
          scheme: a.scheme, mode: 'native', converted: false, precision: prec,
          note: 'CKKS 原生支持浮点：编码为 round(x · Δ) 的多项式系数，Δ = 2^' + CKKS_SCALE_BITS + '，无需定点化；精度只决定输出保留位数',
          items: values.map(function (v) { return { input: String(v).trim(), encoded_integer: null, encoded_bits: null, decoded: Number(v).toFixed(prec), abs_error: Math.abs(Number(Number(v).toFixed(prec)) - Number(v)) }; }),
          sweep: []
        });
      }
      const cur = encodeAt(a.scheme, values, allInt ? 0 : prec);
      const sweep = [];
      for (let pp = 0; pp <= 8; pp++) {
        const r = encodeAt(a.scheme, values, pp);
        // 两个同精度定点数相乘后缩放变为 10^(2p)，位数约翻倍，用于提示乘法溢出风险
        let mulOverflow = false;
        r.items.forEach(function (it) { if (overflowOf(a.scheme, BigInt(it.encoded_integer) * BigInt(it.encoded_integer))) mulOverflow = true; });
        sweep.push({ precision: pp, scale_factor: r.scale_factor, max_abs_error: r.max_abs_error, error_bound: r.error_bound, max_encoded_bits: r.max_encoded_bits, overflow: r.overflow, mul_overflow: mulOverflow });
      }
      return k.ok(Object.assign({
        scheme: a.scheme, mode: allInt ? 'integer' : 'fixed_point', converted: !allInt,
        plaintext_space: a.plaintext_space,
        note: allInt ? '输入全为整数，直接加密，缩放因子 1' : a.name + ' 仅支持整数：按 round(x · 10^' + prec + ') 自动转为定点整数，解密后除以 10^' + prec + ' 还原',
        sweep: sweep
      }, cur, { precision: prec, scale_exponent: allInt ? 0 : prec }));
    });

    /* ================= 运算验证（HE-ALGO-04/05） ================= */

    k.route('POST', '/he/verify', function (p, q, body) {
      try { return verify(body); } catch (x) { if (x && x.he) return x.he; throw x; }
    });
    function verify(body) {
      const a = algo(body.scheme);
      if (!a) return k.err(40000, '未知加密方案 ' + body.scheme);
      const op = body.op;
      if (['add', 'mul', 'mul_plain'].indexOf(op) < 0) return k.err(40000, 'op 必须是 add / mul / mul_plain');
      if (op === 'mul' && a.supported_ops.indexOf('mul_ct_ct') < 0) return k.err(40001, a.name + ' 不支持密文乘密文，请选择明文数乘');
      const A = body.a, B = body.b;
      if (!Array.isArray(A) || !A.length) return k.err(40000, '操作数 A 至少 1 个');
      if (A.length > 64) return k.err(40003, '一次最多验证 64 个数');
      if (!Array.isArray(B) || !(B.length === A.length || (op === 'mul_plain' && B.length === 1))) {
        return k.err(40000, '操作数 B 的个数必须与 A 相同' + (op === 'mul_plain' ? '（明文数乘可只给 1 个标量）' : ''));
      }
      const all = A.concat(B);
      for (let i = 0; i < all.length; i++) {
        if (!isNumStr(all[i])) return k.err(40002, '不是合法数值：' + all[i]);
      }
      const prec = body.precision;
      if (!Number.isInteger(prec) || prec < 0 || prec > 8) return k.err(40003, '精度必须是 0 – 8 的整数');
      if (body.library) {
        const l = lib(body.library);
        if (!l) return k.err(40000, '未知底层库 ' + body.library);
        if (l.schemes.indexOf(a.scheme) < 0) return k.err(40001, l.name + ' 不支持 ' + a.name);
      }
      const bAt = function (i) { return B.length === 1 ? B[0] : B[i]; };
      const n = A.length;
      const perf = PERF[a.scheme];
      // 定点化指数：加法两边须同缩放；乘法各操作数独立缩放（整数操作数不放大），结果缩放为两者之和
      const native = a.plaintext_type === 'float';
      const allInt = all.every(isIntStr);
      const sA = native || (op === 'add' ? allInt : A.every(isIntStr)) ? 0 : prec;
      const sB = native || (op === 'add' ? allInt : B.every(isIntStr)) ? 0 : prec;
      const sExp = Math.max(sA, sB);
      const rExpAll = op === 'add' ? sExp : sA + sB;
      const mode = native ? 'ckks_native' : (sExp === 0 ? 'integer' : 'fixed_point');
      const rand = rng([a.scheme, op, prec].concat(all).join('|'));
      const rows = [];
      let maxErr = 0;

      for (let i = 0; i < n; i++) {
        const x = Number(A[i]), y = Number(bAt(i));
        const expected = op === 'add' ? x + y : x * y;
        let raw, encA = null, encB = null, encR = null;
        if (mode === 'ckks_native') {
          const u = rand() * 2 - 1;
          const errBits = op === 'add' ? CKKS_SCALE_BITS - 12 : CKKS_SCALE_BITS - 18;
          raw = expected + u * (1 + Math.abs(expected)) * Math.pow(2, -errBits);
        } else {
          const ea = toFixedBig(A[i], op === 'add' ? sExp : sA), eb = toFixedBig(bAt(i), op === 'add' ? sExp : sB);
          const er = op === 'add' ? ea + eb : ea * eb;
          const rExp = rExpAll;
          [ea, eb, er].forEach(function (v) {
            if (overflowOf(a.scheme, v)) {
              throw { he: k.err(40003, a.name + ' 明文空间 ' + a.plaintext_space.label + '，第 ' + (i + 1) + ' 组编码后整数 ' + v.toString() +
                ' 超出范围，请降低精度或改用 CKKS', { index: i, encoded_integer: v.toString() }) };
            }
          });
          encA = ea.toString(); encB = eb.toString(); encR = er.toString();
          raw = Number(fromFixedBig(er, rExp));
        }
        const e = Math.abs(raw - expected);
        if (e > maxErr) maxErr = e;
        rows.push({ index: i + 1, a: String(A[i]).trim(), b: String(bAt(i)).trim(), expected: expected, decrypted: raw, abs_error: e, encoded_a: encA, encoded_b: encB, encoded_result: encR });
      }

      const cts = perf.packed ? Math.ceil(n / perf.slots) : n;
      const ctB = op === 'mul_plain' ? 0 : cts;
      const seed = a.scheme + op + n;
      const steps = [
        { stage: 'keygen', label: '密钥生成', elapsed_ms: r1(perf.keygen * jitter(seed + 'k')), size_kb: null, detail: a.typical_params },
        { stage: 'encode', label: '编码', elapsed_ms: r2(0.02 * n), size_kb: null,
          detail: mode === 'ckks_native' ? 'CKKS 编码：系数 = round(x · 2^' + CKKS_SCALE_BITS + ')，' + n + ' 个数打包进 1 条密文的槽位'
            : (mode === 'integer' ? '整数输入，直接加密' : '定点化：A × 10^' + (op === 'add' ? sExp : sA) + '，B × 10^' + (op === 'add' ? sExp : sB) + '，取整') },
        { stage: 'encrypt', label: '加密', elapsed_ms: r1(perf.enc * (cts + ctB) * jitter(seed + 'e')), size_kb: r1(perf.ct_kb * (cts + ctB)),
          detail: (cts + ctB) + ' 条密文（A ' + cts + ' 条' + (ctB ? '，B ' + ctB + ' 条' : '，B 以明文参与') + '）' },
        { stage: 'evaluate', label: '密态运算', elapsed_ms: r1((op === 'add' ? perf.add : perf.mul) * cts * jitter(seed + 'v')), size_kb: r1(perf.ct_kb * cts), detail: opLabel(op) },
        { stage: 'decrypt', label: '解密', elapsed_ms: r1(perf.dec * cts * jitter(seed + 'd')), size_kb: null,
          detail: mode === 'fixed_point' ? '解密后除以 10^' + rExpAll + ' 还原' : '解密并解码' }
      ];
      return k.ok({
        scheme: a.scheme, library: body.library || a.default_library, op: op, op_label: opLabel(op), mode: mode,
        precision: prec, scale_exponent_a: op === 'add' ? sExp : sA, scale_exponent_b: op === 'add' ? sExp : sB, result_scale_exponent: rExpAll,
        ckks_scale_bits: mode === 'ckks_native' ? CKKS_SCALE_BITS : null,
        rows: rows, max_abs_error: maxErr,
        total_elapsed_ms: r1(steps.reduce(function (s, x) { return s + x.elapsed_ms; }, 0)),
        steps: steps
      });
    }

    /* ================= 参数寻优（HE-ALGO-08） ================= */

    /** CKKS 参数规则：Δ 位数 = ⌈d · log2 10⌉ + 20（编码与重缩放噪声余量），q0 = P = min(60, Δ + 20)，中间素数每层一个 Δ。 */
    function optimize(sec, depth, digits, batch) {
      const scaleBits = Math.min(60, Math.max(20, Math.ceil(digits * Math.log2(10)) + 20));
      const q0 = Math.min(60, scaleBits + 20);
      const chain = [q0];
      for (let i = 0; i < depth; i++) chain.push(scaleBits);
      chain.push(q0);
      const total = chain.reduce(function (s, x) { return s + x; }, 0);
      const L = depth + 1;   // 新鲜密文所在层的 RNS 素数个数（不含特殊素数）
      const rows = N_LIST.map(function (N) {
        const bound = HE_STD[sec][N];
        const reasons = [];
        if (total > bound) reasons.push('总模数 ' + total + ' bit 超过 ' + sec + ' 位安全上限 ' + bound + ' bit');
        if (N / 2 < batch) reasons.push('槽位 ' + N / 2 + ' 个少于批大小 ' + batch);
        const lg = Math.log2(N);
        return {
          poly_modulus_degree: N, coeff_modulus_bits: chain, total_modulus_bits: total, max_modulus_bits: bound,
          margin_bits: bound - total, scale_bits: scaleBits, slots: N / 2,
          integer_bits: q0 - scaleBits,
          est_add_ms: Number((2.85e-6 * N * L).toFixed(3)),
          est_mul_ms: Number((2.27e-6 * N * lg * L * (L + 1)).toFixed(2)),
          ciphertext_kb: r1(2 * N * L * 8 / 1024),
          feasible: reasons.length === 0, reasons: reasons
        };
      });
      return { scale_bits: scaleBits, chain: chain, total: total, rows: rows };
    }

    k.route('POST', '/he/param-optimize', function (p, q, body) {
      const sec = Number(body.security_bits);
      if (!HE_STD[sec]) return k.err(40000, '安全强度只能是 128 / 192 / 256 位');
      const depth = body.mult_depth, digits = body.precision_digits, batch = body.batch_size;
      if (!Number.isInteger(depth) || depth < 1 || depth > 30) return k.err(40003, '乘法深度必须是 1 – 30 的整数');
      if (!Number.isInteger(digits) || digits < 1 || digits > 8) return k.err(40003, '精度需求必须是 1 – 8 位小数');
      if (!Number.isInteger(batch) || batch < 1 || batch > 16384) return k.err(40003, '批大小必须是 1 – 16384 的整数');
      const r = optimize(sec, depth, digits, batch);
      const feasible = r.rows.filter(function (x) { return x.feasible; });
      if (!feasible.length) {
        return k.err(40003, '在 N ≤ 32768 内无法同时满足 ' + sec + ' 位安全、乘法深度 ' + depth + '、' + digits + ' 位小数精度（需总模数 ' + r.total +
          ' bit，上限 ' + HE_STD[sec][32768] + ' bit），请降低乘法深度或精度，或改用自举方案', { total_modulus_bits: r.total });
      }
      const best = feasible[0];
      const idx = r.rows.indexOf(best);
      const cands = [];
      if (idx > 0) cands.push(r.rows[idx - 1]);   // 小一档的 N 作为不可行对照
      feasible.slice(0, cands.length ? 2 : 3).forEach(function (x) { cands.push(x); });
      return k.ok({
        scheme: 'ckks',
        input: { security_bits: sec, mult_depth: depth, precision_digits: digits, batch_size: batch },
        recommended: Object.assign({ recommended: true }, best),
        candidates: cands.map(function (x) { return Object.assign({ recommended: x === best }, x); }),
        rules: [
          '缩放因子 Δ = 2^' + r.scale_bits + '：精度需求 ' + digits + ' 位小数需 ⌈' + digits + ' × log2 10⌉ = ' + Math.ceil(digits * Math.log2(10)) +
            ' bit，另加 20 bit 编码与重缩放噪声余量（上限 60 bit）',
          '模数链 = [q0, Δ × ' + depth + ', P]：q0 与特殊素数 P 取 min(60, Δ + 20) = ' + r.chain[0] + ' bit（保留 20 bit 整数部分），每一层乘法消耗一个 Δ 位素数',
          '多项式阶数 N 取满足「总模数 ≤ HomomorphicEncryption.org 安全标准上限」且「N / 2 ≥ 批大小」的最小值',
          '耗时按 SEAL 4.1 单线程量级外推：N = 8192、3 个素数时加法约 0.07 ms、乘法（含重线性化与重缩放）约 2.9 ms，加法按 N·L、乘法按 N·log2 N·L·(L+1) 缩放；密文大小 = 2 × N × L × 8 字节'
        ],
        security_table: Object.keys(HE_STD[sec]).map(function (N) { return { poly_modulus_degree: Number(N), max_modulus_bits: HE_STD[sec][N] }; })
      });
    });

    /* ================= 密钥生命周期（HE-APP-03） ================= */

    function policyOf(pid) { return db.policy[pid] || { project_id: pid, enabled: true, period_days: 30, updated_at: null }; }
    function projectNodes(pid) { return k.db.nodes[pid] || []; }

    function newKey(pid, scheme, opts) {
      const sch = algo(scheme);
      const id = k.nextId('hek');
      const created = opts.created_at || k.NOW();
      const params = scheme === 'paillier' ? { key_size_bits: opts.key_size_bits || 2048 }
        : (scheme === 'tfhe' ? { parameter_set: 'PARAM_MESSAGE_2_CARRY_2' } : { poly_modulus_degree: 8192 });
      const managed = opts.purpose === 'fl_aggregation';
      const key = {
        key_id: id, scheme: scheme, project_id: pid, key_params: params,
        public_key_preview: k.hashHex('pk' + scheme + id, 5).slice(0, 56),
        elapsed_ms: PERF[scheme].keygen, created_at: created,
        expires_at: new Date(Date.parse(created) + (managed ? policyOf(pid).period_days * DAY : DAY)).toISOString()
      };
      k.db.heKeys[id] = key;
      db.keys[id] = {
        key_id: id, project_id: pid, scheme: scheme, scheme_name: sch.name, purpose: opts.purpose || 'session',
        status: 'active', storage: '平台密钥服务（KMS）托管，私钥不出域', distributed_to: [],
        rotated_from: opts.rotated_from || null, rotated_to: null, rotated_at: null, rotate_reason: null, destroyed_at: null
      };
      return key;
    }
    function keyView(id) {
      const m = db.keys[id];
      const core = k.db.heKeys[id] || m.snapshot;
      const pol = policyOf(m.project_id);
      return Object.assign({}, core, m, {
        snapshot: undefined,
        next_rotation_at: m.status === 'active' && m.purpose === 'fl_aggregation' && pol.enabled
          ? new Date(Date.parse(core.created_at) + pol.period_days * DAY).toISOString() : null
      });
    }
    function distribute(m, nodeIds, at) {
      nodeIds.forEach(function (nid) {
        if (!m.distributed_to.some(function (d) { return d.node_id === nid; })) m.distributed_to.push({ node_id: nid, distributed_at: at || k.NOW() });
      });
    }
    function rotate(id, reason, at) {
      const m = db.keys[id];
      const old = k.db.heKeys[id];
      const nk = newKey(m.project_id, m.scheme, { purpose: m.purpose, rotated_from: id, key_size_bits: old.key_params.key_size_bits, created_at: at });
      distribute(db.keys[nk.key_id], m.distributed_to.map(function (d) { return d.node_id; }), at);
      m.status = 'rotated'; m.rotated_to = nk.key_id; m.rotated_at = at || k.NOW(); m.rotate_reason = reason;
      return nk.key_id;
    }

    /** 每个项目首次访问播种 1 把在用的联邦聚合密钥（12 天前生成）和它轮换掉的前一把（42 天前生成）。 */
    function seedKeys(pid) {
      if (db.seeded[pid]) return;
      db.seeded[pid] = true;
      const now = Date.now();
      const nodes = projectNodes(pid).map(function (x) { return x.node_id; });
      const old = newKey(pid, 'paillier', { purpose: 'fl_aggregation', created_at: new Date(now - 42 * DAY).toISOString() });
      distribute(db.keys[old.key_id], nodes, new Date(now - 42 * DAY + 60000).toISOString());
      rotate(old.key_id, 'auto', new Date(now - 12 * DAY).toISOString());
    }
    function autoRotate(pid) {
      const pol = policyOf(pid);
      if (!pol.enabled) return;
      Object.keys(db.keys).forEach(function (id) {
        const m = db.keys[id];
        if (m.project_id !== pid || m.status !== 'active' || m.purpose !== 'fl_aggregation') return;
        if (Date.now() - Date.parse(k.db.heKeys[id].created_at) >= pol.period_days * DAY) rotate(id, 'auto');
      });
    }

    k.routeFirst('POST', '/he/keys', function (p, q, body) {
      if (!algo(body.scheme)) return k.err(40000, '未知加密方案 ' + body.scheme);
      if (!body.project_id || !project(body.project_id)) return k.err(40000, 'project_id 必填且必须是已有项目');
      if (body.purpose && ['session', 'fl_aggregation'].indexOf(body.purpose) < 0) return k.err(40000, 'purpose 必须是 session 或 fl_aggregation');
      const ks = body.key_params && body.key_params.key_size_bits;
      if (ks && (body.scheme !== 'paillier' || [2048, 3072, 4096].indexOf(ks) < 0)) return k.err(40000, 'key_size_bits 仅 Paillier 可设，取 2048 / 3072 / 4096');
      const ids = body.node_ids || [];
      const known = projectNodes(body.project_id).map(function (x) { return x.node_id; });
      const bad = ids.filter(function (x) { return known.indexOf(x) < 0; });
      if (bad.length) return k.err(40400, '节点不属于本项目：' + bad.join('、'));
      seedKeys(body.project_id);
      const key = newKey(body.project_id, body.scheme, { purpose: body.purpose, key_size_bits: ks });
      distribute(db.keys[key.key_id], ids);
      return k.ok(keyView(key.key_id));
    });
    k.routeFirst('DELETE', '/he/keys/{key_id}', function (p) {
      const m = db.keys[p.key_id];
      if (!k.db.heKeys[p.key_id] || (m && m.status === 'destroyed')) return k.err(40402, '密钥不存在或已销毁');
      if (m) { m.snapshot = k.db.heKeys[p.key_id]; m.status = 'destroyed'; m.destroyed_at = k.NOW(); }
      delete k.db.heKeys[p.key_id];
      Object.keys(k.db.heCiphers).forEach(function (c) { if (k.db.heCiphers[c].key_id === p.key_id) delete k.db.heCiphers[c]; });
      return k.ok({ key_id: p.key_id, destroyed: true });
    });
    k.route('GET', '/he/keys', function (p, q) {
      if (!q.project_id || !project(q.project_id)) return k.err(40000, 'project_id 必填且必须是已有项目');
      seedKeys(q.project_id);
      autoRotate(q.project_id);
      let ids = Object.keys(db.keys).filter(function (id) { return db.keys[id].project_id === q.project_id; });
      if (q.status) ids = ids.filter(function (id) { return q.status.split(',').indexOf(db.keys[id].status) >= 0; });
      if (q.purpose) ids = ids.filter(function (id) { return db.keys[id].purpose === q.purpose; });
      const items = ids.map(keyView).sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); });
      return k.ok({ items: items, total: items.length, policy: policyOf(q.project_id) });
    });
    k.route('POST', '/he/keys/{key_id}/distribute', function (p, q, body) {
      const m = db.keys[p.key_id];
      if (!m) return k.err(40402, '密钥不存在');
      if (m.status !== 'active') return k.err(40901, '只有使用中的密钥可以分发，当前状态 ' + m.status, { status: m.status });
      const ids = body.node_ids;
      if (!Array.isArray(ids) || !ids.length) return k.err(40000, 'node_ids 至少选 1 个节点');
      const known = projectNodes(m.project_id).map(function (x) { return x.node_id; });
      const bad = ids.filter(function (x) { return known.indexOf(x) < 0; });
      if (bad.length) return k.err(40400, '节点不属于本项目：' + bad.join('、'));
      distribute(m, ids);
      return k.ok(keyView(p.key_id));
    });
    k.route('POST', '/he/keys/{key_id}/rotate', function (p) {
      const m = db.keys[p.key_id];
      if (!m) return k.err(40402, '密钥不存在');
      if (m.status !== 'active') return k.err(40901, '只有使用中的密钥可以轮换，当前状态 ' + m.status, { status: m.status });
      const nid = rotate(p.key_id, 'manual');
      return k.ok({ old_key: keyView(p.key_id), new_key: keyView(nid) });
    });
    k.route('GET', '/projects/{project_id}/he/rotation-policy', function (p) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      return k.ok(policyOf(p.project_id));
    });
    k.route('PUT', '/projects/{project_id}/he/rotation-policy', function (p, q, body) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      if (typeof body.enabled !== 'boolean') return k.err(40000, 'enabled 必须是布尔值');
      const d = body.period_days;
      if (!Number.isInteger(d) || d < 1 || d > 365) return k.err(40003, '轮换周期必须是 1 – 365 的整数天');
      db.policy[p.project_id] = { project_id: p.project_id, enabled: body.enabled, period_days: d, updated_at: k.NOW() };
      seedKeys(p.project_id);
      autoRotate(p.project_id);
      return k.ok(db.policy[p.project_id]);
    });

    /* ================= 流程测试模拟（HE-APP-04） ================= */

    /** 标准正态（Box-Muller）。 */
    function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

    k.route('POST', '/projects/{project_id}/he/simulations', function (p, q, body) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      const scheme = body.scheme || 'paillier';
      if (['paillier', 'ckks'].indexOf(scheme) < 0) return k.err(40000, '联邦聚合模拟只支持 paillier / ckks');
      const dim = body.dim, parties = body.parties;
      if ([1000, 10000].indexOf(dim) < 0) return k.err(40000, '梯度维度只能是 1000 或 10000');
      if (!Number.isInteger(parties) || parties < 2 || parties > 5) return k.err(40003, '参与方数必须是 2 – 5');
      const prec = body.precision === undefined ? 6 : body.precision;
      if (!Number.isInteger(prec) || prec < 0 || prec > 8) return k.err(40003, '精度必须是 0 – 8 的整数');
      const tol = body.tolerance === undefined ? 1e-4 : Number(body.tolerance);
      if (!(tol > 0 && tol <= 1)) return k.err(40003, '容差必须在 (0, 1] 之间');

      // 模拟梯度：每个参与方 dim 维，N(0, 0.02²)，同输入同输出
      const r = rng([p.project_id, scheme, dim, parties].join('|'));
      const grads = [];
      for (let i = 0; i < parties; i++) {
        const g = new Array(dim);
        for (let j = 0; j < dim; j++) g[j] = gauss(r) * 0.02;
        grads.push(g);
      }
      const scale = Math.pow(10, prec);
      let maxErr = 0, sumErr = 0, maxEnc = 0;
      for (let j = 0; j < dim; j++) {
        let plain = 0, agg;
        for (let i = 0; i < parties; i++) plain += grads[i][j];
        if (scheme === 'paillier') {
          let s = 0;   // 定点整数求和（|g|·10^8 < 2^53，Number 精确）
          for (let i = 0; i < parties; i++) s += Math.round(grads[i][j] * scale);
          if (Math.abs(s) > maxEnc) maxEnc = Math.abs(s);
          agg = s / scale;
        } else {
          agg = plain + (r() * 2 - 1) * Math.sqrt(parties) * Math.pow(2, -(CKKS_SCALE_BITS - 12));
        }
        const e = Math.abs(agg - plain);
        sumErr += e;
        if (e > maxErr) maxErr = e;
      }
      const perf = PERF[scheme];
      const perCt = scheme === 'paillier' ? PAILLIER_SLOTS : perf.slots;
      const cts = Math.ceil(dim / perCt);
      const slotBits = maxEnc ? Math.ceil(Math.log2(maxEnc + 1)) + 1 : 1;
      const seed = p.project_id + scheme + dim + parties;
      const steps = [
        { stage: 'keygen', label: '密钥生成', elapsed_ms: r1(perf.keygen * jitter(seed + 'k')), ciphertext_kb: null, ciphertext_count: null,
          detail: scheme === 'paillier' ? 'Paillier n = 2048 bit' : 'CKKS N = 8192，Δ = 2^40' },
        { stage: 'encrypt', label: '加密（每个参与方）', elapsed_ms: r1(perf.enc * cts * jitter(seed + 'e')), ciphertext_kb: r1(perf.ct_kb * cts), ciphertext_count: cts,
          detail: scheme === 'paillier' ? dim + ' 维定点化（×10^' + prec + '）后每 ' + PAILLIER_SLOTS + ' 个打包为 1 条密文' : dim + ' 维按 ' + perf.slots + ' 槽位打包' },
        { stage: 'aggregate', label: '密态聚合', elapsed_ms: r1(perf.add * cts * (parties - 1) * jitter(seed + 'a')), ciphertext_kb: r1(perf.ct_kb * cts), ciphertext_count: cts,
          detail: parties + ' 方密文逐条相加，聚合方全程不解密' },
        { stage: 'decrypt', label: '解密', elapsed_ms: r1(perf.dec * cts * jitter(seed + 'd')), ciphertext_kb: null, ciphertext_count: cts,
          detail: scheme === 'paillier' ? '解密后除以 10^' + prec + ' 还原' : '解密并解码' }
      ];
      const checks = [
        { name: '密文条数一致', passed: true, detail: '每个参与方 ' + cts + ' 条密文，聚合结果 ' + cts + ' 条' },
        { name: '聚合结果维度', passed: true, detail: '解密后 ' + dim + ' 维，与输入梯度维度一致' },
        { name: '最大绝对误差 ≤ 容差', passed: maxErr <= tol, detail: '最大绝对误差 ' + maxErr.toExponential(2) + '，容差 ' + tol.toExponential(0) }
      ];
      if (scheme === 'paillier') {
        checks.push({ name: '打包槽位不溢出', passed: slotBits <= 64, detail: '求和后定点整数最多 ' + slotBits + ' bit（含符号），槽位 64 bit' });
      }
      const passed = checks.every(function (c) { return c.passed; });
      const sim = {
        sim_id: k.nextId('hesim'), project_id: p.project_id, scheme: scheme, dim: dim, parties: parties, precision: prec, tolerance: tol,
        max_abs_error: maxErr, mean_abs_error: sumErr / dim, passed: passed, steps: steps, checks: checks,
        total_elapsed_ms: r1(steps[0].elapsed_ms + steps[1].elapsed_ms * parties + steps[2].elapsed_ms + steps[3].elapsed_ms),
        conclusion: passed
          ? '通过：' + parties + ' 方 × ' + dim + ' 维模拟梯度经 加密 → 密态聚合 → 解密 后与明文求和一致，最大绝对误差 ' + maxErr.toExponential(2) + ' 在容差内'
          : '未通过：' + checks.filter(function (c) { return !c.passed; }).map(function (c) { return c.name + '（' + c.detail + '）'; }).join('；') +
            (scheme === 'paillier' ? '。可提高定点精度或放宽容差' : ''),
        created_at: k.NOW()
      };
      db.sims.unshift(sim);
      return k.ok(sim);
    });
    k.route('GET', '/projects/{project_id}/he/simulations', function (p) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      const items = db.sims.filter(function (s) { return s.project_id === p.project_id; });
      return k.ok({ items: items, total: items.length });
    });

    /* ================= 加解密性能日志（HE-APP-05） ================= */

    function simLogs(s) {
      const rows = [];
      s.steps.forEach(function (st) {
        const each = st.stage === 'encrypt' ? s.parties : 1;
        for (let i = 0; i < each; i++) {
          rows.push({
            source: 'simulation', ref_id: s.sim_id, ref_name: '流程测试 ' + s.dim + ' 维 × ' + s.parties + ' 方', round: null,
            stage: st.stage, stage_label: st.stage === 'encrypt' ? '加密' : st.label, scheme: s.scheme,
            party: st.stage === 'encrypt' ? '参与方 ' + String.fromCharCode(65 + i) : (st.stage === 'aggregate' ? '聚合方' : '密钥服务'),
            elapsed_ms: st.elapsed_ms, ciphertext_kb: st.ciphertext_kb, ciphertext_count: st.ciphertext_count, recorded_at: s.created_at
          });
        }
      });
      return rows;
    }
    /** 同态聚合训练任务：每轮 每个训练节点加密上传 → 聚合方密态求和 → 密钥服务解密，梯度按 Paillier 32 槽位打包。 */
    function jobLogs(job) {
      const nodes = k.jobNodes(job);
      const trainers = nodes.filter(function (x) { return x.role === 'trainer'; });
      const agg = nodes.filter(function (x) { return x.role === 'aggregator'; })[0];
      const cts = Math.ceil((FL_PARAMS[job.algorithm] || 20000) / PAILLIER_SLOTS);
      const perf = PERF.paillier;
      const rows = [];
      const base = { source: 'fl_job', ref_id: job.job_id, ref_name: job.name, scheme: 'paillier' };
      job.metrics.forEach(function (m) {
        const seed = job.job_id + '#' + m.round;
        trainers.forEach(function (nd) {
          rows.push(Object.assign({}, base, { round: m.round, stage: 'encrypt', stage_label: '加密', party: nd.node_id,
            elapsed_ms: r1(perf.enc * cts * jitter(seed + nd.node_id)), ciphertext_kb: r1(perf.ct_kb * cts), ciphertext_count: cts, recorded_at: m.recorded_at }));
        });
        rows.push(Object.assign({}, base, { round: m.round, stage: 'aggregate', stage_label: '密态聚合', party: agg ? agg.node_id : '聚合方',
          elapsed_ms: r1(perf.add * cts * Math.max(1, trainers.length - 1) * jitter(seed + 'agg')), ciphertext_kb: r1(perf.ct_kb * cts), ciphertext_count: cts, recorded_at: m.recorded_at }));
        rows.push(Object.assign({}, base, { round: m.round, stage: 'decrypt', stage_label: '解密', party: '密钥服务',
          elapsed_ms: r1(perf.dec * cts * jitter(seed + 'dec')), ciphertext_kb: null, ciphertext_count: cts, recorded_at: m.recorded_at }));
      });
      return rows;
    }
    function logsOf(pid, q) {
      const jobs = k.jobsOfProject(pid).filter(function (j) { return j.aggregation === 'he'; });
      const sims = db.sims.filter(function (s) { return s.project_id === pid; });
      const refs = sims.map(function (s) { return { source: 'simulation', ref_id: s.sim_id, ref_name: '流程测试 ' + s.dim + ' 维 × ' + s.parties + ' 方（' + (s.passed ? '通过' : '未通过') + '）' }; })
        .concat(jobs.map(function (j) { return { source: 'fl_job', ref_id: j.job_id, ref_name: j.name + '（' + j.metrics.length + ' 轮）' }; }));
      let rows = [];
      if (!q.source || q.source === 'simulation') sims.forEach(function (s) { rows = rows.concat(simLogs(s)); });
      if (!q.source || q.source === 'fl_job') jobs.forEach(function (j) { rows = rows.concat(jobLogs(j)); });
      if (q.ref_id) rows = rows.filter(function (x) { return x.ref_id === q.ref_id; });
      rows.forEach(function (x, i) { x.log_id = 'hel_' + k.hashHex(x.ref_id + x.round + x.stage + x.party + i, 1); });
      return { rows: rows, refs: refs };
    }
    function validSource(q) { return !q.source || ['simulation', 'fl_job'].indexOf(q.source) >= 0; }

    k.route('GET', '/projects/{project_id}/he/logs', function (p, q) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      if (!validSource(q)) return k.err(40000, 'source 只能是 simulation 或 fl_job');
      const r = logsOf(p.project_id, q);
      const sum = function (st, f) { return r1(r.rows.filter(function (x) { return x.stage === st; }).reduce(function (s, x) { return s + (x[f] || 0); }, 0)); };
      return k.ok({
        items: r.rows, total: r.rows.length, refs: r.refs,
        summary: ['encrypt', 'aggregate', 'decrypt', 'evaluate', 'keygen'].map(function (st) {
          const n = r.rows.filter(function (x) { return x.stage === st; }).length;
          return { stage: st, count: n, total_elapsed_ms: sum(st, 'elapsed_ms'), avg_elapsed_ms: n ? r1(sum(st, 'elapsed_ms') / n) : null, total_ciphertext_kb: sum(st, 'ciphertext_kb') };
        }).filter(function (x) { return x.count > 0; })
      });
    });
    k.download(/^\/projects\/([^/]+)\/he\/logs\/export$/, function (m, q) {
      if (!project(m[1]) || !validSource(q)) return null;
      const r = logsOf(m[1], q);
      let csv = '来源,任务或测试 ID,名称,轮次,环节,方案,节点或参与方,耗时(ms),密文大小(KB),密文条数,记录时间\n';
      r.rows.forEach(function (x) {
        csv += [x.source === 'fl_job' ? '训练任务' : '流程测试', x.ref_id, '"' + x.ref_name.replace(/"/g, '""') + '"', x.round === null ? '' : x.round,
          x.stage_label, x.scheme, x.party, x.elapsed_ms, x.ciphertext_kb === null ? '' : x.ciphertext_kb, x.ciphertext_count === null ? '' : x.ciphertext_count, x.recorded_at].join(',') + '\n';
      });
      return { fileName: 'he_logs_' + m[1] + (q.ref_id ? '_' + q.ref_id : '') + '.csv', contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
    });
  });
})();
