// mock 后端契约测试：node --test tests/
// 在 vm 沙箱里加载 js/mock-server.js，计时器用 node:test 的 mock.timers 驱动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const NODES = ['node-shanghai-01', 'node-hangzhou-02', 'node-ganzhou-03', 'node-center-agg'];
const TS_BODY = {
  name: '流量预测', task_type: 'timeseries', algorithm: 'tcn', aggregation: 'ss', total_rounds: 10, node_ids: NODES,
  dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_a_txn_ts'] },
  timeseries: { time_column: 'txn_date', window_size: 14, horizon: 3 }
};

test('任务类型目录包含分类与时序预测，并给出指标定义', async (t) => {
  const { okData } = boot(t);
  const { items } = await okData('GET', '/fl/task-types');
  const ts = items.find((x) => x.task_type === 'timeseries');
  assert.deepEqual(items.map((x) => x.task_type), ['classification', 'timeseries']);
  assert.deepEqual(ts.metrics.map((m) => m.key), ['rmse', 'mae']);
  assert.ok(ts.algorithms.includes('lstm') && !ts.algorithms.includes('lr'));
});

test('任务列表：首次访问播种 2 个任务，最新在前，latest 只取 1 个', async (t) => {
  const { okData } = boot(t);
  const all = await okData('GET', '/projects/p1/fl/jobs');
  assert.equal(all.total, 2);
  assert.equal(all.items[0].task_type, 'classification');
  assert.equal(all.items[0].status, 'Created');
  const hist = all.items[1];
  assert.equal(hist.task_type, 'timeseries');
  assert.equal(hist.status, 'Success');
  assert.equal(hist.current_round, 20);
  assert.ok(hist.global_metrics.rmse > 0 && hist.global_metrics.mae > 0);
  assert.equal(hist.global_accuracy, null);
  const latest = await okData('GET', '/projects/p1/fl/jobs?latest=true');
  assert.equal(latest.items.length, 1);
  const tsOnly = await okData('GET', '/projects/p1/fl/jobs?task_type=timeseries');
  assert.equal(tsOnly.total, 1);
});

test('创建任务校验：算法与类型不匹配、缺时序参数、节点不足、时间列不存在', async (t) => {
  const { call, okData } = boot(t);
  await okData('GET', '/projects/p1/fl/jobs');
  const cases = [
    [{ ...TS_BODY, algorithm: 'lr' }, 40000, /不支持算法/],
    [{ ...TS_BODY, timeseries: undefined }, 40000, /时间列/],
    [{ ...TS_BODY, timeseries: { ...TS_BODY.timeseries, horizon: 0 } }, 40003, /预测步长/],
    [{ ...TS_BODY, node_ids: NODES.slice(0, 2) }, 40000, /聚合节点/],
    [{ ...TS_BODY, node_ids: ['node-x'] }, 40400, /不属于本项目/],
    [{ ...TS_BODY, timeseries: { ...TS_BODY.timeseries, time_column: 'dt' } }, 40000, /没有时间列 dt/],
    [{ ...TS_BODY, total_rounds: 0 }, 40003, /轮次/],
    [{ ...TS_BODY, algorithm: 'custom' }, 40000, /上传模型文件/],
    [{ ...TS_BODY, dataset_source: { type: 'psi_pipeline', pipeline_id: 'psi_nope' } }, 40400, /流水线不存在/]
  ];
  for (const [body, code, rx] of cases) {
    const r = await call('POST', '/projects/p1/fl/jobs', body);
    assert.equal(r.code, code, JSON.stringify(body) + ' → ' + r.message);
    assert.match(r.message, rx);
  }
});

test('自定义模型：先上传文件再创建', async (t) => {
  const { call, okData } = boot(t);
  const bad = await call('POST', '/files', { file: { name: 'm.py', size: 10 }, purpose: 'other', project_id: 'p1' });
  assert.equal(bad.code, 40000);
  const f = await okData('POST', '/files', { file: { name: 'm.py', size: 2048 }, purpose: 'fl_model', project_id: 'p1' });
  const job = await okData('POST', '/projects/p1/fl/jobs', { ...TS_BODY, algorithm: 'custom', model_file_id: f.file_id });
  assert.equal(job.algorithm, 'custom');
  assert.equal(job.model_file_id, f.file_id);
});

test('时序任务全流程：创建 → 启动 → 每轮推送 RMSE/MAE → 跑完 Success → CSV 列随指标', async (t) => {
  const { M, okData, tick } = boot(t);
  const job = await okData('POST', '/projects/p1/fl/jobs', TS_BODY);
  assert.equal(job.status, 'Created');
  assert.deepEqual(job.metrics_spec.map((m) => m.key), ['rmse', 'mae']);
  assert.deepEqual(job.timeseries, { time_column: 'txn_date', window_size: 14, horizon: 3 });
  const list = await okData('GET', '/projects/p1/fl/jobs');
  assert.equal(list.items[0].job_id, job.job_id);

  const events = [];
  M.subscribe('/fl/jobs/' + job.job_id + '/events', {
    round_completed: (e) => events.push(e),
    status_changed: (e) => events.push({ status: e.status })
  });
  await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  tick(650 * 3);
  const rounds = events.filter((e) => e.round);
  assert.equal(rounds.length, 3);
  assert.ok('rmse' in rounds[0].global_metrics && !('loss' in rounds[0].global_metrics));
  assert.ok(rounds[2].global_metrics.rmse < rounds[0].global_metrics.rmse, 'RMSE 应随轮次下降');
  assert.equal(rounds[0].node_metrics.length, 4);

  const met = await okData('GET', '/fl/jobs/' + job.job_id + '/metrics?scope=nodes');
  assert.equal(met.series.length, 5);
  assert.deepEqual(Object.keys(met.series[0].points[0]).sort(), ['mae', 'recorded_at', 'rmse', 'round']);

  tick(650 * 8);
  const done = await okData('GET', '/fl/jobs/' + job.job_id);
  assert.equal(done.status, 'Success');
  assert.equal(done.current_round, 10);

  const csv = await M.download('/fl/jobs/' + job.job_id + '/metrics/export?scope=global');
  assert.match(csv.content, /job_id,round,series,rmse,mae,recorded_at/);
  assert.equal(csv.content.trim().split('\n').length, 11);
});

test('分类任务指标字段保持向后兼容（global_loss / global_accuracy）', async (t) => {
  const { okData, tick } = boot(t);
  const list = await okData('GET', '/projects/p1/fl/jobs');
  const id = list.items[0].job_id;
  await okData('POST', '/fl/jobs/' + id + '/actions', { action: 'start' });
  tick(650 * 2);
  const j = await okData('GET', '/fl/jobs/' + id);
  assert.equal(j.global_loss, j.global_metrics.loss);
  assert.equal(j.global_accuracy, j.global_metrics.accuracy);
  assert.equal(j.global_loss_prev, j.global_metrics_prev.loss);
  const bad = await okData('PATCH', '/fl/jobs/' + list.items[1].job_id, { aggregation: 'he' });
  assert.equal(bad.aggregation, 'he');
});

test('数据接入：校验、接入中→就绪、重名、文件来源、详情脱敏、删除', async (t) => {
  const { call, okData, tick } = boot(t);
  const seed = await okData('GET', '/projects/p1/datasets');
  assert.equal(seed.total, 4);
  assert.equal((await okData('GET', '/projects/p1/datasets?has_time_column=true')).total, 2);
  assert.equal((await okData('GET', '/projects/p1/datasets?party_id=party-b')).total, 1);

  const base = { name: '新表', party_id: 'party-b', source_type: 'database', source: { jdbc_url: 'jdbc:mysql://1.2.3.4:3306/x', table: 't' }, id_column: 'phone_hash' };
  const bads = [
    [{ ...base, source: { jdbc_url: 'mysql://x', table: 't' } }, 40000, /JDBC/],
    [{ ...base, source: { jdbc_url: base.source.jdbc_url } }, 40000, /表名/],
    [{ ...base, party_id: 'party-z' }, 40000, /未知参与方/],
    [{ ...base, id_column: '1bad' }, 40000, /求交键/],
    [{ ...base, source_type: 'hdfs', source: { path: '/tmp/x' } }, 40000, /hdfs:\/\//],
    [{ ...base, source_type: 'file', source: { file_id: 'f_nope' } }, 40400, /先上传/],
    [{ ...base, name: '' }, 40000, /名称必填/]
  ];
  for (const [body, code, rx] of bads) {
    const r = await call('POST', '/projects/p1/datasets', body);
    assert.equal(r.code, code, r.message);
    assert.match(r.message, rx);
  }

  const ds = await okData('POST', '/projects/p1/datasets', { ...base, time_column: 'biz_date' });
  assert.equal(ds.status, 'importing');
  assert.equal(ds.row_count, null);
  assert.equal((await call('POST', '/projects/p1/datasets', base)).code, 40902);
  tick(1200);
  const ready = await okData('GET', '/datasets/' + ds.dataset_id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.row_count > 0);
  assert.ok(ready.columns.some((c) => c.name === 'biz_date' && c.type === 'date'));
  assert.equal(ready.preview.length, 3);
  assert.match(ready.preview[0].phone_hash, /…$/, '求交键预览应脱敏');

  const f = await okData('POST', '/files', { file: { name: 'a.csv', size: 1000 }, purpose: 'dataset', project_id: 'p1' });
  const fromFile = await okData('POST', '/projects/p1/datasets', { ...base, name: '文件表', source_type: 'file', source: { file_id: f.file_id } });
  assert.equal(fromFile.source_type, 'file');

  await okData('DELETE', '/datasets/' + ds.dataset_id);
  assert.equal((await call('GET', '/datasets/' + ds.dataset_id)).code, 40400);
});

test('求交流水线：校验 parties，统计量来自所选数据集，完成后生成 FL 任务', async (t) => {
  const { call, okData, tick, M } = boot(t);
  await okData('GET', '/projects/p1/datasets');
  const parties = [
    { party_id: 'party-a', dataset_id: 'ds_p1_a_user', id_column: 'phone_hash' },
    { party_id: 'party-b', dataset_id: 'ds_p1_b_user', id_column: 'phone_hash' }
  ];
  const body = (over) => ({ protocol: 'ecdh', parties, alignment: {}, ...over });
  const bads = [
    [body({ parties: [parties[0], { ...parties[1], party_id: 'party-a' }] }), /不同参与方/],
    [body({ parties: [parties[0], { ...parties[1], id_column: 'nope' }] }), /没有列 nope/],
    [body({ parties: [parties[0], { ...parties[1], dataset_id: 'ds_p1_a_txn_ts' }] }), /不属于 参与方 B/],
    [body({ parties: [parties[0]] }), /恰好两方/],
    [body({ protocol: 'xx' }), /未知协议/]
  ];
  for (const [b, rx] of bads) {
    const r = await call('POST', '/projects/p1/psi/pipelines', b);
    assert.notEqual(r.code, 0);
    assert.match(r.message, rx);
  }

  const cfg = { task_type: 'classification', algorithm: 'xgb', aggregation: 'he', node_ids: NODES };
  const pipe = await okData('POST', '/projects/p1/psi/pipelines', body({ training: { fl_job_config: cfg, auto_start: false } }));
  assert.equal(pipe.parties[1].dataset_name, '信贷行为表');
  // 数据集在用时不允许删
  assert.equal((await call('DELETE', '/datasets/ds_p1_a_user')).code, 40901);

  let finished = null;
  M.subscribe('/psi/pipelines/' + pipe.pipeline_id + '/events', { pipeline_finished: (e) => { finished = e; } });
  tick(30 * 160);
  assert.ok(finished, '流水线应跑完');
  const v = await okData('GET', '/psi/pipelines/' + pipe.pipeline_id);
  assert.equal(v.stages[0].stats.left_rows, 1200000);
  assert.equal(v.stages[0].stats.right_rows, 864000);
  assert.equal(v.stages[0].stats.intersection_rows, 412000);
  assert.equal(v.stages[1].stats.feature_dim, 68);

  const job = await okData('GET', '/fl/jobs/' + v.fl_job_id);
  assert.deepEqual(job.dataset_source, { type: 'psi_pipeline', pipeline_id: pipe.pipeline_id });
  // 已完成的流水线可作为新任务的数据来源
  const j2 = await okData('POST', '/projects/p1/fl/jobs', { ...cfg, dataset_source: { type: 'psi_pipeline', pipeline_id: pipe.pipeline_id } });
  assert.equal(j2.dataset_source.type, 'psi_pipeline');
});
