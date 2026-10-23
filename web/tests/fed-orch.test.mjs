// 联邦学习 · 任务编排（FL-ORCH-01 至 FL-ORCH-09）mock 契约测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_boot.mjs';

const NODES = ['node-shanghai-01', 'node-hangzhou-02', 'node-ganzhou-03', 'node-center-agg'];
const NEW_PROJECT = {
  name: '稀土氧化物库存联合预测', type: 'pilot', description: '三方库存数据联合建模',
  base_algorithm: 'lstm', model_version: '1.1.0', total_rounds: 40, target: { metric: 'rmse', value: 0.12 }
};
const CLS_JOB = {
  task_type: 'classification', algorithm: 'xgb', aggregation: 'he', total_rounds: 5, node_ids: NODES,
  dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_a_user', 'ds_p1_b_user'] }
};

test('[FL-ORCH-01] 项目创建：必填 / 越界 / 重名 / 版本校验，创建后出现在列表并带空节点表', async (t) => {
  const { call, okData } = boot(t);
  const cases = [
    [{ ...NEW_PROJECT, name: '' }, 40000, /名称必填/],
    [{ ...NEW_PROJECT, name: '稀土氧化物价格联合预测 · 2026Q4' }, 40902, /已存在/],
    [{ ...NEW_PROJECT, total_rounds: 0 }, 40003, /聚合轮数/],
    [{ ...NEW_PROJECT, target: { metric: 'rmse', value: 1.5 } }, 40003, /目标值/],
    [{ ...NEW_PROJECT, target: { metric: 'f2' } }, 40000, /训练目标指标/],
    [{ ...NEW_PROJECT, model_version: '9.9.9' }, 40400, /没有版本/],
    [{ ...NEW_PROJECT, base_algorithm: 'xgb', model_version: '1.2.0' }, 40000, /不支持/]
  ];
  for (const [body, code, rx] of cases) {
    const r = await call('POST', '/projects', body);
    assert.equal(r.code, code, JSON.stringify(body) + ' → ' + r.message);
    assert.match(r.message, rx);
  }
  const p = await okData('POST', '/projects', NEW_PROJECT);
  assert.equal(p.project_id, 'p4');
  assert.deepEqual(p.target, { metric: 'rmse', label: 'RMSE（归一化）', op: '<=', value: 0.12, task_type: 'timeseries' });
  assert.equal(p.total_rounds, 40);
  assert.equal(p.node_count, 0);
  const list = await okData('GET', '/projects?page_size=100');
  assert.ok(list.items.some((x) => x.project_id === 'p4' && x.name === NEW_PROJECT.name));
  assert.equal((await okData('GET', '/projects/p4/nodes')).total, 0);
  assert.equal((await okData('GET', '/projects/p4/fl/jobs')).total, 0);   // 新项目不播种演示任务
});

test('[FL-ORCH-02] 节点管理：添加校验 IP / 端口 / 重复 ID / 连通性，编辑与删除', async (t) => {
  const { call, okData, errCode } = boot(t);
  const base = { node_id: 'node-baotou-04', ip: '10.40.3.9', port: 8471, role: 'trainer', data_partition: 'part-D' };
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, ip: '10.40.3.999' }), 40002);
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, port: 70000 }), 40003);
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, node_id: 'Node_X' }), 40000);
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, data_partition: '' }), 40000);
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, node_id: 'node-shanghai-01' }), 40902);
  assert.equal(await errCode('POST', '/projects/p1/nodes', { ...base, ip: '192.0.2.10' }), 42201);
  // D23：网络地址 / 广播地址 / 未指定 / 回环 / 组播被拒并说明原因
  for (const [ip, rx] of [['10.0.0.0', /网络地址/], ['10.40.3.255', /广播地址/], ['0.0.0.0', /未指定地址/], ['255.255.255.255', /受限广播/],
    ['127.0.0.1', /回环/], ['224.0.0.5', /组播/], ['::', /未指定/], ['::1', /回环/]]) {
    const r = await call('POST', '/projects/p1/nodes', { ...base, ip });
    assert.equal(r.code, 40002, ip);
    assert.match(r.message, rx, ip);
  }
  assert.equal((await call('PATCH', '/projects/p1/nodes/node-shanghai-01', { ip: '10.22.6.0' })).code, 40002);
  const n = await okData('POST', '/projects/p1/nodes', base);
  assert.equal(n.data_dir, '/data/fl/p1/part-d');
  assert.equal(n.running_job_count, 0);

  const ed = await okData('PATCH', '/projects/p1/nodes/node-baotou-04', { ip: '10.40.3.10', port: 8472, data_partition: 'part-E' });
  assert.equal(ed.ip, '10.40.3.10');
  assert.equal(ed.port, 8472);
  assert.equal(ed.data_partition, 'part-E');
  const renamed = await okData('PATCH', '/projects/p1/nodes/node-baotou-04', { node_id: 'node-baotou-05' });
  assert.equal(renamed.node_id, 'node-baotou-05');
  assert.equal(await errCode('PATCH', '/projects/p1/nodes/node-baotou-05', { node_id: 'node-hangzhou-02' }), 40902);
  assert.equal(await errCode('PATCH', '/projects/p1/nodes/node-baotou-05', { port: 0 }), 40003);
  assert.equal(await errCode('PATCH', '/projects/p1/nodes/node-nope', { port: 1 }), 40400);
  const toAgg = await okData('PATCH', '/projects/p1/nodes/node-baotou-05', { role: 'aggregator' });
  assert.equal(toAgg.data_partition, null);
  assert.equal(toAgg.role_label, '聚合方 / 协调节点');
  await okData('DELETE', '/projects/p1/nodes/node-baotou-05');
  assert.ok(!(await okData('GET', '/projects/p1/nodes')).items.some((x) => x.node_id === 'node-baotou-05'));

  // 运行中任务使用的节点：不可删、不可改角色，但可以改端口；历史任务引用的节点不可改 ID
  const job = await okData('POST', '/projects/p1/fl/jobs', CLS_JOB);
  await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  const del = await call('DELETE', '/projects/p1/nodes/node-shanghai-01');
  assert.equal(del.code, 40901);
  assert.match(del.message, /运行中/);
  assert.equal(await errCode('PATCH', '/projects/p1/nodes/node-shanghai-01', { role: 'aggregator' }), 40901);
  assert.equal((await okData('PATCH', '/projects/p1/nodes/node-shanghai-01', { port: 8480 })).port, 8480);
  assert.equal((await okData('GET', '/projects/p1/nodes')).items.find((x) => x.node_id === 'node-shanghai-01').running_job_count, 1);
  await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'terminate' });
  assert.equal(await errCode('PATCH', '/projects/p1/nodes/node-shanghai-01', { node_id: 'node-shanghai-09' }), 40901);
});

test('[FL-ORCH-03] 数据隔离：访问矩阵只放行本节点，越权读取被拒并记日志，传输内容只含梯度与参数', async (t) => {
  const { okData, errCode, tick } = boot(t);
  const iso = await okData('GET', '/projects/p1/isolation');
  assert.equal(iso.data_dirs.length, 3);
  for (const row of iso.matrix) {
    for (const c of row.cells) assert.equal(c.allowed, c.owner_node_id === row.node_id);
  }
  assert.ok(iso.payload_allowed.every((x) => ['gradient', 'model_param', 'metadata', 'metric'].includes(x.kind)));

  const denied = await okData('POST', '/projects/p1/isolation/checks', { type: 'dir_access', actor_node_id: 'node-shanghai-01', target_node_id: 'node-hangzhou-02' });
  assert.equal(denied.result, 'denied');
  assert.match(denied.detail, /EACCES/);
  assert.equal(denied.path, '/data/fl/p1/part-b/train.parquet');
  const self = await okData('POST', '/projects/p1/isolation/checks', { type: 'dir_access', actor_node_id: 'node-shanghai-01', target_node_id: 'node-shanghai-01' });
  assert.equal(self.result, 'allowed');
  assert.equal(await errCode('POST', '/projects/p1/isolation/checks', { type: 'dir_access', actor_node_id: 'node-x', target_node_id: 'node-hangzhou-02' }), 40400);
  assert.equal(await errCode('POST', '/projects/p1/isolation/checks', { type: 'dir_access', actor_node_id: 'node-shanghai-01', target_node_id: 'node-center-agg' }), 40001);
  assert.equal(await errCode('POST', '/projects/p1/isolation/checks', { type: 'other' }), 40000);

  // 历史时序任务有 20 轮记录：审计最近一轮的上传消息
  const audit = await okData('POST', '/projects/p1/isolation/checks', { type: 'payload' });
  assert.equal(audit.result, 'passed');
  assert.equal(audit.round, 20);
  assert.ok(audit.scanned_columns > 40);
  for (const n of audit.nodes) {
    assert.deepEqual(n.fields.map((f) => f.field), n.role === 'aggregator' ? ['global_weights', 'round'] : ['weights_delta', 'num_samples', 'local_metrics']);
    assert.equal(n.raw_fields_found, 0);
  }
  assert.equal(audit.nodes.filter((n) => n.direction === 'downlink').length, 1);
  // D17：同一模型各节点梯度维度相同，等于内核参数量表（LSTM 203,143），未稀疏化
  assert.equal(audit.model_params, 203143);
  assert.equal(audit.sparsity_keep_ratio, 1);
  assert.deepEqual([...new Set(audit.nodes.map((n) => n.fields[0].elements))], [203143]);
  assert.ok(audit.nodes.every((n) => n.wire_bytes > 0 && n.total_bytes >= 203143 * 4));
  // 未开始训练的任务没有传输内容可审计
  const fresh = await okData('POST', '/projects/p1/fl/jobs', CLS_JOB);
  assert.equal(await errCode('POST', '/projects/p1/isolation/checks', { type: 'payload', job_id: fresh.job_id }), 40901);
  tick(1);
  const logs = (await okData('GET', '/projects/p1/isolation')).checks;
  assert.deepEqual(logs.map((x) => x.result), ['passed', 'allowed', 'denied']);
});

test('[FL-ORCH-04] 项目配置：详情、修改持久化（revision 递增）、导出 JSON；非法修改被拒', async (t) => {
  const { okData, errCode, download } = boot(t);
  const d = await okData('GET', '/projects/p1');
  assert.equal(d.base_algorithm, 'lstm');
  assert.equal(d.target.op, '<=');
  assert.equal(d.node_count, 4);
  assert.equal(d.revision, 1);
  const up = await okData('PATCH', '/projects/p1', { total_rounds: 50, target: { metric: 'mae', value: 0.09 }, description: '改' });
  assert.equal(up.total_rounds, 50);
  assert.equal(up.target.metric, 'mae');
  assert.equal(up.revision, 2);
  assert.equal(up.updated_by, 'Rui');
  assert.equal((await okData('GET', '/projects/p1')).description, '改');
  assert.equal(await errCode('PATCH', '/projects/p1', { total_rounds: 201 }), 40003);
  assert.equal(await errCode('PATCH', '/projects/p1', { name: '稀土供应链风险联合建模 · 试点' }), 40902);
  assert.equal(await errCode('PATCH', '/projects/p1', { target: { metric: 'accuracy', value: 0.9 } }), 40000);
  assert.equal(await errCode('PATCH', '/projects/p9', { total_rounds: 3 }), 40400);
  assert.equal(await errCode('GET', '/projects/p9'), 40400);
  const kw = await okData('GET', '/projects?keyword=供应链');
  assert.deepEqual(kw.items.map((x) => x.project_id), ['p2']);

  const f = await download('/projects/p1/config/export');
  assert.equal(f.fileName, 'fl_project_p1_config.json');
  const doc = JSON.parse(f.content);
  // D18：导出文件时间统一写 UTC+8
  assert.equal(doc.timezone, 'UTC+8');
  for (const v of [doc.exported_at, doc.project.created_at, doc.updated_at]) assert.match(v, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, v);
  assert.equal(doc.project.created_at, '2026-07-01 10:00:00 +08:00');
  assert.equal(doc.training.total_rounds, 50);
  assert.equal(doc.training.target.op, '<=');
  assert.equal(doc.nodes.length, 4);
  assert.equal(doc.nodes[0].data_dir, '/data/fl/p1/part-a');
  // 新建任务未传轮次时取项目配置
  const job = await okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, total_rounds: undefined });
  assert.equal(job.total_rounds, 50);
});

test('[FL-ORCH-05] 内置算法：五个基类，统一 fit / predict / evaluate 接口，按任务类型过滤', async (t) => {
  const { okData, errCode } = boot(t);
  const all = await okData('GET', '/fl/algorithms?kind=builtin');
  assert.deepEqual(all.items.map((a) => a.algo_id), ['lr', 'xgb', 'cnn', 'lstm', 'tcn']);
  for (const a of all.items) {
    const d = await okData('GET', '/fl/algorithms/' + a.algo_id);
    assert.deepEqual(d.interface.map((m) => m.method), ['fit', 'predict', 'evaluate']);
    assert.equal(d.params_schema.type, 'object');
    assert.ok(d.versions.length >= 1 && d.versions.filter((v) => v.is_current).length === 1);
  }
  const ts = await okData('GET', '/fl/algorithms?task_type=timeseries&kind=builtin');
  assert.deepEqual(ts.items.map((a) => a.algo_id), ['lstm', 'tcn']);
  assert.equal(await errCode('GET', '/fl/algorithms/nope'), 40400);
});

test('[FL-ORCH-06] 算法注册：JSON Schema 子集校验，注册后可用于新建训练任务', async (t) => {
  const { call, okData } = boot(t);
  const schema = {
    type: 'object', required: ['num_leaves'],
    properties: { num_leaves: { type: 'integer', minimum: 2, maximum: 256, default: 31 }, boosting: { type: 'string', enum: ['gbdt', 'dart'], default: 'gbdt' } }
  };
  const body = { name: 'LightGBM-Fed', version: '1.0.0', task_types: ['classification'], model_format: 'pkl', params_schema: JSON.stringify(schema) };
  const cases = [
    [{ ...body, name: '' }, 40000, /算法名必填/],
    [{ ...body, version: 'v1' }, 40002, /版本号/],
    [{ ...body, model_format: 'zip' }, 40000, /模型文件格式/],
    [{ ...body, params_schema: '{bad json' }, 40002, /不是合法 JSON：第 1 行第 2 列，属性名必须用英文双引号包裹/],
    [{ ...body, params_schema: '{"type":"object", properties:}' }, 40002, /第 1 行第 19 列，属性名必须用英文双引号包裹$/],
    [{ ...body, params_schema: '{\n  "type": "object",\n  "properties": {\n' }, 40002, /第 4 行第 1 列，内容不完整/],
    [{ ...body, params_schema: "{'type':'object'}" }, 40002, /第 1 行第 2 列/],
    [{ ...body, params_schema: { type: 'array' } }, 40002, /根节点 type/],
    [{ ...body, params_schema: { type: 'object', properties: { a: { type: 'object' } } } }, 40002, /type 必须是/],
    [{ ...body, params_schema: { type: 'object', properties: { a: { type: 'integer', minimum: 5, maximum: 1 } } } }, 40002, /minimum 大于 maximum/],
    [{ ...body, params_schema: { type: 'object', properties: { a: { type: 'integer', pattern: 'x' } } } }, 40002, /不支持关键字/],
    [{ ...body, params_schema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['b'] } }, 40002, /未在 properties/],
    [{ ...body, name: 'XGBoost' }, 40902, /内置算法/]
  ];
  for (const [b, code, rx] of cases) {
    const r = await call('POST', '/fl/algorithms', b);
    assert.equal(r.code, code, JSON.stringify(b) + ' → ' + r.message);
    assert.match(r.message, rx);
  }
  const a = await okData('POST', '/fl/algorithms', body);
  assert.equal(a.kind, 'registered');
  assert.equal(a.current_version, '1.0.0');
  assert.ok(a.model_file_id);
  assert.equal((await call('POST', '/fl/algorithms', body)).code, 40902);
  const listed = await okData('GET', '/fl/algorithms?kind=registered&task_type=classification');
  assert.deepEqual(listed.items.map((x) => x.algo_id), [a.algo_id]);

  const job = await okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, algorithm: a.algo_id, params: { num_leaves: 63 } });
  assert.equal(job.algorithm, 'custom');
  assert.equal(job.model_file_id, a.model_file_id);
  assert.deepEqual(job.algo_ref, { algo_id: a.algo_id, name: 'LightGBM-Fed', kind: 'registered', version: '1.0.0' });
  assert.deepEqual(job.params, { num_leaves: 63, boosting: 'gbdt' });
  assert.match(job.name, /LightGBM-Fed 1\.0\.0/);
  const bad = await call('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, algorithm: a.algo_id, params: { num_leaves: 999 } });
  assert.equal(bad.code, 40003);
  const wrongType = await call('POST', '/projects/p1/fl/jobs', {
    ...CLS_JOB, task_type: 'timeseries', algorithm: a.algo_id,
    dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_a_txn_ts'] }, timeseries: { time_column: 'txn_date', window_size: 14, horizon: 3 }
  });
  assert.equal(wrongType.code, 40000);
  assert.match(wrongType.message, /不支持算法 LightGBM-Fed/);
});

test('[FL-ORCH-07] 自定义模型上传：结构校验给出层数 / 参数量 / 输入形状，损坏或空文件校验失败', async (t) => {
  const { call, okData, errCode } = boot(t);
  const up = (name, size) => okData('POST', '/files', { file: { name, size }, purpose: 'fl_model', project_id: 'p1' });
  const good = await up('ree_price_lstm.pt', 412160);
  const m = await okData('POST', '/projects/p1/fl/models', { file_id: good.file_id, name: '价格预测 LSTM-v2', task_type: 'timeseries' });
  assert.equal(m.kind, 'custom');
  assert.equal(m.report.valid, true);
  assert.equal(m.report.param_count, (412160 - 512) / 4);
  assert.deepEqual(m.report.input_shape, ['batch', 30, 11]);
  assert.ok(m.report.layers >= 3 && m.report.layers <= 12);
  // 同输入同输出
  const again = await up('ree_price_lstm.pt', 412160);
  const m2 = await okData('POST', '/projects/p2/fl/models', { file_id: again.file_id, task_type: 'timeseries' });
  assert.equal(m2.report.layers, m.report.layers);

  const corrupt = await up('corrupt_model.h5', 2048);
  const r = await call('POST', '/projects/p1/fl/models', { file_id: corrupt.file_id });
  assert.equal(r.code, 40002);
  assert.match(r.message, /HDF5 文件签名不匹配/);
  assert.equal(r.data.report.valid, false);
  const empty = await up('empty.onnx', 0);
  const r2 = await call('POST', '/projects/p1/fl/models', { file_id: empty.file_id });
  assert.match(r2.message, /文件为空/);
  const zip = await up('model.zip', 100);
  assert.equal(await errCode('POST', '/projects/p1/fl/models', { file_id: zip.file_id }), 40002);
  assert.equal(await errCode('POST', '/projects/p1/fl/models', { file_id: 'f_nope' }), 40400);

  // 只在所属项目可见，可直接用于新建任务
  assert.equal((await okData('GET', '/fl/algorithms?kind=custom&project_id=p1')).total, 1);
  assert.equal((await okData('GET', '/fl/algorithms?kind=custom')).total, 0);
  const job = await okData('POST', '/projects/p1/fl/jobs', {
    ...CLS_JOB, task_type: 'timeseries', algorithm: m.algo_id,
    dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_ree_price'] }, timeseries: { time_column: 'trade_date', window_size: 30, horizon: 7 }
  });
  assert.equal(job.model_file_id, good.file_id);
  assert.equal(await errCode('POST', '/projects/p2/fl/jobs', {
    ...CLS_JOB, task_type: 'timeseries', algorithm: m.algo_id, node_ids: ['node-shenzhen-05', 'node-chengdu-06', 'node-center-agg-2'],
    dataset_source: undefined, timeseries: { time_column: 'trade_date', window_size: 30, horizon: 7 }
  }), 40400);
});

test('[FL-ORCH-08] 模型版本管理：重复上传生成新版本，回滚记录操作人与时间，新任务使用回滚后的版本', async (t) => {
  const { call, okData, errCode } = boot(t);
  const v = await okData('GET', '/fl/algorithms/xgb');
  assert.deepEqual(v.versions.map((x) => x.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.equal(v.current_version, '1.2.0');
  const rb = await okData('POST', '/fl/algorithms/xgb/actions', { action: 'rollback', version: '1.1.0' });
  assert.equal(rb.current_version, '1.1.0');
  assert.equal(rb.versions.find((x) => x.is_current).version, '1.1.0');
  assert.equal(rb.history[0].action, 'rollback');
  assert.equal(rb.history[0].from_version, '1.2.0');
  assert.equal(rb.history[0].operator, 'Rui');
  assert.ok(rb.history[0].at);
  const job = await okData('POST', '/projects/p1/fl/jobs', CLS_JOB);
  assert.equal(job.algo_ref.version, '1.1.0');
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/actions', { action: 'rollback', version: '1.1.0' }), 40901);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/actions', { action: 'rollback', version: '0.9.0' }), 40400);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/actions', { action: 'delete' }), 40000);

  // 自定义模型：同名再次上传 → 1.1.0；注册算法：新版本号必须更大
  const f1 = await okData('POST', '/files', { file: { name: 'a.pkl', size: 9000 }, purpose: 'fl_model', project_id: 'p1' });
  const f2 = await okData('POST', '/files', { file: { name: 'b.pkl', size: 12000 }, purpose: 'fl_model', project_id: 'p1' });
  const m1 = await okData('POST', '/projects/p1/fl/models', { file_id: f1.file_id, name: '违约树模型' });
  const m2 = await okData('POST', '/projects/p1/fl/models', { file_id: f2.file_id, name: '违约树模型' });
  assert.equal(m2.algo_id, m1.algo_id);
  assert.deepEqual(m2.versions.map((x) => x.version), ['1.1.0', '1.0.0']);
  const back = await okData('POST', '/fl/algorithms/' + m1.algo_id + '/actions', { action: 'rollback', version: '1.0.0' });
  assert.equal(back.model_file_id, f1.file_id);
  const reg = { name: 'FedProx-MLP', version: '2.0.0', task_types: ['classification'], model_format: 'pt', params_schema: { type: 'object', properties: { mu: { type: 'number', minimum: 0, maximum: 1, default: 0.01 } } } };
  await okData('POST', '/fl/algorithms', reg);
  assert.equal((await call('POST', '/fl/algorithms', { ...reg, version: '1.5.0' })).code, 40003);
  const r2 = await okData('POST', '/fl/algorithms', { ...reg, version: '2.1.0' });
  assert.equal(r2.version_count, 2);
});

test('[FL-ORCH-09] 算法参数模板：预置模板、另存自定义模板（schema 校验 / 重名）、删除限制、任务按模板参数创建', async (t) => {
  const { okData, errCode } = boot(t);
  const pre = await okData('GET', '/fl/algorithms/xgb/templates');
  assert.ok(pre.items.length >= 3 && pre.items.every((x) => x.preset));
  assert.deepEqual(Object.keys(pre.items[0].params).sort(), ['eta', 'max_depth', 'min_child_weight', 'n_estimators', 'subsample']);
  const mine = await okData('POST', '/fl/algorithms/xgb/templates', { name: '浅树快训', params: { max_depth: 3, n_estimators: 50 } });
  assert.equal(mine.preset, false);
  assert.equal(mine.params.eta, 0.3);   // 未填的参数取 schema 默认值
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/templates', { name: '浅树快训', params: {} }), 40902);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/templates', { name: 'x', params: { max_depth: 99 } }), 40003);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/templates', { name: 'x', params: { depth: 3 } }), 40000);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/templates', { name: 'x', params: { max_depth: 'deep' } }), 40002);
  assert.equal(await errCode('POST', '/fl/algorithms/xgb/templates', { name: '', params: {} }), 40000);
  assert.equal(await errCode('DELETE', '/fl/param-templates/' + pre.items[0].template_id), 40001);

  const job = await okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, params: mine.params, template_id: mine.template_id });
  assert.equal(job.params.max_depth, 3);
  assert.equal(job.algo_ref.template_id, mine.template_id);
  await okData('DELETE', '/fl/param-templates/' + mine.template_id);
  assert.equal((await okData('GET', '/fl/algorithms/xgb/templates')).total, pre.total);
});

test('[FL-ORCH-01][FL-ORCH-04] 新建任务默认聚合策略取聚合与安全页的项目配置（k.db.fla）', async (t) => {
  const { M, okData } = boot(t);
  M._db.fla = { p1: { strategy: 'ss' } };
  assert.equal((await okData('GET', '/projects/p1')).aggregation_default, 'ss');
  const job = await okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, aggregation: undefined });
  assert.equal(job.aggregation, 'ss');
  assert.equal((await okData('GET', '/projects/p2')).aggregation_default, null);
});

test('[FL-ORCH-01] 新建项目可选导入演示数据：节点、数据集、示例任务按内核原逻辑播种，参数非布尔被拒', async (t) => {
  const { okData, errCode } = boot(t);
  assert.equal(await errCode('POST', '/projects', { ...NEW_PROJECT, seed_demo: 'yes' }), 40000);
  const p = await okData('POST', '/projects', { ...NEW_PROJECT, seed_demo: true });
  const nodes = (await okData('GET', '/projects/' + p.project_id + '/nodes')).items;
  assert.deepEqual(nodes.map((n) => n.node_id), ['node-baotou-p4', 'node-ganzhou-p4', 'node-center-agg-p4']);
  assert.equal(nodes[0].data_dir, '/data/fl/p4/part-a');
  const jobs = (await okData('GET', '/projects/p4/fl/jobs')).items;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.node_ids.length === 3));
  assert.equal((await okData('GET', '/projects/p4/datasets')).total, 4);
  assert.equal((await okData('GET', '/projects/p4')).node_count, 3);
  // 演示任务可直接启动，隔离审计能取到训练轮次
  await okData('POST', '/fl/jobs/' + jobs[0].job_id + '/actions', { action: 'start' });
  const iso = await okData('GET', '/projects/p4/isolation');
  assert.equal(iso.data_dirs.length, 2);
});

test('[FL-ORCH-06][FL-ORCH-07] 任务列表 / 详情 / 动作返回注册算法与自定义模型的真实名称和版本', async (t) => {
  const { okData } = boot(t);
  const a = await okData('POST', '/fl/algorithms', {
    name: '稀土价格 Transformer', version: '1.2.0', task_types: ['timeseries'], model_format: 'pt',
    params_schema: { type: 'object', properties: { d_model: { type: 'integer', minimum: 16, maximum: 512, default: 64 } } }
  });
  const job = await okData('POST', '/projects/p1/fl/jobs', {
    ...CLS_JOB, task_type: 'timeseries', algorithm: a.algo_id,
    dataset_source: { type: 'dataset', dataset_ids: ['ds_p1_ree_price'] }, timeseries: { time_column: 'trade_date', window_size: 30, horizon: 7 }
  });
  assert.equal(job.algo_ref_name, '稀土价格 Transformer v1.2.0（已注册）');
  const listed = (await okData('GET', '/projects/p1/fl/jobs')).items;
  assert.equal(listed.find((j) => j.job_id === job.job_id).algo_ref_name, '稀土价格 Transformer v1.2.0（已注册）');
  assert.equal(listed.find((j) => j.job_id !== job.job_id).algo_ref_name, null);   // 内置算法与内核种子任务不带名称
  assert.equal((await okData('GET', '/fl/jobs/' + job.job_id)).algo_ref_name, '稀土价格 Transformer v1.2.0（已注册）');
  const started = await okData('POST', '/fl/jobs/' + job.job_id + '/actions', { action: 'start' });
  assert.equal(started.status, 'Running');
  assert.equal(started.algo_ref.version, '1.2.0');
  assert.equal((await okData('GET', '/projects/p1/fl/jobs?status=Running')).total, 1);
  const f = await okData('POST', '/files', { file: { name: 'tree.pkl', size: 9000 }, purpose: 'fl_model', project_id: 'p1' });
  const m = await okData('POST', '/projects/p1/fl/models', { file_id: f.file_id, name: '违约树模型' });
  const j2 = await okData('POST', '/projects/p1/fl/jobs', { ...CLS_JOB, algorithm: m.algo_id });
  assert.equal(j2.algo_ref_name, '违约树模型 v1.0.0（自定义模型）');
});
