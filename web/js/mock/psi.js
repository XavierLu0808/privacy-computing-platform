/**
 * mock 扩展：隐私求交 · 算法配置（v1.2）。接口见 docs/api/psi.md。
 *
 * - GET  /psi/protocols                    升级内核同名接口：参数加类型 / 范围 / 选项，协议加安全强度说明
 * - GET  /projects/{project_id}/psi/config 当前求交配置（算法配置页写，平台集成页读）
 * - PUT  /projects/{project_id}/psi/config
 * - POST /projects/{project_id}/psi/templates  升级内核同名接口：参数校验 + 重名检查
 * - GET  /projects/{project_id}/psi/templates  升级内核同名接口：首次访问播种 2 个内置模板，最新在前
 * - POST /psi/route-advice                 求交协议自适应路由（合同 C-16）
 * - GET  /psi/benchmarks                   典型场景性能参考
 *
 * 自有数据挂在 k.db.psia；模板沿用内核的 k.db.psiTemplates（同属隐私求交模块）。
 */
(function () {
  'use strict';

  window.MockServer.extend(function (k) {
    const db = k.db.psia = { config: {}, seeded: {} };

    /* ---------- 参数规格 ---------- */

    // type: enum / int / float / bool；enum 的 options 为 [{ value, label }]
    const PARAM_SPEC = {
      ecdh: {
        curve: { type: 'enum', options: [
          { value: 'Curve25519', label: 'Curve25519（X25519，128 位）' },
          { value: 'P-256', label: 'NIST P-256（secp256r1，128 位）' }
        ] },
        hash: { type: 'enum', options: [
          { value: 'SHA-256', label: 'SHA-256' },
          { value: 'SM3', label: 'SM3（国密）' }
        ] },
        batch_size: { type: 'int', min: 1024, max: 65536, step: 1024, unit: '条 / 批',
          hint: '每批往返一次，高延迟链路调大可减少往返次数' },
        point_compression: { type: 'bool', hint: 'P-256 压缩点 33 字节、未压缩 65 字节；Curve25519 恒为 32 字节' }
      },
      kkrt: {
        ot_security_lambda: { type: 'enum', options: [
          { value: 128, label: '128 位（默认）' },
          { value: 256, label: '256 位' }
        ], hint: 'OT 扩展计算安全参数，不低于 128 位' },
        cuckoo_bucket_factor: { type: 'float', min: 1.1, max: 2.0, step: 0.01, unit: '× n',
          hint: '桶数 = 系数 × 接收方集合大小，系数越小越省通信，低于 1.2 时布谷鸟哈希失败率上升' },
        hash_count: { type: 'int', min: 2, max: 4, step: 1, unit: '个' },
        bloom_fpr_log2: { type: 'int', min: -64, max: -30, step: 1, unit: 'log₂',
          hint: '假阳率 = 2 的该次方，−40 即统计安全 40 位' }
      },
      unbalanced: {
        small_set_party_id: { type: 'enum', options: k.PSI_PARTIES.map(function (p) {
          return { value: p.party_id, label: p.party_name };
        }) },
        oprf_batch_size: { type: 'int', min: 256, max: 16384, step: 256, unit: '条 / 批' },
        preprocess_cache_ttl_hours: { type: 'int', min: 0, max: 168, step: 1, unit: '小时',
          hint: '大集合离线预处理结果的缓存时长，0 表示不缓存、每次重新预处理' },
        poly_degree: { type: 'int', min: 255, max: 4095, step: 1, unit: '次',
          hint: '同态多项式求值的插值次数，越大单个密文覆盖的元素越多' }
      }
    };

    const SECURITY = {
      ecdh: {
        security_bits: 128,
        basis: '椭圆曲线判定性 Diffie-Hellman（ECDDH）假设，随机预言机模型',
        detail: 'Curve25519 与 NIST P-256 的离散对数求解复杂度约 2¹²⁸，即 128 位计算安全；半诚实敌手模型下双方只得到交集。',
        threat_model: '半诚实（semi-honest）'
      },
      kkrt: {
        security_bits: 128,
        basis: '基础 OT（基于 Curve25519）+ IKNP 式 OT 扩展 + 伪随机函数（AES-128）',
        detail: 'OT 扩展计算安全参数 λ = 128（基础 OT 与 PRF 均为 128 位计算安全）；布谷鸟哈希与布隆过滤器假阳率取 2⁻⁴⁰，即 40 位统计安全。',
        threat_model: '半诚实（semi-honest）'
      },
      unbalanced: {
        security_bits: 128,
        basis: 'ECDH-OPRF（P-256）+ 全同态加密多项式求值（BFV，环维度 8192）',
        detail: 'OPRF 基于 P-256，128 位计算安全；BFV 参数按 HomomorphicEncryption.org 安全标准取 128 位。大集合方只做一次离线预处理，小集合方的元素不以明文离开本地。',
        threat_model: '半诚实（semi-honest），大集合方可为恶意'
      }
    };

    function protocolsView() {
      return k.PSI_PROTOCOLS.map(function (p) {
        const spec = PARAM_SPEC[p.protocol];
        return Object.assign({}, p, {
          security: SECURITY[p.protocol],
          params: p.params.map(function (pa) {
            const out = Object.assign({}, pa, spec[pa.key]);
            if (pa.key === 'small_set_party_id') out.display = partyLabel(pa.value);
            return out;
          })
        });
      });
    }

    function protoOf(key) { return k.PSI_PROTOCOLS.filter(function (p) { return p.protocol === key; })[0]; }
    function partyLabel(id) {
      const p = k.PSI_PARTIES.filter(function (x) { return x.party_id === id; })[0];
      return p ? p.party_name : id;
    }
    function defaults(protocol) {
      const out = {};
      protoOf(protocol).params.forEach(function (pa) { out[pa.key] = pa.value; });
      return out;
    }

    /**
     * 校验并补全参数：未传的键取协议默认值，未知键 40000，类型不符 40002，越界 / 不在选项内 40003。
     * 返回 { params } 或 { error }。
     */
    function checkParams(protocol, params) {
      const def = protoOf(protocol);
      if (!def) return { error: k.err(40000, '未知协议 ' + protocol) };
      if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
        return { error: k.err(40002, 'params 必须是对象') };
      }
      const spec = PARAM_SPEC[protocol];
      const out = defaults(protocol);
      const keys = Object.keys(params || {});
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], v = params[key], s = spec[key];
        if (!s) return { error: k.err(40000, def.name + ' 没有参数 ' + key) };
        const label = def.params.filter(function (pa) { return pa.key === key; })[0].label;
        if (s.type === 'bool') {
          if (typeof v !== 'boolean') return { error: k.err(40002, label + ' 必须是布尔值') };
        } else if (s.type === 'enum') {
          if (!s.options.some(function (o) { return o.value === v; })) {
            return { error: k.err(40003, label + ' 只能取 ' + s.options.map(function (o) { return o.value; }).join(' / ')) };
          }
        } else {
          if (typeof v !== 'number' || !Number.isFinite(v)) return { error: k.err(40002, label + ' 必须是数字') };
          if (s.type === 'int' && !Number.isInteger(v)) return { error: k.err(40002, label + ' 必须是整数') };
          if (v < s.min || v > s.max) return { error: k.err(40003, label + ' 必须在 ' + s.min + ' – ' + s.max + ' 之间') };
        }
        out[key] = v;
      }
      return { params: out };
    }

    /* ---------- 当前配置 ---------- */

    function configOf(pid) {
      if (!db.config[pid]) {
        db.config[pid] = { project_id: pid, protocol: 'ecdh', params: defaults('ecdh'),
          template_id: null, template_name: null, source: 'default', updated_at: null };
      }
      return db.config[pid];
    }

    k.route('GET', '/projects/{project_id}/psi/config', function (p) {
      return k.ok(configOf(p.project_id));
    });
    k.route('PUT', '/projects/{project_id}/psi/config', function (p, q, body) {
      const source = body.source || 'manual';
      if (['manual', 'template', 'route_advice'].indexOf(source) < 0) return k.err(40000, 'source 只能是 manual / template / route_advice');
      const chk = checkParams(body.protocol, body.params);
      if (chk.error) return chk.error;
      let tpl = null;
      if (body.template_id) {
        tpl = k.db.psiTemplates[body.template_id];
        if (!tpl || tpl.project_id !== p.project_id) return k.err(40400, '模板不存在');
        if (tpl.protocol !== body.protocol) return k.err(40000, '模板协议与配置协议不一致');
      }
      const cfg = configOf(p.project_id);
      Object.assign(cfg, {
        protocol: body.protocol, params: chk.params,
        template_id: tpl ? tpl.template_id : null, template_name: tpl ? tpl.name : null,
        source: tpl ? 'template' : source, updated_at: k.NOW()
      });
      return k.ok(cfg);
    });

    /* ---------- 协议列表 / 模板（升级内核接口） ---------- */

    k.routeFirst('GET', '/psi/protocols', function () { return k.ok({ items: protocolsView() }); });

    function seedTemplates(pid) {
      if (db.seeded[pid]) return;
      db.seeded[pid] = true;
      const day = 86400000;
      [
        { key: 'wan_ecdh', name: '跨机构专线 · ECDH 大分块', protocol: 'ecdh',
          params: { curve: 'Curve25519', hash: 'SHA-256', batch_size: 65536, point_compression: true } },
        { key: 'lan_kkrt', name: '同机房百万级 · KKRT 默认', protocol: 'kkrt',
          params: { ot_security_lambda: 128, cuckoo_bucket_factor: 1.27, hash_count: 3, bloom_fpr_log2: -40 } }
      ].forEach(function (s, i) {
        const id = 'tpl_' + pid + '_' + s.key;
        k.db.psiTemplates[id] = { template_id: id, project_id: pid, name: s.name, protocol: s.protocol,
          params: s.params, builtin: true, created_at: new Date(Date.now() - (5 - i) * day).toISOString() };
      });
    }

    function templatesOf(pid, protocol) {
      seedTemplates(pid);
      return Object.keys(k.db.psiTemplates).map(function (id) { return k.db.psiTemplates[id]; })
        .filter(function (t) { return t.project_id === pid && (!protocol || t.protocol === protocol); })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : (a.created_at > b.created_at ? -1 : 0); });
    }

    k.routeFirst('GET', '/projects/{project_id}/psi/templates', function (p, q) {
      const items = templatesOf(p.project_id, q.protocol);
      return k.ok({ items: items, page: 1, page_size: 20, total: items.length });
    });
    k.routeFirst('POST', '/projects/{project_id}/psi/templates', function (p, q, body) {
      const name = String(body.name || '').trim();
      if (!name) return k.err(40000, '模板名称必填');
      if (name.length > 40) return k.err(40003, '模板名称不超过 40 个字');
      const chk = checkParams(body.protocol, body.params);
      if (chk.error) return chk.error;
      if (templatesOf(p.project_id).some(function (t) { return t.name === name; })) return k.err(40902, '已存在同名模板「' + name + '」');
      const id = k.nextId('tpl');
      const tpl = { template_id: id, project_id: p.project_id, name: name, protocol: body.protocol,
        params: chk.params, builtin: false, created_at: k.NOW() };
      k.db.psiTemplates[id] = tpl;
      return k.ok(tpl);
    });
    k.routeFirst('DELETE', '/psi/templates/{template_id}', function (p) {
      const tpl = k.db.psiTemplates[p.template_id];
      if (!tpl) return k.err(40400, '模板不存在');
      if (tpl.builtin) return k.err(40901, '内置模板不可删除');
      delete k.db.psiTemplates[p.template_id];
      Object.keys(db.config).forEach(function (pid) {   // 当前配置引用的模板被删后，参数保留、来源改为手动
        const c = db.config[pid];
        if (c.template_id === p.template_id) { c.template_id = null; c.template_name = null; c.source = 'manual'; }
      });
      return k.ok({ template_id: p.template_id, deleted: true });
    });

    /* ---------- 自适应路由 ---------- */

    /*
     * 估算模型（单位：秒 / 字节），n_a、n_b 为两方行数，n_l = max、n_s = min，B 为带宽（Mbps），L 为单向延迟（ms）。
     *   网络耗时 = 通信量 × 8 / (B × 10⁶) + 往返次数 × 2L / 1000
     *   ECDH-PSI   计算 = 2 (n_a + n_b) 次标量乘 × 4 µs（Curve25519，8 线程；P-256 取 6 µs）
     *              通信 = (n_a + n_b) × 32 字节（每条记录的掩码曲线点各传一次；n_a = n_b = n 时即 2 × n × 32）
     *              往返 = 2 × ⌈n_l / batch_size⌉
     *   KKRT       计算 = (n_a + n_b) × 1.5 µs（对称密码运算）+ 0.2 s 基础 OT
     *              通信 = 1.27 n_s × 64 字节（OT 扩展）+ 3 n_l × (40 + log₂(n_a n_b)) / 8 字节（OPRF 编码）
     *              往返 = 4
     *   非平衡 PSI 在线计算 = n_s × 40 µs + n_l × 0.05 µs；离线预处理 = n_l × 4 µs（缓存期内复用，不计入在线耗时）
     *              通信 = n_s × (64 + 12 × ⌈log₂ n_l⌉) 字节，往返 = 2 × ⌈n_s / oprf_batch_size⌉ + 2
     * 推荐 = 在线预估耗时最短者；耗时差在 10% 内时取通信量更小者。
     */
    function recommendParams(protocol, req) {
      const p = defaults(protocol);
      if (protocol === 'ecdh') p.batch_size = req.latency_ms >= 20 ? 65536 : 8192;
      if (protocol === 'unbalanced') {
        p.small_set_party_id = req.left_rows <= req.right_rows ? k.PSI_PARTIES[0].party_id : k.PSI_PARTIES[1].party_id;
        p.oprf_batch_size = Math.min(req.left_rows, req.right_rows) < 10000 ? 1024 : 4096;
      }
      return p;
    }

    function estimate(protocol, req, params) {
      const na = req.left_rows, nb = req.right_rows;
      const nl = Math.max(na, nb), ns = Math.min(na, nb);
      let compute, offline = 0, bytes, rounds;
      if (protocol === 'ecdh') {
        compute = 2 * (na + nb) * (params.curve === 'P-256' ? 6e-6 : 4e-6);
        bytes = (na + nb) * (params.curve === 'P-256' && !params.point_compression ? 65 : 32);
        rounds = 2 * Math.ceil(nl / params.batch_size);
      } else if (protocol === 'kkrt') {
        compute = (na + nb) * 1.5e-6 + 0.2;
        bytes = params.cuckoo_bucket_factor * ns * 64 + params.hash_count * nl * (40 + Math.log2(na * nb)) / 8;
        rounds = 4;
      } else {
        compute = ns * 40e-6 + nl * 0.05e-6;
        offline = nl * 4e-6;
        bytes = ns * (64 + 12 * Math.ceil(Math.log2(Math.max(2, nl))));
        rounds = 2 * Math.ceil(ns / params.oprf_batch_size) + 2;
      }
      const network = bytes * 8 / (req.bandwidth_mbps * 1e6) + rounds * 2 * req.latency_ms / 1000;
      return {
        protocol: protocol, name: protoOf(protocol).name,
        params: params,
        compute_sec: round(compute, 2), network_sec: round(network, 2),
        total_sec: round(compute + network, 2), offline_sec: round(offline, 2),
        comm_mb: round(bytes / 1048576, 2), rounds: rounds,
        security_bits: SECURITY[protocol].security_bits
      };
    }

    function round(v, n) { const f = Math.pow(10, n); return Math.round(v * f) / f; }

    function advise(req) {
      const list = ['ecdh', 'kkrt', 'unbalanced'].map(function (pr) { return estimate(pr, req, recommendParams(pr, req)); });
      const byTime = list.slice().sort(function (a, b) { return a.total_sec - b.total_sec; });
      let best = byTime[0];
      if (byTime[1].total_sec <= best.total_sec * 1.1 && byTime[1].comm_mb < best.comm_mb) best = byTime[1];
      const ratio = Math.max(req.left_rows, req.right_rows) / Math.min(req.left_rows, req.right_rows);
      return { best: best, list: list, ratio: ratio };
    }

    function reasonOf(a, req) {
      const b = a.best, others = a.list.filter(function (x) { return x !== b; });
      const ratioText = '两方规模比 ' + fmtRatio(a.ratio) + ' : 1';
      const parts = [];
      if (b.protocol === 'unbalanced') {
        parts.push(ratioText + '，超过 100 : 1 时非平衡 PSI 的在线开销只与小集合规模线性相关');
        parts.push('大集合离线预处理约 ' + b.offline_sec + ' 秒，缓存期内复用');
      } else if (b.protocol === 'kkrt') {
        parts.push(ratioText + '，带宽 ' + req.bandwidth_mbps + ' Mbps 足以承载 KKRT 较高的通信量（' + b.comm_mb + ' MB）');
        parts.push('KKRT 以对称密码运算为主，计算耗时 ' + b.compute_sec + ' 秒，明显低于 ECDH 的椭圆曲线标量乘');
      } else {
        parts.push(ratioText + '，带宽 ' + req.bandwidth_mbps + ' Mbps 下通信是瓶颈，ECDH-PSI 通信量最小（' + b.comm_mb + ' MB）');
        if (b.params.batch_size === 65536) parts.push('链路延迟 ' + req.latency_ms + ' ms，分块大小取 65 536 条 / 批以减少往返次数');
      }
      parts.push('预估在线耗时 ' + b.total_sec + ' 秒，比 ' + others.map(function (o) {
        return o.name + ' 少 ' + Math.max(0, (1 - b.total_sec / o.total_sec) * 100).toFixed(1) + '%';
      }).join('、'));
      return parts.join('；') + '。';
    }

    function fmtRatio(r) { return r >= 100 ? String(Math.round(r)) : String(round(r, 2)); }

    const LIMITS = {
      left_rows: [1, 1e10, '参与方 A 数据量（行）'], right_rows: [1, 1e10, '参与方 B 数据量（行）'],
      bandwidth_mbps: [0.1, 100000, '网络带宽（Mbps）'], latency_ms: [0, 2000, '网络延迟（ms）']
    };

    k.route('POST', '/psi/route-advice', function (p, q, body) {
      const req = {};
      const keys = Object.keys(LIMITS);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], lim = LIMITS[key], v = body[key];
        if (v === undefined || v === null || v === '') return k.err(40000, lim[2] + '必填');
        if (typeof v !== 'number' || !Number.isFinite(v)) return k.err(40002, lim[2] + '必须是数字');
        if ((key === 'left_rows' || key === 'right_rows') && !Number.isInteger(v)) return k.err(40002, lim[2] + '必须是整数');
        if (v < lim[0] || v > lim[1]) return k.err(40003, lim[2] + '必须在 ' + lim[0] + ' – ' + lim[1] + ' 之间');
        req[key] = v;
      }
      const a = advise(req);
      return k.ok({
        input: req,
        size_ratio: round(a.ratio, 2),
        recommended: { protocol: a.best.protocol, name: a.best.name, params: a.best.params },
        reason: reasonOf(a, req),
        estimates: a.list,
        model_note: '估算值，按文档 docs/api/psi.md「估算模型」计算，非实测；在线耗时不含大集合离线预处理。'
      });
    });

    const SCENARIOS = [
      { scenario_id: 's1', label: '10 万 × 10 万', left_rows: 100000, right_rows: 100000 },
      { scenario_id: 's2', label: '100 万 × 100 万', left_rows: 1000000, right_rows: 1000000 },
      { scenario_id: 's3', label: '1 亿 × 1 万', left_rows: 100000000, right_rows: 10000 }
    ];
    const NETWORKS = [
      { network_id: 'lan', label: '局域网', bandwidth_mbps: 1000, latency_ms: 1 },
      { network_id: 'wan', label: '广域网', bandwidth_mbps: 100, latency_ms: 30 }
    ];

    k.route('GET', '/psi/benchmarks', function () {
      const items = [];
      SCENARIOS.forEach(function (s) {
        NETWORKS.forEach(function (n) {
          const req = { left_rows: s.left_rows, right_rows: s.right_rows, bandwidth_mbps: n.bandwidth_mbps, latency_ms: n.latency_ms };
          const a = advise(req);
          items.push({
            scenario_id: s.scenario_id + '_' + n.network_id, scale_label: s.label, network_label: n.label,
            left_rows: s.left_rows, right_rows: s.right_rows, bandwidth_mbps: n.bandwidth_mbps, latency_ms: n.latency_ms,
            recommended: a.best.protocol,
            estimates: a.list.map(function (e) {
              return { protocol: e.protocol, total_sec: e.total_sec, comm_mb: e.comm_mb, offline_sec: e.offline_sec };
            })
          });
        });
      });
      return k.ok({ items: items, model_note: '估算值，与 POST /psi/route-advice 同一估算模型，非实测。' });
    });
  });
})();
