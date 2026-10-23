// 联邦学习 · 过程管控（FL-PROC-01 至 FL-PROC-08）mock 契约测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const NODES = ['node-shanghai-01', 'node-hangzhou-02', 'node-ganzhou-03', 'node-center-agg'];
const CLS_JOB = {
  task_type: 'classification', algorithm: 'xgb', aggregation: 'he', total_rounds: 10, node_ids: NODES,
  dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_a_user', 'ds_p1_b_user'] }
};
const TICK = 650;   // 内核每 650 ms 完成一轮聚合

async function newJob(okData, body) {
  await okData('GET', '/projects/p1/fl/jobs');
  return okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, ...body });
}
const act = (okData, id, action) => okData('POST', '/fl/jobs/' + id + '/actions', { action });

test('[FL-PROC-01] 任务状态机：六种状态可达，迁移记录完整，非法迁移返回 40901 与可执行动作', async (t) => {
  const { okData, call, tick } = boot(t);
  const job = await newJob(okData);
  assert.equal(job.status, 'Created');
  assert.deepEqual(job.allowed_actions, ['start', 'reset']);
  const bad = await call('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'pause' });
  assert.equal(bad.code, 40901);
  assert.deepEqual(bad.data.allowed_actions, ['start', 'reset']);

  assert.equal((await act(okData, job.job_id, 'start')).status, 'Running');
  assert.equal((await call('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'resume' })).code, 40901);
  assert.equal((await act(okData, job.job_id, 'pause')).status, 'Paused');
  assert.equal((await act(okData, job.job_id, 'resume')).status, 'Running');
  tick(TICK * 11);
  const done = await okData('GET', '/fl/jobs/' + job.job_id);
  assert.equal(done.status, 'Success');
  assert.deepEqual(done.allowed_actions, ['reset']);
  assert.equal((await call('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' })).code, 40901);
  assert.deepEqual(done.state_history.map((h) => h.from + '→' + h.to),
    ['null→Created', 'Created→Running', 'Running→Paused', 'Paused→Running', 'Running→Success']);

  // 节点心跳丢失 → Failed；Failed 可重新启动；任意可重置状态 → Created
  await act(okData, job.job_id, 'reset');
  await act(okData, job.job_id, 'start');
  tick(TICK * 2);
  await okData('PATCH', '/projects/p1/nodes/node-hangzhou-02', { online: false });
  const failed = await okData('GET', '/fl/jobs/' + job.job_id);
  assert.equal(failed.status, 'Failed');
  assert.match(failed.failure_reason, /node-hangzhou-02 心跳丢失/);
  assert.deepEqual(failed.allowed_actions, ['start', 'reset']);
  await okData('PATCH', '/projects/p1/nodes/node-hangzhou-02', { online: true });
  assert.equal((await act(okData, job.job_id, 'start')).status, 'Running');
  assert.equal((await act(okData, job.job_id, 'terminate')).status, 'Terminated');
  const seen = new Set((await okData('GET', '/fl/jobs/' + job.job_id)).state_history.map((h) => h.to));
  assert.deepEqual([...seen].sort(), ['Created', 'Failed', 'Paused', 'Running', 'Success', 'Terminated']);
  assert.equal((await call('PATCH', '/projects/p1/nodes/node-hangzhou-02', { online: 'no' })).code, 40000);
});

test('[FL-PROC-02] 任务启动：校验项目配置、节点可用性、算法兼容性，通过后为每个节点分配训练容器', async (t) => {
  const { M, okData, call } = boot(t);
  const job = await newJob(okData);
  // 节点离线
  await okData('PATCH', '/projects/p1/nodes/node-ganzhou-03', { online: false });
  const off = await call('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  assert.equal(off.code, 42201);
  assert.deepEqual(off.data.offline_node_ids, ['node-ganzhou-03']);
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id)).status, 'Created', '预检失败不改变状态');
  await okData('PATCH', '/projects/p1/nodes/node-ganzhou-03', { online: true });
  // 节点不足：两个训练节点改成聚合节点
  await okData('PATCH', '/projects/p1/nodes/node-shanghai-01', { role: 'aggregator' });
  await okData('PATCH', '/projects/p1/nodes/node-hangzhou-02', { role: 'aggregator' });
  const few = await call('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  assert.equal(few.code, 40000);
  assert.match(few.message, /参与节点不足/);
  await okData('PATCH', '/projects/p1/nodes/node-shanghai-01', { role: 'trainer', data_partition: 'part-A' });
  await okData('PATCH', '/projects/p1/nodes/node-hangzhou-02', { role: 'trainer', data_partition: 'part-B' });
  // 算法不兼容：自定义模型制品被移除
  const f = await okData('POST', '/files', { file: { name: 'm.pkl', size: 9000 }, purpose: 'fl_model', project_id: 'p1' });
  const custom = await newJob(okData, { algorithm: 'custom', model_file_id: f.file_id });
  delete M._db.files[f.file_id];
  const inc = await call('POST', '/fl/jobs/' + custom.job_id + '/actions', { action: 'start' });
  assert.equal(inc.code, 40000);
  assert.match(inc.message, /算法不兼容/);

  const started = await act(okData, job.job_id, 'start');
  assert.deepEqual(started.preflight.map((c) => c.item), ['项目配置', '节点可用性', '算法兼容性']);
  assert.ok(started.preflight.every((c) => c.passed));
  assert.equal(started.runtime.workers.length, 4);
  assert.ok(started.runtime.workers.every((w) => w.status === 'running' && /^flc-[0-9a-f]{12}$/.test(w.container_id) && w.pid > 0));
  assert.equal(started.runtime.workers.find((w) => w.role === 'aggregator').cpu_cores, 2);
});

test('[FL-PROC-03] 暂停与恢复：暂停时保存当前轮次断点，恢复后从断点继续，轮次不重复不丢失', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const job = await newJob(okData);
  await act(okData, job.job_id, 'start');
  tick(TICK * 4);
  const paused = await act(okData, job.job_id, 'pause');
  assert.equal(paused.checkpoint.round, 4);
  assert.match(paused.checkpoint.path, /round_004\.ckpt$/);
  assert.equal(paused.checkpoint.global_model_sha256.length, 64);
  assert.deepEqual(paused.checkpoint.node_cursors.map((c) => c.node_id), NODES.slice(0, 3));
  assert.ok(paused.runtime.workers.every((w) => w.status === 'suspended'));
  assert.equal(await errCode('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'pause' }), 40901);
  tick(TICK * 5);
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id)).current_round, 4, '暂停期间聚合循环中断');
  const resumed = await act(okData, job.job_id, 'resume');
  assert.equal(resumed.resumed_from_round, 4);
  assert.ok(resumed.runtime.workers.every((w) => w.status === 'running'));
  assert.equal(resumed.state_history.at(-1).reason, '从第 4 轮断点继续');
  tick(TICK * 2);
  const met = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics');
  assert.deepEqual(met.series[0].points.map((x) => x.round), [1, 2, 3, 4, 5, 6]);
  assert.equal(await errCode('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'resume' }), 40901);
});

test('[FL-PROC-04] 强制终止：停止训练、容器 SIGKILL 并释放资源，状态迁移到 Terminated', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const job = await newJob(okData);
  assert.equal(await errCode('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'terminate' }), 40901);
  await act(okData, job.job_id, 'start');
  tick(TICK * 3);
  const killed = await act(okData, job.job_id, 'terminate');
  assert.equal(killed.status, 'Terminated');
  assert.equal(killed.runtime.released, true);
  assert.ok(killed.runtime.workers.every((w) => w.status === 'killed' && w.released_at));
  assert.match(killed.state_history.at(-1).reason, /SIGKILL/);
  tick(TICK * 3);
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id)).current_round, 3);
  assert.equal(await errCode('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'terminate' }), 40901);
  // 终止后运行中任务数归零，节点可删除 / 改角色
  assert.equal((await okData('GET', '/projects/p1/nodes')).items.find((n) => n.node_id === 'node-shanghai-01').running_job_count, 0);
  const again = await act(okData, job.job_id, 'start');
  assert.equal(again.current_round, 0);
  assert.notEqual(again.runtime.workers[0].container_id, killed.runtime.workers[0].container_id);
});

test('[FL-PROC-05] 数据存储：每轮聚合后存储全局与各节点的 Loss / Accuracy（时序为 RMSE / MAE）', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const job = await newJob(okData);
  await act(okData, job.job_id, 'start');
  tick(TICK * 3);
  const met = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=nodes');
  assert.deepEqual(met.series.map((s) => s.key), ['global'].concat(NODES));
  for (const s of met.series) {
    assert.equal(s.points.length, 3);
    for (const pt of s.points) {
      assert.ok(pt.loss > 0 && pt.loss < 2 && pt.accuracy > 0.5 && pt.accuracy < 1, JSON.stringify(pt));
      assert.ok(pt.recorded_at);
    }
  }
  const ts = (await okData('GET', '/projects/p1/fl/jobs?task_type=timeseries')).items[0];
  const tm = await okData('GET', '/fl/jobs/' + ts.job_id + '/metrics?scope=nodes');
  assert.deepEqual(Object.keys(tm.series[1].points[0]).sort(), ['mae', 'recorded_at', 'rmse', 'round']);
  assert.equal(await errCode('GET', '/fl/jobs/fl_nope/metrics'), 40400);
  assert.equal(await errCode('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=all'), 40000);
});

test('[FL-PROC-06] 动态曲线：全局 / 各节点切换，横轴轮次可按区间截取', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const job = await newJob(okData);
  await act(okData, job.job_id, 'start');
  tick(TICK * 6);
  const g = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=global');
  assert.equal(g.series.length, 1);
  assert.equal(g.total_rounds, 10);
  assert.deepEqual(g.metrics_spec.map((m) => m.key), ['loss', 'accuracy']);
  const n = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=nodes');
  assert.equal(n.series.length, 5);
  const part = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=nodes&from_round=2&to_round=4');
  assert.deepEqual(part.series[2].points.map((x) => x.round), [2, 3, 4]);
  // 每条曲线的同一轮次取自同一次聚合
  assert.equal(part.series[0].points[0].loss, g.series[0].points[1].loss);
  assert.equal(await errCode('GET', '/fl/jobs/' + job.job_id + '/metrics?from_round=5&to_round=2'), 40003);
  assert.equal(await errCode('GET', '/fl/jobs/' + job.job_id + '/metrics?from_round=x'), 40002);
});

test('[FL-PROC-07] 预估剩余时间：按每轮耗时做指数平滑（EMA，α = 0.3），列表 / 详情与 ETA 接口一致', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const job = await newJob(okData);
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id + '/eta')).eta_sec, null, '未开始时不预测');
  await act(okData, job.job_id, 'start');
  tick(TICK * 5);
  const e = await okData('GET', '/fl/jobs/' + job.job_id + '/eta');
  assert.equal(e.current_round, 5);
  assert.equal(e.method, 'ema');
  assert.equal(e.alpha, 0.3);
  let s = null, sum = 0;
  for (const h of e.history) {
    assert.ok(h.duration_sec > 3 && h.duration_sec < 8, '每轮耗时 ' + h.duration_sec);
    s = s === null ? h.duration_sec : 0.3 * h.duration_sec + 0.7 * s;
    sum += h.duration_sec;
  }
  assert.equal(e.ema_round_sec, Number(s.toFixed(2)));
  assert.equal(e.eta_sec, Number((s * 5).toFixed(1)));
  assert.equal(e.elapsed_sec, Number(sum.toFixed(1)));
  assert.equal(e.eta_naive_sec, Number((sum / 5 * 5).toFixed(1)));
  const d = await okData('GET', '/fl/jobs/' + job.job_id);
  assert.equal(d.eta_sec, e.eta_sec);
  assert.equal(d.elapsed_sec, e.elapsed_sec);
  // 同输入同输出
  assert.deepEqual(await okData('GET', '/fl/jobs/' + job.job_id + '/eta'), e);
  tick(TICK * 6);
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id + '/eta')).eta_sec, 0);
  assert.equal(await errCode('GET', '/fl/jobs/fl_nope/eta'), 40400);
});

test('[FL-PROC-08] 历史指标查询：按项目 ID / 任务 ID / 时间范围过滤，导出 CSV 列与行数正确', async (t) => {
  const { okData, errCode, download, tick } = boot(t);
  const job = await newJob(okData);
  await act(okData, job.job_id, 'start');
  tick(TICK * 3);
  const all = await okData('GET', '/fl/metrics?project_id=p1');
  assert.equal(all.total, 20 + 3, '历史时序任务 20 轮 + 新任务 3 轮');
  assert.equal(all.job_count, 3);
  const one = await okData('GET', '/fl/metrics?job_id=' + job.job_id + '&scope=nodes');
  assert.equal(one.total, 3 * 5, '每轮 1 条全局 + 4 个节点');
  assert.deepEqual(Object.keys(one.items[0]).sort(), ['accuracy', 'job_id', 'job_name', 'loss', 'mae', 'project_id', 'recorded_at', 'rmse', 'round', 'series', 'task_type']);
  const past = new Date(Date.now() - 3600e3).toISOString(), future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await okData('GET', '/fl/metrics?project_id=p1&start_time=' + past + '&end_time=' + future)).total, 23);
  assert.equal((await okData('GET', '/fl/metrics?project_id=p1&start_time=' + future)).total, 0);
  assert.equal((await okData('GET', '/fl/metrics?project_id=p1&end_time=' + past)).total, 0);
  assert.equal((await okData('GET', '/fl/metrics?project_id=p2')).total, 20);
  assert.equal(await errCode('GET', '/fl/metrics?project_id=p1&start_time=yesterday'), 40002);
  assert.equal(await errCode('GET', '/fl/metrics?project_id=p1&start_time=' + future + '&end_time=' + past), 40003);
  assert.equal(await errCode('GET', '/fl/metrics?project_id=p9'), 40400);
  assert.equal(await errCode('GET', '/fl/metrics?job_id=' + job.job_id + '&scope=x'), 40000);

  const f = await download('/projects/p1/fl/metrics/export?start_time=' + past);
  assert.equal(f.fileName, 'fl_metrics_p1.csv');
  const lines = f.content.replace('﻿', '').trim().split('\n');
  assert.equal(lines[0], 'project_id,job_id,task_type,round,series,loss,accuracy,rmse,mae,recorded_at');
  assert.equal(lines.length, 1 + 23);
  const cls = lines.find((l) => l.includes(job.job_id)).split(',');
  assert.equal(cls[2], 'classification');
  assert.equal(cls[7], '', '分类任务不含 RMSE');
  const j = await download('/fl/metrics/export?job_id=' + job.job_id + '&scope=nodes');
  assert.equal(j.content.trim().split('\n').length, 1 + 15);
  await assert.rejects(download('/projects/p9/fl/metrics/export'));
});
