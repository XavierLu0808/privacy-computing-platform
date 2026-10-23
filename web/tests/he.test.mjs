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
  const k = await okData('POST', '/he/keys', { scheme: 'paillier', project_id: 'p1', purpose: 'fl_aggregation', key_params: { key_size_bits: 3072 }, node_ids: ['node-shanghai-01'] });
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
  // 自动轮换：周期从 30 天改为 7 天，12 天前生成的播种密钥立即被轮换
  const pol = await okData('PUT', '/projects/p1/he/rotation-policy', { enabled: true, period_days: 7 });
  assert.equal(pol.period_days, 7);
  const after = await okData('GET', '/he/keys?project_id=p1');
  const old = after.items.find((x) => x.key_id === seededActive.key_id);
  assert.equal(old.status, 'rotated');
  assert.equal(old.rotate_reason, 'auto');
  assert.ok(after.items.some((x) => x.rotated_from === seededActive.key_id && x.status === 'active'));
  assert.ok(Date.parse(after.items.find((x) => x.rotated_from === seededActive.key_id).next_rotation_at) - Date.now() > 6 * DAY);
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
  assert.equal(j.items.find((x) => x.stage === 'encrypt').ciphertext_count, Math.ceil(4096 / 32));
  assert.ok(j.summary.find((x) => x.stage === 'encrypt').avg_elapsed_ms > 0);
  assert.deepEqual(j.refs.map((r) => r.source).sort(), ['fl_job', 'simulation']);
  const f = await download('/projects/p1/he/logs/export?source=fl_job&ref_id=' + cls.job_id);
  const lines = f.content.trim().split('\n');
  assert.match(lines[0], /耗时\(ms\),密文大小\(KB\)/);
  assert.equal(lines.length, 1 + 10);
  assert.equal(await errCode('GET', '/projects/p1/he/logs?source=xx'), 40000);
  await okData('POST', '/fl/jobs/' + cls.job_id + '/actions', { action: 'terminate' });
});
