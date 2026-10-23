/**
 * mock 扩展：联邦学习 · 聚合与安全（FL-AGG-01–07）+ 技术指标验证（FL-EVAL-01–03）。接口见 docs/api/fed-sec.md。
 *
 * 数据命名空间：
 *   k.db.fla[project_id]      已保存的聚合配置 { strategy, ss, he, sparsification, updated_at }（任务编排页读 strategy）
 *   k.db.flaKeys[project_id]  项目聚合密钥列表（最新在前），为同态模块密钥的镜像，读取时同步；私钥只留 key_id
 *   k.db.fle[eval_id]         指标评估运行记录
 *
 * 仿真数值全部是确定性的：同一项目、同一配置得到同一结果（种子 = k.hashHex(项目 + 配置)）。
 */
(function () {
  'use strict';
  window.MockServer.extend(function (k) {
    const db = k.db;
    db.fla = db.fla || {};
    db.flaKeys = db.flaKeys || {};
    db.fle = db.fle || {};

    /* ================= 常量 ================= */

    // 验收场景模型：2 层 LSTM（隐藏单元 128），输入 9 维特征（3 类氧化物价格 + 6 维市场特征），预测步长 7
    //   第 1 层 4×(128×(9+128)+128) = 70,656；第 2 层 4×(128×256+128) = 131,584；输出层 128×7+7 = 903
    const MODEL = { name: 'LSTM（2 层 × 128 隐藏单元，输入 9 维，预测步长 7）', params: k.MODEL_PARAMS.lstm };   // 内核参数量表，lstm = 203,143
    const IDX_BITS = Math.ceil(Math.log2(MODEL.params));   // 单个下标编码位数 = ⌈log₂P⌉ = 18
    const FLOAT_BITS = 32;
    const ECDH_PUB_BITS = 256;                             // 掩码种子协商：每方 X25519 公钥 256 bit
    const CKKS_MAX_COEFF = { 4096: 109, 8192: 218, 16384: 438, 32768: 881 };   // HE 标准 128 bit 安全上限

    const LIMITS = {
      ss: {
        parties: { min: 2, max: 16 },
        threshold: { min: 2 },
        dropout_tolerance: { min: 0 },
        field_bits: { min: 16, max: 64 },
        mask_rotation_rounds: { min: 1, max: 100 }
      },
      he: {
        schemes: ['paillier', 'ckks'],
        key_size_bits: [2048, 3072, 4096],
        precision_bits: { min: 8, max: 53 },
        paillier_batch_size: { min: 1, max: 128 },
        poly_modulus_degree: [4096, 8192, 16384, 32768],
        ckks_max_coeff_modulus_bits: CKKS_MAX_COEFF,
        scale_bits: { min: 20, max: 60 }
      },
      sparsification: {
        topk_ratio: { min: 0.001, max: 1 },
        quant_bits: [4, 8, 16, 32]
      }
    };

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function log2ceil(n) { return Math.ceil(Math.log2(Math.max(2, n))); }
    /** 0–1 的确定性伪随机数 */
    function rnd(seed) { return parseInt(k.hashHex(seed, 1), 16) / 4294967296; }
    function project(pid) { return db.projects.filter(function (p) { return p.project_id === pid; })[0] || null; }
    function trainerCount(pid) {
      return (db.nodes[pid] || []).filter(function (n) { return n.role === 'trainer'; }).length;
    }
    function partiesOf(pid) { return Math.min(16, Math.max(2, trainerCount(pid) || 3)); }

    /* ================= 默认 / 推荐配置 ================= */

    function defaults(pid) {
      const n = partiesOf(pid);
      return {
        strategy: 'ss',
        ss: { parties: n, threshold: 2, dropout_tolerance: 0, field_bits: 16, mask_rotation_rounds: 5 },
        he: {
          scheme: 'paillier', key_size_bits: 2048, precision_bits: 24, batch_size: 16,
          poly_modulus_degree: 8192, coeff_modulus_bits: 218, scale_bits: 40
        },
        sparsification: { enabled: true, topk_ratio: 0.15, error_feedback: true, quant_bits: 8 }
      };
    }

    /** 推荐配置：门限取多数派 ⌊n/2⌋+1，掉线容忍取满 n−t；Paillier 按明文空间打满批打包；CKKS 取 N=8192 标准参数。 */
    function recommended(pid) {
      const n = partiesOf(pid);
      const t = Math.floor(n / 2) + 1;
      const slotBits = 24 + log2ceil(n) + 1;
      return {
        ss: { parties: n, threshold: t, dropout_tolerance: n - t, field_bits: 16, mask_rotation_rounds: 10 },
        he: {
          paillier: { scheme: 'paillier', key_size_bits: 2048, precision_bits: 24, batch_size: Math.min(128, Math.floor((2048 - 1) / slotBits)) },
          ckks: { scheme: 'ckks', poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40, batch_size: 4096 }
        },
        sparsification: { enabled: true, topk_ratio: 0.15, error_feedback: true, quant_bits: 8 }
      };
    }

    /* ================= 校验 ================= */

    function bad(code, field, message) { return { error: k.err(code, message, { field: field }) }; }

    /** 标签以字母或数字结尾时与后文空一格（「门限 t 超出范围」） */
    function spaced(label) { return /[A-Za-z0-9]$/.test(label) ? label + ' ' : label; }

    function checkInt(v, field, label, lo, hi) {
      label = spaced(label);
      if (v === undefined || v === null || v === '') return bad(40000, field, label + '必填');
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad(40002, field, label + '必须是数字');
      if (!Number.isInteger(v)) return bad(40002, field, label + '必须是整数');
      if ((lo !== null && v < lo) || (hi !== null && v > hi)) {
        return bad(40003, field, label + '超出范围：允许 ' + (lo !== null ? lo : '−∞') + ' 至 ' + (hi !== null ? hi : '+∞') + '，当前 ' + v);
      }
      return null;
    }
    function checkEnum(v, field, label, list) {
      label = spaced(label);
      if (list.indexOf(v) < 0) return bad(40000, field, label + '必须是 ' + list.join(' / ') + ' 之一');
      return null;
    }

    /**
     * 校验并规整一份聚合配置；返回 { config } 或 { error }。
     * 两种策略的参数都校验（都会存进项目），同态参数只校验当前方案用到的字段。
     */
    function validateConfig(body, pid) {
      body = body || {};
      const d = defaults(pid);
      const r = checkEnum(body.strategy, 'strategy', '聚合策略', ['ss', 'he']);
      if (r) return r;
      const ss = Object.assign({}, d.ss, body.ss || {});
      const he = Object.assign({}, d.he, body.he || {});
      const sp = Object.assign({}, d.sparsification, body.sparsification || {});
      const L = LIMITS;
      let e;

      // 稀疏化（先校验：有限域位数依赖量化位数）
      if (typeof sp.enabled !== 'boolean') return bad(40000, 'sparsification.enabled', '稀疏化开关必须是布尔值');
      if (typeof sp.error_feedback !== 'boolean') return bad(40000, 'sparsification.error_feedback', '误差反馈开关必须是布尔值');
      if (typeof sp.topk_ratio !== 'number' || !Number.isFinite(sp.topk_ratio)) return bad(40002, 'sparsification.topk_ratio', 'Top-k 保留比例必须是数字');
      if (sp.topk_ratio < L.sparsification.topk_ratio.min || sp.topk_ratio > L.sparsification.topk_ratio.max) {
        return bad(40003, 'sparsification.topk_ratio', 'Top-k 保留比例超出范围：允许 0.1% 至 100%，当前 ' + Number((sp.topk_ratio * 100).toFixed(3)) + '%');
      }
      e = checkEnum(sp.quant_bits, 'sparsification.quant_bits', '量化位数', L.sparsification.quant_bits); if (e) return e;

      // 秘密共享
      e = checkInt(ss.parties, 'ss.parties', '参与方数量 n', L.ss.parties.min, L.ss.parties.max); if (e) return e;
      e = checkInt(ss.threshold, 'ss.threshold', '门限 t', 2, ss.parties); if (e) return e;
      e = checkInt(ss.dropout_tolerance, 'ss.dropout_tolerance', '掉线容忍数', 0, ss.parties - ss.threshold); if (e) return e;
      e = checkInt(ss.field_bits, 'ss.field_bits', '有限域位数', L.ss.field_bits.min, L.ss.field_bits.max); if (e) return e;
      const needField = sp.quant_bits + log2ceil(ss.parties);
      if (ss.field_bits < needField) {
        return bad(40003, 'ss.field_bits', '有限域位数不足：n = ' + ss.parties + ' 方求和不溢出至少需要 量化位数 ' + sp.quant_bits +
          ' + ⌈log₂n⌉ ' + log2ceil(ss.parties) + ' = ' + needField + ' 位，当前 ' + ss.field_bits);
      }
      e = checkInt(ss.mask_rotation_rounds, 'ss.mask_rotation_rounds', '掩码种子轮换周期', L.ss.mask_rotation_rounds.min, L.ss.mask_rotation_rounds.max); if (e) return e;

      // 同态加密
      e = checkEnum(he.scheme, 'he.scheme', '同态方案', L.he.schemes); if (e) return e;
      if (he.scheme === 'paillier') {
        e = checkEnum(he.key_size_bits, 'he.key_size_bits', '密钥长度', L.he.key_size_bits); if (e) return e;
        e = checkInt(he.precision_bits, 'he.precision_bits', '定点编码精度', L.he.precision_bits.min, L.he.precision_bits.max); if (e) return e;
        e = checkInt(he.batch_size, 'he.batch_size', '批打包大小', L.he.paillier_batch_size.min, L.he.paillier_batch_size.max); if (e) return e;
        const slotBits = he.precision_bits + log2ceil(ss.parties) + 1;
        if (he.batch_size * slotBits > he.key_size_bits - 1) {
          return bad(40003, 'he.batch_size', '批打包超出明文空间：批打包大小 × 槽位宽度（精度 ' + he.precision_bits + ' + ⌈log₂n⌉ ' +
            log2ceil(ss.parties) + ' + 符号位 1 = ' + slotBits + ' 位）须 ≤ 密钥长度 − 1 = ' + (he.key_size_bits - 1) +
            '，当前 ' + (he.batch_size * slotBits) + '，最多可打包 ' + Math.floor((he.key_size_bits - 1) / slotBits) + ' 个');
        }
      } else {
        e = checkEnum(he.poly_modulus_degree, 'he.poly_modulus_degree', '多项式阶数 N', L.he.poly_modulus_degree); if (e) return e;
        const maxQ = CKKS_MAX_COEFF[he.poly_modulus_degree];
        e = checkInt(he.scale_bits, 'he.scale_bits', '缩放因子位数', L.he.scale_bits.min, L.he.scale_bits.max); if (e) return e;
        e = checkInt(he.coeff_modulus_bits, 'he.coeff_modulus_bits', '系数模数总位数', he.scale_bits + 20, maxQ); if (e) return e;
        e = checkInt(he.batch_size, 'he.batch_size', '批打包大小（槽位数）', 1, he.poly_modulus_degree / 2); if (e) return e;
      }
      return {
        config: {
          strategy: body.strategy,
          ss: { parties: ss.parties, threshold: ss.threshold, dropout_tolerance: ss.dropout_tolerance, field_bits: ss.field_bits, mask_rotation_rounds: ss.mask_rotation_rounds },
          he: {
            scheme: he.scheme, key_size_bits: he.key_size_bits, precision_bits: he.precision_bits, batch_size: he.batch_size,
            poly_modulus_degree: he.poly_modulus_degree, coeff_modulus_bits: he.coeff_modulus_bits, scale_bits: he.scale_bits
          },
          sparsification: { enabled: sp.enabled, topk_ratio: sp.topk_ratio, error_feedback: sp.error_feedback, quant_bits: sp.quant_bits }
        }
      };
    }

    /* ================= 通信量估算（FL-AGG-07 / FL-EVAL-02 共用） ================= */

    /**
     * 单轮通信量（bit）。全局 Top-k：服务端按上一轮聚合结果下发统一下标集合，各客户端只上传这些位置，
     * 秘密共享掩码与同态密文槽位因此对齐，上行不带下标。
     *   FedAvg   = n × (上行 P×32 + 下行 P×32)
     *   本算法   = n × (上行 + 下行) + 掩码种子协商
     *   上行（秘密共享）= k × 有限域位数
     *   上行（同态）    = ⌈k / 批打包⌉ × 单密文位数（Paillier 2×密钥长度；CKKS 2×N×系数模数位数）
     *   下行            = k × 32（聚合后的明文更新）+ min(k×⌈log₂P⌉, P)（下一轮下标集合：列表或位图取小）
     *   种子协商        = n×(n−1)×2×256 / 轮换周期（仅秘密共享）
     * 其中 k = ⌈ρ_r × P⌉，未开启稀疏化时 ρ = 1 且不传下标。
     */
    function commRound(cfg, n, rhoFactor) {
      const P = MODEL.params;
      const sp = cfg.sparsification;
      const rho = sp.enabled ? Math.min(1, sp.topk_ratio * (rhoFactor || 1)) : 1;
      const kk = Math.ceil(rho * P);
      let upBits, ctBits = null, ctCount = null;
      if (cfg.strategy === 'he') {
        const he = cfg.he;
        ctBits = he.scheme === 'paillier' ? 2 * he.key_size_bits : 2 * he.poly_modulus_degree * he.coeff_modulus_bits;
        ctCount = Math.ceil(kk / he.batch_size);
        upBits = ctCount * ctBits;
      } else {
        upBits = kk * cfg.ss.field_bits;
      }
      const idxBits = sp.enabled ? Math.min(kk * IDX_BITS, P) : 0;
      const downBits = kk * FLOAT_BITS + idxBits;
      const seedBits = cfg.strategy === 'ss' ? n * (n - 1) * 2 * ECDH_PUB_BITS / cfg.ss.mask_rotation_rounds : 0;
      const oursBits = n * (upBits + downBits) + seedBits;
      const fedavgBits = n * 2 * FLOAT_BITS * P;
      return {
        kept: kk, rho: rho,
        upload_bytes_per_client: upBits / 8,
        download_bytes_per_client: downBits / 8,
        index_bytes: idxBits / 8,
        seed_bytes: seedBits / 8,
        ciphertext_bits: ctBits, ciphertext_count: ctCount,
        ours_bytes: oursBits / 8,
        fedavg_bytes: fedavgBits / 8,
        ratio: fedavgBits / oursBits
      };
    }

    function estimateView(cfg) {
      const n = cfg.ss.parties;
      const r = commRound(cfg, n, 1);
      return Object.assign(r, {
        strategy: cfg.strategy, client_count: n,
        model: MODEL.name, model_params: MODEL.params, index_bits: IDX_BITS,
        min_ratio_required: 6, meets_contract: r.ratio >= 6
      });
    }

    /* ================= 视图 ================= */

    function keySummary(key) {
      if (!key) return null;
      return {
        key_id: key.key_id, scheme: key.scheme, key_size_bits: key.key_size_bits,
        poly_modulus_degree: key.poly_modulus_degree, coeff_modulus_bits: key.coeff_modulus_bits,
        fingerprint: key.fingerprint, status: key.status, created_at: key.created_at
      };
    }
    /**
     * 项目聚合密钥与同态加密模块共用一套（docs/api/he.md H.7.7）：
     *   - 本页生成的密钥只写内核 k.db.heKeys（purpose = 'fl_aggregation'），同态模块列出时自行补建生命周期元数据；
     *   - 项目当前有效聚合密钥 = 同态模块生命周期表 k.db.he.keys 里 status = active 的 fl_aggregation 密钥
     *     （同态页播种、轮换出的 hek_ 接替者都算），表中没有的再看 k.db.heKeys[key_id].status；
     *   - k.db.flaKeys[project_id] 是它的镜像（每次读取时同步），内核 aggregationInfo 直接读它，任务详情 he_public_key_id 因此一致。
     */
    const flaStore = {};
    Object.keys(db.flaKeys).forEach(function (pid) { flaStore[pid] = db.flaKeys[pid]; });
    db.flaKeys = new Proxy(flaStore, {
      get: function (t, pid) { return typeof pid === 'string' && project(pid) ? syncKeys(pid) : t[pid]; }
    });

    function heLife() { return db.he && db.he.keys ? db.he : null; }

    /** 公钥记录：Paillier 公钥 = 模数 n（完整十六进制）；CKKS 公钥是 2 个 RNS 多项式，只给前 512 bit 预览 */
    function keyRecord(pid, id, scheme, kp, createdAt) {
      const seed = pid + id + scheme;
      const ks = scheme === 'paillier' ? (kp.key_size_bits || 2048) : null;
      const N = scheme === 'ckks' ? (kp.poly_modulus_degree || 8192) : null;
      // 同态模块允许 coeff_modulus_bits 为各素数位数数组，求和即总位数
      const qRaw = Array.isArray(kp.coeff_modulus_bits) ? kp.coeff_modulus_bits.reduce(function (a, b) { return a + b; }, 0) : kp.coeff_modulus_bits;
      const Q = scheme === 'ckks' ? (qRaw || CKKS_MAX_COEFF[N]) : null;
      return {
        key_id: id, project_id: pid, scheme: scheme,
        key_size_bits: ks, poly_modulus_degree: N, coeff_modulus_bits: Q,
        public_key: scheme === 'paillier' ? k.hashHex('n' + seed, ks / 32) : k.hashHex('pk' + seed, 16),
        public_key_bytes: scheme === 'paillier' ? ks / 8 : 2 * N * Q / 8,
        public_key_truncated: scheme === 'ckks',
        generator: scheme === 'paillier' ? 'g = n + 1' : null,
        security_bits: scheme === 'paillier' ? { 2048: 112, 3072: 128, 4096: 152 }[ks] : 128,
        fingerprint: 'SHA256:' + k.hashHex('fp' + seed, 8),
        private_key_ref: 'kms://fl-agg/' + pid + '/' + id,
        status: 'active',
        created_at: createdAt
      };
    }

    /** 某把密钥的真实状态：生命周期元数据优先（外部把 heKeys.status 改成 rotated / destroyed 视为覆盖），其次 heKeys，都没有即已销毁。 */
    function statusOf(id) {
      const life = heLife();
      const m = life && life.keys[id];
      const c = db.heKeys[id];
      if (m) return m.status === 'active' && c && (c.status === 'rotated' || c.status === 'destroyed') ? c.status : m.status;
      if (c) return c.status || 'active';
      return 'destroyed';
    }

    function syncKeys(pid) {
      const list = flaStore[pid] || (flaStore[pid] = []);
      const life = heLife();
      if (life) {
        Object.keys(life.keys).forEach(function (id) {
          const m = life.keys[id];
          if (m.project_id !== pid || m.purpose !== 'fl_aggregation') return;
          if (list.some(function (x) { return x.key_id === id; })) return;
          const core = db.heKeys[id] || m.snapshot;
          if (!core) return;
          const kp = Object.assign({}, core.key_params || {});
          // 同态页轮换 CKKS 密钥时只带 N，系数模数沿用被轮换的那把
          const from = m.rotated_from && list.filter(function (x) { return x.key_id === m.rotated_from; })[0];
          if (core.scheme === 'ckks' && !kp.coeff_modulus_bits && from) kp.coeff_modulus_bits = from.coeff_modulus_bits;
          list.push(keyRecord(pid, id, core.scheme, kp, core.created_at));
        });
      }
      list.forEach(function (x) {
        const st = statusOf(x.key_id);
        if (st !== x.status) { x.status = st; x.rotated_at = x.rotated_at || k.NOW(); }
      });
      list.sort(function (a, b) { return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0); });
      return list;
    }
    function activeKey(pid) {
      return syncKeys(pid).filter(function (x) { return x.status === 'active'; })[0] || null;
    }
    function keyMatches(key, he) {
      if (!key || key.scheme !== he.scheme) return false;
      if (he.scheme === 'paillier') return key.key_size_bits === he.key_size_bits;
      return key.poly_modulus_degree === he.poly_modulus_degree && key.coeff_modulus_bits === he.coeff_modulus_bits;
    }

    function aggView(pid) {
      const saved = db.fla[pid];
      const cfg = saved ? clone(saved) : Object.assign(defaults(pid), { updated_at: null });
      const key = activeKey(pid);
      return {
        project_id: pid,
        project_name: project(pid).name,
        saved: !!saved,
        strategy: cfg.strategy, ss: cfg.ss, he: cfg.he, sparsification: cfg.sparsification,
        updated_at: cfg.updated_at,
        trainer_count: trainerCount(pid),
        he_key: keySummary(key),
        he_key_matches: keyMatches(key, cfg.he),
        estimate: estimateView(cfg),
        defaults: defaults(pid),
        recommended: recommended(pid),
        limits: LIMITS
      };
    }

    function needProject(p) {
      if (!project(p.project_id)) return k.err(40400, '项目不存在');
      return null;
    }

    /* ================= 聚合配置路由 ================= */

    k.route('GET', '/projects/{project_id}/fl/aggregation', function (p) {
      return needProject(p) || k.ok(aggView(p.project_id));
    });

    k.route('PUT', '/projects/{project_id}/fl/aggregation', function (p, q, body) {
      const nf = needProject(p); if (nf) return nf;
      const v = validateConfig(body, p.project_id);
      if (v.error) return v.error;
      const cfg = v.config;
      if (cfg.strategy === 'he') {
        const key = activeKey(p.project_id);
        if (!key) return k.err(40901, '同态加密聚合需要先生成密钥对', { field: 'he_key' });
        if (!keyMatches(key, cfg.he)) {
          return k.err(40901, '同态加密参数与当前密钥对 ' + key.key_id + ' 不一致，请重新生成密钥对', { field: 'he_key', key_id: key.key_id });
        }
      }
      cfg.updated_at = k.NOW();
      db.fla[p.project_id] = cfg;
      return k.ok(aggView(p.project_id));
    });

    k.route('POST', '/projects/{project_id}/fl/aggregation/reset', function (p) {
      const nf = needProject(p); if (nf) return nf;
      const cfg = defaults(p.project_id);
      cfg.updated_at = k.NOW();
      db.fla[p.project_id] = cfg;
      return k.ok(aggView(p.project_id));
    });

    // 实时估算，不落库
    k.route('POST', '/projects/{project_id}/fl/aggregation/estimate', function (p, q, body) {
      const nf = needProject(p); if (nf) return nf;
      const v = validateConfig(body, p.project_id);
      if (v.error) return v.error;
      return k.ok(estimateView(v.config));
    });

    /* --- 密钥对 --- */

    k.route('GET', '/projects/{project_id}/fl/aggregation/keys', function (p) {
      const nf = needProject(p); if (nf) return nf;
      const items = syncKeys(p.project_id).map(keySummary);
      return k.ok({ items: items, page: 1, page_size: 20, total: items.length });
    });

    k.route('POST', '/projects/{project_id}/fl/aggregation/keys', async function (p, q, body) {
      const nf = needProject(p); if (nf) return nf;
      const pid = p.project_id;
      const cur = db.fla[pid] || defaults(pid);
      const v = validateConfig({ strategy: 'he', ss: cur.ss, he: (body && body.he) || {}, sparsification: cur.sparsification }, pid);
      if (v.error) return v.error;
      // 同态加密模块首次访问项目时会播种聚合密钥；先触发它的播种，再轮换并登记新密钥，保证项目只有一把在用的聚合密钥
      if (heLife() && !db.he.seeded[pid]) await window.MockServer.handle('GET', '/he/keys?project_id=' + encodeURIComponent(pid));
      const he = v.config.he;
      const now = k.NOW();
      const id = k.nextId('flk');
      let prev = null;
      syncKeys(pid).forEach(function (x) {
        if (x.status !== 'active') return;
        // 按 H.7.7 改 heKeys 的 status，同态模块会同步到它的生命周期表
        if (db.heKeys[x.key_id]) { db.heKeys[x.key_id].status = 'rotated'; db.heKeys[x.key_id].rotated_to = id; db.heKeys[x.key_id].rotated_at = now; }
        x.status = 'rotated'; x.rotated_at = now;
        prev = x.key_id;
      });
      const kp = he.scheme === 'paillier' ? { key_size_bits: he.key_size_bits }
        : { poly_modulus_degree: he.poly_modulus_degree, coeff_modulus_bits: he.coeff_modulus_bits, scale_bits: he.scale_bits };
      const key = keyRecord(pid, id, he.scheme, kp, now);
      const life = heLife();
      const period = life && life.policy[pid] ? life.policy[pid].period_days : 30;
      db.heKeys[id] = {
        key_id: id, project_id: pid, scheme: he.scheme, purpose: 'fl_aggregation', status: 'active', source: 'fed-sec',
        key_params: kp,
        // 兼容 §3 / §2.8 读 key_size_bits 的地方；CKKS 无模数位数，取系数模数总位数 log₂Q
        key_size_bits: he.scheme === 'paillier' ? he.key_size_bits : he.coeff_modulus_bits,
        distributed_to: (db.nodes[pid] || []).map(function (n) { return { node_id: n.node_id, distributed_at: now }; }),
        rotated_from: prev, rotated_to: null,
        public_key_preview: key.public_key.slice(0, 56),
        elapsed_ms: 8.5, created_at: now,
        expires_at: new Date(Date.parse(now) + period * 86400000).toISOString()
      };
      flaStore[pid].unshift(key);
      return k.ok(publicKeyView(key));
    });

    function publicKeyView(key) {
      const pj = project(key.project_id);
      return {
        key_id: key.key_id, project_id: key.project_id, project_name: pj ? pj.name : key.project_id,
        scheme: key.scheme, key_size_bits: key.key_size_bits,
        poly_modulus_degree: key.poly_modulus_degree, coeff_modulus_bits: key.coeff_modulus_bits,
        security_bits: key.security_bits, generator: key.generator,
        public_key: key.public_key, public_key_bytes: key.public_key_bytes, public_key_truncated: key.public_key_truncated,
        fingerprint: key.fingerprint, private_key_ref: key.private_key_ref,
        status: key.status, created_at: key.created_at
      };
    }

    k.route('GET', '/projects/{project_id}/fl/aggregation/public-key', function (p) {
      const nf = needProject(p); if (nf) return nf;
      const key = activeKey(p.project_id);
      if (!key) return k.err(40402, '尚未生成同态加密密钥对，请先在同态加密聚合下点击「生成密钥对」');
      return k.ok(publicKeyView(key));
    });

    /**
     * 覆盖内核 GET /fl/jobs/{job_id}/he-public-key（API.md §2.8）：任务所属项目在聚合与安全页生成过密钥时，
     * 返回该项目当前有效密钥，过程管控页与同态应用集成页看到的公钥与本页一致；否则按内核原逻辑生成。
     * 响应字段与 §2.8 兼容；CKKS 无「模数位数」，key_size_bits 取系数模数总位数 log₂Q，另附 N 与 log₂Q。
     */
    k.routeFirst('GET', '/fl/jobs/{job_id}/he-public-key', function (p) {
      const job = db.flJobs[p.job_id];
      if (!job) return k.err(40400, '任务不存在');
      if (job.aggregation !== 'he') return k.err(40400, '当前聚合策略不是同态加密聚合');
      const key = activeKey(job.project_id);
      if (key) {
        return k.ok({
          key_id: key.key_id,
          scheme: key.scheme,
          key_size_bits: key.scheme === 'paillier' ? key.key_size_bits : key.coeff_modulus_bits,
          poly_modulus_degree: key.poly_modulus_degree,
          coeff_modulus_bits: key.coeff_modulus_bits,
          public_key: key.public_key,
          fingerprint: key.fingerprint,
          created_at: key.created_at,
          source: 'project'
        });
      }
      // 内核原逻辑（mock-server.js aggregationInfo + §2.8 路由）
      return k.ok({
        key_id: 'hek_' + k.hashHex(job.job_id, 1).slice(0, 4),
        scheme: 'paillier',
        key_size_bits: 2048,
        public_key: k.hashHex('agg' + job.job_id, 8),
        fingerprint: 'SHA256:' + k.hashHex('fp' + job.job_id, 2).slice(0, 32),
        created_at: job.created_at
      });
    });

    /* ================= 指标评估 ================= */

    const KINDS = {
      gradient_attack: { label: '梯度重构攻击评估', acc: 'FL-EVAL-01', steps: 10,
        stages: ['加载稀土氧化物价格数据集', '1 服务端 + 3 客户端联邦训练，截获客户端上行梯度', '运行 DLG 攻击（明文 FedAvg）', '运行 DLG 攻击（本算法）',
          '运行 iDLG 攻击（明文 FedAvg）', '运行 iDLG 攻击（本算法）', '计算还原 MSE 并统计成功率'] },
      compression: { label: '通信压缩比评估', acc: 'FL-EVAL-02', steps: 8,
        stages: ['加载稀土氧化物价格数据集', '运行明文 FedAvg 并逐轮统计通信量', '运行本算法并逐轮统计通信量', '在测试集上评估 RMSE / MAE'] },
      accuracy: { label: '联邦训练精度衰减评估', acc: 'FL-EVAL-03', steps: 10,
        stages: ['加载 MNIST / CIFAR-10', '集中式明文训练（MNIST）', '联邦训练（MNIST）', '集中式明文训练（CIFAR-10）', '联邦训练（CIFAR-10）', '测试集评估 Accuracy'] }
    };
    const MSE_THRESHOLD = 0.0025;
    const EVAL_CLIENTS = 3;            // 合同场景：1 服务端 + 3 客户端
    const EVAL_TICK_MS = 400;

    function evalDefaults(kind, pid) {
      if (kind === 'gradient_attack') return { sample_count: 200, max_iterations: 300, target_client: 'all', seed: 2026 };
      if (kind === 'compression') {
        const cfg = db.fla[pid] || defaults(pid);
        return {
          rounds: 20, topk_ratio: cfg.sparsification.topk_ratio, quant_bits: cfg.sparsification.quant_bits,
          error_feedback: cfg.sparsification.error_feedback, field_bits: cfg.ss.field_bits
        };
      }
      return { rounds: 50, local_epochs: 1, partition: 'iid', seed: 2026 };
    }

    function validateEval(kind, body, pid) {
      const c = Object.assign(evalDefaults(kind, pid), body || {});
      let e;
      if (kind === 'gradient_attack') {
        e = checkInt(c.sample_count, 'config.sample_count', '攻击样本数', 20, 1000); if (e) return e;
        e = checkInt(c.max_iterations, 'config.max_iterations', '攻击迭代次数', 50, 2000); if (e) return e;
        e = checkEnum(c.target_client, 'config.target_client', '被攻击客户端', ['all', 'party-a', 'party-b', 'party-c']); if (e) return e;
        e = checkInt(c.seed, 'config.seed', '随机种子', 0, 99999); if (e) return e;
        return { config: { sample_count: c.sample_count, max_iterations: c.max_iterations, target_client: c.target_client, seed: c.seed } };
      }
      if (kind === 'compression') {
        e = checkInt(c.rounds, 'config.rounds', '训练轮次', 5, 100); if (e) return e;
        if (typeof c.topk_ratio !== 'number' || c.topk_ratio < 0.001 || c.topk_ratio > 1) {
          return bad(40003, 'config.topk_ratio', 'Top-k 保留比例超出范围：允许 0.1% 至 100%');
        }
        e = checkEnum(c.quant_bits, 'config.quant_bits', '量化位数', LIMITS.sparsification.quant_bits); if (e) return e;
        if (typeof c.error_feedback !== 'boolean') return bad(40000, 'config.error_feedback', '误差反馈开关必须是布尔值');
        // 与聚合配置同一约束：有限域位数 ≥ 量化位数 + ⌈log₂n⌉（评估场景 n = 3）
        e = checkInt(c.field_bits, 'config.field_bits', '有限域位数', c.quant_bits + log2ceil(EVAL_CLIENTS), 64); if (e) return e;
        return { config: { rounds: c.rounds, topk_ratio: c.topk_ratio, quant_bits: c.quant_bits, error_feedback: c.error_feedback, field_bits: c.field_bits } };
      }
      e = checkInt(c.rounds, 'config.rounds', '联邦轮次', 10, 200); if (e) return e;
      e = checkInt(c.local_epochs, 'config.local_epochs', '本地训练轮数', 1, 5); if (e) return e;
      e = checkEnum(c.partition, 'config.partition', '数据划分', ['iid', 'dirichlet']); if (e) return e;
      e = checkInt(c.seed, 'config.seed', '随机种子', 0, 99999); if (e) return e;
      return { config: { rounds: c.rounds, local_epochs: c.local_epochs, partition: c.partition, seed: c.seed } };
    }

    /* --- FL-EVAL-01 梯度重构攻击 --- */
    function attackResult(pid, c) {
      k.seedProject(pid);
      const ds = db.datasets['ds_' + pid + '_ree_price'];
      const seed = pid + '|' + c.seed + '|' + c.sample_count + '|' + c.max_iterations + '|' + c.target_client;
      // 迭代次数越少攻击越弱：300 次及以上饱和
      const strength = Math.min(1, 0.6 + 0.4 * c.max_iterations / 300);
      function group(key) {
        return ['DLG', 'iDLG'].map(function (atk) {
          const u = rnd(seed + key + atk);
          let rate, mse;
          if (key === 'fedavg') {
            rate = (atk === 'DLG' ? 0.83 : 0.87) * strength + 0.04 * (u - 0.5);
            mse = (atk === 'DLG' ? 0.00118 : 0.00091) / strength * (0.9 + 0.2 * u);
          } else {
            rate = 0.0008 * 2 * u;   // 本算法：期望 0.08%，200 样本时取整为 0
            mse = (atk === 'DLG' ? 0.0874 : 0.0791) * (0.94 + 0.12 * u);
          }
          const success = Math.floor(c.sample_count * rate);
          return {
            attack: atk, sample_count: c.sample_count, success_count: success,
            success_rate: success / c.sample_count, mean_mse: Number(mse.toFixed(5))
          };
        });
      }
      const ours = group('ours');
      const maxRate = Math.max(ours[0].success_rate, ours[1].success_rate);
      return {
        scenario: {
          dataset_id: ds.dataset_id, dataset_name: ds.name, dataset_rows: ds.row_count,
          server_count: 1, client_count: 3, model: MODEL.name, model_params: MODEL.params,
          window_size: 30, feature_count: 9, horizon: 7, batch_size: 1,
          mse_threshold: MSE_THRESHOLD, normalization: 'min-max'
        },
        groups: [
          { key: 'ours', attacks: ours },
          { key: 'fedavg', attacks: group('fedavg') }
        ],
        max_success_rate_required: 0.05,
        max_success_rate: maxRate,
        passed: maxRate <= 0.05
      };
    }

    /* --- FL-EVAL-02 通信压缩比 --- */
    function compressionResult(pid, c) {
      const n = EVAL_CLIENTS;
      const cfg = {
        strategy: 'ss',
        ss: { parties: n, threshold: 2, dropout_tolerance: 1, field_bits: c.field_bits, mask_rotation_rounds: 10 },
        sparsification: { enabled: true, topk_ratio: c.topk_ratio, error_feedback: c.error_feedback, quant_bits: c.quant_bits }
      };
      const seed = pid + '|' + JSON.stringify(c);
      const rounds = [];
      let sumF = 0, sumO = 0;
      for (let r = 1; r <= c.rounds; r++) {
        // 动态裁剪：前几轮梯度能量分散，保留量偏多，随收敛回落到设定比例
        const a = 1 + 0.3 * Math.exp(-(r - 1) / 4) + 0.04 * (rnd(seed + r) - 0.5);
        const x = commRound(cfg, n, a);
        sumF += x.fedavg_bytes; sumO += x.ours_bytes;
        rounds.push({
          round: r, kept: x.kept, kept_ratio: Number(x.rho.toFixed(5)),
          fedavg_bytes: Math.round(x.fedavg_bytes), ours_bytes: Math.round(x.ours_bytes),
          ratio: Number(x.ratio.toFixed(3))
        });
      }
      const avgF = sumF / c.rounds, avgO = sumO / c.rounds;
      const ratio = avgF / avgO;
      // 模型效果（测试集，Min-Max 归一化价格）。轮次少时两者都偏高；误差反馈关闭、量化过粗、保留过少时本算法损失变大
      const base = 1 + 3 / c.rounds;
      const fr = 0.0386 * base, fm = 0.0279 * base;
      const lossPct = (c.error_feedback ? 1.1 : 6.8) + (c.quant_bits <= 4 ? 2.6 : 0) + 40 * Math.max(0, 0.08 - c.topk_ratio) +
        0.6 * (rnd(seed + 'u') - 0.5);
      const or = fr * (1 + lossPct / 100), om = fm * (1 + (lossPct * 0.9) / 100);
      return {
        scenario: {
          dataset_id: 'ds_' + pid + '_ree_price', server_count: 1, client_count: n, model: MODEL.name, model_params: MODEL.params,
          strategy: 'ss', index_bits: IDX_BITS
        },
        rounds: rounds,
        fedavg_avg_bytes: Math.round(avgF),
        ours_avg_bytes: Math.round(avgO),
        ratio: Number(ratio.toFixed(3)),
        utility: {
          fedavg: { rmse: Number(fr.toFixed(4)), mae: Number(fm.toFixed(4)) },
          ours: { rmse: Number(or.toFixed(4)), mae: Number(om.toFixed(4)) },
          rmse_increase_pct: Number(((or / fr - 1) * 100).toFixed(2)),
          mae_increase_pct: Number(((om / fm - 1) * 100).toFixed(2))
        },
        min_ratio_required: 6,
        passed: ratio >= 6
      };
    }

    /* --- FL-EVAL-03 精度衰减 --- */
    function accuracyResult(pid, c) {
      const seed = pid + '|' + JSON.stringify(c);
      const niid = c.partition === 'dirichlet';
      function one(name, model, cen, drop) {
        const fed = cen - drop / 100;
        const d = Number((drop).toFixed(2));
        return {
          dataset: name, model: model,
          centralized_accuracy: Number(cen.toFixed(4)), federated_accuracy: Number(fed.toFixed(4)),
          drop_pp: d, relative_drop_pct: Number((drop / cen).toFixed(2)),
          passed: d <= 3
        };
      }
      const mn = one('MNIST', 'CNN（Conv 5×5×32 → Conv 5×5×64 → FC 512 → FC 10，约 1.66M 参数）',
        0.9935 - 0.02 * Math.exp(-c.rounds / 15),
        0.45 + 12 / c.rounds + (niid ? 0.35 + 0.1 * (c.local_epochs - 1) : 0) + 0.2 * (rnd(seed + 'm') - 0.5));
      const cf = one('CIFAR-10', 'CNN（3 个卷积块 64-128-256 + FC 512 → FC 10，约 3.25M 参数）',
        0.8320 - 0.15 * Math.exp(-c.rounds / 25),
        1.3 + 30 / c.rounds + (niid ? 0.8 + 0.25 * (c.local_epochs - 1) : 0) + 0.3 * (rnd(seed + 'c') - 0.5));
      return {
        scenario: {
          client_count: 3, privacy: 'Top-k 稀疏化 + 秘密共享安全聚合 + 高斯 DP（ε = 8，δ = 1e-5）',
          optimizer: 'SGD（学习率 0.01，动量 0.9，批大小 64）',
          centralized_epochs: c.rounds * c.local_epochs
        },
        datasets: [mn, cf],
        max_drop_pp_required: 3,
        passed: mn.passed && cf.passed
      };
    }

    function evalView(run) {
      return {
        eval_id: run.eval_id, project_id: run.project_id, kind: run.kind, kind_label: KINDS[run.kind].label,
        config: run.config, status: run.status, progress: run.progress, stage: run.stage,
        started_at: run.started_at, finished_at: run.finished_at,
        result: run.status === 'finished' ? run.result : null,
        passed: run.status === 'finished' ? run.result.passed : null
      };
    }

    function runEval(run) {
      const def = KINDS[run.kind];
      run._timer = setInterval(function () {
        run.tick += 1;
        if (run.tick >= def.steps) {
          clearInterval(run._timer); run._timer = null;
          run.result = run.kind === 'gradient_attack' ? attackResult(run.project_id, run.config)
            : run.kind === 'compression' ? compressionResult(run.project_id, run.config)
              : accuracyResult(run.project_id, run.config);
          run.status = 'finished';
          run.progress = 100;
          run.stage = '评估完成';
          run.finished_at = k.NOW();
          k.emit('/fl/evaluations/' + run.eval_id + '/events', 'finished', evalView(run));
          return;
        }
        run.progress = Math.round(run.tick / def.steps * 100);
        run.stage = def.stages[Math.min(def.stages.length - 1, Math.floor(run.tick / def.steps * def.stages.length))];
        k.emit('/fl/evaluations/' + run.eval_id + '/events', 'progress', { eval_id: run.eval_id, progress: run.progress, stage: run.stage });
      }, EVAL_TICK_MS);
    }

    k.route('GET', '/projects/{project_id}/fl/evaluations/defaults', function (p) {
      const nf = needProject(p); if (nf) return nf;
      return k.ok({
        gradient_attack: evalDefaults('gradient_attack', p.project_id),
        compression: evalDefaults('compression', p.project_id),
        accuracy: evalDefaults('accuracy', p.project_id),
        mse_threshold: MSE_THRESHOLD, model: MODEL.name, model_params: MODEL.params
      });
    });

    k.route('POST', '/projects/{project_id}/fl/evaluations', function (p, q, body) {
      const nf = needProject(p); if (nf) return nf;
      body = body || {};
      if (!KINDS[body.kind]) return k.err(40000, '评估类型必须是 gradient_attack / compression / accuracy 之一', { field: 'kind' });
      const running = Object.keys(db.fle).some(function (id) {
        const r = db.fle[id];
        return r.project_id === p.project_id && r.kind === body.kind && r.status === 'running';
      });
      if (running) return k.err(40901, '「' + KINDS[body.kind].label + '」已有评估在运行，请等待完成');
      const v = validateEval(body.kind, body.config, p.project_id);
      if (v.error) return v.error;
      const run = {
        eval_id: k.nextId('fle'), project_id: p.project_id, kind: body.kind, config: v.config,
        status: 'running', progress: 0, stage: KINDS[body.kind].stages[0], tick: 0,
        started_at: k.NOW(), finished_at: null, result: null, _timer: null
      };
      db.fle[run.eval_id] = run;
      runEval(run);
      return k.ok(evalView(run));
    });

    k.route('GET', '/projects/{project_id}/fl/evaluations', function (p, q) {
      const nf = needProject(p); if (nf) return nf;
      if (q.kind && !KINDS[q.kind]) return k.err(40000, '评估类型不合法', { field: 'kind' });
      const items = Object.keys(db.fle).map(function (id) { return db.fle[id]; })
        .filter(function (r) { return r.project_id === p.project_id && (!q.kind || r.kind === q.kind); })
        .sort(function (a, b) { return a.eval_id < b.eval_id ? 1 : -1; })
        .map(evalView);
      return k.ok({ items: items, page: 1, page_size: 100, total: items.length });
    });

    k.route('GET', '/fl/evaluations/{eval_id}', function (p) {
      const run = db.fle[p.eval_id];
      if (!run) return k.err(40400, '评估记录不存在');
      return k.ok(evalView(run));
    });

    /* --- CSV 评估报告 --- */
    function pct(x) { return (x * 100).toFixed(1) + '%'; }
    function csvOf(run) {
      const c = run.config, r = run.result;
      const head = '评估 ID,' + run.eval_id + '\n评估项,' + KINDS[run.kind].label + '（' + KINDS[run.kind].acc + '）\n项目,' + run.project_id +
        '\n开始时间,' + run.started_at + '\n完成时间,' + run.finished_at + '\n配置,"' + JSON.stringify(c).replace(/"/g, '""') + '"\n';
      let body = '';
      if (run.kind === 'gradient_attack') {
        body += '数据集,' + r.scenario.dataset_name + '（' + r.scenario.dataset_id + '）\n联邦架构,1 服务端 + 3 客户端\n还原成功判定,还原样本与原始样本 MSE ≤ ' + MSE_THRESHOLD + '（Min-Max 归一化后逐元素均方误差）\n\n';
        body += '组别,攻击方法,攻击样本数,还原成功数,还原成功率,平均还原 MSE\n';
        r.groups.forEach(function (g) {
          g.attacks.forEach(function (a) {
            body += (g.key === 'ours' ? '本算法（稀疏化 + 安全聚合 + DP）' : '对照：明文 FedAvg') + ',' + a.attack + ',' + a.sample_count + ',' +
              a.success_count + ',' + pct(a.success_rate) + ',' + a.mean_mse + '\n';
          });
        });
        body += '\n合同要求,本算法 DLG、iDLG 还原成功率均 ≤ 5%\n判定,' + (r.passed ? '达标' : '未达标') + '\n';
      } else if (run.kind === 'compression') {
        body += '轮次,本轮保留梯度数,保留比例,FedAvg 通信量(MB),本算法通信量(MB),本轮压缩比\n';
        r.rounds.forEach(function (x) {
          body += x.round + ',' + x.kept + ',' + (x.kept_ratio * 100).toFixed(2) + '%,' + (x.fedavg_bytes / 1048576).toFixed(3) + ',' +
            (x.ours_bytes / 1048576).toFixed(3) + ',' + x.ratio.toFixed(2) + '\n';
        });
        body += '\nFedAvg 单轮平均通信总量(MB),' + (r.fedavg_avg_bytes / 1048576).toFixed(3) + '\n本算法单轮平均通信总量(MB),' +
          (r.ours_avg_bytes / 1048576).toFixed(3) + '\n单轮平均通信压缩比,' + r.ratio.toFixed(2) + '\n';
        body += '\n模型效果（测试集，Min-Max 归一化价格）,RMSE,MAE\n明文 FedAvg,' + r.utility.fedavg.rmse + ',' + r.utility.fedavg.mae +
          '\n本算法,' + r.utility.ours.rmse + ',' + r.utility.ours.mae + '\n相对 FedAvg 变化,+' + r.utility.rmse_increase_pct + '%,+' + r.utility.mae_increase_pct + '%\n';
        body += '\n合同要求,单轮平均通信压缩比 ≥ 6\n判定,' + (r.passed ? '达标' : '未达标') + '\n';
      } else {
        body += '数据集,模型,集中式明文 Accuracy,联邦（含隐私保护）Accuracy,下降幅度(百分点),相对下降,判定\n';
        r.datasets.forEach(function (d) {
          body += d.dataset + ',"' + d.model + '",' + (d.centralized_accuracy * 100).toFixed(2) + '%,' + (d.federated_accuracy * 100).toFixed(2) + '%,' +
            d.drop_pp.toFixed(2) + ',' + d.relative_drop_pct.toFixed(2) + '%,' + (d.passed ? '达标' : '未达标') + '\n';
        });
        body += '\n合同要求,Accuracy 下降幅度 ≤ 3 个百分点\n判定,' + (r.passed ? '达标' : '未达标') + '\n';
      }
      return '﻿' + head + '\n' + body;
    }

    k.download(/^\/fl\/evaluations\/([^/]+)\/export$/, function (m) {
      const run = db.fle[m[1]];
      if (!run || run.status !== 'finished') return null;
      return { fileName: run.eval_id + '_' + run.kind + '_report.csv', contentType: 'text/csv;charset=utf-8', content: csvOf(run) };
    });
  });
})();
