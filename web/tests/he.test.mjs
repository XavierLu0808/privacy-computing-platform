// 同态加密模块（算法管理 #/he/algo + 应用集成 #/he/app）mock 契约测试。接口见 docs/api/he.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const PRICES = ['41.2356', '0.6821', '0.3957'];   // 氧化钕 / 氧化铈 / 氧化镧 均价（万元/吨）
const DAY = 86400000;

test('[HE-ALGO-01] 半同态 Paillier：目录给出整数加、数乘；整数精确加与数乘，不支持密文乘', async (t) => {
  const { okData, call } = boot(t);
  const { items } = await okData('GET', '/he/algorithms');
  const pa = items.find((x) => x.scheme === 'paillier');
  assert.equal(pa.family, 'phe');
  assert.deepEqual(pa.supported_ops, ['add_ct_ct', 'mul_ct_pt']);
  assert.equal(pa.plaintext_type, 'integer');
  assert.deepEqual(pa.libraries, ['phe']);
  const add = await okData('POST', '/he/verify', { scheme: 'paillier', op: 'add', a: ['1200', '860'], b: ['455', '-60'], precision: 4 });
  assert.equal(add.mode, 'integer');
  assert.deepEqual(add.rows.map((r) => r.decrypted), [1655, 800]);
  assert.equal(add.max_abs_error, 0);
  const mp = await okData('POST', '/he/verify', { scheme: 'paillier', op: 'mul_plain', a: ['1200', '860'], b: ['3'], precision: 4 });
  assert.deepEqual(mp.rows.map((r) => r.decrypted), [3600, 2580]);
  const bad = await call('POST', '/he/verify', { scheme: 'paillier', op: 'mul', a: ['2'], b: ['3'], precision: 0 });
  assert.equal(bad.code, 40001);
  assert.match(bad.message, /不支持密文乘密文/);
});

test('[HE-ALGO-02] 全同态 CKKS / BGV：CKKS 浮点乘为近似（误差非 0 且 < 1e-4），BGV 整数乘精确', async (t) => {
  const { okData, errCode } = boot(t);
  const { items } = await okData('GET', '/he/algorithms');
  const ck = items.find((x) => x.scheme === 'ckks');
  const bg = items.find((x) => x.scheme === 'bgv');
  assert.equal(ck.family, 'fhe');
  assert.ok(ck.supported_ops.includes('mul_ct_ct') && bg.supported_ops.includes('mul_ct_ct'));
  assert.equal(ck.plaintext_type, 'float');
  assert.equal(bg.plaintext_type, 'integer_exact');
  const c = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'mul', a: PRICES, b: ['1.035', '0.982', '1.012'], precision: 4 });
  assert.equal(c.mode, 'ckks_native');
  assert.ok(c.max_abs_error > 0 && c.max_abs_error < 1e-4, 'CKKS 近似误差 ' + c.max_abs_error);
  const again = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'mul', a: PRICES, b: ['1.035', '0.982', '1.012'], precision: 4 });
  assert.equal(again.max_abs_error, c.max_abs_error, '同输入同输出');
  const b = await okData('POST', '/he/verify', { scheme: 'bgv', op: 'mul', a: ['120', '-35'], b: ['42', '7'], precision: 0 });
  assert.deepEqual(b.rows.map((r) => r.decrypted), [5040, -245]);
  assert.equal(b.max_abs_error, 0);
  assert.equal(await errCode('POST', '/he/verify', { scheme: 'rsa', op: 'add', a: ['1'], b: ['1'], precision: 0 }), 40000);
});

test('[HE-ALGO-03] 加密算法配置：库 × 方案矩阵；合法组合保存为项目默认，不支持的组合 40001', async (t) => {
  const { okData, call, errCode } = boot(t);
  const libs = await okData('GET', '/he/libraries');
  const m = Object.fromEntries(libs.items.map((l) => [l.library, l.matrix]));
  assert.deepEqual(Object.keys(m).sort(), ['openfhe', 'phe', 'pyfhel', 'seal', 'tfhe-rs']);
  assert.equal(m['tfhe-rs'].tfhe, true);
  assert.equal(m['tfhe-rs'].ckks, false);
  assert.equal(m.pyfhel.paillier, false);
  const def = await okData('GET', '/projects/p1/he/config');
  assert.deepEqual([def.scheme, def.library, def.precision], ['ckks', 'seal', 4]);
  const saved = await okData('PUT', '/projects/p1/he/config', { scheme: 'bgv', library: 'openfhe', precision: 3 });
  assert.equal(saved.library, 'openfhe');
  assert.equal((await okData('GET', '/projects/p1/he/config')).scheme, 'bgv');
  assert.equal((await okData('GET', '/projects/p2/he/config')).scheme, 'ckks', '项目之间互不影响');
  const bad = await call('PUT', '/projects/p1/he/config', { scheme: 'ckks', library: 'tfhe-rs', precision: 3 });
  assert.equal(bad.code, 40001);
  assert.match(bad.message, /TFHE-rs 0.7 不支持 CKKS/);
  assert.equal((await okData('GET', '/projects/p1/he/config')).scheme, 'bgv', '拒绝后配置不变');
  assert.equal(await errCode('PUT', '/projects/p1/he/config', { scheme: 'ckks', library: 'seal', precision: 9 }), 40003);
  assert.equal(await errCode('PUT', '/projects/p1/he/config', { scheme: 'ckks', library: 'nope' }), 40000);
  assert.equal(await errCode('POST', '/he/verify', { scheme: 'paillier', library: 'seal', op: 'add', a: ['1'], b: ['1'], precision: 0 }), 40001);
});

test('[HE-ALGO-04] 整型数据：BGV / TFHE 加乘精确还原；超出明文空间 40003，非数值 40002', async (t) => {
  const { okData, call, errCode } = boot(t);
  const tf = await okData('POST', '/he/verify', { scheme: 'tfhe', op: 'mul', a: ['46000', '-3'], b: ['40000', '7'], precision: 0 });
  assert.deepEqual(tf.rows.map((r) => r.decrypted), [1840000000, -21]);
  assert.equal(tf.steps.map((s) => s.stage).join(','), 'keygen,encode,encrypt,evaluate,decrypt');
  assert.ok(tf.steps.every((s) => s.elapsed_ms >= 0));
  const ov = await call('POST', '/he/verify', { scheme: 'tfhe', op: 'mul', a: ['50000'], b: ['50000'], precision: 0 });
  assert.equal(ov.code, 40003);
  assert.match(ov.message, /2500000000 超出范围/);
  assert.equal(await errCode('POST', '/he/verify', { scheme: 'bgv', op: 'add', a: ['1', 'abc'], b: ['1', '2'], precision: 0 }), 40002);
  assert.equal(await errCode('POST', '/he/verify', { scheme: 'bgv', op: 'add', a: ['1', '2'], b: ['1'], precision: 0 }), 40000);
});

test('[HE-ALGO-05] 浮点型数据：CKKS 加法误差 < 乘法误差；Paillier 浮点自动定点化后误差受精度约束', async (t) => {
  const { okData, errCode } = boot(t);
  const B = ['1.035', '0.982', '1.012'];
  const add = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'add', a: PRICES, b: B, precision: 4 });
  const mul = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'mul', a: PRICES, b: B, precision: 4 });
  assert.ok(add.max_abs_error < mul.max_abs_error);
  assert.equal(add.steps.find((s) => s.stage === 'encrypt').detail.startsWith('2 条密文'), true, 'CKKS 向量打包为 1 条 / 操作数');
  const p = await okData('POST', '/he/verify', { scheme: 'paillier', op: 'add', a: PRICES, b: B, precision: 4 });
  assert.equal(p.mode, 'fixed_point');
  assert.equal(p.rows[0].encoded_a, '412356');
  assert.ok(p.max_abs_error <= 1e-4 + 1e-12);
  assert.equal(await errCode('POST', '/he/verify', { scheme: 'ckks', op: 'add', a: PRICES, b: B, precision: -1 }), 40003);
});

test('[HE-ALGO-06] 数据类型自动转换：整数方案输入浮点 → 定点整数，给出缩放因子、编码整数、还原值', async (t) => {
  const { okData, errCode } = boot(t);
  const r = await okData('POST', '/he/encode', { scheme: 'bgv', values: ['41.2356', '-0.6821', '1.005'], precision: 2 });
  assert.equal(r.mode, 'fixed_point');
  assert.equal(r.converted, true);
  assert.equal(r.scale_factor, 100);
  assert.deepEqual(r.items.map((x) => x.encoded_integer), ['4124', '-68', '101'], '十进制四舍五入，1.005 → 101');
  assert.deepEqual(r.items.map((x) => x.decoded), ['41.24', '-0.68', '1.01']);
  const ints = await okData('POST', '/he/encode', { scheme: 'paillier', values: ['1200', '-7'], precision: 4 });
  assert.equal(ints.mode, 'integer');
  assert.equal(ints.scale_factor, 1);
  const ck = await okData('POST', '/he/encode', { scheme: 'ckks', values: ['1.5'], precision: 2 });
  assert.equal(ck.mode, 'native');
  assert.equal(ck.converted, false);
  assert.equal(await errCode('POST', '/he/encode', { scheme: 'bgv', values: ['1.2', '1e'], precision: 2 }), 40002);
  assert.equal(await errCode('POST', '/he/encode', { scheme: 'bgv', values: [], precision: 2 }), 40000);
});

test('[HE-ALGO-07] 浮点转换精度：0–8 位逐档误差单调不增，BGV 高精度触发溢出提示；越界 40003', async (t) => {
  const { okData, errCode } = boot(t);
  const r = await okData('POST', '/he/encode', { scheme: 'bgv', values: PRICES, precision: 4 });
  assert.equal(r.sweep.length, 9);
  for (let i = 1; i < 9; i++) assert.ok(r.sweep[i].max_abs_error <= r.sweep[i - 1].max_abs_error + 1e-12);
  r.sweep.forEach((s) => assert.ok(s.max_abs_error <= s.error_bound + 1e-12, '误差不超过 0.5 × 10^-p'));
  assert.equal(r.sweep[4].overflow, false, '41.2356 × 10^4 = 412356 ≤ 516096');
  assert.equal(r.sweep[5].overflow, true, '× 10^5 超出 t = 1032193 的对称区间');
  assert.equal(r.sweep[0].mul_overflow, false);
  assert.equal(r.sweep[3].mul_overflow, true);
  assert.equal(r.items[0].encoded_integer, '412356');
  assert.equal(await errCode('POST', '/he/encode', { scheme: 'bgv', values: PRICES, precision: 9 }), 40003);
  assert.equal(await errCode('POST', '/he/encode', { scheme: 'bgv', values: PRICES, precision: 2.5 }), 40003);
});

test('[HE-ALGO-08] 参数智能寻优：按安全标准表选最小 N，给出模数链、Δ、性能估计与候选对比；不可行 40003', async (t) => {
  const { okData, call, errCode } = boot(t);
  const r = await okData('POST', '/he/param-optimize', { security_bits: 128, mult_depth: 2, precision_digits: 6, batch_size: 4096 });
  assert.equal(r.recommended.poly_modulus_degree, 8192);
  assert.deepEqual(r.recommended.coeff_modulus_bits, [60, 40, 40, 60]);
  assert.equal(r.recommended.total_modulus_bits, 200);
  assert.equal(r.recommended.max_modulus_bits, 218);
  assert.equal(r.recommended.scale_bits, 40);
  assert.ok(r.recommended.est_mul_ms > r.recommended.est_add_ms);
  assert.equal(r.recommended.ciphertext_kb, 384);
  assert.ok(r.candidates.length >= 2 && r.candidates.length <= 3);
  assert.equal(r.candidates[0].feasible, false, '小一档 N 作为不可行对照');
  assert.match(r.candidates[0].reasons.join(), /超过 128 位安全上限 109 bit/);
  assert.equal(r.candidates.filter((c) => c.recommended).length, 1);
  const deep = await okData('POST', '/he/param-optimize', { security_bits: 128, mult_depth: 3, precision_digits: 6, batch_size: 4096 });
  assert.equal(deep.recommended.poly_modulus_degree, 16384, '240 bit > 218 bit，升到 N = 16384');
  const s256 = await okData('POST', '/he/param-optimize', { security_bits: 256, mult_depth: 2, precision_digits: 6, batch_size: 16 });
  assert.equal(s256.recommended.poly_modulus_degree, 16384, '256 位安全下 N = 8192 上限 118 bit');
  const bad = await call('POST', '/he/param-optimize', { security_bits: 256, mult_depth: 20, precision_digits: 8, batch_size: 1 });
  assert.equal(bad.code, 40003);
  assert.match(bad.message, /无法同时满足/);
  assert.equal(await errCode('POST', '/he/param-optimize', { security_bits: 100, mult_depth: 2, precision_digits: 6, batch_size: 1 }), 40000);
  assert.equal(await errCode('POST', '/he/param-optimize', { security_bits: 128, mult_depth: 0, precision_digits: 6, batch_size: 1 }), 40003);
});

test('[HE-APP-01] 可视化配置：密钥 → 加密 → 密态运算 → 解密 四步走通；密钥销毁后加密 40402', async (t) => {
  const { okData, call, errCode } = boot(t);
  const key = await okData('POST', '/he/keys', { scheme: 'ckks', project_id: 'p1' });
  assert.equal(key.status, 'active');
  assert.equal(key.purpose, 'session');
  const enc = await okData('POST', '/he/encrypt', { key_id: key.key_id, precision: 4, values: [{ name: 'A', value: '128.75' }, { name: 'B', value: '64.25' }] });
  const ev = await okData('POST', '/he/evaluate', { key_id: key.key_id, op: 'add', left_ciphertext_id: enc.ciphertexts[0].ciphertext_id, right_ciphertext_id: enc.ciphertexts[1].ciphertext_id });
  const dec = await okData('POST', '/he/decrypt', { key_id: key.key_id, ciphertext_id: ev.result_ciphertext_id, verify: true });
  assert.equal(dec.plaintext, '193.0000');
  assert.equal(dec.verification.matched, true);
  await okData('DELETE', '/he/keys/' + key.key_id);
  assert.equal(await errCode('POST', '/he/encrypt', { key_id: key.key_id, precision: 4, values: [{ name: 'A', value: '1' }] }), 40402);
  assert.equal(await errCode('DELETE', '/he/keys/' + key.key_id), 40402);
  assert.equal((await call('POST', '/he/keys', { scheme: 'ckks' })).code, 40000, 'project_id 必填');
});

test('[HE-APP-02] 联邦学习一键配置：Created 任务启用 he 后可查公钥；运行中任务 40901', async (t) => {
  const { okData, call } = boot(t);
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const ts = items.find((j) => j.task_type === 'timeseries');
  const cls = items.find((j) => j.task_type === 'classification');
  assert.equal(ts.aggregation, 'ss');
  assert.equal((await call('GET', '/fl/jobs/' + ts.job_id + '/he-public-key')).code, 40400, '未启用时无聚合公钥');
  await okData('PATCH', '/fl/jobs/' + cls.job_id, { aggregation: 'ss' });
  const on = await okData('PATCH', '/fl/jobs/' + cls.job_id, { aggregation: 'he' });
  assert.equal(on.aggregation, 'he');
  assert.equal(on.aggregation_info.he_key_ready, true);
  const pk = await okData('GET', '/fl/jobs/' + cls.job_id + '/he-public-key');
  assert.equal(pk.key_id, on.aggregation_info.he_public_key_id);
  assert.match(pk.fingerprint, /^SHA256:/);
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'start' });
  const busy = await call('PATCH', '/fl/jobs/' + cls.job_id, { aggregation: 'he' });
  assert.equal(busy.code, 40901);
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'terminate' });
});

test('[HE-APP-03] 密钥管理：播种在用 + 已轮换；生成、分发、轮换、销毁与自动轮换策略', async (t) => {
  const { okData, call, errCode } = boot(t);
  const first = await okData('GET', '/he/keys?project_id=p1');
  assert.deepEqual(first.items.map((x) => x.status).sort(), ['active', 'rotated']);
  const seededActive = first.items.find((x) => x.status === 'active');
  assert.equal(seededActive.distributed_to.length, 4, '轮换继承分发节点');
  assert.ok(seededActive.next_rotation_at);
  // 自动轮换：周期从 30 天改为 7 天，12 天前生成的播种密钥立即被轮换
  const pol = await okData('PUT', '/projects/p1/he/rotation-policy', { enabled: true, period_days: 7 });
  assert.equal(pol.period_days, 7);
  const after = await okData('GET', '/he/keys?project_id=p1');
  const old = after.items.find((x) => x.key_id === seededActive.key_id);
  assert.equal(old.status, 'rotated');
  assert.equal(old.rotate_reason, 'auto');
  assert.ok(after.items.some((x) => x.rotated_from === seededActive.key_id && x.status === 'active'));
  assert.ok(Date.parse(after.items.find((x) => x.rotated_from === seededActive.key_id).next_rotation_at) - Date.now() > 6 * DAY);
  const k = await okData('POST', '/he/keys', { scheme: 'paillier', project_id: 'p1', purpose: 'fl_aggregation', key_params: { key_size_bits: 3072 }, node_ids: ['node-shanghai-01'] });
  assert.equal(k.superseded_key_ids.length, 1, '新聚合密钥替代原在用的那把');
  assert.equal(k.key_params.key_size_bits, 3072);
  const d = await okData('POST', '/he/keys/' + k.key_id + '/distribute', { node_ids: ['node-hangzhou-02', 'node-shanghai-01'] });
  assert.deepEqual(d.distributed_to.map((x) => x.node_id), ['node-shanghai-01', 'node-hangzhou-02']);
  assert.equal(await errCode('POST', '/he/keys/' + k.key_id + '/distribute', { node_ids: ['node-shenzhen-05'] }), 40400);
  assert.equal(await errCode('POST', '/he/keys/' + k.key_id + '/distribute', { node_ids: [] }), 40000);
  const rot = await okData('POST', '/he/keys/' + k.key_id + '/rotate', {});
  assert.equal(rot.old_key.status, 'rotated');
  assert.equal(rot.old_key.rotated_to, rot.new_key.key_id);
  assert.equal(rot.new_key.rotated_from, k.key_id);
  assert.equal(rot.new_key.distributed_to.length, 2);
  assert.equal(await errCode('POST', '/he/keys/' + k.key_id + '/rotate', {}), 40901, '已轮换的密钥不能再轮换');
  await okData('DELETE', '/he/keys/' + rot.new_key.key_id);
  const destroyed = await okData('GET', '/he/keys?project_id=p1&status=destroyed');
  assert.deepEqual(destroyed.items.map((x) => x.key_id), [rot.new_key.key_id]);
  assert.equal(await errCode('POST', '/he/keys/' + rot.new_key.key_id + '/distribute', { node_ids: ['node-shanghai-01'] }), 40901);
  assert.equal(await errCode('PUT', '/projects/p1/he/rotation-policy', { enabled: true, period_days: 0 }), 40003);
  assert.equal(await errCode('PUT', '/projects/p1/he/rotation-policy', { enabled: 'yes', period_days: 7 }), 40000);
  assert.equal((await call('GET', '/he/keys')).code, 40000);
});

test('[HE-APP-04] 流程测试模拟：3 方 × 10 000 维模拟梯度 加密→聚合→解密 通过；精度不足判失败；参数校验', async (t) => {
  const { okData, errCode } = boot(t);
  const ok = await okData('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 10000, parties: 3, precision: 6, tolerance: 1e-4 });
  assert.equal(ok.passed, true);
  assert.ok(ok.max_abs_error <= 3 * 0.5e-6 + 1e-12, '3 方定点舍入误差上界 1.5e-6');
  assert.equal(ok.steps.find((s) => s.stage === 'encrypt').ciphertext_count, Math.ceil(10000 / 32));
  assert.match(ok.conclusion, /^通过/);
  const fail = await okData('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 1000, parties: 3, precision: 2, tolerance: 1e-4 });
  assert.equal(fail.passed, false);
  assert.match(fail.conclusion, /^未通过：最大绝对误差/);
  const ck = await okData('POST', '/projects/p1/he/simulations', { scheme: 'ckks', dim: 1000, parties: 3, tolerance: 1e-6 });
  assert.equal(ck.passed, true);
  assert.equal(ck.steps.find((s) => s.stage === 'encrypt').ciphertext_count, 1);
  const list = await okData('GET', '/projects/p1/he/simulations');
  assert.equal(list.total, 3);
  assert.equal(await errCode('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 500, parties: 3 }), 40000);
  assert.equal(await errCode('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 1000, parties: 1 }), 40003);
  assert.equal(await errCode('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 1000, parties: 3, tolerance: 0 }), 40003);
  assert.equal(await errCode('POST', '/projects/px/he/simulations', { scheme: 'paillier', dim: 1000, parties: 3 }), 40400);
});

test('[HE-APP-05] 日志：模拟与同态聚合训练的每环节耗时与密文大小，可按来源 / 任务筛选并导出 CSV', async (t) => {
  const { okData, errCode, download, tick } = boot(t);
  const empty = await okData('GET', '/projects/p1/he/logs');
  assert.equal(empty.total, 0, '训练任务尚未跑轮次、无模拟时为空');
  const sim = await okData('POST', '/projects/p1/he/simulations', { scheme: 'paillier', dim: 1000, parties: 3 });
  const s = await okData('GET', '/projects/p1/he/logs?source=simulation');
  assert.equal(s.total, 1 + 3 + 1 + 1, '密钥生成 + 3 方加密 + 聚合 + 解密');
  assert.ok(s.items.every((x) => x.elapsed_ms >= 0 && x.ref_id === sim.sim_id));
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const cls = items.find((j) => j.aggregation === 'he');
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'start' });
  tick(650 * 2);
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'pause' });
  const j = await okData('GET', '/projects/p1/he/logs?source=fl_job&ref_id=' + cls.job_id);
  const rounds = new Set(j.items.map((x) => x.round));
  assert.equal(rounds.size, 2);
  assert.equal(j.total, 2 * (3 + 1 + 1), '每轮 3 个训练节点加密 + 聚合 + 解密');
  // 条数 = ⌈参数量 × Top-k 保留比例 / 每条打包个数⌉，三者分别取自内核 MODEL_PARAMS 与聚合与安全页生效配置
  const agg = await okData('GET', '/projects/p1/fl/aggregation');
  const pk = await okData('GET', '/fl/jobs/' + cls.job_id + '/he-public-key');
  const enc = j.items.find((x) => x.stage === 'encrypt');
  const ratio = agg.sparsification.enabled ? agg.sparsification.topk_ratio : 1;
  const expectCts = Math.ceil(Math.ceil(2176 * ratio) / agg.he.batch_size);
  assert.equal(enc.ciphertext_count, expectCts, 'xgb 2176 维 × Top-k ' + ratio + ' ÷ 每条 ' + agg.he.batch_size + ' 个');
  assert.equal(enc.key_id, pk.key_id, '按任务绑定的公钥计算');
  const each = 2 * pk.key_size_bits / 8 / 1024;
  assert.equal(enc.ciphertext_kb, Number((each * expectCts).toFixed(1)));
  const kf = pk.key_size_bits / 2048;
  const per = 3.4 / 16 * kf * kf * kf;
  assert.ok(enc.elapsed_ms > expectCts * per * 0.94 - 0.01 && enc.elapsed_ms < expectCts * per * 1.06 + 0.01, '节点 16 线程批处理，按密钥位数³ 缩放 ±6%');
  assert.equal(j.job_bases[0].values_uploaded, Math.ceil(2176 * ratio));
  assert.match(j.timing_basis, /16 线程批处理/);
  assert.ok(j.summary.find((x) => x.stage === 'encrypt').avg_elapsed_ms > 0);
  assert.deepEqual(j.refs.map((r) => r.source).sort(), ['fl_job', 'simulation']);
  const f = await download('/projects/p1/he/logs/export?source=fl_job&ref_id=' + cls.job_id);
  const lines = f.content.trim().split('\n');
  assert.match(lines[0], /耗时\(ms\),密文大小\(KB\),密文条数,记录时间\(UTC\+8\)$/);
  lines.slice(1).forEach((l) => assert.match(l, /,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, '[D07] 导出时间按 UTC+8'));
  assert.equal(lines.length, 1 + 10);
  assert.equal(await errCode('GET', '/projects/p1/he/logs?source=xx'), 40000);
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'terminate' });
});

test('[HE-APP-03] 密钥状态约束加密：已轮换 40901、已销毁 40402，新钥可加密', async (t) => {
  const { okData, call, errCode } = boot(t);
  const k = await okData('POST', '/he/keys', { scheme: 'ckks', project_id: 'p1', purpose: 'fl_aggregation' });
  const vals = { precision: 4, values: [{ name: 'A', value: '41.2356' }] };
  await okData('POST', '/he/encrypt', { key_id: k.key_id, ...vals });
  const rot = await okData('POST', '/he/keys/' + k.key_id + '/rotate', {});
  const r = await call('POST', '/he/encrypt', { key_id: k.key_id, ...vals });
  assert.equal(r.code, 40901);
  assert.equal(r.message, '密钥已轮换，只能用于解密历史密文');
  assert.equal(r.data.rotated_to, rot.new_key.key_id);
  const enc = await okData('POST', '/he/encrypt', { key_id: rot.new_key.key_id, ...vals });
  assert.equal(enc.ciphertexts[0].size_kb, 384, 'CKKS N = 8192、L = 3：2 × 8192 × 3 × 8 字节 = 384 KB');
  await okData('DELETE', '/he/keys/' + rot.new_key.key_id);
  assert.equal(await errCode('POST', '/he/encrypt', { key_id: rot.new_key.key_id, ...vals }), 40402);
  assert.equal(await errCode('POST', '/he/encrypt', { key_id: 'hek_nope', ...vals }), 40402);
  assert.equal(await errCode('POST', '/he/encrypt', { key_id: k.key_id, precision: 9, values: vals.values }), 40901, '状态检查先于参数校验');
});

test('[HE-APP-03] 外部模块写入 db.heKeys 的聚合密钥：列表兜底显示，可轮换，外部标记已轮换后拒绝加密', async (t) => {
  const { M, okData, call } = boot(t);
  const db = M._db;
  db.heKeys.hek_fs01 = { key_id: 'hek_fs01', project_id: 'p1', scheme: 'paillier', purpose: 'fl_aggregation',
    created_at: new Date(Date.now() - 3 * 86400000).toISOString(), node_ids: ['node-shanghai-01', 'node-center-agg'] };
  db.heKeys.hek_fs02 = { key_id: 'hek_fs02', project_id: 'p1' };   // 字段几乎全缺
  const { items } = await okData('GET', '/he/keys?project_id=p1');
  const a = items.find((x) => x.key_id === 'hek_fs01');
  assert.equal(a.status, 'active');
  assert.equal(a.purpose, 'fl_aggregation');
  assert.deepEqual(a.distributed_to.map((d) => d.node_id), ['node-shanghai-01', 'node-center-agg']);
  assert.ok(a.next_rotation_at);
  const b = items.find((x) => x.key_id === 'hek_fs02');
  assert.equal(b.status, 'active');
  assert.equal(b.purpose, 'session');
  assert.deepEqual(b.key_params, {});
  assert.equal(b.next_rotation_at, null);
  const rot = await okData('POST', '/he/keys/hek_fs01/rotate', {});
  assert.equal(rot.new_key.distributed_to.length, 2);
  db.heKeys.hek_fs02.status = 'rotated';
  assert.equal((await call('POST', '/he/encrypt', { key_id: 'hek_fs02', precision: 2, values: [{ name: 'A', value: '1' }] })).code, 40901);
  const after = await okData('GET', '/he/keys?project_id=p1&status=rotated');
  assert.ok(after.items.some((x) => x.key_id === 'hek_fs02'));
});

test('[HE-APP-03] 外部 CKKS 聚合密钥：轮换整体继承 key_params，外部写入的 rotated_to 同步到列表', async (t) => {
  const { M, okData } = boot(t);
  const db = M._db;
  const now = new Date().toISOString();
  db.heKeys.hek_ck01 = { key_id: 'hek_ck01', project_id: 'p1', scheme: 'ckks', purpose: 'fl_aggregation', created_at: now,
    key_size_bits: 438, key_params: { poly_modulus_degree: 16384, coeff_modulus_bits: 438, scale_bits: 40 } };
  db.heKeys.hek_ck02 = { key_id: 'hek_ck02', project_id: 'p1', scheme: 'ckks', purpose: 'fl_aggregation', created_at: now,
    key_params: { poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40 } };
  await okData('GET', '/he/keys?project_id=p1');
  const rot = await okData('POST', '/he/keys/hek_ck01/rotate', {});
  assert.deepEqual(rot.new_key.key_params, { poly_modulus_degree: 16384, coeff_modulus_bits: 438, scale_bits: 40 });
  // fed-sec 生成新钥时把旧钥标记 rotated 并写 rotated_to
  db.heKeys.hek_ck02.status = 'rotated';
  db.heKeys.hek_ck02.rotated_to = 'hek_ck03';
  const { items } = await okData('GET', '/he/keys?project_id=p1');
  const old = items.find((x) => x.key_id === 'hek_ck02');
  assert.equal(old.status, 'rotated');
  assert.equal(old.rotated_to, 'hek_ck03');
});

test('[HE-APP-03] 一个项目只保留一把在用的联邦聚合密钥：新建时其余在用的（含外部写入、不同方案）标记为被替代', async (t) => {
  const { M, okData } = boot(t);
  const db = M._db;
  await okData('GET', '/he/keys?project_id=p1');
  db.heKeys.hek_ext1 = { key_id: 'hek_ext1', project_id: 'p1', scheme: 'ckks', purpose: 'fl_aggregation', created_at: new Date().toISOString(),
    key_params: { poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40 } };
  const sess = await okData('POST', '/he/keys', { scheme: 'ckks', project_id: 'p1' });
  const p2 = await okData('POST', '/he/keys', { scheme: 'paillier', project_id: 'p2', purpose: 'fl_aggregation' });
  const nk = await okData('POST', '/he/keys', { scheme: 'bgv', project_id: 'p1', purpose: 'fl_aggregation' });
  assert.equal(nk.superseded_key_ids.length, 2, '播种的在用 Paillier 密钥 + 外部写入的 CKKS 密钥');
  assert.ok(nk.superseded_key_ids.includes('hek_ext1'));
  const { items } = await okData('GET', '/he/keys?project_id=p1');
  const activeAgg = items.filter((x) => x.purpose === 'fl_aggregation' && x.status === 'active');
  assert.deepEqual(activeAgg.map((x) => x.key_id), [nk.key_id], '全项目只有一把 active 的聚合密钥');
  nk.superseded_key_ids.forEach((id) => {
    const v = items.find((x) => x.key_id === id);
    assert.equal(v.status, 'rotated');
    assert.equal(v.rotated_to, nk.key_id);
    assert.equal(v.rotate_reason, 'superseded');
    assert.equal(db.heKeys[id].status, 'rotated', '同步写 db.heKeys');
    assert.equal(db.heKeys[id].rotated_to, nk.key_id);
  });
  assert.equal(items.find((x) => x.key_id === sess.key_id).status, 'active', '会话密钥不受影响');
  const p2v = (await okData('GET', '/he/keys?project_id=p2')).items.filter((x) => x.purpose === 'fl_aggregation' && x.status === 'active');
  assert.deepEqual(p2v.map((x) => x.key_id), [p2.key_id], '其他项目不受影响');
});

test('[HE-ALGO-02][HE-ALGO-08] 同一 CKKS 参数下运算验证、四步流程、参数寻优的单条密文大小一致（2 × N × L × 8 字节）', async (t) => {
  const { okData } = boot(t);
  const v = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'add', a: ['1.5'], b: ['2.5'], precision: 4 });
  const opt = await okData('POST', '/he/param-optimize', { security_bits: 128, mult_depth: 2, precision_digits: 6, batch_size: 4096 });
  assert.deepEqual(opt.recommended.coeff_modulus_bits, [60, 40, 40, 60]);
  assert.equal(v.ciphertext_kb_each, opt.recommended.ciphertext_kb);
  assert.equal(v.steps.find((x) => x.stage === 'encrypt').size_kb, 2 * 384);
  assert.match(v.ciphertext_formula, /2 × N × L × 8 字节/);
  const key = await okData('POST', '/he/keys', { scheme: 'ckks', project_id: 'p1' });
  const e = await okData('POST', '/he/encrypt', { key_id: key.key_id, precision: 4, values: [{ name: 'A', value: '1' }] });
  assert.equal(e.ciphertexts[0].size_kb, opt.recommended.ciphertext_kb);
  const mul = await okData('POST', '/he/verify', { scheme: 'ckks', op: 'mul', a: ['1.5'], b: ['2.5'], precision: 4 });
  assert.equal(mul.steps.find((x) => x.stage === 'evaluate').size_kb, 256, '乘法重缩放后 L = 2');
  const opt3 = await okData('POST', '/he/param-optimize', { security_bits: 128, mult_depth: 1, precision_digits: 6, batch_size: 4096 });
  assert.equal(opt3.recommended.ciphertext_kb, 256, '深度 1：L = 2，与乘法后密文同口径');
});

test('[HE-APP-01][HE-APP-05] 四步流程解密后真正写入性能日志（来源「全流程配置」），汇总与日志一致；未解密不记', async (t) => {
  const { okData, errCode } = boot(t);
  const key = await okData('POST', '/he/keys', { scheme: 'ckks', project_id: 'p1' });
  const enc = await okData('POST', '/he/encrypt', { key_id: key.key_id, precision: 4, values: [{ name: 'A', value: '128.75' }, { name: 'B', value: '64.25' }] });
  const ev = await okData('POST', '/he/evaluate', { key_id: key.key_id, op: 'mul', left_ciphertext_id: enc.ciphertexts[0].ciphertext_id, right_ciphertext_id: enc.ciphertexts[1].ciphertext_id });
  assert.equal(ev.size_kb, 256);
  assert.equal((await okData('GET', '/projects/p1/he/logs?source=session')).total, 0, '解密前不记');
  const dec = await okData('POST', '/he/decrypt', { key_id: key.key_id, ciphertext_id: ev.result_ciphertext_id, verify: true });
  assert.equal(dec.plaintext, '8272.1875');
  assert.equal(dec.session_summary.logged, true);
  const logs = await okData('GET', '/projects/p1/he/logs?source=session&ref_id=' + key.key_id);
  assert.deepEqual(logs.items.map((x) => x.stage), ['keygen', 'encrypt', 'evaluate', 'decrypt']);
  assert.match(logs.items[0].ref_name, /全流程配置 · CKKS · 密文乘法/);
  const sumMs = logs.items.reduce((a, x) => a + x.elapsed_ms, 0);
  assert.ok(Math.abs(sumMs - dec.session_summary.total_elapsed_ms) <= 0.05, "汇总按 0.1 ms 取整");
  assert.equal(dec.session_summary.total_ciphertext_kb, 2 * 384 + 256);
  assert.ok(logs.refs.some((r) => r.source === 'session' && r.ref_id === key.key_id));
  await okData('DELETE', '/he/keys/' + key.key_id);
  assert.equal((await okData('GET', '/projects/p1/he/logs?source=session')).total, 4, '重置销毁密钥后日志保留');
  assert.equal(await errCode('POST', '/he/evaluate', { key_id: key.key_id, op: 'add', left_ciphertext_id: 'x', right_plaintext: '1' }), 40402);
});

test('[HE-APP-05] 同态训练任务每轮 加密 + 聚合 + 解密 墙钟耗时小于每轮训练时长（含参数量最大的 LSTM）', async (t) => {
  const { okData, tick } = boot(t);
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const xgb = items.find((j) => j.aggregation === 'he');
  const lstm = await okData('POST', '/projects/p1/fl/jobs', {
    name: 'LSTM 同态', task_type: 'timeseries', algorithm: 'lstm', aggregation: 'he', total_rounds: 3,
    node_ids: ['node-shanghai-01', 'node-hangzhou-02', 'node-ganzhou-03', 'node-center-agg'],
    dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_a_txn_ts'] }, timeseries: { time_column: 'txn_date', window_size: 14, horizon: 3 }
  });
  for (const j of [xgb, lstm]) await okData('POST', '/fl/jobs/' + j.job_id + '/actions', { action: 'start' });
  tick(650 * 3);
  for (const j of [xgb, lstm]) {
    const job = await okData('GET', '/fl/jobs/' + j.job_id);
    const roundMs = job.elapsed_sec / job.current_round * 1000;
    const { items: rows } = await okData('GET', '/projects/p1/he/logs?source=fl_job&ref_id=' + j.job_id);
    assert.ok(rows.length > 0);
    for (const r of new Set(rows.map((x) => x.round))) {
      const rr = rows.filter((x) => x.round === r);
      const wall = Math.max(...rr.filter((x) => x.stage === 'encrypt').map((x) => x.elapsed_ms)) +
        rr.find((x) => x.stage === 'aggregate').elapsed_ms + rr.find((x) => x.stage === 'decrypt').elapsed_ms;
      assert.ok(wall < roundMs, j.job_id + ' 第 ' + r + ' 轮加解密 ' + wall.toFixed(0) + ' ms 应小于每轮 ' + roundMs + ' ms');
    }
    await okData('POST', '/fl/jobs/' + j.job_id + '/actions', { action: 'terminate' }).catch(() => {});
  }
});

test('[HE-APP-05] 日志按任务实际绑定的公钥位数与 Top-k 稀疏化计算（D34）：3072 bit → 单条 0.75 KB，关闭稀疏化后条数回到全量', async (t) => {
  const { okData, tick } = boot(t);
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const job = items.find((j) => j.aggregation === 'he');
  const k3 = await okData('POST', '/he/keys', { scheme: 'paillier', project_id: 'p1', purpose: 'fl_aggregation', key_params: { key_size_bits: 3072 } });
  const pk = await okData('GET', '/fl/jobs/' + job.job_id + '/he-public-key');
  assert.equal(pk.key_id, k3.key_id, '项目在用聚合密钥即任务绑定公钥');
  assert.equal(pk.key_size_bits, 3072);
  await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  tick(650);
  const agg = await okData('GET', '/projects/p1/fl/aggregation');
  const a = await okData('GET', '/projects/p1/he/logs?source=fl_job&ref_id=' + job.job_id);
  const e = a.items.find((x) => x.stage === 'encrypt');
  const n = Math.ceil(Math.ceil(2176 * agg.sparsification.topk_ratio) / agg.he.batch_size);
  assert.equal(e.key_id, k3.key_id);
  assert.equal(e.ciphertext_count, n);
  assert.equal(e.ciphertext_kb, Number((0.75 * n).toFixed(1)), '3072 bit：2 × 3072 / 8 = 768 字节 = 0.75 KB');
  assert.equal(a.job_bases[0].ciphertext_kb_each, 0.75);
  assert.match(a.timing_basis, /Paillier 3072 bit/);
  assert.match(a.timing_basis, /Top-k 15%/);
  const pE = await okData('PUT', '/projects/p1/fl/aggregation', Object.assign({}, { strategy: agg.strategy, ss: agg.ss, he: agg.he },
    { sparsification: Object.assign({}, agg.sparsification, { enabled: false }) }));
  void pE;
  const b = await okData('GET', '/projects/p1/he/logs?source=fl_job&ref_id=' + job.job_id);
  assert.equal(b.items.find((x) => x.stage === 'encrypt').ciphertext_count, Math.ceil(2176 / agg.he.batch_size), '关闭稀疏化：全部 2176 个参数');
  assert.match(b.timing_basis, /未稀疏化/);
  await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'terminate' });
});
