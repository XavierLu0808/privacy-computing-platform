/**
 * mock 扩展：多方安全计算（协议管理 #/mpc/proto + 运维监控 #/mpc/ops）。接口见 docs/api/mpc.md。
 *
 * 覆盖内核 §4 的 MPC 路由（routeFirst）：任务改为支持多步计算流程、≥3 方动态角色、协议参数，
 * 指标由性能预估模型按进度推进，异常判定规则为「偏离全部参与方均值超过阈值（默认 50%）」。
 * 数据挂在 k.db.mpc 下；只读内核的 k.db.nodes / k.db.projects。
 */
(function () {
  'use strict';

  window.MockServer.extend(function (k) {
    const db = k.db.mpc = { tasks: {}, params: {}, seeded: {}, seq: 0 };

    /* ================= 目录 ================= */

    const PROTOCOLS = [
      {
        protocol: 'ss', name: '秘密共享', full_name: '加法秘密共享（Additive Secret Sharing）',
        principle: '把每个私有数拆成若干随机份额分给各计算方，任何少于全部计算方的子集都得不到明文；加法在本地完成，乘法借助预生成的 Beaver 三元组完成。',
        security_models: ['semi_honest', 'malicious'],
        security_note: '默认半诚实模型；恶意模型下为每个份额附加信息论 MAC（SPDZ 风格），开启后通信量约 ×2。',
        rounds_note: '本地加法 0 轮；每层乘法 1 轮 + 定点截断 1 轮，乘法深度决定轮数，通信量与数据行数线性相关。',
        operators: ['secure_sum', 'secure_product', 'secure_mean'],
        acc: 'MPC-PROTO-01'
      },
      {
        protocol: 'gc', name: '混淆电路', full_name: '姚氏混淆电路（Yao Garbled Circuits）',
        principle: '把待算函数写成布尔电路，混淆方为每根导线生成随机标签并加密真值表，求值方通过不经意传输取得自己输入的标签后逐门解密，只得到输出。',
        security_models: ['semi_honest', 'malicious'],
        security_note: '默认半诚实模型；恶意模型采用认证混淆（authenticated garbling），通信量约 ×3。',
        rounds_note: '常数轮：基础 OT 3 轮 + 发送混淆表 1 轮，与电路规模无关；通信量与 AND 门数量成正比（Free-XOR 下 XOR 门免费）。',
        operators: ['secure_compare', 'secure_max', 'logic_op'],
        acc: 'MPC-PROTO-02'
      },
      {
        protocol: 'ot', name: '不经意传输扩展', full_name: 'IKNP 不经意传输扩展（OT Extension）',
        principle: '先用少量公钥运算完成 k 次基础 OT，再用对称密码把它们扩展成任意多次 OT；接收方按选择位取得消息，发送方不知道取走了哪一条。',
        security_models: ['semi_honest', 'malicious'],
        security_note: '默认半诚实模型（IKNP03）；恶意模型增加 KOS15 一致性校验，通信量约 ×1.05。',
        rounds_note: '基础 OT 3 轮（可离线预处理）+ 每个扩展批次 2 轮，批次数 = ⌈数据行数 / 扩展批大小⌉。',
        operators: ['vector_ot'],
        acc: 'MPC-PROTO-03'
      }
    ];
    const PROTO = {};
    PROTOCOLS.forEach(function (p) { PROTO[p.protocol] = p; });

    const SECURITY_CN = { semi_honest: '半诚实', malicious: '恶意' };

    /** 参数表：type = enum / int / bool；范围越界返回 40003。 */
    const PARAM_SCHEMA = {
      ss: [
        { key: 'ring_bits', label: '环大小', type: 'enum', options: [32, 64, 128], default: 64, unit: 'bit', desc: '份额所在的整数环（模 2^ℓ），ℓ 越大可表示的数越大，单份额字节数 = ℓ / 8' },
        { key: 'frac_bits', label: '定点小数位', type: 'int', min: 0, max: 64, default: 16, unit: 'bit', desc: '定点编码 x · 2^f，精度 2^-f；须 ≤ 环大小的一半' },
        { key: 'security_model', label: '安全模型', type: 'enum', options: ['semi_honest', 'malicious'], default: 'semi_honest', unit: '', desc: '恶意模型附加 MAC 校验' }
      ],
      gc: [
        { key: 'free_xor', label: 'Free-XOR', type: 'bool', default: true, unit: '', desc: 'XOR 门不产生混淆表，通信与计算免费' },
        { key: 'half_gates', label: '半门优化（Half-Gates）', type: 'bool', default: true, unit: '', desc: '每个 AND 门 2 个密文（关闭时 GRR3 为 3 个）' },
        { key: 'bit_width', label: '电路位宽', type: 'int', min: 8, max: 64, default: 32, unit: 'bit', desc: '参与比较 / 逻辑运算的整数位宽' },
        { key: 'security_model', label: '安全模型', type: 'enum', options: ['semi_honest', 'malicious'], default: 'semi_honest', unit: '', desc: '恶意模型采用认证混淆' }
      ],
      ot: [
        { key: 'base_ot_count', label: '基础 OT 数', type: 'int', min: 128, max: 256, default: 128, unit: '次', desc: '公钥基础 OT 次数 k，即扩展矩阵列数，决定计算安全强度' },
        { key: 'batch_size', label: '扩展批大小', type: 'int', min: 1024, max: 1048576, default: 65536, unit: '条 / 批', desc: '每批扩展的 OT 条数，批越大轮数越少、内存越高' },
        { key: 'security_model', label: '安全模型', type: 'enum', options: ['semi_honest', 'malicious'], default: 'semi_honest', unit: '', desc: '恶意模型增加 KOS15 一致性校验' }
      ]
    };

    /** 值类型：parties = 各方私有输入（只能出现在第 1 步）。 */
    const TYPE_CN = {
      parties: '各方私有数据', vector: '密态向量', scalar: '密态标量',
      bool_vector: '密态布尔向量', bool: '密态布尔值'
    };

    /** 算子：io = 输入类型 → 输出类型。 */
    const OPERATORS = [
      { key: 'secure_sum', name: '安全求和', protocols: ['ss'], io: { parties: 'vector', vector: 'scalar' },
        desc: '各方逐行相加得到向量；作用于向量时对全部行求和' },
      { key: 'secure_product', name: '安全求积', protocols: ['ss'], io: { parties: 'vector', vector: 'vector', scalar: 'scalar' },
        desc: '各方逐行相乘；作用于向量 / 标量时乘以公开系数' },
      { key: 'secure_mean', name: '安全求均值', protocols: ['ss'], io: { parties: 'vector', vector: 'scalar' },
        desc: '各方逐行取均值；作用于向量时对全部行取均值' },
      { key: 'secure_compare', name: '安全比较', protocols: ['gc'], io: { parties: 'bool_vector', vector: 'bool_vector', scalar: 'bool' },
        desc: '作用于各方数据时逐行比较前两个输入方（百万富翁问题）；作用于向量 / 标量时与公开阈值比较' },
      { key: 'secure_max', name: '安全最大值', protocols: ['gc'], io: { parties: 'vector', vector: 'scalar' },
        desc: '各方逐行取最大值；作用于向量时取全部行的最大值' },
      { key: 'logic_op', name: '逻辑运算', protocols: ['gc'], io: { bool_vector: 'bool', bool: 'bool' },
        desc: 'AND（全部为真）/ OR（任一为真）把布尔向量归约为布尔值；NOT 取反' },
      { key: 'vector_ot', name: '向量 OT', protocols: ['ot'], io: { parties: 'vector', vector: 'scalar' },
        desc: '输出方不经意地取第 i 行：作用于各方数据时得到各输入方第 i 行组成的向量；作用于向量时得到第 i 个元素' }
    ];
    const OP = {};
    OPERATORS.forEach(function (o) { OP[o.key] = o; });
    const LOGIC_MODES = ['and', 'or', 'not'];
    const CMP_MODES = ['gt', 'lt'];

    /** 默认流程：兼容内核 GET /mpc/estimate?operator=… 的单算子预估。 */
    const DEFAULT_FLOW = {
      secure_sum: [{ operator: 'secure_sum', protocol: 'ss' }],
      secure_product: [{ operator: 'secure_product', protocol: 'ss' }],
      secure_mean: [{ operator: 'secure_mean', protocol: 'ss' }],
      secure_compare: [{ operator: 'secure_compare', protocol: 'gc' }],
      secure_max: [{ operator: 'secure_max', protocol: 'gc' }],
      logic_op: [{ operator: 'secure_compare', protocol: 'gc' }, { operator: 'logic_op', protocol: 'gc', operand: { mode: 'and' } }],
      vector_ot: [{ operator: 'vector_ot', protocol: 'ot', operand: { index: 1 } }]
    };

    const ROLE_KEYS = ['input', 'compute', 'output'];
    const ROLE_CN = { input: '输入方', compute: '计算方', output: '输出方' };

    /** 演示用链路降级节点：该节点参与时通信量 ×2.4、计算耗时 ×2.2，用于展示异常检测（p3 无降级节点）。 */
    const DEGRADED = { 'node-ganzhou-03': { comm: 2.4, time: 2.2 }, 'node-chengdu-06': { comm: 2.4, time: 2.2 } };

    const TOTAL_TICKS = 30;
    const TICK_MS = 420;
    const DEFAULT_RULE = { threshold_pct: 50, min_ticks: 5, metrics: ['comm_bytes', 'compute_sec'] };
    const DEFAULT_NET = { bandwidth_mbps: 100, rtt_ms: 20 };
    const DEFAULT_ROWS = 1200000;
    const TRIAL_ROWS = 4;

    function fail(code, message, data) { return { __err: k.err(code, message, data) }; }
    function isErr(x) { return x && x.__err; }
    function hnum(seed, mod) { return parseInt(k.hashHex(seed, 1).slice(0, 7), 16) % mod; }
    function round(v, n) { const p = Math.pow(10, n); return Math.round(v * p) / p; }

    /* ================= 参与方 ================= */

    function partiesOf(projectId) {
      const nodes = (k.db.nodes[projectId] || []).slice();
      const letters = 'ABCDEFGH';
      while (nodes.length < 3) {
        const i = nodes.length;
        nodes.push({ node_id: 'node-mpc-0' + (i + 1), ip: '10.90.0.' + (11 + i), online: true });
      }
      return nodes.slice(0, 8).map(function (n, i) {
        return {
          party_id: 'party-' + letters[i].toLowerCase(), tag: letters[i], name: '参与方 ' + letters[i],
          node_id: n.node_id, ip: n.ip, online: n.online !== false,
          default_roles: defaultRoles(i)
        };
      });
    }
    function defaultRoles(i) {
      return [['input', 'compute'], ['input', 'compute'], ['compute', 'output'], ['input']][i] || ['input'];
    }

    /* ================= 参数 ================= */

    function defaultsOf(protocol) {
      const out = {};
      PARAM_SCHEMA[protocol].forEach(function (s) { out[s.key] = s.default; });
      return out;
    }
    function savedParams(projectId, protocol) {
      const saved = (db.params[projectId] || {})[protocol];
      return Object.assign(defaultsOf(protocol), saved || {});
    }

    /** 校验并合并参数：base 为起点（项目已保存值或默认值），patch 为待覆盖项。 */
    function validateParams(protocol, base, patch) {
      const out = Object.assign({}, base);
      const schema = PARAM_SCHEMA[protocol];
      const keys = Object.keys(patch || {});
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const s = schema.filter(function (x) { return x.key === key; })[0];
        if (!s) return fail(40000, PROTO[protocol].name + ' 没有参数 ' + key, { field: key });
        const v = patch[key];
        if (s.type === 'bool') {
          if (typeof v !== 'boolean') return fail(40002, s.label + ' 应为 true / false', { field: key });
        } else if (s.type === 'enum') {
          if (s.options.indexOf(v) < 0) return fail(40002, s.label + ' 只能取 ' + s.options.join(' / '), { field: key });
        } else {
          if (typeof v !== 'number' || !Number.isInteger(v)) return fail(40002, s.label + ' 应为整数', { field: key });
          if (v < s.min || v > s.max) return fail(40003, s.label + ' 应在 ' + s.min + '–' + s.max + ' ' + s.unit + ' 之间', { field: key, min: s.min, max: s.max });
        }
        out[key] = v;
      }
      if (protocol === 'ss' && out.frac_bits > out.ring_bits / 2) {
        return fail(40003, '定点小数位不能超过环大小的一半（ℓ = ' + out.ring_bits + ' 时最大 ' + out.ring_bits / 2 + ' bit）', { field: 'frac_bits', min: 0, max: out.ring_bits / 2 });
      }
      return out;
    }

    /** body.params = { ss: {...}, gc: {...}, ot: {...} }，未给的协议用项目已保存参数。 */
    function resolveAllParams(projectId, given) {
      const out = {};
      const protos = Object.keys(PARAM_SCHEMA);
      for (let i = 0; i < protos.length; i++) {
        const p = protos[i];
        const r = validateParams(p, savedParams(projectId, p), (given || {})[p]);
        if (isErr(r)) return r;
        out[p] = r;
      }
      if (given && typeof given === 'object') {
        const unknown = Object.keys(given).filter(function (x) { return !PARAM_SCHEMA[x]; })[0];
        if (unknown) return fail(40000, '未知协议 ' + unknown, { field: 'params' });
      }
      return out;
    }

    /* ================= 计算流程校验 ================= */

    /** 返回规范化步骤 [{ operator, protocol, operand, in_type, out_type }] 或 fail。rows = 数据行数（向量 OT 下标上限）。 */
    function validateFlow(steps, rows, inputCount) {
      if (!Array.isArray(steps) || !steps.length) return fail(40000, '计算流程至少需要 1 个步骤', { field: 'steps' });
      if (steps.length > 8) return fail(40000, '计算流程最多 8 个步骤，当前 ' + steps.length + ' 个', { field: 'steps' });
      let type = 'parties';
      const out = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] || {};
        const at = '第 ' + (i + 1) + ' 步：';
        const op = OP[s.operator];
        if (!op) return fail(40000, at + '未知算子 ' + s.operator, { field: 'steps[' + i + '].operator' });
        if (!PROTO[s.protocol]) return fail(40000, at + '未知协议 ' + s.protocol, { field: 'steps[' + i + '].protocol' });
        if (op.protocols.indexOf(s.protocol) < 0) {
          return fail(40001, at + op.name + ' 不支持' + PROTO[s.protocol].name + '协议（可用：' +
            op.protocols.map(function (p) { return PROTO[p].name; }).join(' / ') + '）', { field: 'steps[' + i + '].protocol' });
        }
        const outType = op.io[type];
        if (!outType) {
          return fail(40000, at + op.name + ' 不能作用于' + TYPE_CN[type] + '（可接受：' +
            Object.keys(op.io).map(function (t) { return TYPE_CN[t]; }).join(' / ') + '）', { field: 'steps[' + i + '].operator' });
        }
        const operand = {};
        const given = s.operand || {};
        if (op.key === 'secure_compare') {
          if (type === 'parties') {
            if (inputCount !== undefined && inputCount < 2) return fail(40000, at + '比较各方数据需要至少 2 个输入方', { field: 'parties' });
          } else {
            const cmp = given.cmp === undefined ? 'gt' : given.cmp;
            if (CMP_MODES.indexOf(cmp) < 0) return fail(40002, at + '比较方式只能取 gt / lt', { field: 'steps[' + i + '].operand.cmp' });
            if (typeof given.threshold !== 'number' || !isFinite(given.threshold)) {
              return fail(40002, at + '安全比较需要数值阈值', { field: 'steps[' + i + '].operand.threshold' });
            }
            operand.cmp = cmp;
            operand.threshold = given.threshold;
          }
        } else if (op.key === 'secure_product' && type !== 'parties') {
          if (typeof given.factor !== 'number' || !isFinite(given.factor)) {
            return fail(40002, at + '对密态数据求积需要数值系数', { field: 'steps[' + i + '].operand.factor' });
          }
          operand.factor = given.factor;
        } else if (op.key === 'logic_op') {
          const mode = given.mode || (type === 'bool' ? 'not' : 'and');
          if (LOGIC_MODES.indexOf(mode) < 0) return fail(40002, at + '逻辑运算只能取 and / or / not', { field: 'steps[' + i + '].operand.mode' });
          if (type === 'bool' && mode !== 'not') return fail(40000, at + '密态布尔值只能做 NOT，AND / OR 需要布尔向量', { field: 'steps[' + i + '].operand.mode' });
          operand.mode = mode;
        } else if (op.key === 'vector_ot') {
          const idx = given.index;
          if (typeof idx !== 'number' || !Number.isInteger(idx)) return fail(40002, at + '向量 OT 需要整数行号', { field: 'steps[' + i + '].operand.index' });
          if (idx < 1 || idx > rows) return fail(40003, at + '行号应在 1–' + rows + ' 之间', { field: 'steps[' + i + '].operand.index', min: 1, max: rows });
          operand.index = idx;
        }
        // NOT 作用于布尔向量时输出仍是布尔向量
        const realOut = (op.key === 'logic_op' && operand.mode === 'not') ? type : outType;
        out.push({ operator: op.key, protocol: s.protocol, operand: operand, in_type: type, out_type: realOut });
        type = realOut;
      }
      return out;
    }

    /** parties = [{ party_id, roles | role }]；protocols = 流程用到的协议。 */
    function validateParties(projectId, parties, protocols) {
      if (!Array.isArray(parties)) return fail(40000, '缺少参与方配置', { field: 'parties' });
      if (parties.length < 3) return fail(40000, '多方安全计算至少需要 3 个参与方，当前 ' + parties.length + ' 个', { field: 'parties' });
      const pool = partiesOf(projectId);
      const seen = {};
      const out = [];
      const cnt = { input: 0, compute: 0, output: 0 };
      for (let i = 0; i < parties.length; i++) {
        const x = parties[i] || {};
        const def = pool.filter(function (p) { return p.party_id === x.party_id; })[0];
        if (!def) return fail(40400, '参与方不存在：' + x.party_id, { field: 'parties[' + i + '].party_id' });
        if (seen[x.party_id]) return fail(40000, def.name + ' 重复出现', { field: 'parties[' + i + '].party_id' });
        seen[x.party_id] = true;
        const roles = Array.isArray(x.roles) ? x.roles.slice() : (x.role ? [x.role] : []);
        if (!roles.length) return fail(40000, def.name + ' 至少要承担一个角色', { field: 'parties[' + i + '].roles' });
        for (let j = 0; j < roles.length; j++) {
          if (ROLE_KEYS.indexOf(roles[j]) < 0) return fail(40002, def.name + ' 的角色取值不合法：' + roles[j], { field: 'parties[' + i + '].roles' });
        }
        const uniq = ROLE_KEYS.filter(function (r) { return roles.indexOf(r) >= 0; });
        uniq.forEach(function (r) { cnt[r] += 1; });
        out.push(Object.assign({}, def, { roles: uniq }));
      }
      const miss = ROLE_KEYS.filter(function (r) { return !cnt[r]; });
      if (miss.length) {
        return fail(40000, '至少需要 1 个输入方、1 个计算方、1 个输出方，缺少：' + miss.map(function (r) { return ROLE_CN[r]; }).join('、'), { field: 'parties' });
      }
      const needTwo = protocols.filter(function (p) { return p === 'ss' || p === 'gc'; });
      if (needTwo.length && cnt.compute < 2) {
        return fail(40000, PROTO[needTwo[0]].name + '需要至少 2 个计算方（份额 / 混淆表分属不共谋的两方才能保密），当前 ' + cnt.compute + ' 个', { field: 'parties' });
      }
      return { parties: out, counts: cnt };
    }

    function protocolsOf(steps) {
      const out = [];
      steps.forEach(function (s) { if (out.indexOf(s.protocol) < 0) out.push(s.protocol); });
      return out;
    }

    /* ================= 性能预估模型 ================= */

    /**
     * 单步代价。n = 参与方数，m = 数据行数，P = 三协议参数。
     * 返回 { bytes（全体参与方发送总字节）, compute_us（单方关键路径计算微秒）, rounds, formula }。
     * 计算常数为原型标定值：SS 本地加法 0.4 µs/元素、乘法 2 µs、截断 1.5 µs；GC AND 门 0.25 µs（半门）/ 0.35 µs（GRR3）；OT 每条 0.6 µs。
     */
    function stepCost(step, n, m, P) {
      const e = (step.in_type === 'parties' || step.in_type === 'vector' || step.in_type === 'bool_vector') ? m : 1;
      if (step.protocol === 'ss') {
        const p = P.ss;
        const w = p.ring_bits / 8;
        const mal = p.security_model === 'malicious' ? 2 : 1;
        const malC = p.security_model === 'malicious' ? 2.2 : 1;
        const rc = p.ring_bits / 64;
        const open = n * (n - 1) * w;
        if (step.operator === 'secure_sum') {
          return { bytes: 0, compute_us: e * (step.in_type === 'parties' ? n : 1) * 0.4 * rc, rounds: 0,
            formula: '本地加法，无通信；计算 = 元素数 × ' + (step.in_type === 'parties' ? 'n × ' : '') + '0.4 µs × ℓ/64' };
        }
        if (step.operator === 'secure_mean') {
          const outN = step.in_type === 'parties' ? m : 1;
          return { bytes: open * outN * mal, compute_us: (e * (step.in_type === 'parties' ? n : 1) * 0.4 * rc + outN * 1.5) * malC, rounds: 1,
            formula: '本地求和 + 除以公开常数后定点截断 1 次打开：通信 = n(n−1) · ℓ/8 · ' + (outN === 1 ? '1' : 'm') + ' 字节，1 轮' };
        }
        // secure_product
        if (step.in_type === 'parties') {
          const depth = Math.ceil(Math.log2(n));
          return { bytes: 2 * open * m * (n - 1) * mal, compute_us: m * (n - 1) * 2 * rc * malC, rounds: 2 * depth,
            formula: '每行 (n−1) 次 Beaver 乘法，每次打开 2 个值：通信 = 2 · n(n−1) · ℓ/8 · m · (n−1) 字节，轮数 = 2 · ⌈log₂ n⌉（乘法 + 截断）' };
        }
        return { bytes: open * e * mal, compute_us: e * 1.5 * malC, rounds: 1,
          formula: '乘公开系数为本地运算，定点截断 1 次打开：通信 = n(n−1) · ℓ/8 · 元素数 字节，1 轮' };
      }
      if (step.protocol === 'gc') {
        const p = P.gc;
        const kap = 16;   // κ = 128 bit
        const andB = p.half_gates ? 2 * kap : 3 * kap;
        const xorB = p.free_xor ? 0 : 3 * kap;
        const andUs = p.half_gates ? 0.25 : 0.35;
        const xorUs = p.free_xor ? 0.01 : 0.3;
        const mal = p.security_model === 'malicious' ? 3 : 1;
        const b = p.bit_width;
        let and = 0, xor = 0, inBits = 0;
        if (step.operator === 'secure_compare') {
          and = b * e; xor = 3 * b * e; inBits = (step.in_type === 'parties' ? 2 : 1) * b * e;
        } else if (step.operator === 'secure_max') {
          const kk = step.in_type === 'parties' ? n : m;
          const reps = step.in_type === 'parties' ? m : 1;
          and = 2 * b * (kk - 1) * reps; xor = 5 * b * (kk - 1) * reps; inBits = b * kk * reps;
        } else {
          const mode = step.operand.mode;
          if (mode === 'not') { xor = e; }
          else { and = Math.max(0, e - 1); xor = mode === 'or' ? 2 * Math.max(0, e - 1) : 0; inBits = e; }
        }
        const bytes = (and * andB + xor * xorB + inBits * 3 * kap) * mal;
        return { bytes: bytes, compute_us: (and * andUs + xor * xorUs + inBits * 0.6) * mal, rounds: inBits ? 4 : 0,
          formula: 'AND 门 ' + and + ' 个 × ' + andB + ' B + XOR 门 ' + xor + ' 个 × ' + xorB + ' B + 输入标签 ' + inBits + ' bit × 48 B（OT 取标签）' +
            (mal > 1 ? '，恶意模型 ×3' : '') + '；常数 4 轮' };
      }
      // ot · vector_ot
      const p = P.ot;
      const kb = p.base_ot_count;
      const senders = n;
      const per = kb / 8 + 2 * 8;    // 扩展矩阵一列 k bit + 两条 64 bit 掩码消息
      const mal = p.security_model === 'malicious' ? 1.05 : 1;
      const batches = Math.ceil(m / p.batch_size);
      return {
        bytes: (senders * m * per + kb * 96) * mal,
        compute_us: (m * 0.6 * kb / 128 + kb * 500) * mal,
        rounds: 3 + 2 * batches,
        formula: senders + ' 个发送方 × m 条 OT × (k/8 + 16) B + 基础 OT k × 96 B；轮数 = 3 + 2 · ⌈m / 批大小⌉ = ' + (3 + 2 * batches)
      };
    }

    /** 协议切换的份额转换（A2Y / Y2A），按元素数计。 */
    function convCost(from, to, step, m, P) {
      if (from === to || from === 'ot' || to === 'ot') return null;
      const e = (step.in_type === 'vector' || step.in_type === 'bool_vector') ? m : 1;
      const b = P.gc.bit_width;
      if (from === 'ss' && to === 'gc') {
        return { bytes: e * (b * (P.gc.half_gates ? 32 : 48) + 2 * b * 48), compute_us: e * b * 0.25, rounds: 2,
          name: 'A2Y 份额转换（秘密共享 → 混淆电路）', formula: '每元素 b 位加法电路：b 个 AND 门 + 2b bit 输入标签' };
      }
      const w = P.ss.ring_bits / 8;
      return { bytes: e * b * (16 + 2 * w), compute_us: e * b * 0.6, rounds: 2,
        name: 'Y2A 份额转换（混淆电路 → 秘密共享）', formula: '每元素 b 次 OT，每次 16 + 2 · ℓ/8 字节' };
    }

    function estimateFlow(steps, n, m, P, net) {
      const items = [];
      let bytes = 0, us = 0, rounds = 0;
      if (steps[0].protocol === 'ss' && steps[0].in_type === 'parties') {
        const w = P.ss.ring_bits / 8;
        const mal = P.ss.security_model === 'malicious' ? 2 : 1;
        const x = { bytes: n * (n - 1) * w * m * mal, compute_us: m * 0.5 * P.ss.ring_bits / 64, rounds: 1 };
        items.push({ index: 0, name: '输入分享', protocol: 'ss', bytes: x.bytes, compute_sec: round(x.compute_us / 1e6, 3), rounds: 1,
          formula: '每方把 m 个元素拆成 n 份发给其余 n−1 方：n(n−1) · ℓ/8 · m 字节，1 轮' });
        bytes += x.bytes; us += x.compute_us; rounds += 1;
      }
      steps.forEach(function (s, i) {
        if (i > 0) {
          const c = convCost(steps[i - 1].protocol, s.protocol, s, m, P);
          if (c) {
            items.push({ index: i + 0.5, name: c.name, protocol: s.protocol, bytes: c.bytes, compute_sec: round(c.compute_us / 1e6, 3), rounds: c.rounds, formula: c.formula });
            bytes += c.bytes; us += c.compute_us; rounds += c.rounds;
          }
        }
        const x = stepCost(s, n, m, P);
        items.push({ index: i + 1, name: OP[s.operator].name, operator: s.operator, protocol: s.protocol,
          bytes: Math.round(x.bytes), compute_sec: round(x.compute_us / 1e6, 3), rounds: x.rounds, formula: x.formula });
        bytes += x.bytes; us += x.compute_us; rounds += x.rounds;
      });
      bytes = Math.round(bytes);
      const perParty = bytes / n;
      const transfer = perParty * 8 / (net.bandwidth_mbps * 1e6);
      const latency = rounds * net.rtt_ms / 1000;
      return {
        party_count: n, data_rows: m,
        est_compute_sec: round(us / 1e6, 2),
        est_comm_sec: round(transfer + latency, 2),
        est_total_sec: round(us / 1e6 + transfer + latency, 2),
        est_comm_bytes: bytes,
        est_comm_mb: round(bytes / 1048576, 2),
        rounds: rounds,
        comm_breakdown: { transfer_sec: round(transfer, 2), latency_sec: round(latency, 2) },
        assumptions: { bandwidth_mbps: net.bandwidth_mbps, rtt_ms: net.rtt_ms, kappa_bits: 128 },
        steps: items,
        formula: {
          compute: '计算耗时 = Σ 各步单方关键路径计算时间（各方并行执行）；常数为原型标定值，见各步说明',
          comm_volume: '通信量 = Σ 各步全体参与方发送字节；1 MB = 1,048,576 字节',
          comm_time: '通信耗时 = (通信量 / n) × 8 / 带宽 + 总轮数 × RTT（各方独立链路并行收发）'
        }
      };
    }

    function parseNet(src) {
      const net = Object.assign({}, DEFAULT_NET);
      const fields = [['bandwidth_mbps', 1, 10000, '带宽（Mbps）'], ['rtt_ms', 0, 1000, '往返时延 RTT（ms）']];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (src[f[0]] === undefined || src[f[0]] === '') continue;
        const v = Number(src[f[0]]);
        if (!isFinite(v)) return fail(40002, f[3] + ' 应为数字', { field: f[0] });
        if (v < f[1] || v > f[2]) return fail(40003, f[3] + ' 应在 ' + f[1] + '–' + f[2] + ' 之间', { field: f[0], min: f[1], max: f[2] });
        net[f[0]] = v;
      }
      return net;
    }
    function parseRows(v, def) {
      if (v === undefined || v === '' || v === null) return def;
      const n = Number(v);
      if (!Number.isInteger(n)) return fail(40002, '数据规模应为整数行数', { field: 'data_rows' });
      if (n < 1 || n > 100000000) return fail(40003, '数据规模应在 1–100,000,000 行之间', { field: 'data_rows', min: 1, max: 100000000 });
      return n;
    }
    function parseCount(v) {
      if (v === undefined || v === '' || v === null) return 3;
      const n = Number(v);
      if (!Number.isInteger(n)) return fail(40002, '参与方数量应为整数', { field: 'party_count' });
      if (n < 3) return fail(40000, '多方安全计算至少需要 3 个参与方', { field: 'party_count' });
      if (n > 8) return fail(40003, '参与方数量应在 3–8 之间', { field: 'party_count', min: 3, max: 8 });
      return n;
    }

    /** POST /estimate 与 GET /estimate 共用。 */
    function estimateRequest(projectId, src, rawSteps) {
      const m = parseRows(src.data_rows, DEFAULT_ROWS);
      if (isErr(m)) return m;
      let n = parseCount(src.party_count);
      if (Array.isArray(src.parties)) n = src.parties.length < 3 ? parseCount(src.parties.length) : Math.min(src.parties.length, 8);
      if (isErr(n)) return n;
      const net = parseNet(src);
      if (isErr(net)) return net;
      const P = resolveAllParams(projectId, src.params);
      if (isErr(P)) return P;
      const steps = validateFlow(rawSteps, m);
      if (isErr(steps)) return steps;
      return Object.assign({ steps_input: steps, params: P }, estimateFlow(steps, n, m, P, net));
    }

    /* ================= 试运行（确定性小数据） ================= */

    /** 各输入方的 4 行演示数据：氧化钕 Nd₂O₃ 月度成交价（元/吨），由 project + party 种子确定。 */
    function trialValues(projectId, partyId) {
      const base = 628000 + hnum(projectId + '|' + partyId, 60) * 100;
      return [0, 1800, 3500, 1200].map(function (d, r) {
        return base + d + hnum(projectId + '|' + partyId + '|' + r, 20) * 100;
      });
    }

    function evalStep(step, val, inputs) {
      const t = step.in_type;
      const op = step.operator;
      const rows = function (fn) {
        const out = [];
        for (let r = 0; r < TRIAL_ROWS; r++) out.push(fn(inputs.map(function (x) { return x[r]; }), r));
        return out;
      };
      const sum = function (a) { return a.reduce(function (s, x) { return s + x; }, 0); };
      if (op === 'secure_sum') return t === 'parties' ? rows(sum) : sum(val);
      if (op === 'secure_mean') return t === 'parties' ? rows(function (a) { return sum(a) / a.length; }) : sum(val) / val.length;
      if (op === 'secure_product') {
        if (t === 'parties') return rows(function (a) { return a.reduce(function (s, x) { return s * x; }, 1); });
        return t === 'vector' ? val.map(function (x) { return x * step.operand.factor; }) : val * step.operand.factor;
      }
      if (op === 'secure_max') return t === 'parties' ? rows(function (a) { return Math.max.apply(null, a); }) : Math.max.apply(null, val);
      if (op === 'secure_compare') {
        if (t === 'parties') return rows(function (a) { return a[0] > a[1]; });
        const c = function (x) { return step.operand.cmp === 'lt' ? x < step.operand.threshold : x > step.operand.threshold; };
        return t === 'vector' ? val.map(c) : c(val);
      }
      if (op === 'logic_op') {
        const mode = step.operand.mode;
        if (mode === 'not') return Array.isArray(val) ? val.map(function (x) { return !x; }) : !val;
        return mode === 'and' ? val.every(Boolean) : val.some(Boolean);
      }
      // vector_ot
      const i = step.operand.index - 1;
      return t === 'parties' ? inputs.map(function (x) { return x[i]; }) : val[i];
    }

    /** 加法份额：enc = round(x · 2^f) mod 2^ℓ，前 C−1 份由种子生成，最后一份补差。返回十六进制串。 */
    function additiveShares(x, holders, P, seed) {
      const L = BigInt(P.ss.ring_bits);
      const mod = BigInt(1) << L;
      const f1 = Math.min(P.ss.frac_bits, 20);
      let enc = BigInt(Math.round(x * Math.pow(2, f1))) << BigInt(P.ss.frac_bits - f1);
      enc = ((enc % mod) + mod) % mod;
      const hexLen = P.ss.ring_bits / 4;
      const out = [];
      let acc = BigInt(0);
      for (let i = 0; i < holders.length - 1; i++) {
        const s = BigInt('0x' + k.hashHex(seed + '|' + holders[i], hexLen / 8)) % mod;
        acc = (acc + s) % mod;
        out.push(s);
      }
      out.push(((enc - acc) % mod + mod) % mod);
      return out.map(function (s) { return s.toString(16).padStart(hexLen, '0'); });
    }

    function shareKind(protocol, P) {
      if (protocol === 'ss') return '加法份额（模 2^' + P.ss.ring_bits + '，定点 ' + P.ss.frac_bits + ' 位小数）';
      if (protocol === 'gc') return '混淆电路导线标签（128 bit，首元素最低位）';
      return 'OT 掩码消息（x ⊕ H(k_c)，64 bit）';
    }

    function dryRun(projectId, body) {
      const P = resolveAllParams(projectId, body.params);
      if (isErr(P)) return P;
      const pre = validateFlow(body.steps, TRIAL_ROWS);
      if (isErr(pre)) return pre;
      const pv = validateParties(projectId, body.parties, protocolsOf(pre));
      if (isErr(pv)) return pv;
      const inputParties = pv.parties.filter(function (p) { return p.roles.indexOf('input') >= 0; });
      const steps = validateFlow(body.steps, TRIAL_ROWS, inputParties.length);
      if (isErr(steps)) return steps;
      const holders = pv.parties.filter(function (p) { return p.roles.indexOf('compute') >= 0; });
      const outputs = pv.parties.filter(function (p) { return p.roles.indexOf('output') >= 0; });
      const plain = inputParties.map(function (p) { return trialValues(projectId, p.party_id); });
      const first = steps[0].protocol;
      const warnings = [];
      const limit = Math.pow(2, P.ss.ring_bits - 1 - P.ss.frac_bits);

      const inputs = inputParties.map(function (p, pi) {
        return {
          party_id: p.party_id, name: p.name, rows: TRIAL_ROWS, unit: '元/吨',
          share_kind: shareKind(first, P),
          shares: holders.map(function (h, hi) {
            return {
              holder_id: h.party_id, holder_name: h.name,
              values: plain[pi].map(function (x, r) {
                const seed = projectId + '|' + p.party_id + '|' + r;
                if (first === 'ss') return additiveShares(x, holders.map(function (z) { return z.party_id; }), P, seed)[hi];
                if (first === 'gc') return k.hashHex(seed + '|label|' + h.party_id, 4);
                return k.hashHex(seed + '|ot|' + h.party_id, 2);
              })
            };
          })
        };
      });

      let val = null;
      const trace = steps.map(function (s, i) {
        val = evalStep(s, val, plain);
        const flat = [].concat(val).filter(function (x) { return typeof x === 'number'; });
        if (s.protocol === 'ss' && flat.some(function (x) { return Math.abs(x) >= limit; })) {
          warnings.push('第 ' + (i + 1) + ' 步结果超出模 2^' + P.ss.ring_bits + ' 环的定点可表示范围（|x| < 2^' + (P.ss.ring_bits - 1 - P.ss.frac_bits) + '），真实执行会溢出，建议把环大小调到 128 bit 或减少定点小数位');
        }
        const last = i === steps.length - 1;
        return {
          index: i + 1, operator: s.operator, name: OP[s.operator].name, protocol: s.protocol,
          in_type: s.in_type, out_type: s.out_type,
          visibility: last ? 'revealed_to_output' : 'secret',
          share_kind: shareKind(s.protocol, P),
          share_preview: k.hashHex(projectId + '|trace|' + i + '|' + s.operator, s.protocol === 'gc' ? 4 : 2)
        };
      });
      const reveal = function (x) { return typeof x === 'number' ? round(x, 2) : x; };
      const est = estimateFlow(steps, pv.parties.length, TRIAL_ROWS, P, DEFAULT_NET);
      return {
        trial_rows: TRIAL_ROWS,
        dataset_note: '演示数据：各输入方 4 行氧化钕 Nd₂O₃ 月度成交价（元/吨），按项目与参与方种子确定性生成，明文不出本方',
        inputs: inputs,
        steps: trace,
        result: {
          type: steps[steps.length - 1].out_type,
          value: Array.isArray(val) ? val.map(reveal) : reveal(val),
          revealed_to: outputs.map(function (p) { return p.party_id; }),
          revealed_to_names: outputs.map(function (p) { return p.name; })
        },
        stats: { comm_bytes: est.est_comm_bytes, rounds: est.rounds, compute_sec: est.est_compute_sec },
        warnings: warnings
      };
    }

    /* ================= 任务 ================= */

    function nextTaskId(dateIso) {
      db.seq += 1;
      const d = (dateIso || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
      return 'mpc-' + d + '-' + String(db.seq).padStart(2, '0');
    }

    function factorsOf(task, p) {
      const base = 0.94 + hnum(task.task_id + '|' + p.party_id, 13) / 100;
      const bad = DEGRADED[p.node_id];
      return { comm: base * (bad ? bad.comm : 1), time: base * (bad ? bad.time : 1) };
    }

    function buildTask(projectId, cfg) {
      const est = estimateFlow(cfg.steps, cfg.parties.length, cfg.data_rows, cfg.params, cfg.net);
      const task = {
        task_id: cfg.task_id || nextTaskId(),
        project_id: projectId,
        name: cfg.name || '',
        steps: cfg.steps,
        parties: cfg.parties,
        params: cfg.params,
        net: cfg.net,
        data_rows: cfg.data_rows,
        estimate: est,
        rule: Object.assign({}, DEFAULT_RULE, cfg.rule || {}),
        status: 'pending', tick: 0,
        created_at: cfg.created_at || k.NOW(),
        started_at: null, finished_at: null,
        alarm_at: {}, _timer: null
      };
      return task;
    }

    function partyMetrics(task) {
      const prog = task.tick / TOTAL_TICKS;
      const n = task.parties.length;
      const est = task.estimate;
      return task.parties.map(function (p) {
        const f = factorsOf(task, p);
        return {
          p: p,
          comm: Math.round(est.est_comm_bytes / n * f.comm * prog),
          time: round(est.est_compute_sec * f.time * prog, 2),
          comm_sec: round(est.est_comm_sec * f.comm * prog, 2),
          rounds: Math.round(est.rounds * prog)
        };
      });
    }

    function taskView(task) {
      const rows = partyMetrics(task);
      const mean = function (key) { return rows.reduce(function (s, r) { return s + r[key]; }, 0) / rows.length; };
      const mc = mean('comm'), mt = mean('time');
      const thr = task.rule.threshold_pct;
      const armed = task.tick >= task.rule.min_ticks;
      const alarms = [];
      const parties = rows.map(function (r) {
        const devC = mc ? (r.comm - mc) / mc * 100 : 0;
        const devT = mt ? (r.time - mt) / mt * 100 : 0;
        const hitC = armed && Math.abs(devC) > thr;
        const hitT = armed && Math.abs(devT) > thr;
        [[hitC, 'comm_anomaly', '累计通信量 ' + (r.comm / 1048576).toFixed(1) + ' MB，为全部参与方均值 ' + (mc / 1048576).toFixed(1) + ' MB 的 ' + (r.comm / mc).toFixed(2) + ' 倍（偏离 ' + sign(devC) + '%）', r.comm / mc, devC, '建议检查其网络链路与分片规模'],
          [hitT, 'compute_anomaly', '累计计算耗时 ' + r.time.toFixed(1) + ' 秒，为全部参与方均值 ' + mt.toFixed(1) + ' 秒的 ' + (r.time / mt).toFixed(2) + ' 倍（偏离 ' + sign(devT) + '%）', r.time / mt, devT, '建议检查其 CPU 负载与本地数据读取']
        ].forEach(function (a) {
          if (!a[0]) return;
          const key = a[1] + '|' + r.p.party_id;
          if (!task.alarm_at[key]) task.alarm_at[key] = k.NOW();
          alarms.push({
            alarm_id: 'al_' + task.task_id + '_' + r.p.party_id + '_' + a[1],
            type: a[1], party_id: r.p.party_id, node_id: r.p.node_id,
            ratio_to_mean: round(a[3], 2), deviation_pct: round(a[4], 1), threshold_pct: thr,
            message: '检测到' + r.p.name + '（' + r.p.node_id + '）' + a[2] + '，超过 ±' + thr + '% 阈值，' + a[5] + '。',
            raised_at: task.alarm_at[key]
          });
        });
        const anom = hitC || hitT;
        return {
          party_id: r.p.party_id, tag: r.p.tag, name: r.p.name, node_id: r.p.node_id, ip: r.p.ip,
          roles: r.p.roles, role: r.p.roles[0],
          status: anom ? 'abnormal' : (task.status === 'running' ? 'running' : (task.tick === 0 ? 'pending' : 'finished')),
          comm_bytes: r.comm, compute_sec: r.time, comm_sec: r.comm_sec, interaction_rounds: r.rounds,
          comm_deviation_pct: round(devC, 1), compute_deviation_pct: round(devT, 1)
        };
      });
      const protos = protocolsOf(task.steps);
      return {
        task_id: task.task_id, project_id: task.project_id, name: task.name,
        protocol: task.steps[0].protocol, protocols: protos, operator: task.steps[0].operator,
        steps: task.steps.map(function (s) { return Object.assign({ name: OP[s.operator].name }, s); }),
        status: task.status, readonly: !!task.seeded,
        progress_pct: round(task.tick / TOTAL_TICKS * 100, 1),
        data_rows: task.data_rows, params: task.params,
        estimate: { est_compute_sec: task.estimate.est_compute_sec, est_comm_sec: task.estimate.est_comm_sec, est_comm_mb: task.estimate.est_comm_mb, rounds: task.estimate.rounds },
        anomaly_rule: Object.assign({ description: '执行满 ' + task.rule.min_ticks + ' 个心跳后，某参与方累计通信量或累计计算耗时与全部参与方均值的偏离 |x − 均值| / 均值 > ' + thr + '% 即判为异常' }, task.rule),
        parties: parties,
        summary: {
          total_comm_bytes: rows.reduce(function (s, r) { return s + r.comm; }, 0),
          mean_comm_bytes: Math.round(mc),
          max_compute_sec: Math.max.apply(null, rows.map(function (r) { return r.time; })),
          mean_compute_sec: round(mt, 2),
          duration_sec: Math.max.apply(null, rows.map(function (r) { return round(r.time + r.comm_sec, 2); })),
          interaction_rounds: rows.length ? rows[0].rounds : 0,
          abnormal_parties: parties.filter(function (p) { return p.status === 'abnormal'; }).length
        },
        alarms: alarms,
        created_at: task.created_at, started_at: task.started_at, finished_at: task.finished_at
      };
    }
    function sign(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }

    function itemOf(task) {
      const v = taskView(task);
      return {
        task_id: v.task_id, name: v.name, protocol: v.protocol, protocols: v.protocols, operator: v.operator,
        flow: v.steps.map(function (s) { return s.name; }).join(' → '),
        party_count: v.parties.length, data_rows: v.data_rows,
        total_comm_bytes: v.summary.total_comm_bytes,
        total_duration_sec: v.summary.duration_sec,
        mean_comm_bytes: v.summary.mean_comm_bytes,
        interaction_rounds: v.summary.interaction_rounds,
        alarm_count: v.alarms.length,
        status: v.status, progress_pct: v.progress_pct,
        created_at: v.created_at, started_at: v.started_at, finished_at: v.finished_at
      };
    }

    function path(task) { return '/mpc/tasks/' + task.task_id + '/events'; }
    function stopTimer(task) { if (task._timer) { clearInterval(task._timer); task._timer = null; } }
    function startTimer(task) {
      stopTimer(task);
      task._timer = setInterval(function () {
        if (task.tick >= TOTAL_TICKS) {
          stopTimer(task);
          task.status = 'finished';
          task.finished_at = k.NOW();
          k.emit(path(task), 'status_changed', { task_id: task.task_id, status: 'finished' });
          return;
        }
        task.tick += 1;
        const v = taskView(task);
        k.emit(path(task), 'metrics', { parties: v.parties, summary: v.summary, progress_pct: v.progress_pct, alarms: v.alarms });
        v.alarms.forEach(function (a) { k.emit(path(task), 'alarm_raised', a); });
      }, TICK_MS);
    }

    /** 每个项目播种 6 条历史任务（结束态），日期固定，便于筛选与对比演示。 */
    const SEED = [
      { at: '2026-10-20T15:30:00+08:00', rows: 1200000, n: 3, name: '三方氧化钕均价阈值核验', steps: [
        { operator: 'secure_sum', protocol: 'ss' }, { operator: 'secure_mean', protocol: 'ss' },
        { operator: 'secure_compare', protocol: 'gc', operand: { cmp: 'gt', threshold: 1890000 } }] },
      { at: '2026-10-16T10:12:00+08:00', rows: 800000, n: 3, skip: 2, name: '采购额联合测算', steps: [
        { operator: 'secure_sum', protocol: 'ss' }, { operator: 'secure_product', protocol: 'ss', operand: { factor: 1.13 } }] },
      { at: '2026-10-09T09:40:00+08:00', rows: 200000, n: 3, name: '最高报价比对', steps: [
        { operator: 'secure_max', protocol: 'gc' }, { operator: 'secure_compare', protocol: 'gc', operand: { cmp: 'gt', threshold: 640000 } }] },
      { at: '2026-09-28T14:05:00+08:00', rows: 500000, n: 4, name: '指定批次价格不经意检索', steps: [
        { operator: 'vector_ot', protocol: 'ot', operand: { index: 2 } }] },
      { at: '2026-09-21T16:42:00+08:00', rows: 2000000, n: 3, name: '氧化铈 CeO₂ 月度均价', steps: [
        { operator: 'secure_mean', protocol: 'ss' }] },
      { at: '2026-09-12T20:14:00+08:00', rows: 300000, n: 3, name: '双方报价一致性核查', steps: [
        { operator: 'secure_compare', protocol: 'gc' }, { operator: 'logic_op', protocol: 'gc', operand: { mode: 'and' } }] }
    ];
    function ensureSeed(projectId) {
      if (db.seeded[projectId]) return;
      db.seeded[projectId] = true;
      const pool = partiesOf(projectId);
      SEED.forEach(function (s, i) {
        const n = Math.min(s.n, pool.length);
        // skip：项目参与方 ≥ 4 时跳过该下标的参与方（演示不含降级节点的正常任务）
        const cand = (s.skip !== undefined && pool.length >= 4) ? pool.filter(function (x, j) { return j !== s.skip; }) : pool;
        const parties = cand.slice(0, n).map(function (p, j) { return Object.assign({}, p, { roles: defaultRoles(j) }); });
        const P = resolveAllParams(projectId, {});
        const steps = validateFlow(s.steps, s.rows, 2);
        const id = 'mpc-' + s.at.slice(0, 10).replace(/-/g, '') + '-' + projectId + String(i + 1).padStart(2, '0');
        const task = buildTask(projectId, { task_id: id, name: s.name, steps: steps, parties: parties, params: P, net: DEFAULT_NET, data_rows: s.rows, created_at: s.at });
        const total = task.estimate.est_total_sec * 1.1;
        task.tick = TOTAL_TICKS;
        task.status = 'finished';
        task.finished_at = s.at;
        task.started_at = new Date(Date.parse(s.at) - total * 1000).toISOString();
        task.seeded = true;
        db.tasks[id] = task;
      });
    }

    function tasksOf(projectId) {
      ensureSeed(projectId);
      return Object.keys(db.tasks).map(function (id) { return db.tasks[id]; })
        .filter(function (t) { return t.project_id === projectId; });
    }

    /** 列表过滤：status（逗号分隔，all = 全部）、protocol、start_time / end_time（YYYY-MM-DD，按结束时间，未结束按创建时间）、task_ids。 */
    function filterTasks(projectId, q) {
      const st = q.status || 'finished,failed';
      const statuses = st === 'all' ? null : st.split(',');
      const dateRx = /^\d{4}-\d{2}-\d{2}$/;
      if (q.start_time && !dateRx.test(q.start_time)) return fail(40002, '开始日期格式应为 YYYY-MM-DD', { field: 'start_time' });
      if (q.end_time && !dateRx.test(q.end_time)) return fail(40002, '结束日期格式应为 YYYY-MM-DD', { field: 'end_time' });
      if (q.start_time && q.end_time && q.start_time > q.end_time) return fail(40000, '开始日期不能晚于结束日期', { field: 'start_time' });
      if (q.protocol && !PROTO[q.protocol]) return fail(40000, '未知协议 ' + q.protocol, { field: 'protocol' });
      const ids = q.task_ids ? q.task_ids.split(',') : null;
      const day = function (iso) {
        const d = new Date(Date.parse(iso) + 8 * 3600 * 1000);   // 按 +08:00 取日期
        return d.toISOString().slice(0, 10);
      };
      return tasksOf(projectId).filter(function (t) {
        if (ids && ids.indexOf(t.task_id) < 0) return false;
        if (statuses && statuses.indexOf(t.status) < 0) return false;
        if (q.protocol && protocolsOf(t.steps).indexOf(q.protocol) < 0) return false;
        const d = day(t.finished_at || t.created_at);
        if (q.start_time && d < q.start_time) return false;
        if (q.end_time && d > q.end_time) return false;
        return true;
      }).sort(function (a, b) {
        return Date.parse(b.finished_at || b.created_at) - Date.parse(a.finished_at || a.created_at);
      });
    }

    const COMPARE_METRICS = [
      { key: 'total_comm_bytes', label: '总通信量', unit: 'MB', fmt: function (v) { return round(v / 1048576, 1); }, note: '各参与方累计发送字节之和' },
      { key: 'mean_comm_bytes', label: '单方平均通信量', unit: 'MB', fmt: function (v) { return round(v / 1048576, 1); }, note: '总通信量 / 参与方数' },
      { key: 'total_duration_sec', label: '总耗时', unit: '秒', fmt: function (v) { return round(v, 1); }, note: '最慢参与方的计算 + 通信耗时' },
      { key: 'interaction_rounds', label: '轮次交互数', unit: '轮', fmt: function (v) { return v; }, note: '协议消息往返轮数' },
      { key: 'party_count', label: '参与方数', unit: '方', fmt: function (v) { return v; }, note: '' },
      { key: 'data_rows', label: '数据规模', unit: '行', fmt: function (v) { return v; }, note: '每个输入方的数据行数' },
      { key: 'sec_per_10k', label: '每万行耗时', unit: '秒', fmt: function (v) { return round(v, 3); }, note: '总耗时 / (数据规模 / 10,000)，消除规模差异后的效率' },
      { key: 'alarm_count', label: '异常告警数', unit: '条', fmt: function (v) { return v; }, note: '通信量或耗时偏离均值超过阈值的告警' }
    ];
    function compare(items) {
      items.forEach(function (x) { x.sec_per_10k = x.total_duration_sec / (x.data_rows / 10000); });
      return COMPARE_METRICS.map(function (m) {
        const a = items[0][m.key], b = items[1][m.key];
        return {
          key: m.key, label: m.label, unit: m.unit, note: m.note,
          values: [m.fmt(a), m.fmt(b)],
          diff_pct: a ? round((b - a) / a * 100, 1) : null
        };
      });
    }

    function csvCell(v) {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    /* ================= 路由 ================= */

    function out(r) { return isErr(r) ? r.__err : k.ok(r); }
    function needProject(pid) {
      return k.db.projects.some(function (p) { return p.project_id === pid; }) || !!k.db.nodes[pid];
    }

    k.route('GET', '/mpc/protocols', function () {
      return k.ok({
        protocols: PROTOCOLS.map(function (p) {
          return Object.assign({}, p, {
            security_models: p.security_models.map(function (s) { return { key: s, name: SECURITY_CN[s] }; }),
            params_schema: PARAM_SCHEMA[p.protocol], default_params: defaultsOf(p.protocol)
          });
        }),
        operators: OPERATORS,
        value_types: Object.keys(TYPE_CN).map(function (t) { return { key: t, name: TYPE_CN[t] }; }),
        roles: ROLE_KEYS.map(function (r) { return { key: r, name: ROLE_CN[r] }; })
      });
    });

    k.route('GET', '/projects/{project_id}/mpc/parties', function (p) {
      if (!needProject(p.project_id)) return k.err(40400, '项目不存在');
      return k.ok({ items: partiesOf(p.project_id), min_parties: 3 });
    });

    k.route('GET', '/projects/{project_id}/mpc/params', function (p) {
      const items = Object.keys(PARAM_SCHEMA).map(function (proto) {
        const saved = (db.params[p.project_id] || {})[proto];
        return { protocol: proto, params: savedParams(p.project_id, proto), defaults: defaultsOf(proto), customized: !!saved };
      });
      return k.ok({ items: items });
    });
    k.route('PUT', '/projects/{project_id}/mpc/params/{protocol}', function (p, q, body) {
      if (!PARAM_SCHEMA[p.protocol]) return k.err(40400, '协议不存在：' + p.protocol);
      const given = (body || {}).params;
      if (!given || typeof given !== 'object') return k.err(40000, '缺少 params', { field: 'params' });
      const r = validateParams(p.protocol, defaultsOf(p.protocol), given);
      if (isErr(r)) return r.__err;
      db.params[p.project_id] = db.params[p.project_id] || {};
      db.params[p.project_id][p.protocol] = r;
      return k.ok({ protocol: p.protocol, params: r, defaults: defaultsOf(p.protocol), customized: true });
    });
    k.route('DELETE', '/projects/{project_id}/mpc/params/{protocol}', function (p) {
      if (!PARAM_SCHEMA[p.protocol]) return k.err(40400, '协议不存在：' + p.protocol);
      if (db.params[p.project_id]) delete db.params[p.project_id][p.protocol];
      return k.ok({ protocol: p.protocol, params: defaultsOf(p.protocol), defaults: defaultsOf(p.protocol), customized: false });
    });

    // 兼容内核 4.1：protocol + operator 单算子预估；新增 steps / party_count / data_rows / 网络参数
    k.routeFirst('GET', '/projects/{project_id}/mpc/estimate', function (p, q) {
      const proto = q.protocol || 'ss';
      if (!PROTO[proto]) return k.err(40000, '未知协议 ' + proto, { field: 'protocol' });
      let raw;
      if (q.steps) {
        raw = q.steps.split(',').map(function (x) { const a = x.split(':'); return { operator: a[0], protocol: a[1] }; });
      } else {
        const opKey = q.operator || PROTO[proto].operators[0];
        if (!OP[opKey]) return k.err(40000, '未知算子 ' + opKey, { field: 'operator' });
        if (OP[opKey].protocols.indexOf(proto) < 0) return k.err(40001, OP[opKey].name + ' 不支持' + PROTO[proto].name + '协议', { field: 'operator' });
        raw = DEFAULT_FLOW[opKey];
      }
      const src = Object.assign({}, q);
      delete src.params;
      if (q.party_ids) src.party_count = q.party_ids.split(',').length;
      const r = estimateRequest(p.project_id, src, raw);
      if (isErr(r)) return r.__err;
      delete r.steps_input;
      delete r.params;
      r.protocol = proto;
      r.operators = PROTO[proto].operators.map(function (o) { return { key: o, name: OP[o].name }; });
      return k.ok(r);
    });
    k.route('POST', '/projects/{project_id}/mpc/estimate', function (p, q, body) {
      const r = estimateRequest(p.project_id, body || {}, (body || {}).steps);
      if (isErr(r)) return r.__err;
      delete r.steps_input;
      return k.ok(r);
    });

    k.route('POST', '/projects/{project_id}/mpc/flows/dry-run', function (p, q, body) {
      return out(dryRun(p.project_id, body || {}));
    });

    k.routeFirst('POST', '/projects/{project_id}/mpc/tasks', function (p, q, body) {
      body = body || {};
      const m = parseRows(body.data_rows, DEFAULT_ROWS);
      if (isErr(m)) return m.__err;
      const net = parseNet(body);
      if (isErr(net)) return net.__err;
      const P = resolveAllParams(p.project_id, body.params);
      if (isErr(P)) return P.__err;
      // 兼容内核 4.2：只传 protocol + operator 时按默认流程
      let raw = body.steps;
      if (!raw && body.operator) {
        const op = OP[body.operator];
        if (!op) return k.err(40000, '未知算子 ' + body.operator, { field: 'operator' });
        if (body.protocol && op.protocols.indexOf(body.protocol) < 0) return k.err(40001, op.name + ' 不支持' + (PROTO[body.protocol] ? PROTO[body.protocol].name : body.protocol) + '协议', { field: 'protocol' });
        raw = DEFAULT_FLOW[body.operator];
      }
      const pre = validateFlow(raw, m);
      if (isErr(pre)) return pre.__err;
      const pv = validateParties(p.project_id, body.parties, protocolsOf(pre));
      if (isErr(pv)) return pv.__err;
      const steps = validateFlow(raw, m, pv.counts.input);
      if (isErr(steps)) return steps.__err;
      let rule = null;
      if (body.anomaly_threshold_pct !== undefined) {
        const t = body.anomaly_threshold_pct;
        if (typeof t !== 'number' || !isFinite(t)) return k.err(40002, '异常阈值应为数字（%）', { field: 'anomaly_threshold_pct' });
        if (t < 10 || t > 200) return k.err(40003, '异常阈值应在 10%–200% 之间', { field: 'anomaly_threshold_pct', min: 10, max: 200 });
        rule = { threshold_pct: t };
      }
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 40)) {
        return k.err(40002, '任务名称应为不超过 40 个字的文本', { field: 'name' });
      }
      ensureSeed(p.project_id);
      const task = buildTask(p.project_id, { name: (body.name || '').trim(), steps: steps, parties: pv.parties, params: P, net: net, data_rows: m, rule: rule });
      db.tasks[task.task_id] = task;
      if (body.auto_start !== false) {
        task.status = 'running';
        task.started_at = k.NOW();
        startTimer(task);
      }
      return k.ok(taskView(task));
    });

    k.routeFirst('GET', '/mpc/tasks/{task_id}', function (p) {
      const task = db.tasks[p.task_id];
      if (!task) return k.err(40400, '任务不存在');
      return k.ok(taskView(task));
    });

    k.routeFirst('POST', '/mpc/tasks/{task_id}/actions', function (p, q, body) {
      const task = db.tasks[p.task_id];
      if (!task) return k.err(40400, '任务不存在');
      const action = (body || {}).action;
      if (action === 'start') {
        if (task.status === 'finished') return k.err(40901, '任务已结束，请新建任务', { status: task.status });
        if (task.status === 'running') return k.err(40901, '任务已在执行中', { status: task.status });
        task.status = 'running';
        if (!task.started_at) task.started_at = k.NOW();
        startTimer(task);
      } else if (action === 'stop') {
        if (task.status !== 'running') return k.err(40901, '只有执行中的任务可以停止', { status: task.status });
        stopTimer(task);
        task.status = 'stopped';
      } else if (action === 'reset') {
        if (task.seeded) return k.err(40901, '历史任务只读，不能重置', { status: task.status });
        stopTimer(task);
        task.status = 'pending';
        task.tick = 0;
        task.alarm_at = {};
        task.started_at = null;
        task.finished_at = null;
      } else {
        return k.err(40000, '未知动作 ' + action, { field: 'action' });
      }
      k.emit(path(task), 'status_changed', { task_id: task.task_id, status: task.status });
      return k.ok(taskView(task));
    });

    k.route('GET', '/projects/{project_id}/mpc/tasks/compare', function (p, q) {
      const ids = (q.task_ids || '').split(',').filter(Boolean);
      if (ids.length !== 2) return k.err(40000, '请选择 2 个任务进行对比，当前 ' + ids.length + ' 个', { field: 'task_ids' });
      if (ids[0] === ids[1]) return k.err(40000, '请选择 2 个不同的任务', { field: 'task_ids' });
      tasksOf(p.project_id);
      const items = [];
      for (let i = 0; i < 2; i++) {
        const t = db.tasks[ids[i]];
        if (!t || t.project_id !== p.project_id) return k.err(40400, '任务不存在：' + ids[i], { field: 'task_ids' });
        items.push(itemOf(t));
      }
      return k.ok({ tasks: items, metrics: compare(items), baseline: items[0].task_id });
    });

    k.routeFirst('GET', '/projects/{project_id}/mpc/tasks', function (p, q) {
      const list = filterTasks(p.project_id, q);
      if (isErr(list)) return list.__err;
      const page = Math.max(1, Number(q.page) || 1);
      const size = Math.min(100, Math.max(1, Number(q.page_size) || 20));
      const items = list.slice((page - 1) * size, page * size).map(itemOf);
      return k.ok({ items: items, page: page, page_size: size, total: list.length });
    });

    // 内核 4.6 的导出路径固定输出内置历史，这里提供带筛选 / 对比的报表导出
    k.download(/^\/projects\/([^/]+)\/mpc\/reports\/export$/, function (m, q) {
      const list = filterTasks(m[1], q);
      if (isErr(list)) throw new Error(list.__err.message);
      const items = list.map(itemOf);
      let csv = '任务 ID,任务名称,计算流程,协议,参与方数,数据规模(行),总通信量(MB),单方平均通信量(MB),总耗时(秒),轮次交互数(轮),异常告警数(条),开始时间,结束时间,状态\n';
      items.forEach(function (t) {
        csv += [t.task_id, t.name, t.flow, t.protocols.join('+'), t.party_count, t.data_rows,
          (t.total_comm_bytes / 1048576).toFixed(1), (t.mean_comm_bytes / 1048576).toFixed(1),
          t.total_duration_sec.toFixed(1), t.interaction_rounds, t.alarm_count,
          t.started_at || '', t.finished_at || '', t.status].map(csvCell).join(',') + '\n';
      });
      if (items.length === 2 && q.task_ids) {
        csv += '\n对比指标,单位,' + items[0].task_id + ',' + items[1].task_id + ',差异(后者相对前者 %)\n';
        compare(items).forEach(function (x) {
          csv += [x.label, x.unit, x.values[0], x.values[1], x.diff_pct === null ? '' : x.diff_pct].map(csvCell).join(',') + '\n';
        });
      }
      return { fileName: 'mpc_report_' + m[1] + '.csv', contentType: 'text/csv;charset=utf-8', content: '﻿' + csv };
    });
  });
})();
