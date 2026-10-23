// 联邦学习 · 聚合与安全（FL-AGG-01–07）+ 技术指标验证（FL-EVAL-01–03）mock 接口契约测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const AGG = '/projects/p1/fl/aggregation';

async function cfgOf(okData) {
  const v = await okData('GET', AGG);
  return { strategy: v.strategy, ss: v.ss, he: v.he, sparsification: v.sparsification };
}

async function finishEval(env, kind, config) {
  const run = await env.okData('POST', '/projects/p1/fl/evaluations', { kind, config });
  assert.equal(run.status, 'running');
  env.tick(5000);
  return env.okData('GET', '/fl/evaluations/' + run.eval_id);
}

test('[FL-AGG-01] 一键聚合策略配置：未保存时给出默认 + 两种策略的推荐配置，推荐门限取多数派', async (t) => {
  const { okData, errCode } = boot(t);
  const v = await okData('GET', AGG);
  assert.equal(v.saved, false);
  assert.equal(v.strategy, 'ss');
  assert.equal(v.trainer_count, 3);
  assert.deepEqual(v.recommended.ss, { parties: 3, threshold: 2, dropout_tolerance: 1, field_bits: 16, mask_rotation_rounds: 10 });
  // Paillier 推荐批打包 = ⌊(2048 − 1) / (24 + ⌈log₂3⌉ + 1)⌋ = 75
  assert.equal(v.recommended.he.paillier.batch_size, 75);
  assert.equal(v.recommended.he.ckks.poly_modulus_degree, 8192);
  // p2 只有 2 个训练节点：推荐 n = 2、t = 2、d = 0
  const v2 = await okData('GET', '/projects/p2/fl/aggregation');
  assert.deepEqual([v2.recommended.ss.parties, v2.recommended.ss.threshold, v2.recommended.ss.dropout_tolerance], [2, 2, 0]);
  // 失败路径：策略不合法、项目不存在
  const cfg = await cfgOf(okData);
  assert.equal(await errCode('PUT', AGG, Object.assign(cfg, { strategy: 'fedavg' })), 40000);
  assert.equal(await errCode('GET', '/projects/nope/fl/aggregation'), 40400);
});

test('[FL-AGG-02] 秘密共享参数：保存 + 越界校验（门限 / 掉线容忍 / 有限域 / 轮换周期）', async (t) => {
  const { okData, call } = boot(t);
  const cfg = await cfgOf(okData);
  cfg.ss = { parties: 3, threshold: 3, dropout_tolerance: 0, field_bits: 24, mask_rotation_rounds: 20 };
  const saved = await okData('PUT', AGG, cfg);
  assert.deepEqual(saved.ss, cfg.ss);
  assert.equal(saved.saved, true);

  const bad = async (ssPatch, spPatch, field, code) => {
    const c = await cfgOf(okData);
    Object.assign(c.ss, ssPatch);
    Object.assign(c.sparsification, spPatch || {});
    const r = await call('POST', AGG + '/estimate', c);
    assert.equal(r.code, code, JSON.stringify(ssPatch) + ' → ' + r.message);
    assert.equal(r.data.field, field);
    return r;
  };
  await bad({ threshold: 4 }, null, 'ss.threshold', 40003);
  await bad({ threshold: 1 }, null, 'ss.threshold', 40003);
  await bad({ threshold: 2, dropout_tolerance: 2 }, null, 'ss.dropout_tolerance', 40003);
  await bad({ field_bits: 8 }, null, 'ss.field_bits', 40003);
  // 跨字段：量化 16 bit + ⌈log₂3⌉ = 18 > 有限域 16
  const r = await bad({ field_bits: 16 }, { quant_bits: 16 }, 'ss.field_bits', 40003);
  assert.match(r.message, /至少需要.*18/);
  await bad({ mask_rotation_rounds: 2.5 }, null, 'ss.mask_rotation_rounds', 40002);
  await bad({ parties: 17 }, null, 'ss.parties', 40003);
});

test('[FL-AGG-03] 同态加密参数：Paillier / CKKS 可编辑；打包超明文空间、系数模数超安全上限被拒', async (t) => {
  const { okData, call } = boot(t);
  const c = await cfgOf(okData);
  c.strategy = 'he';
  c.he = Object.assign(c.he, { scheme: 'paillier', key_size_bits: 3072, precision_bits: 32, batch_size: 64 });
  const e1 = await okData('POST', AGG + '/estimate', c);
  // 64 个/密文：⌈30,472 / 64⌉ = 477 个密文，每个 2 × 3072 bit
  assert.equal(e1.ciphertext_count, 477);
  assert.equal(e1.ciphertext_bits, 6144);

  const fail = async (he, field) => {
    const r = await call('POST', AGG + '/estimate', Object.assign({}, c, { he: Object.assign({}, c.he, he) }));
    assert.equal(r.code, 40003, r.message);
    assert.equal(r.data.field, field);
    return r;
  };
  // 64 × (32 + 2 + 1) = 2240 > 2047
  await fail({ key_size_bits: 2048, batch_size: 64 }, 'he.batch_size');
  await fail({ precision_bits: 60 }, 'he.precision_bits');
  const ck = { scheme: 'ckks', poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40, batch_size: 4096 };
  const e2 = await okData('POST', AGG + '/estimate', Object.assign({}, c, { he: Object.assign({}, c.he, ck) }));
  assert.equal(e2.ciphertext_bits, 2 * 8192 * 200);
  await fail(Object.assign({}, ck, { coeff_modulus_bits: 219 }), 'he.coeff_modulus_bits');   // > 218 上限
  await fail(Object.assign({}, ck, { batch_size: 4097 }), 'he.batch_size');                 // > N/2
  const bad = await call('POST', AGG + '/estimate', Object.assign({}, c, { he: Object.assign({}, c.he, { scheme: 'bfv' }) }));
  assert.equal(bad.code, 40000);
});

test('[FL-AGG-04] 密钥对生成：未生成时查看公钥 40402；生成后公钥可查看、私钥只给 key_id；再生成则旧钥轮换', async (t) => {
  const { okData, errCode } = boot(t);
  assert.equal(await errCode('GET', AGG + '/public-key'), 40402);
  const c = await cfgOf(okData);
  // 同态策略在没有密钥时不能保存
  assert.equal(await errCode('PUT', AGG, Object.assign({}, c, { strategy: 'he' })), 40901);

  const k1 = await okData('POST', AGG + '/keys', { he: c.he });
  assert.match(k1.key_id, /^flk_/);
  assert.equal(k1.scheme, 'paillier');
  assert.equal(k1.key_size_bits, 2048);
  assert.equal(k1.public_key.length, 2048 / 4);           // 模数 n 完整十六进制
  assert.match(k1.fingerprint, /^SHA256:[0-9a-f]{64}$/);
  assert.equal(k1.project_id, 'p1');
  assert.ok(k1.project_name.length > 0 && k1.created_at);
  assert.ok(!('private_key' in k1));
  const pk = await okData('GET', AGG + '/public-key');
  assert.equal(pk.key_id, k1.key_id);

  const saved = await okData('PUT', AGG, Object.assign({}, c, { strategy: 'he' }));
  assert.equal(saved.strategy, 'he');
  assert.equal(saved.he_key_matches, true);

  // 参数与密钥不一致 → 拒绝保存；重新生成 → 旧钥 rotated
  const c3072 = Object.assign({}, c, { strategy: 'he', he: Object.assign({}, c.he, { key_size_bits: 3072 }) });
  assert.equal(await errCode('PUT', AGG, c3072), 40901);
  const k2 = await okData('POST', AGG + '/keys', { he: c3072.he });
  const list = await okData('GET', AGG + '/keys');
  // 列表还含同态模块播种的历史聚合密钥（hek_），本页生成的两把：新钥在用、旧钥已轮换，全项目只有一把在用
  assert.deepEqual(list.items.filter((x) => x.key_id.startsWith('flk_')).map((x) => [x.key_id, x.status]), [[k2.key_id, 'active'], [k1.key_id, 'rotated']]);
  assert.deepEqual(list.items.filter((x) => x.status === 'active').map((x) => x.key_id), [k2.key_id]);
  await okData('PUT', AGG, c3072);
  // 密钥参数越界
  assert.equal(await errCode('POST', AGG + '/keys', { he: Object.assign({}, c.he, { key_size_bits: 1024 }) }), 40000);
});

test('[FL-AGG-04] 项目生成密钥后，过程管控页任务公钥（/fl/jobs/{id}/he-public-key）与项目密钥一致；未生成时回落内核逻辑', async (t) => {
  const { okData, errCode } = boot(t);
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const cls = items.find((j) => j.task_type === 'classification');
  const ts = items.find((j) => j.task_type === 'timeseries');
  const on = await okData('PATCH', '/fl/jobs/' + cls.job_id, { aggregation: 'he' });
  // 未生成项目密钥：与内核原响应一致
  const before = await okData('GET', '/fl/jobs/' + cls.job_id + '/he-public-key');
  assert.equal(before.key_id, on.aggregation_info.he_public_key_id);
  assert.equal(before.key_size_bits, 2048);
  assert.match(before.fingerprint, /^SHA256:[0-9a-f]+$/);
  assert.equal(await errCode('GET', '/fl/jobs/' + ts.job_id + '/he-public-key'), 40400);   // ss 任务无聚合公钥
  assert.equal(await errCode('GET', '/fl/jobs/nope/he-public-key'), 40400);

  const c = await cfgOf(okData);
  await okData('POST', AGG + '/keys', { he: c.he });
  const proj = await okData('GET', AGG + '/public-key');
  const pk = await okData('GET', '/fl/jobs/' + cls.job_id + '/he-public-key');
  for (const f of ['key_id', 'scheme', 'key_size_bits', 'public_key', 'fingerprint', 'created_at']) assert.equal(pk[f], proj[f], f);
  // 轮换后跟随新密钥；CKKS 的 key_size_bits 取 log₂Q
  const ck = Object.assign({}, c.he, { scheme: 'ckks', poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40, batch_size: 4096 });
  const k2 = await okData('POST', AGG + '/keys', { he: ck });
  const pk2 = await okData('GET', '/fl/jobs/' + cls.job_id + '/he-public-key');
  assert.deepEqual([pk2.key_id, pk2.scheme, pk2.key_size_bits, pk2.poly_modulus_degree], [k2.key_id, 'ckks', 200, 8192]);
  // 其他项目不受影响
  const p2 = (await okData('GET', '/projects/p2/fl/jobs')).items.find((j) => j.task_type === 'classification');
  await okData('PATCH', '/fl/jobs/' + p2.job_id, { aggregation: 'he' });
  assert.match((await okData('GET', '/fl/jobs/' + p2.job_id + '/he-public-key')).key_id, /^hek_/);
});

test('[FL-AGG-04] 项目聚合密钥与同态加密模块共用一套（he.md H.7.7）：只写 heKeys，播种的旧钥被轮换；同态页轮换 / 销毁后本页与任务详情同步', async (t) => {
  const { okData, errCode, M } = boot(t);
  const c = await cfgOf(okData);
  const { items } = await okData('GET', '/projects/p1/fl/jobs');
  const job = items.find((j) => j.task_type === 'classification');
  await okData('PATCH', '/fl/jobs/' + job.job_id, { aggregation: 'he' });
  // 任务详情 he_public_key_id、任务公钥接口、本页公钥三者一致
  const consistent = async (keyId) => {
    const pk = await okData('GET', '/fl/jobs/' + job.job_id + '/he-public-key');
    const detail = await okData('GET', '/fl/jobs/' + job.job_id);
    assert.equal(pk.key_id, keyId);
    assert.equal(detail.aggregation_info.he_public_key_id, pk.key_id);
    assert.equal((await okData('GET', AGG + '/public-key')).key_id, keyId);
  };

  const k1 = await okData('POST', AGG + '/keys', { he: c.he });
  // 内核表：H.7.7 约定字段，可直接用于同态四步流程
  const core = M._db.heKeys[k1.key_id];
  assert.deepEqual([core.project_id, core.scheme, core.purpose, core.status], ['p1', 'paillier', 'fl_aggregation', 'active']);
  assert.equal(core.key_params.key_size_bits, 2048);
  assert.ok(!Number.isNaN(Date.parse(core.created_at)));
  assert.equal(core.distributed_to.length, 4);
  assert.ok(core.rotated_from);
  assert.equal(M._db.heKeys[core.rotated_from].rotated_to, k1.key_id);
  assert.ok(await okData('POST', '/he/encrypt', { key_id: k1.key_id, values: [{ name: 'a', value: 12 }], precision: 0 }));
  // 同态加密密钥管理页：只有这一把在用的 fl_aggregation 密钥
  const list = await okData('GET', '/he/keys?project_id=p1&purpose=fl_aggregation');
  assert.deepEqual(list.items.filter((x) => x.status === 'active').map((x) => x.key_id), [k1.key_id]);
  assert.equal(list.items.find((x) => x.key_id === k1.key_id).purpose, 'fl_aggregation');
  await consistent(k1.key_id);

  // 同态页手动轮换 → hek_ 接替者镜像进本页列表并成为项目密钥
  const rot = await okData('POST', '/he/keys/' + k1.key_id + '/rotate', {});
  const nid = rot.new_key.key_id;
  const mine = await okData('GET', AGG + '/keys');
  assert.deepEqual(mine.items.filter((x) => x.status === 'active').map((x) => x.key_id), [nid]);
  assert.equal(mine.items.find((x) => x.key_id === k1.key_id).status, 'rotated');
  assert.equal(M._db.flaKeys.p1.filter((x) => x.status === 'active')[0].key_id, nid);
  await consistent(nid);
  assert.equal((await okData('GET', AGG)).he_key.key_id, nid);

  // 同态页销毁在用密钥 → 本页无有效密钥，任务回落为任务派生密钥
  await okData('DELETE', '/he/keys/' + nid);
  assert.equal((await okData('GET', AGG + '/keys')).items.find((x) => x.key_id === nid).status, 'destroyed');
  assert.equal(await errCode('GET', AGG + '/public-key'), 40402);
  const detail = await okData('GET', '/fl/jobs/' + job.job_id);
  assert.equal(detail.aggregation_info.he_public_key_id, (await okData('GET', '/fl/jobs/' + job.job_id + '/he-public-key')).key_id);
});

test('[FL-AGG-04] 同态页已有在用的聚合密钥时直接作为项目密钥（未在本页生成过）', async (t) => {
  const { okData } = boot(t);
  const he = await okData('GET', '/he/keys?project_id=p1&purpose=fl_aggregation');
  const act = he.items.filter((x) => x.status === 'active');
  assert.equal(act.length, 1);
  const v = await okData('GET', AGG);
  assert.equal(v.he_key.key_id, act[0].key_id);
  const pk = await okData('GET', AGG + '/public-key');
  assert.equal(pk.key_id, act[0].key_id);
  assert.equal(pk.scheme, 'paillier');
  assert.equal(pk.key_size_bits, 2048);
  // 参数一致即可直接保存同态策略
  const c = await cfgOf(okData);
  assert.equal((await okData('PUT', AGG, Object.assign(c, { strategy: 'he' }))).he_key_matches, true);
});

test('[FL-AGG-05] 参数重置：恢复默认策略并落库，密钥保留', async (t) => {
  const { okData, M, errCode } = boot(t);
  const c = await cfgOf(okData);
  await okData('POST', AGG + '/keys', { he: c.he });
  c.ss.threshold = 3; c.sparsification.topk_ratio = 0.05;
  await okData('PUT', AGG, c);
  const v = await okData('POST', AGG + '/reset', {});
  assert.equal(v.strategy, 'ss');
  assert.equal(v.ss.threshold, 2);
  assert.equal(v.sparsification.topk_ratio, 0.15);
  assert.equal(v.saved, true);
  assert.equal(M._db.fla.p1.strategy, 'ss');
  assert.equal(v.he_key.status, 'active');
  assert.equal(await errCode('POST', '/projects/nope/fl/aggregation/reset', {}), 40400);
});

test('[FL-AGG-06] 参数配置保存：k.db.fla[projectId] 结构固定，项目间隔离；非法配置不落库', async (t) => {
  const { okData, M, errCode } = boot(t);
  const c = await cfgOf(okData);
  c.ss.mask_rotation_rounds = 12;
  const v = await okData('PUT', AGG, c);
  const s = M._db.fla.p1;
  assert.deepEqual(Object.keys(s).sort(), ['he', 'sparsification', 'ss', 'strategy', 'updated_at']);
  assert.equal(s.strategy, 'ss');
  assert.equal(s.ss.mask_rotation_rounds, 12);
  assert.equal(v.updated_at, s.updated_at);
  assert.equal(M._db.fla.p2, undefined);
  const again = await okData('GET', AGG);
  assert.equal(again.ss.mask_rotation_rounds, 12);
  // 失败路径：越界不覆盖已保存值
  c.ss.mask_rotation_rounds = 0;
  assert.equal(await errCode('PUT', AGG, c), 40003);
  assert.equal(M._db.fla.p1.ss.mask_rotation_rounds, 12);
});

test('[FL-AGG-07] 梯度稀疏化：按公式估算每轮上传量与压缩比；比例越界被拒', async (t) => {
  const { okData, call } = boot(t);
  const v = await okData('GET', AGG);
  const e = v.estimate;
  const P = 203143;
  const k = Math.ceil(0.15 * P);
  assert.equal(e.kept, k);
  assert.equal(e.upload_bytes_per_client, k * 16 / 8);
  assert.equal(e.download_bytes_per_client, (k * 32 + Math.min(k * 18, P)) / 8);
  assert.equal(e.fedavg_bytes, 3 * 2 * 32 * P / 8);
  const ours = 3 * (k * 16 + k * 32 + Math.min(k * 18, P)) + 3 * 2 * 2 * 256 / 5;
  assert.ok(Math.abs(e.ratio - (3 * 64 * P) / ours) < 1e-9);
  assert.ok(e.ratio >= 7 && e.ratio <= 9, 'ratio ' + e.ratio);
  assert.equal(e.meets_contract, true);

  const c = { strategy: v.strategy, ss: v.ss, he: v.he, sparsification: Object.assign({}, v.sparsification, { enabled: false }) };
  const dense = await okData('POST', AGG + '/estimate', c);
  assert.equal(dense.kept, P);
  assert.equal(dense.index_bytes, 0);
  assert.equal(dense.meets_contract, false);

  for (const ratio of [0, 1.5]) {
    const r = await call('POST', AGG + '/estimate', Object.assign({}, c, { sparsification: Object.assign({}, v.sparsification, { topk_ratio: ratio }) }));
    assert.equal(r.code, 40003);
    assert.equal(r.data.field, 'sparsification.topk_ratio');
  }
  const q = await call('POST', AGG + '/estimate', Object.assign({}, c, { sparsification: Object.assign({}, v.sparsification, { quant_bits: 7 }) }));
  assert.equal(q.code, 40000);
});

test('[FL-EVAL-01] 梯度重构攻击：本算法 DLG / iDLG 0 / 200，明文 FedAvg 80%–90%，结果确定可复现', async (t) => {
  const env = boot(t);
  const run = await env.okData('POST', '/projects/p1/fl/evaluations', { kind: 'gradient_attack' });
  const events = [];
  const sub = env.M.subscribe('/fl/evaluations/' + run.eval_id + '/events', {
    progress: (e) => events.push(e.progress), finished: (e) => events.push('done:' + e.status)
  });
  env.tick(5000);
  sub.close();
  assert.ok(events.length >= 5 && events[events.length - 1] === 'done:finished');
  const d = await env.okData('GET', '/fl/evaluations/' + run.eval_id);
  const r = d.result;
  assert.equal(r.scenario.dataset_id, 'ds_p1_ree_price');
  assert.equal(r.scenario.server_count, 1);
  assert.equal(r.scenario.client_count, 3);
  assert.equal(r.scenario.mse_threshold, 0.0025);
  const [ours, fedavg] = r.groups;
  assert.equal(ours.key, 'ours');
  assert.deepEqual(ours.attacks.map((a) => [a.attack, a.sample_count, a.success_count, a.success_rate]), [['DLG', 200, 0, 0], ['iDLG', 200, 0, 0]]);
  ours.attacks.forEach((a) => assert.ok(a.mean_mse > 0.0025));
  fedavg.attacks.forEach((a) => {
    assert.ok(a.success_rate >= 0.8 && a.success_rate <= 0.9, a.attack + ' ' + a.success_rate);
    assert.equal(a.success_rate, a.success_count / a.sample_count);
    assert.ok(a.mean_mse < 0.0025);
  });
  assert.equal(r.passed, true);
  // 同配置再跑一次，结果一致
  const d2 = await finishEval(env, 'gradient_attack');
  assert.deepEqual(d2.result, r);
  // 失败路径：样本数越界、类型不合法、同类评估并发
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'gradient_attack', config: { sample_count: 5 } }), 40003);
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'gradient_attack', config: { target_client: 'node-x' } }), 40000);
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'gan' }), 40000);
  await env.okData('POST', '/projects/p1/fl/evaluations', { kind: 'gradient_attack' });
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'gradient_attack' }), 40901);
  env.tick(5000);
});

test('[FL-EVAL-02] 通信压缩比：逐轮通信量 + 平均压缩比 7–9，含 RMSE / MAE 对比；保留比例过大则未达标', async (t) => {
  const env = boot(t);
  const d = await finishEval(env, 'compression');
  const r = d.result;
  assert.equal(r.rounds.length, 20);
  const avgF = r.rounds.reduce((s, x) => s + x.fedavg_bytes, 0) / 20;
  const avgO = r.rounds.reduce((s, x) => s + x.ours_bytes, 0) / 20;
  assert.ok(Math.abs(r.ratio - avgF / avgO) < 0.01);
  assert.ok(r.ratio >= 7 && r.ratio <= 9, 'ratio ' + r.ratio);
  assert.equal(r.passed, true);
  assert.ok(r.utility.ours.rmse > r.utility.fedavg.rmse);
  assert.ok(r.utility.rmse_increase_pct > 0 && r.utility.rmse_increase_pct < 3);
  // 动态裁剪：首轮保留量多于末轮
  assert.ok(r.rounds[0].kept > r.rounds[19].kept);
  // 默认配置取自项目已保存的稀疏化参数
  const defs = await env.okData('GET', '/projects/p1/fl/evaluations/defaults');
  assert.equal(defs.compression.topk_ratio, 0.15);
  const big = await finishEval(env, 'compression', { topk_ratio: 0.4 });
  assert.equal(big.result.passed, false);
  const noEf = await finishEval(env, 'compression', { error_feedback: false });
  assert.ok(noEf.result.utility.rmse_increase_pct > r.utility.rmse_increase_pct);
  // 失败路径
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'compression', config: { rounds: 1 } }), 40003);
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'compression', config: { quant_bits: 16, field_bits: 16 } }), 40003);
  // CSV 报告
  const f = await env.download('/fl/evaluations/' + d.eval_id + '/export');
  assert.match(f.fileName, /_compression_report\.csv$/);
  assert.match(f.content, /单轮平均通信压缩比,\d+\.\d{2}/);
  assert.match(f.content, /明文 FedAvg,0\.\d{4},0\.\d{4}/);
});

test('[FL-EVAL-03] 精度衰减：MNIST 0.5–1.0、CIFAR-10 1.5–2.5 个百分点；轮次过少时未达标', async (t) => {
  const env = boot(t);
  const d = await finishEval(env, 'accuracy');
  const [mn, cf] = d.result.datasets;
  assert.equal(mn.dataset, 'MNIST');
  assert.equal(cf.dataset, 'CIFAR-10');
  assert.ok(mn.drop_pp >= 0.5 && mn.drop_pp <= 1.0, 'mnist ' + mn.drop_pp);
  assert.ok(cf.drop_pp >= 1.5 && cf.drop_pp <= 2.5, 'cifar ' + cf.drop_pp);
  assert.ok(Math.abs((mn.centralized_accuracy - mn.federated_accuracy) * 100 - mn.drop_pp) < 0.02);
  assert.equal(d.result.passed, true);
  const short = await finishEval(env, 'accuracy', { rounds: 10 });
  assert.equal(short.result.datasets[1].passed, false);
  assert.equal(short.result.passed, false);
  // 历史记录：最新在前，可按类型过滤
  const h = await env.okData('GET', '/projects/p1/fl/evaluations?kind=accuracy');
  assert.deepEqual(h.items.map((x) => x.eval_id), [short.eval_id, d.eval_id]);
  assert.equal((await env.okData('GET', '/projects/p2/fl/evaluations')).total, 0);
  // 失败路径
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'accuracy', config: { partition: 'shard' } }), 40000);
  assert.equal(await env.errCode('POST', '/projects/p1/fl/evaluations', { kind: 'accuracy', config: { local_epochs: 9 } }), 40003);
  assert.equal(await env.errCode('GET', '/fl/evaluations/fle_9999'), 40400);
  await assert.rejects(env.download('/fl/evaluations/fle_9999/export'));
  const f = await env.download('/fl/evaluations/' + d.eval_id + '/export');
  assert.match(f.content, /MNIST,.*,达标/);
});
