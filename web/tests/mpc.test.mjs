// 多方安全计算：协议管理（MPC-PROTO-01..07）+ 运维监控（MPC-OPS-01..05）
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const ROLES3 = [
  { party_id: 'party-a', roles: ['input', 'compute'] },
  { party_id: 'party-b', roles: ['input', 'compute'] },
  { party_id: 'party-c', roles: ['compute', 'output'] }
];
const FLOW = [
  { operator: 'secure_sum', protocol: 'ss' },
  { operator: 'secure_mean', protocol: 'ss' },
  { operator: 'secure_compare', protocol: 'gc', operand: { cmp: 'gt', threshold: 1880000 } }
];

async function createTask(okData, body) {
  return okData('POST', '/projects/p1/mpc/tasks', Object.assign({ steps: FLOW, parties: ROLES3, data_rows: 1200000 }, body || {}));
}

test('[MPC-PROTO-01] 秘密共享协议：目录含原理 / 安全模型 / 求积求均值算子，试运行份额可还原、不含明文', async (t) => {
  const { okData, errCode } = boot(t);
  const cat = await okData('GET', '/mpc/protocols');
  const ss = cat.protocols.find((p) => p.protocol === 'ss');
  assert.ok(ss.principle.length > 20 && ss.rounds_note.length > 10);
  assert.deepEqual(ss.security_models.map((s) => s.key), ['semi_honest', 'malicious']);
  assert.ok(ss.operators.includes('secure_product') && ss.operators.includes('secure_mean'));

  const run = await okData('POST', '/projects/p1/mpc/flows/dry-run', {
    steps: [{ operator: 'secure_mean', protocol: 'ss' }], parties: ROLES3
  });
  // 3 个计算方各持一份；Σ 份额 mod 2^64 = round(x · 2^16)
  const inp = run.inputs[0];
  assert.equal(inp.shares.length, 3);
  const sum = inp.shares.reduce((s, h) => (s + BigInt('0x' + h.values[0])) % (1n << 64n), 0n);
  const x = Number(sum) / 65536;
  assert.ok(x > 600000 && x < 700000, 'reconstructed ' + x);
  assert.ok(!JSON.stringify(run.inputs).includes(String(Math.round(x))), '输入区不应出现明文');
  assert.equal(run.result.type, 'vector');
  assert.equal(run.result.value.length, 4);
  assert.deepEqual(run.result.revealed_to, ['party-c']);

  // 失败：秘密共享不支持安全比较
  assert.equal(await errCode('POST', '/projects/p1/mpc/flows/dry-run', {
    steps: [{ operator: 'secure_compare', protocol: 'ss' }], parties: ROLES3
  }), 40001);
});

test('[MPC-PROTO-02] 混淆电路协议：安全比较（百万富翁）+ 逻辑运算，Free-XOR / 半门影响通信量', async (t) => {
  const { okData, errCode, call } = boot(t);
  const cat = await okData('GET', '/mpc/protocols');
  const gc = cat.protocols.find((p) => p.protocol === 'gc');
  assert.ok(gc.operators.includes('secure_compare') && gc.operators.includes('logic_op'));
  assert.equal(gc.default_params.free_xor, true);
  assert.equal(gc.default_params.half_gates, true);

  const steps = [{ operator: 'secure_compare', protocol: 'gc' }, { operator: 'logic_op', protocol: 'gc', operand: { mode: 'or' } }];
  const run = await okData('POST', '/projects/p1/mpc/flows/dry-run', { steps, parties: ROLES3 });
  assert.equal(run.result.type, 'bool');
  assert.equal(typeof run.result.value, 'boolean');
  assert.match(run.inputs[0].share_kind, /导线标签/);

  const on = await okData('POST', '/projects/p1/mpc/estimate', { steps, party_count: 3, data_rows: 100000 });
  const off = await okData('POST', '/projects/p1/mpc/estimate', { steps, party_count: 3, data_rows: 100000, params: { gc: { free_xor: false, half_gates: false } } });
  assert.ok(off.est_comm_bytes > on.est_comm_bytes, '关闭 Free-XOR / 半门后通信量应增加');

  // 失败：逻辑运算不能作用于各方原始数据；AND 不能作用于单个布尔值
  assert.equal(await errCode('POST', '/projects/p1/mpc/flows/dry-run', { steps: [{ operator: 'logic_op', protocol: 'gc' }], parties: ROLES3 }), 40000);
  const r = await call('POST', '/projects/p1/mpc/flows/dry-run', { steps: [
    { operator: 'secure_sum', protocol: 'ss' }, { operator: 'secure_mean', protocol: 'ss' },
    { operator: 'secure_compare', protocol: 'gc', operand: { threshold: 1 } }, { operator: 'logic_op', protocol: 'gc', operand: { mode: 'and' } }
  ], parties: ROLES3 });
  assert.equal(r.code, 40000);
  assert.match(r.message, /只能做 NOT/);
});

test('[MPC-PROTO-03] 不经意传输扩展：向量 OT 取第 i 行，轮数随扩展批大小变化', async (t) => {
  const { okData, errCode } = boot(t);
  const steps = [{ operator: 'vector_ot', protocol: 'ot', operand: { index: 2 } }];
  const run = await okData('POST', '/projects/p1/mpc/flows/dry-run', { steps, parties: ROLES3 });
  assert.equal(run.result.type, 'vector');
  assert.equal(run.result.value.length, 2, '两个输入方各取第 2 行');
  assert.match(run.inputs[0].share_kind, /OT 掩码/);

  const big = await okData('POST', '/projects/p1/mpc/estimate', { steps, data_rows: 1000000, params: { ot: { batch_size: 1048576 } } });
  const small = await okData('POST', '/projects/p1/mpc/estimate', { steps, data_rows: 1000000, params: { ot: { batch_size: 1024 } } });
  assert.equal(big.rounds, 3 + 2 * 1);
  assert.equal(small.rounds, 3 + 2 * Math.ceil(1000000 / 1024));

  // 失败：行号越界 / 非整数
  assert.equal(await errCode('POST', '/projects/p1/mpc/flows/dry-run', { steps: [{ operator: 'vector_ot', protocol: 'ot', operand: { index: 9 } }], parties: ROLES3 }), 40003);
  assert.equal(await errCode('POST', '/projects/p1/mpc/flows/dry-run', { steps: [{ operator: 'vector_ot', protocol: 'ot', operand: { index: 1.5 } }], parties: ROLES3 }), 40002);
});

test('[MPC-PROTO-04] 基础算子组合：求和 → 求均值 → 阈值比较，结果仅输出方可见；兼容性 / 类型校验', async (t) => {
  const { okData, call } = boot(t);
  const run = await okData('POST', '/projects/p1/mpc/flows/dry-run', { steps: FLOW, parties: ROLES3 });
  assert.deepEqual(run.steps.map((s) => [s.in_type, s.out_type]), [['parties', 'vector'], ['vector', 'scalar'], ['scalar', 'bool']]);
  assert.deepEqual(run.steps.map((s) => s.visibility), ['secret', 'secret', 'revealed_to_output']);
  assert.equal(typeof run.result.value, 'boolean');
  // 同输入同输出
  const again = await okData('POST', '/projects/p1/mpc/flows/dry-run', { steps: FLOW, parties: ROLES3 });
  assert.deepEqual(again, run);

  // 预估里出现 A2Y 份额转换
  const est = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, parties: ROLES3 });
  assert.ok(est.steps.some((s) => /A2Y/.test(s.name)));

  // 创建任务后可在任务详情里看到完整流程
  const task = await createTask(okData);
  assert.deepEqual(task.steps.map((s) => s.operator), ['secure_sum', 'secure_mean', 'secure_compare']);
  assert.deepEqual(task.protocols, ['ss', 'gc']);

  // 失败：混淆电路不支持求均值（40001）；比较缺阈值（40002）；超过 8 步（40000）
  let r = await call('POST', '/projects/p1/mpc/tasks', { steps: [{ operator: 'secure_mean', protocol: 'gc' }], parties: ROLES3 });
  assert.equal(r.code, 40001);
  assert.match(r.message, /第 1 步/);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: [FLOW[0], FLOW[1], { operator: 'secure_compare', protocol: 'gc' }], parties: ROLES3 });
  assert.equal(r.code, 40002);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: Array(9).fill(FLOW[0]), parties: ROLES3 });
  assert.equal(r.code, 40000);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: [], parties: ROLES3 });
  assert.equal(r.code, 40000);
});

test('[MPC-PROTO-05] 3 方计算：≥3 方、角色可动态配置，缺角色 / 少于 3 方拒绝', async (t) => {
  const { okData, call } = boot(t);
  const pool = await okData('GET', '/projects/p1/mpc/parties');
  assert.equal(pool.min_parties, 3);
  assert.ok(pool.items.length >= 4);
  assert.ok(pool.items.every((p) => /^node-/.test(p.node_id)));

  // 4 方，D 只做输入方
  const four = ROLES3.concat([{ party_id: 'party-d', roles: ['input'] }]);
  const task = await createTask(okData, { parties: four });
  assert.equal(task.parties.length, 4);
  assert.deepEqual(task.parties[3].roles, ['input']);
  // 兼容单角色字段 role
  const legacy = await okData('POST', '/projects/p1/mpc/tasks', {
    protocol: 'ot', operator: 'vector_ot',
    parties: [{ party_id: 'party-a', role: 'input' }, { party_id: 'party-b', role: 'compute' }, { party_id: 'party-c', role: 'output' }]
  });
  assert.deepEqual(legacy.parties.map((p) => p.role), ['input', 'compute', 'output']);

  let r = await call('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: ROLES3.slice(0, 2) });
  assert.equal(r.code, 40000);
  assert.match(r.message, /至少需要 3 个参与方/);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: ROLES3.map((p) => ({ party_id: p.party_id, roles: ['input', 'compute'] })) });
  assert.equal(r.code, 40000);
  assert.match(r.message, /输出方/);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: [ROLES3[0], ROLES3[0], ROLES3[2]] });
  assert.equal(r.code, 40000);
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: ROLES3.concat([{ party_id: 'party-z', roles: ['input'] }]) });
  assert.equal(r.code, 40400);
  // 秘密共享需要 ≥2 个计算方
  r = await call('POST', '/projects/p1/mpc/tasks', { steps: [FLOW[0]], parties: [
    { party_id: 'party-a', roles: ['input'] }, { party_id: 'party-b', roles: ['compute'] }, { party_id: 'party-c', roles: ['output'] }] });
  assert.equal(r.code, 40000);
  assert.match(r.message, /至少 2 个计算方/);
});

test('[MPC-PROTO-06] 参数默认配置：默认值、自定义保存、恢复默认、范围校验', async (t) => {
  const { okData, errCode } = boot(t);
  const all = await okData('GET', '/projects/p1/mpc/params');
  const ss = all.items.find((x) => x.protocol === 'ss');
  assert.deepEqual(ss.params, { ring_bits: 64, frac_bits: 16, security_model: 'semi_honest' });
  assert.equal(ss.customized, false);
  const ot = all.items.find((x) => x.protocol === 'ot');
  assert.equal(ot.params.base_ot_count, 128);
  assert.equal(ot.params.batch_size, 65536);

  const saved = await okData('PUT', '/projects/p1/mpc/params/ss', { params: { ring_bits: 128, frac_bits: 24 } });
  assert.equal(saved.customized, true);
  assert.equal(saved.params.ring_bits, 128);
  // 保存后创建任务默认采用自定义值
  const task = await createTask(okData);
  assert.equal(task.params.ss.ring_bits, 128);
  // 只影响本项目
  const p2 = await okData('GET', '/projects/p2/mpc/params');
  assert.equal(p2.items.find((x) => x.protocol === 'ss').params.ring_bits, 64);

  const reset = await okData('DELETE', '/projects/p1/mpc/params/ss');
  assert.equal(reset.customized, false);
  assert.equal(reset.params.ring_bits, 64);

  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/ss', { params: { ring_bits: 48 } }), 40002);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/ss', { params: { ring_bits: 32, frac_bits: 20 } }), 40003);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/ot', { params: { base_ot_count: 64 } }), 40003);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/ot', { params: { batch_size: 2000000 } }), 40003);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/gc', { params: { free_xor: 'yes' } }), 40002);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/gc', { params: { foo: 1 } }), 40000);
  assert.equal(await errCode('PUT', '/projects/p1/mpc/params/xx', { params: {} }), 40400);
});

test('[MPC-PROTO-07] 性能预估：随参与方数 / 数据规模单调增长，给出公式与单位', async (t) => {
  const { okData, errCode } = boot(t);
  const base = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, party_count: 3, data_rows: 1200000 });
  const moreRows = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, party_count: 3, data_rows: 2400000 });
  const moreParties = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, party_count: 5, data_rows: 1200000 });
  assert.ok(moreRows.est_compute_sec > base.est_compute_sec);
  assert.ok(moreRows.est_comm_mb > base.est_comm_mb);
  assert.ok(moreParties.est_comm_mb > base.est_comm_mb);
  assert.equal(base.est_comm_mb, Math.round(base.est_comm_bytes / 1048576 * 100) / 100);
  assert.ok(base.formula.comm_time.includes('RTT'));
  assert.equal(base.assumptions.bandwidth_mbps, 100);
  // 带宽翻倍，传输时间减半
  const fast = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, party_count: 3, data_rows: 1200000, bandwidth_mbps: 200 });
  assert.ok(Math.abs(fast.comm_breakdown.transfer_sec - base.comm_breakdown.transfer_sec / 2) < 0.02);
  // 兼容内核 4.1 的 GET 形态
  const legacy = await okData('GET', '/projects/p1/mpc/estimate?protocol=ss');
  assert.deepEqual(legacy.operators.map((o) => o.key), ['secure_sum', 'secure_product', 'secure_mean']);
  assert.equal(legacy.party_count, 3);
  assert.ok(legacy.est_compute_sec > 0 && legacy.est_comm_sec > 0);

  // 输入分享只计输入方发出的份额：A / B 输入 + 计算，C 计算 + 输出 → 2 × (3 − 1) × 8 × m
  const byRole = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, parties: ROLES3, data_rows: 1200000 });
  const share = (r) => r.steps.find((s) => s.name === '输入分享').bytes;
  assert.equal(share(byRole), 2 * 2 * 8 * 1200000);
  // 再加只做输入方的 D：D 不兼任计算方，要发出全部 3 份 → (2 × 2 + 3) × 8 × m
  const withD = await okData('POST', '/projects/p1/mpc/estimate', { steps: FLOW, parties: ROLES3.concat([{ party_id: 'party-d', roles: ['input'] }]), data_rows: 1200000 });
  assert.equal(share(withD), (2 * 2 + 3) * 8 * 1200000);
  assert.match(byRole.steps[0].formula, /只有输入方发送份额/);
  // 任务详情里的预估与按角色口径一致
  const task = await createTask(okData);
  assert.equal(task.estimate.est_comm_mb, byRole.est_comm_mb);
  assert.equal(await errCode('POST', '/projects/p1/mpc/estimate', { steps: FLOW, parties: ROLES3.map((p) => ({ party_id: p.party_id, roles: ['output'] })) }), 40000);
  assert.equal(await errCode('POST', '/projects/p1/mpc/estimate', { steps: FLOW, party_count: 2 }), 40000);
  assert.equal(await errCode('POST', '/projects/p1/mpc/estimate', { steps: FLOW, data_rows: 0 }), 40003);
  assert.equal(await errCode('POST', '/projects/p1/mpc/estimate', { steps: FLOW, data_rows: 'abc' }), 40002);
  assert.equal(await errCode('POST', '/projects/p1/mpc/estimate', { steps: FLOW, bandwidth_mbps: 0 }), 40003);
  assert.equal(await errCode('GET', '/projects/p1/mpc/estimate?protocol=gc&operator=secure_mean'), 40001);
});

test('[MPC-OPS-01][MPC-OPS-02][MPC-OPS-03] 实时监控：每方通信量、计算耗时、轮次交互数随执行递增；停止 / 继续 / 重置', async (t) => {
  const { okData, errCode, M, tick } = boot(t);
  const task = await createTask(okData);
  assert.equal(task.status, 'running');
  // [D35] 编号日期按 UTC+8：与 created_at 换算到 +08:00 后的日期一致
  const local = new Date(Date.parse(task.created_at) + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
  assert.match(task.task_id, new RegExp('^mpc-' + local + '-\\d{2}$'));
  assert.ok(task.parties.every((p) => p.comm_bytes === 0 && p.compute_sec === 0 && p.interaction_rounds === 0));
  const seen = [];
  const sub = M.subscribe('/mpc/tasks/' + task.task_id + '/events', { metrics: (ev) => seen.push(ev) });
  tick(420 * 6);
  sub.close();
  assert.equal(seen.length, 6);
  const mid = await okData('GET', '/mpc/tasks/' + task.task_id);
  assert.ok(mid.parties.every((p) => p.comm_bytes > 0 && p.compute_sec > 0 && p.interaction_rounds > 0));
  assert.ok(seen[5].parties[0].comm_bytes > seen[0].parties[0].comm_bytes);
  assert.equal(mid.summary.total_comm_bytes, mid.parties.reduce((s, p) => s + p.comm_bytes, 0));
  assert.equal(mid.progress_pct, 20);

  const stopped = await okData('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'stop' });
  assert.equal(stopped.status, 'stopped');
  // 停止后参与方状态跟随任务为 stopped（降级节点 C 仍标异常），累计指标保留不清零
  assert.ok(stopped.parties.filter((p) => p.party_id !== 'party-c').every((p) => p.status === 'stopped'));
  assert.ok(stopped.parties.every((p) => p.status !== 'finished'));
  assert.deepEqual(stopped.parties.map((p) => p.comm_bytes), mid.parties.map((p) => p.comm_bytes));
  tick(420 * 5);
  assert.equal((await okData('GET', '/mpc/tasks/' + task.task_id)).progress_pct, 20, '停止后不再推进');
  await okData('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'start' });
  tick(420 * 40);
  const done = await okData('GET', '/mpc/tasks/' + task.task_id);
  assert.equal(done.status, 'finished');
  assert.equal(done.progress_pct, 100);
  assert.equal(done.parties[0].interaction_rounds, done.estimate.rounds);

  assert.equal(await errCode('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'start' }), 40901);
  assert.equal(await errCode('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'stop' }), 40901);
  assert.equal(await errCode('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'jump' }), 40000);
  assert.equal(await errCode('GET', '/mpc/tasks/mpc-nope'), 40400);
  const reset = await okData('POST', '/mpc/tasks/' + task.task_id + '/actions', { action: 'reset' });
  assert.equal(reset.status, 'pending');
  assert.equal(reset.parties[0].comm_bytes, 0);
});

test('[MPC-OPS-04] 异常节点检测：偏离均值超过 50% 告警并高亮；排除降级节点后无告警；阈值可配', async (t) => {
  const { okData, errCode, M, tick } = boot(t);
  const task = await createTask(okData);
  const alarms = [];
  const sub = M.subscribe('/mpc/tasks/' + task.task_id + '/events', { alarm_raised: (a) => alarms.push(a) });
  tick(420 * 4);
  assert.equal(alarms.length, 0, '前 4 个心跳不判定');
  tick(420 * 2);
  sub.close();
  const v = await okData('GET', '/mpc/tasks/' + task.task_id);
  const c = v.parties.find((p) => p.party_id === 'party-c');
  assert.equal(c.status, 'abnormal');
  assert.ok(c.comm_deviation_pct > 50);
  const al = v.alarms.find((a) => a.type === 'comm_anomaly');
  assert.equal(al.party_id, 'party-c');
  assert.equal(al.node_id, 'node-ganzhou-03');
  assert.equal(al.threshold_pct, 50);
  assert.ok(al.ratio_to_mean > 1.5);
  assert.match(al.message, /偏离 \+\d+\.\d%/);
  assert.ok(v.alarms.some((a) => a.type === 'compute_anomaly'));
  assert.ok(alarms.length > 0);
  // 正常节点不告警
  assert.ok(v.parties.filter((p) => p.party_id !== 'party-c').every((p) => p.status === 'running'));

  // 换成 A / B / D（不含降级节点）→ 无告警
  const clean = await createTask(okData, { parties: [ROLES3[0], ROLES3[1], { party_id: 'party-d', roles: ['compute', 'output'] }] });
  tick(420 * 10);
  const cv = await okData('GET', '/mpc/tasks/' + clean.task_id);
  assert.equal(cv.alarms.length, 0);
  assert.ok(cv.parties.every((p) => Math.abs(p.comm_deviation_pct) <= 50));

  // 阈值调到 200%，降级节点也不告警
  const loose = await createTask(okData, { anomaly_threshold_pct: 200 });
  tick(420 * 10);
  assert.equal((await okData('GET', '/mpc/tasks/' + loose.task_id)).alarms.length, 0);
  assert.equal(await errCode('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: ROLES3, anomaly_threshold_pct: 5 }), 40003);
});

test('[MPC-OPS-05] 历史任务：按协议 / 时间筛选、两任务对比、导出报表', async (t) => {
  const { okData, errCode, download, tick } = boot(t);
  const all = await okData('GET', '/projects/p1/mpc/tasks');
  assert.equal(all.total, 6);
  assert.ok(all.items.every((x) => x.status === 'finished' && x.total_comm_bytes > 0 && x.total_duration_sec > 0));
  // 时间倒序
  assert.ok(all.items[0].finished_at > all.items[5].finished_at);

  const gc = await okData('GET', '/projects/p1/mpc/tasks?protocol=gc');
  assert.ok(gc.total >= 3 && gc.items.every((x) => x.protocols.includes('gc')));
  const oct = await okData('GET', '/projects/p1/mpc/tasks?start_time=2026-10-01&end_time=2026-10-31');
  assert.equal(oct.total, 3);
  assert.ok(oct.items.every((x) => x.finished_at.startsWith('2026-10')));

  // 新跑完的任务进入历史
  await createTask(okData);
  tick(420 * 40);
  assert.equal((await okData('GET', '/projects/p1/mpc/tasks')).total, 7);
  assert.ok((await okData('GET', '/projects/p1/mpc/tasks?status=all')).total >= 7);

  const a = all.items[0].task_id, b = all.items[4].task_id;
  const cmp = await okData('GET', '/projects/p1/mpc/tasks/compare?task_ids=' + a + ',' + b);
  assert.equal(cmp.tasks.length, 2);
  const comm = cmp.metrics.find((m) => m.key === 'total_comm_bytes');
  assert.equal(comm.unit, 'MB');
  assert.equal(comm.values[0], Math.round(cmp.tasks[0].total_comm_bytes / 1048576 * 10) / 10);
  assert.ok(cmp.metrics.some((m) => m.key === 'sec_per_10k'));

  const file = await download('/projects/p1/mpc/reports/export?format=csv&protocol=ss');
  assert.match(file.fileName, /\.csv$/);
  const lines = file.content.trim().split('\n');
  assert.match(lines[0], /总通信量\(MB\)/);
  assert.equal(lines.length - 1, (await okData('GET', '/projects/p1/mpc/tasks?protocol=ss')).total);
  assert.match(lines[0], /开始时间\(UTC\+8\),结束时间\(UTC\+8\)/);
  assert.match(lines[1], /,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00,已结束$/);
  assert.ok(!/finished|T\d{2}:\d{2}|Z,/.test(file.content), '导出不含英文状态码与 ISO/UTC 时间');
  // 对比报表：按勾选顺序 b, a 请求，CSV 的任务顺序与差异方向和界面（compare 接口）一致
  const ui = await okData('GET', '/projects/p1/mpc/tasks/compare?task_ids=' + b + ',' + a);
  const cfile = await download('/projects/p1/mpc/reports/export?format=csv&task_ids=' + b + ',' + a);
  const cl = cfile.content.trim().split('\n');
  assert.ok(cl[1].startsWith(b + ',') && cl[2].startsWith(a + ','), '明细行按 A / B 顺序');
  assert.match(cfile.content, new RegExp('对比指标,单位,任务 A：' + b + ',任务 B：' + a));
  const commRow = cl.find((x) => x.startsWith('总通信量,'));
  const uiComm = ui.metrics.find((m) => m.key === 'total_comm_bytes');
  assert.equal(commRow, ['总通信量', 'MB', uiComm.values[0], uiComm.values[1], uiComm.diff_pct].join(','));
  assert.match(cfile.content, /秘密共享 \+ 混淆电路|秘密共享|混淆电路/);
  assert.ok(!/,ss|,gc|,ot|\+gc/.test(cfile.content));

  // 失败：对比数量不对 / 任务不存在 / 日期格式错 / 起止颠倒 / 历史任务只读
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks/compare?task_ids=' + a), 40000);
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks/compare?task_ids=' + a + ',' + a), 40000);
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks/compare?task_ids=' + a + ',mpc-x'), 40400);
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks?start_time=2026/10/01'), 40002);
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks?start_time=2026-10-31&end_time=2026-10-01'), 40000);
  assert.equal(await errCode('GET', '/projects/p1/mpc/tasks?protocol=zz'), 40000);
  assert.equal(await errCode('POST', '/mpc/tasks/' + a + '/actions', { action: 'reset' }), 40901);
  // 换项目：p2 历史独立
  const p2 = await okData('GET', '/projects/p2/mpc/tasks');
  assert.ok(p2.items.every((x) => !x.task_id.includes('-p1')));
});

test('[MPC-OPS-05] [D35] 任务编号日期按 UTC+8：UTC 17:30 创建的任务编号取次日', async (t) => {
  const { okData, call } = boot(t);
  // 沙箱与本 realm 共用 Date，把「当前时间」固定为 UTC 2026-10-23T17:30Z（= UTC+8 10-24 01:30）
  t.mock.method(Date.prototype, 'toISOString', () => '2026-10-23T17:30:00.000Z');
  const task = await createTask(okData);
  assert.match(task.task_id, /^mpc-20261024-\d{2}$/);
  // 失败路径：校验失败不消耗编号，也不产生任务
  const r = await call('POST', '/projects/p1/mpc/tasks', { steps: FLOW, parties: ROLES3.slice(0, 2) });
  assert.equal(r.code, 40000);
  const next = await createTask(okData);
  assert.equal(Number(next.task_id.slice(-2)), Number(task.task_id.slice(-2)) + 1);
});
