// 差分隐私模块测试：隐私机制（DP-MECH-01–04）、效果评估（DP-EVAL-01–03）、框架集成（DP-FW-01–04）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const P = 'p1';
const DS = 'ds_p1_ree_price';
const GAUSS = { enabled: true, mechanism: 'gaussian', epsilon_total: 2, clip_norm: 1, delta: '1e-5' };

async function jobsOf(okData, project = P) {
  const r = await okData('GET', `/projects/${project}/fl/jobs`);
  return { created: r.items.find((j) => j.status === 'Created'), done: r.items.find((j) => j.status === 'Success') };
}

test('[DP-MECH-01] 机制目录：高斯 (ε,δ)-DP 与拉普拉斯 ε-DP，含定义、噪声分布、适用场景', async (t) => {
  const { okData, errCode } = boot(t);
  const { items } = await okData('GET', '/dp/mechanisms');
  assert.deepEqual(items.map((m) => m.mechanism), ['gaussian', 'laplace']);
  const g = items[0], l = items[1];
  assert.equal(g.guarantee, '(ε, δ)-DP');
  assert.match(l.guarantee, /ε-DP/);
  for (const m of items) {
    assert.ok(m.definition && m.noise && m.sensitivity && m.scenarios.length >= 2);
  }
  assert.ok(g.params.some((p) => p.key === 'delta'));
  assert.ok(!l.params.some((p) => p.key === 'delta'), '拉普拉斯机制没有 δ');
  // 失败路径：预估接口拒绝未知机制
  assert.equal(await errCode('POST', '/dp/estimate', { mechanism: 'exponential', epsilon_total: 2, clip_norm: 1, total_rounds: 30 }), 40000);
});

test('[DP-MECH-02] 参数配置：ε / δ / C / 会计方式写入任务；越界与运行中被拒（40003 / 40002 / 40901）', async (t) => {
  const { okData, errCode, call } = boot(t);
  const { created } = await jobsOf(okData);
  const saved = await okData('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, epsilon_total: 3, clip_norm: 1.5, accountant: 'rdp', clip_mode: 'adaptive' });
  assert.equal(saved.epsilon_total, 3);
  assert.equal(saved.accountant, 'rdp');
  assert.equal(saved.clip_mode, 'adaptive');
  // 效果评估页的旧调用不带扩展字段：扩展字段保持不变
  const legacy = await okData('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, epsilon_total: 2.5 });
  assert.equal(legacy.accountant, 'rdp');
  assert.equal((await okData('GET', `/fl/jobs/${created.job_id}/dp`)).epsilon_total, 2.5);

  assert.equal(await errCode('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, epsilon_total: 12 }), 40003);
  assert.equal(await errCode('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, clip_norm: 0.1 }), 40003);
  assert.equal(await errCode('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, delta: '1e-3' }), 40002);
  assert.equal(await errCode('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, accountant: 'zcdp' }), 40000);
  await okData('POST', `/fl/jobs/${created.job_id}/actions`, { action: 'start' });
  const r = await call('PUT', `/fl/jobs/${created.job_id}/dp`, GAUSS);
  assert.equal(r.code, 40901);
  assert.match(r.message, /不允许修改/);

  // 作用对象 = 统计查询：项目级查询配置
  const qc = await okData('PUT', `/projects/${P}/dp/query-config`, { mechanism: 'laplace', epsilon: 0.5, dataset_id: DS, column: 'nd2o3_price', query: 'mean', clip_mode: 'fixed' });
  assert.equal(qc.column, 'nd2o3_price');
  assert.equal(await errCode('PUT', `/projects/${P}/dp/query-config`, { ...qc, column: 'series_id' }), 40001);
  assert.equal(await errCode('PUT', `/projects/${P}/dp/query-config`, { ...qc, epsilon: 0 }), 40003);
});

test('[DP-MECH-03] 自适应噪声：按字段分布选裁剪区间，重尾字段噪声显著下降；梯度自适应裁剪；非数值字段被拒', async (t) => {
  const { okData, errCode } = boot(t);
  await okData('GET', `/projects/${P}/datasets`);
  const r = await okData('POST', '/dp/adaptive-noise', { target: 'field', dataset_id: DS, column: 'ceo2_price', query: 'group_mean', mechanism: 'laplace', epsilon: 0.5 });
  assert.equal(r.unit, '元/吨');
  assert.equal(r.group_size, 21);
  // 固定：Δ = (公开上界 − 0) / n；拉普拉斯 b = Δ / ε
  assert.ok(Math.abs(r.fixed.sensitivity - 150000 / 21) < 0.01);
  assert.ok(Math.abs(r.fixed.noise_scale - r.fixed.sensitivity / 0.5) < 0.01);
  // 自适应：10% 预算用于分位数估计，候选里 RMSE 最小者入选
  assert.equal(r.adaptive.epsilon_used, 0.45);
  assert.equal(r.adaptive.rmse, Math.min(...r.candidates.map((c) => c.rmse)));
  assert.equal(r.recommended, 'adaptive');
  assert.ok(r.noise_reduction_pct > 50, `噪声降低 ${r.noise_reduction_pct}%`);
  // 同输入同输出
  assert.deepEqual(await okData('POST', '/dp/adaptive-noise', { target: 'field', dataset_id: DS, column: 'ceo2_price', query: 'group_mean', mechanism: 'laplace', epsilon: 0.5 }), r);
  // 全量均值样本多、敏感度已很小：固定裁剪更优
  const big = await okData('POST', '/dp/adaptive-noise', { dataset_id: DS, column: 'nd2o3_price', query: 'mean', mechanism: 'laplace', epsilon: 0.5 });
  assert.equal(big.recommended, 'fixed');

  const { created } = await jobsOf(okData);
  const g = await okData('POST', '/dp/adaptive-noise', { target: 'gradient', job_id: created.job_id });
  assert.equal(g.series.length, 30);
  assert.ok(g.summary.noise_adaptive_avg < g.summary.noise_fixed_avg);
  assert.ok(Math.abs(g.summary.clip_ratio_adaptive_avg - 0.5) < 0.1, '自适应裁剪比例接近目标分位 50%');

  assert.equal(await errCode('POST', '/dp/adaptive-noise', { dataset_id: DS, column: 'series_id', mechanism: 'laplace', epsilon: 0.5 }), 40001);
  assert.equal(await errCode('POST', '/dp/adaptive-noise', { dataset_id: 'ds_none', column: 'x', mechanism: 'laplace', epsilon: 0.5 }), 40400);
  assert.equal(await errCode('POST', '/dp/adaptive-noise', { dataset_id: DS, column: 'ceo2_price', mechanism: 'gaussian', epsilon: 0.5, delta: '1e-2' }), 40002);
});

test('[DP-MECH-03] 统计查询发布：只返回加噪结果，结果在裁剪区间内', async (t) => {
  const { okData } = boot(t);
  const r = await okData('POST', `/projects/${P}/dp/query`, { mechanism: 'laplace', epsilon: 0.5, dataset_id: DS, column: 'nd2o3_price', query: 'group_mean', clip_mode: 'adaptive' });
  assert.equal(r.true_value, undefined);
  assert.ok(r.noisy_value >= r.clip_lower && r.noisy_value <= r.clip_upper);
  const list = await okData('GET', `/projects/${P}/dp/queries`);
  assert.equal(list.total, 1);
  assert.equal(list.epsilon_spent_total, 0.5);
});

test('[DP-MECH-04] 组合定理：同一单步机制 T 步，RDP ≤ 高级组合 ≤ 基础组合，公式数值可复核', async (t) => {
  const { okData, errCode } = boot(t);
  const r = await okData('POST', '/dp/compose', { mechanism: 'gaussian', epsilon_per_step: 0.0667, delta: '1e-5', rounds: 30 });
  const { basic, advanced, rdp } = r.results;
  assert.ok(Math.abs(basic.epsilon - 30 * 0.0667) < 1e-3);
  // 高级组合 ε₀·√(2T ln(1/δ)) + T·ε₀·(e^ε₀ − 1)
  const e0 = 0.0667;
  const drv = e0 * Math.sqrt(2 * 30 * Math.log(1e5)) + 30 * e0 * (Math.exp(e0) - 1);
  assert.ok(Math.abs(advanced.epsilon - drv) < 1e-3);
  assert.ok(rdp.epsilon < advanced.epsilon && advanced.epsilon < basic.epsilon);
  assert.equal(rdp.delta_total, 1e-5);
  assert.equal(basic.delta_total, 3e-4);
  assert.equal(r.curve[r.curve.length - 1].t, 30);
  // 拉普拉斯 T 小时 RDP 不劣于基础组合
  const lap = await okData('POST', '/dp/compose', { mechanism: 'laplace', epsilon_per_step: 0.5, delta: '1e-5', rounds: 2 });
  assert.ok(lap.results.rdp.epsilon <= lap.results.basic.epsilon + 1e-9);

  assert.equal(await errCode('POST', '/dp/compose', { mechanism: 'gaussian', epsilon_per_step: 0.1, delta: '1e-5', rounds: 0 }), 40003);
  assert.equal(await errCode('POST', '/dp/compose', { mechanism: 'gaussian', epsilon_per_step: 9, delta: '1e-5', rounds: 10 }), 40003);
});

test('[DP-MECH-04] 策略编排：按权重分配总预算并下发到训练任务；运行中任务 40901，重名 40902', async (t) => {
  const { okData, errCode, call } = boot(t);
  const { created, done } = await jobsOf(okData);
  const body = {
    name: '多维分析', accountant: 'rdp', mechanism: 'gaussian', epsilon_total: 4, delta: '1e-5',
    dimensions: [
      { key: 'train', label: '联合训练', kind: 'training', job_id: created.job_id, weight: 3, sensitivity: 1 },
      { key: 'nd', label: 'Nd₂O₃ 均价', kind: 'query', dataset_id: DS, column: 'nd2o3_price', query: 'mean', weight: 1, steps: 2 }
    ]
  };
  const pol = await okData('POST', `/projects/${P}/dp/policies`, body);
  const [tr, q] = pol.dimensions;
  assert.equal(tr.epsilon, 3);
  assert.equal(q.epsilon, 1);
  assert.equal(tr.steps, created.total_rounds);
  assert.ok(tr.noise_by_accountant.rdp.noise_multiplier < tr.noise_by_accountant.basic.noise_multiplier);
  assert.equal(await errCode('POST', `/projects/${P}/dp/policies`, body), 40902);
  assert.equal(await errCode('POST', `/projects/${P}/dp/policies`, { ...body, name: 'x', dimensions: [{ ...body.dimensions[0], weight: 0 }] }), 40003);
  assert.equal(await errCode('POST', `/projects/${P}/dp/policies`, { ...body, name: 'y', dimensions: [] }), 40000);

  const applied = await okData('POST', `/dp/policies/${pol.policy_id}/apply`, {});
  assert.equal(applied.applied[0].job_id, created.job_id);
  const cfg = await okData('GET', `/fl/jobs/${created.job_id}/dp`);
  assert.equal(cfg.epsilon_total, 3);
  assert.equal(cfg.accountant, 'rdp');
  assert.equal(cfg.policy_id, pol.policy_id);

  // 查询维度按次发布，次数用完 40901；训练维度不能当查询发布 40001
  await okData('POST', `/projects/${P}/dp/query`, { policy_id: pol.policy_id, dimension_key: 'nd' });
  const second = await okData('POST', `/projects/${P}/dp/query`, { policy_id: pol.policy_id, dimension_key: 'nd' });
  assert.equal(second.steps_used, 2);
  assert.equal(await errCode('POST', `/projects/${P}/dp/query`, { policy_id: pol.policy_id, dimension_key: 'nd' }), 40901);
  assert.equal(await errCode('POST', `/projects/${P}/dp/query`, { policy_id: pol.policy_id, dimension_key: 'train' }), 40001);

  await okData('POST', `/fl/jobs/${created.job_id}/actions`, { action: 'start' });
  const r = await call('POST', `/dp/policies/${pol.policy_id}/apply`, {});
  assert.equal(r.code, 40901);
  // 分到的 ε 超出任务允许范围 40003
  const big = await okData('POST', `/projects/${P}/dp/policies`, { ...body, name: '大预算', epsilon_total: 40, dimensions: [{ ...body.dimensions[0], job_id: done.job_id }] });
  assert.equal(await errCode('POST', `/dp/policies/${big.policy_id}/apply`, {}), 40003);
  assert.equal((await okData('GET', `/projects/${P}/dp/policies`)).total, 2);
});

test('[DP-EVAL-01] 效果展示：预算按会计方式累计；basic 与内核数值一致', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const { created } = await jobsOf(okData);
  const id = created.job_id;
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp`)).accountant, 'rdp', '默认 RDP 会计');
  await okData('PUT', `/fl/jobs/${id}/dp`, { ...GAUSS, accountant: 'basic' });
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 6);
  const b = await okData('GET', `/fl/jobs/${id}/dp/budget`);
  assert.equal(b.rounds_completed, 6);
  assert.equal(b.accountant, 'basic');
  assert.equal(b.epsilon_used, Number((2 * 6 / 30).toFixed(3)));
  assert.equal(b.used_pct, 20);
  const e = await okData('POST', '/dp/estimate', { mechanism: 'gaussian', epsilon_total: 2, clip_norm: 1, delta: '1e-5', total_rounds: 30, accountant: 'basic' });
  // 不传 accountant 默认 RDP，与任务默认一致
  assert.equal((await okData('POST', '/dp/estimate', { mechanism: 'gaussian', epsilon_total: 2, clip_norm: 1, delta: '1e-5', total_rounds: 30 })).accountant, 'rdp');
  assert.equal(e.noise_scale, 72.672);
  assert.equal(e.estimated_accuracy, 0.799);
  // RDP：同样总预算下噪声更小、预估效用更高
  const r = await okData('POST', '/dp/estimate', { mechanism: 'gaussian', epsilon_total: 2, clip_norm: 1, delta: '1e-5', total_rounds: 30, accountant: 'rdp' });
  assert.ok(r.noise_scale < e.noise_scale / 4);
  assert.ok(r.estimated_accuracy > e.estimated_accuracy);
  assert.ok(Math.abs(r.curve[29].cumulative_epsilon - 2) < 1e-3, 'RDP 30 轮累计 ε 恰为总预算');
  assert.equal(await errCode('GET', '/fl/jobs/fl_none/dp/budget'), 40400);
  assert.equal(await errCode('POST', '/dp/estimate', { mechanism: 'gaussian', epsilon_total: 2, clip_norm: 1, total_rounds: 30 }), 40000);
});

test('[DP-EVAL-02] 效用曲线 + 效用-隐私平衡：ε 增大效用单调不降，给出平衡点', async (t) => {
  const { okData, errCode } = boot(t);
  const r = await okData('POST', '/dp/tradeoff', { mechanism: 'gaussian', clip_norm: 1, delta: '1e-5', total_rounds: 30, accountant: 'rdp' });
  const accs = r.points.map((p) => p.estimated_accuracy);
  for (let i = 1; i < accs.length; i++) assert.ok(accs[i] >= accs[i - 1]);
  const hit = r.points.find((p) => p.accuracy_loss <= 0.03);
  assert.equal(r.recommended_epsilon, hit.epsilon_total);
  const basic = await okData('POST', '/dp/tradeoff', { mechanism: 'gaussian', clip_norm: 1, delta: '1e-5', total_rounds: 30, accountant: 'basic' });
  assert.equal((await okData('POST', '/dp/tradeoff', { mechanism: 'gaussian', clip_norm: 1, delta: '1e-5', total_rounds: 30 })).accountant, 'rdp');
  assert.ok(basic.recommended_epsilon > r.recommended_epsilon, 'RDP 达到同样效用所需 ε 更小');
  const e = await okData('POST', '/dp/estimate', { mechanism: 'laplace', epsilon_total: 2, clip_norm: 1, total_rounds: 30 });
  assert.equal(e.curve.length, 30);
  assert.equal(e.curve[29].cumulative_epsilon, 2);
  assert.equal(await errCode('POST', '/dp/tradeoff', { mechanism: 'gaussian', clip_norm: 1, delta: '1e-5', total_rounds: 30, epsilons: [0, 1] }), 40003);
});

test('[DP-EVAL-03] 历史审计：每轮 ε 增量与噪声详情、查看全部、导出 CSV；快照不随后改配置变化', async (t) => {
  const { okData, errCode, download, tick } = boot(t);
  const { created, done } = await jobsOf(okData);
  // 播种的已完成任务按其配置回放历史
  const hist = await okData('GET', `/fl/jobs/${done.job_id}/dp/audit`, undefined);
  assert.equal(hist.total, done.total_rounds);
  assert.equal(hist.items.length, 5);
  assert.equal(hist.items[0].round, done.total_rounds);
  const all = await okData('GET', `/fl/jobs/${done.job_id}/dp/audit?limit=all`);
  assert.equal(all.items.length, done.total_rounds);
  assert.ok(Math.abs(all.items[0].epsilon_cumulative - 2) < 1e-3);
  // 训练结束后改配置，历史审计不变
  await okData('PUT', `/fl/jobs/${done.job_id}/dp`, { ...GAUSS, epsilon_total: 5 });
  const after = await okData('GET', `/fl/jobs/${done.job_id}/dp/audit?limit=all`);
  assert.deepEqual(after.items.map((x) => x.noise_scale), all.items.map((x) => x.noise_scale));

  await okData('PUT', `/fl/jobs/${created.job_id}/dp`, { ...GAUSS, accountant: 'rdp' });
  await okData('POST', `/fl/jobs/${created.job_id}/actions`, { action: 'start' });
  tick(650 * 3);
  const a = await okData('GET', `/fl/jobs/${created.job_id}/dp/audit?limit=all`);
  assert.equal(a.total, 3);
  assert.equal(a.items[0].accountant, 'rdp');
  assert.equal(a.items[0].source, 'engine');
  const sum = a.items.reduce((s, x) => s + x.epsilon_spent, 0);
  assert.ok(Math.abs(sum - a.items[0].epsilon_cumulative) < 1e-3, '逐轮增量之和 = 累计 ε');
  const csv = await download(`/fl/jobs/${created.job_id}/dp/audit/export`);
  assert.equal(csv.fileName, `${created.job_id}_dp_audit.csv`);
  assert.equal(csv.content.trim().split('\n').length, 4);
  assert.match(csv.content, /epsilon_spent,epsilon_cumulative/);
  // 导出时间按 UTC+8 书写（D07）
  assert.match(csv.content, /recorded_at\(UTC\+8\)/);
  assert.match(csv.content.trim().split('\n')[1], /,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/);
  assert.equal(await errCode('GET', `/fl/jobs/${created.job_id}/dp/audit?limit=-1`), 40002);
  assert.equal(await errCode('GET', '/fl/jobs/fl_none/dp/audit'), 40400);
});

test('[DP-FW-01] 隐语集成：适配层接口映射、可替换实现、切换 provider', async (t) => {
  const { okData, errCode } = boot(t);
  const p = await okData('GET', '/dp/providers');
  assert.equal(p.current, 'secretflow-native');
  assert.deepEqual(p.items.map((x) => x.provider), ['secretflow-native', 'opacus', 'tf-privacy']);
  const sf = p.items[0];
  assert.ok(sf.mapping.some((m) => m.impl.startsWith('secretflow.') && m.source === 'native'));
  assert.ok(sf.mapping.some((m) => m.source === 'adapter'), '隐语缺的能力由适配器补齐');
  const ifaces = (x) => x.mapping.map((m) => m.iface);
  p.items.forEach((x) => assert.deepEqual(ifaces(x), ifaces(sf), '各实现暴露同一组平台接口'));
  const { created, done } = await jobsOf(okData);
  await okData('GET', '/projects/p2/fl/jobs');
  const r = await okData('PUT', '/dp/provider', { provider: 'opacus', project_id: P });
  assert.equal(r.current, 'opacus');
  // 只作用于本项目待启动 / 失败 / 已终止任务（D40）
  assert.deepEqual(r.affected_job_ids, [created.job_id]);
  assert.equal(r.affected_jobs, 1);
  assert.deepEqual(r.kept_finished.map((x) => x.job_id), [done.job_id]);
  assert.equal((await okData('GET', `/fl/jobs/${created.job_id}/dp`)).provider, 'opacus');
  assert.equal((await okData('GET', `/fl/jobs/${done.job_id}/dp`)).provider, 'secretflow-native', '已完成任务保留训练时实现');
  assert.equal((await okData('GET', '/dp/providers?project_id=p1')).current, 'opacus');
  assert.equal((await okData('GET', '/dp/providers?project_id=p2')).current, 'secretflow-native', '其他项目不受影响');
  const p2 = (await okData('GET', '/projects/p2/fl/jobs')).items;
  for (const j of p2) assert.equal((await okData('GET', `/fl/jobs/${j.job_id}/dp`)).provider, 'secretflow-native');
  // 已完成任务重置后回到待启动，跟随项目当前实现
  await okData('POST', `/fl/jobs/${done.job_id}/actions`, { action: 'reset' });
  assert.equal((await okData('GET', `/fl/jobs/${done.job_id}/dp`)).provider, 'opacus');
  assert.equal(await errCode('PUT', '/dp/provider', { provider: 'opacus' }), 40000);
  assert.equal(await errCode('PUT', '/dp/provider', { provider: 'pydp' }), 40000);
});

test('[DP-FW-02] DP 初始化：启用 DP 的任务启动后 hook 链在聚合前逐轮调用；未启用时 DP 步骤跳过', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const { created } = await jobsOf(okData);
  const id = created.job_id;
  let h = await okData('GET', `/fl/jobs/${id}/dp/hooks`);
  assert.equal(h.initialized, false);
  assert.equal(h.hook_point, 'before_aggregate');
  assert.deepEqual(h.steps.map((s) => s.key), ['load', 'train', 'clip', 'noise', 'agg', 'account']);
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 4);
  h = await okData('GET', `/fl/jobs/${id}/dp/hooks`);
  assert.equal(h.initialized, true);
  const byKey = Object.fromEntries(h.steps.map((s) => [s.key, s]));
  assert.equal(byKey.clip.calls, 4 * h.trainers);
  assert.equal(byKey.agg.calls, 4);
  assert.equal(byKey.noise.status, 'active');
  // 本次运行结束后关 DP 不改写本次运行的 hook 记录；重置后再启动则裁剪 / 加噪 / 记账跳过
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'terminate' });
  await okData('PUT', `/fl/jobs/${id}/dp`, { ...GAUSS, enabled: false });
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp/hooks`)).dp_enabled, true);
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'reset' });
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 2);
  h = await okData('GET', `/fl/jobs/${id}/dp/hooks`);
  assert.equal(h.steps.find((s) => s.key === 'train').calls, 2 * h.trainers);
  assert.equal(h.steps.find((s) => s.key === 'clip').calls, 0);
  assert.equal(h.dp_enabled, false);
  assert.deepEqual(h.steps.filter((s) => s.status === 'skipped').map((s) => s.key), ['clip', 'noise', 'account']);
  assert.equal(await errCode('GET', '/fl/jobs/fl_none/dp/hooks'), 40400);
});

test('[DP-EVAL-01][DP-FW-02] SSE round_completed 的 ε 与 DP 页同一会计方式；默认配置效用损失 ≤ 3 个百分点', async (t) => {
  const { okData, M, tick } = boot(t);
  const { created } = await jobsOf(okData);
  const id = created.job_id;
  const cfg = await okData('GET', `/fl/jobs/${id}/dp`);
  const est = await okData('POST', '/dp/estimate', { ...cfg, baseline_job_id: id });
  assert.equal(est.accountant, 'rdp');
  assert.ok(est.accuracy_loss <= 0.03, `默认配置效用损失 ${est.accuracy_loss}`);
  const seen = [];
  M.subscribe(`/fl/jobs/${id}/events`, { round_completed: (e) => seen.push(e.dp) });
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 4);
  const b = await okData('GET', `/fl/jobs/${id}/dp/budget`);
  const a = await okData('GET', `/fl/jobs/${id}/dp/audit`);
  assert.equal(seen.length, 4);
  assert.equal(seen[3].accountant, 'rdp');
  assert.equal(seen[3].epsilon_used, a.items[0].epsilon_cumulative);
  assert.equal(seen[3].epsilon_spent, a.items[0].epsilon_spent);
  assert.ok(Math.abs(seen[3].epsilon_used - b.epsilon_used) < 1e-3);
});

test('[DP-MECH-03] 启用自适应裁剪后仍以原固定 C 为对照；自适应不占优时如实给出噪声增加（D15）', async (t) => {
  const { okData } = boot(t);
  const { created } = await jobsOf(okData);
  const id = created.job_id;
  const before = await okData('POST', '/dp/adaptive-noise', { target: 'gradient', job_id: id });
  assert.equal(before.fixed_clip_norm, 1);
  assert.ok(before.summary.noise_reduction_pct > 0 && before.summary.adaptive_better);
  await okData('PUT', `/fl/jobs/${id}/dp`, { ...GAUSS, accountant: 'rdp', clip_norm: before.recommended_clip_norm, clip_mode: 'adaptive' });
  const after = await okData('POST', '/dp/adaptive-noise', { target: 'gradient', job_id: id });
  assert.equal(after.fixed_clip_norm, 1, '对照仍是启用前的固定 C');
  assert.equal(after.initial_clip_norm, before.recommended_clip_norm);
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp`)).clip_norm, after.initial_clip_norm, '写入的初始 C 与对比卡一致（D38）');
  assert.ok(after.summary.noise_reduction_pct > 0);
  // 再切回固定裁剪：对照清空为当前 C
  await okData('PUT', `/fl/jobs/${id}/dp`, { ...GAUSS, accountant: 'rdp', clip_norm: 0.3, clip_mode: 'fixed' });
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp`)).clip_norm_fixed, null);
  // 固定 C 很小时自适应 C（中位数）更大，噪声增加：adaptive_better = false，百分比为负，界面改写为「噪声增加」
  const worse = await okData('POST', '/dp/adaptive-noise', { target: 'gradient', job_id: id });
  assert.equal(worse.summary.adaptive_better, false);
  assert.ok(worse.summary.noise_reduction_pct < 0);
});

test('[DP-EVAL-01][DP-EVAL-02] 时序任务按 metrics_spec 展示 RMSE / MAE（越低越好），平衡分析同口径（D16）', async (t) => {
  const { okData } = boot(t);
  const { created, done } = await jobsOf(okData);
  assert.equal(done.task_type, 'timeseries');
  const cfg = await okData('GET', `/fl/jobs/${done.job_id}/dp`);
  const e = await okData('POST', '/dp/estimate', { ...cfg, baseline_job_id: done.job_id });
  assert.equal(e.task_type, 'timeseries');
  assert.equal(e.estimated_accuracy, null);
  assert.deepEqual(e.metrics.map((m) => m.key), ['rmse', 'mae']);
  e.metrics.forEach((m) => { assert.equal(m.better, 'lower'); assert.ok(m.estimated >= m.baseline); });
  assert.ok(e.metrics[0].change_pct <= 10, `默认配置 RMSE 增幅 ${e.metrics[0].change_pct}%`);
  assert.ok(e.curve.every((p) => p.estimated_rmse > 0 && p.estimated_accuracy === null));
  // 噪声越大误差越大
  const basic = await okData('POST', '/dp/estimate', { ...cfg, accountant: 'basic', baseline_job_id: done.job_id });
  assert.ok(basic.metrics[0].estimated > e.metrics[0].estimated);
  const tr = await okData('POST', '/dp/tradeoff', { ...cfg, baseline_job_id: done.job_id });
  assert.equal(tr.metric.key, 'rmse');
  assert.match(tr.rule, /RMSE/);
  const vals = tr.points.map((p) => p.metric_value);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] <= vals[i - 1]);
  assert.equal(tr.recommended_epsilon, tr.points.find((p) => p.metric_change_pct <= 10).epsilon_total);
  // 分类任务仍是 Accuracy
  const c = await okData('POST', '/dp/estimate', { ...GAUSS, total_rounds: 30, baseline_job_id: created.job_id });
  assert.equal(c.primary_metric, 'accuracy');
  assert.equal(c.metrics[0].estimated, c.estimated_accuracy);
});

test('[DP-FW-03] DP 指标：每轮裁剪比例、噪声 L2 范数、信噪比与噪声直方图', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const { created } = await jobsOf(okData);
  const id = created.job_id;
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp/metrics`)).summary, null);
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 5);
  const m = await okData('GET', `/fl/jobs/${id}/dp/metrics`);
  assert.equal(m.rounds.length, 5);
  m.rounds.forEach((r) => assert.ok(r.clip_ratio >= 0 && r.clip_ratio <= 1));
  // 高斯：‖n‖₂ = σ·√d
  assert.equal(m.summary.model_dim, 2176, 'XGBoost 维度取内核 MODEL_PARAMS');
  assert.ok(Math.abs(m.summary.noise_l2_last - m.summary.noise_scale * Math.sqrt(m.summary.model_dim)) < 0.5);
  assert.equal(m.histogram.length, 21);
  assert.equal(m.histogram.reduce((s, h) => s + h.count, 0) <= m.histogram_samples, true);
  const peak = m.histogram.reduce((a, b) => (b.count > a.count ? b : a));
  assert.ok(Math.abs(peak.x) < 0.6, '高斯噪声抽样峰值在 0 附近');
  assert.deepEqual(await okData('GET', `/fl/jobs/${id}/dp/metrics`), m, '同输入同输出');
  assert.equal(await errCode('GET', `/fl/jobs/${id}/dp/metrics?bins=3`), 40003);
});

test('[DP-FW-04] 端到端工作流：配置 → 初始化检查 → 启动 → 预算记账；不可启动任务检查不通过', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const { created, done } = await jobsOf(okData);
  const id = created.job_id;
  await okData('PUT', `/fl/jobs/${id}/dp`, { ...GAUSS, accountant: 'rdp', epsilon_total: 3 });
  const chk = await okData('POST', `/fl/jobs/${id}/dp/init-check`);
  assert.equal(chk.ok, true);
  assert.deepEqual(chk.checks.map((c) => c.key), ['enabled', 'params', 'provider', 'calibration', 'aggregation', 'nodes', 'status']);
  await okData('POST', `/fl/jobs/${id}/actions`, { action: 'start' });
  tick(650 * 31);
  const b = await okData('GET', `/fl/jobs/${id}/dp/budget`);
  assert.equal(b.exhausted, true);
  assert.ok(Math.abs(b.epsilon_used - 3) < 1e-3, 'RDP 记账：跑满 30 轮恰好用完总预算');
  assert.equal((await okData('GET', `/fl/jobs/${id}/dp/audit`)).total, 30);

  const bad = await okData('POST', `/fl/jobs/${done.job_id}/dp/init-check`);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find((c) => c.key === 'status').pass, false);
  await okData('PUT', `/fl/jobs/${done.job_id}/dp`, { ...GAUSS, enabled: false });
  assert.equal((await okData('POST', `/fl/jobs/${done.job_id}/dp/init-check`)).checks.find((c) => c.key === 'enabled').pass, false);
  assert.equal(await errCode('POST', '/fl/jobs/fl_none/dp/init-check'), 40400);
});
