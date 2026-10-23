// 隐私求交：数据接入 / 算法配置 / 平台集成。接口见 docs/api/psi.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { boot } from './_boot.mjs';

// 页面模块里的纯函数（csvProfile）在 vm 里加载，UI 只需提供 $
function loadPsiPage() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../js/psi.js', import.meta.url), 'utf8'), { window, UI: { $: () => null } });
  return window.PSI;
}

const NODES = ['node-shanghai-01', 'node-hangzhou-02', 'node-center-agg'];
const DB_BASE = { name: '采购台账', party_id: 'party-b', source_type: 'database',
  source: { jdbc_url: 'jdbc:postgresql://10.31.8.27:5432/ree', table: 'purchase_ledger' }, id_column: 'supplier_hash' };
const PARTIES = [
  { party_id: 'party-a', dataset_id: 'ds_p1_a_user', id_column: 'credit_code_hash' },
  { party_id: 'party-b', dataset_id: 'ds_p1_b_user', id_column: 'credit_code_hash' }
];
const pipeBody = (over) => ({ protocol: 'ecdh', parties: PARTIES, alignment: { feature_columns: [] }, ...over });

/* ---------- 数据接入 ---------- */

test('[PSI-DATA-01] 数据集登记：JDBC / HDFS / 文件上传三种来源，非法来源与重名被拒', async (t) => {
  const { okData, call } = boot(t);
  const db = await okData('POST', '/projects/p1/datasets', DB_BASE);
  assert.equal(db.source_type, 'database');
  assert.equal(db.source.table, 'purchase_ledger');
  const hdfs = await okData('POST', '/projects/p1/datasets', { ...DB_BASE, name: '出库流水', source_type: 'hdfs',
    source: { path: 'hdfs://10.31.8.27:8020/ree/outbound' }, time_column: 'out_date' });
  assert.equal(hdfs.time_column, 'out_date');
  const f = await okData('POST', '/files', { file: { name: 'nd2o3.csv', size: 20480 }, purpose: 'dataset', project_id: 'p1' });
  const file = await okData('POST', '/projects/p1/datasets', { ...DB_BASE, name: '氧化钕报价', source_type: 'file',
    source: { file_id: f.file_id, file_name: f.file_name } });
  assert.equal(file.source.file_name, 'nd2o3.csv');
  // 平台只存元数据，不返回原始行
  assert.equal(file.preview, undefined);

  assert.equal((await call('POST', '/projects/p1/datasets', { ...DB_BASE, source: { jdbc_url: 'mysql://x', table: 't' } })).code, 40000);
  assert.equal((await call('POST', '/projects/p1/datasets', { ...DB_BASE, source_type: 'hdfs', source: { path: '/ree' } })).code, 40000);
  assert.equal((await call('POST', '/projects/p1/datasets', { ...DB_BASE, source_type: 'ftp' })).code, 40000);
  assert.equal((await call('POST', '/projects/p1/datasets', DB_BASE)).code, 40902);
});

test('[PSI-DATA-02] 字段与脱敏预览：求交键 / 时间列标注，样例只给哈希前缀与打码值', async (t) => {
  const { okData, call, tick } = boot(t);
  await okData('GET', '/projects/p1/datasets');   // 首次访问项目时播种
  const seed = await okData('GET', '/datasets/ds_p1_a_txn_ts');
  assert.equal(seed.id_column, 'credit_code_hash');
  assert.equal(seed.time_column, 'txn_date');
  assert.ok(seed.columns.some((c) => c.name === 'txn_date' && c.type === 'date'));
  assert.equal(seed.preview.length, 3);
  assert.ok(Object.keys(seed.preview[0]).length <= 6, '样例最多 6 列');
  assert.match(seed.preview[0].credit_code_hash, /^[0-9a-f]{6}…$/);

  const ds = await okData('POST', '/projects/p1/datasets', DB_BASE);
  assert.deepEqual((await okData('GET', '/datasets/' + ds.dataset_id)).preview, [], '接入完成前无样例');
  tick(1200);
  const ready = await okData('GET', '/datasets/' + ds.dataset_id);
  assert.match(ready.preview[0].supplier_hash, /…$/);
  assert.equal((await call('GET', '/datasets/ds_nope')).code, 40400);
});

test('[PSI-DATA-03] 状态流转与删除保护：接入中→已就绪；被运行中流水线引用时 40901，结束后可删', async (t) => {
  const { okData, call, tick } = boot(t);
  const ds = await okData('POST', '/projects/p1/datasets', DB_BASE);
  assert.equal(ds.status, 'importing');
  assert.equal(ds.row_count, null);
  // 未就绪的数据集不能用于求交
  const r = await call('POST', '/projects/p1/psi/pipelines', pipeBody({ parties: [PARTIES[0], { party_id: 'party-b', dataset_id: ds.dataset_id, id_column: 'supplier_hash' }] }));
  assert.equal(r.code, 40901);
  tick(1200);
  assert.equal((await okData('GET', '/datasets/' + ds.dataset_id)).status, 'ready');

  const pipe = await okData('POST', '/projects/p1/psi/pipelines', pipeBody());
  const del = await call('DELETE', '/datasets/ds_p1_b_user');
  assert.equal(del.code, 40901);
  assert.match(del.message, /运行中/);
  await okData('POST', '/psi/pipelines/' + pipe.pipeline_id + '/cancel');
  assert.equal((await okData('DELETE', '/datasets/ds_p1_b_user')).deleted, true);
  assert.equal((await call('DELETE', '/datasets/ds_p1_b_user')).code, 40400);
});

test('[PSI-DATA-01] 文件来源行数（D13）：按前端解析的行数与表头登记；无解析值时按文件大小估算并标注；表头缺求交键被拒', async (t) => {
  const { okData, call, tick } = boot(t);
  const PSI = loadPsiPage();
  const csv = '\uFEFFsupplier_hash,trade_date,ceo2_price,grade\r\na91f03,2026-09-18,7350.5,4N\r\n\r\n';
  const prof = JSON.parse(JSON.stringify(PSI.csvProfile(csv)));   // vm 沙箱对象，JSON 往返后再比较
  assert.equal(prof.row_count, 1, '表头 + 1 行 = 1 行数据，末尾空行不计');
  assert.deepEqual(prof.columns.map((c) => c.type), ['string', 'date', 'float', 'string']);
  assert.match(PSI.csvProfile('').error, /为空/);
  assert.match(PSI.csvProfile('供应商,价格\n1,2').error, /不合法/);
  assert.match(PSI.csvProfile('a,a\n1,2').error, /重复/);

  const f = await okData('POST', '/files', { file: { name: 'ceo2_price.csv', size: 82 }, purpose: 'dataset', project_id: 'p1' });
  const base = { name: '氧化铈报价', party_id: 'party-b', source_type: 'file', source: { file_id: f.file_id, file_name: f.file_name },
    id_column: 'supplier_hash', time_column: 'trade_date' };
  const ds = await okData('POST', '/projects/p1/datasets', { ...base, row_count: prof.row_count, columns: prof.columns });
  tick(1200);
  const v = await okData('GET', '/datasets/' + ds.dataset_id);
  assert.equal(v.row_count, 1);
  assert.deepEqual(v.columns.map((c) => c.name), ['supplier_hash', 'trade_date', 'ceo2_price', 'grade']);
  assert.equal(v.source.row_count_basis, 'parsed');
  assert.equal(v.feature_count, 2);

  const est = await okData('POST', '/projects/p1/datasets', { ...base, name: '氧化铈报价（Parquet）' });
  assert.equal(est.row_count, null);
  tick(1200);
  const ev = await okData('GET', '/datasets/' + est.dataset_id);
  assert.equal(ev.source.row_count_basis, 'size_estimate');
  assert.equal(ev.row_count, Math.round(82 / 64), '估算口径：文件大小 ÷ 64 字节 / 行');

  const bads = [
    [{ ...base, name: 'x1', row_count: 1, columns: [{ name: 'price', type: 'float' }] }, 40000, /没有求交键列 supplier_hash/],
    [{ ...base, name: 'x2', row_count: -1, columns: prof.columns }, 40002, /row_count/],
    [{ ...base, name: 'x3', row_count: 1, columns: [{ name: 'supplier_hash', type: 'blob' }] }, 40002, /类型/],
    [{ ...base, name: 'x4', time_column: 'ts', row_count: 1, columns: prof.columns }, 40000, /没有时间列 ts/]
  ];
  for (const [body, code, rx] of bads) {
    const r = await call('POST', '/projects/p1/datasets', body);
    assert.equal(r.code, code, r.message);
    assert.match(r.message, rx);
  }
});

test('[PSI-DATA-03][PSI-PIPE-02] 删除数据集不改写已完成流水线（D14）：统计量与数据集名在完成后固化', async (t) => {
  const { okData, call, tick } = boot(t);
  await okData('GET', '/projects/p1/datasets');
  const pipe = await okData('POST', '/projects/p1/psi/pipelines', pipeBody());
  tick(30 * 160);
  const before = await okData('GET', '/psi/pipelines/' + pipe.pipeline_id);
  assert.equal(before.status, 'finished');
  assert.ok(before.stats_snapshot_at);

  await okData('DELETE', '/datasets/ds_p1_b_user');
  const after = await okData('GET', '/psi/pipelines/' + pipe.pipeline_id);
  assert.deepEqual(after.stages.map((s) => s.stats), before.stages.map((s) => s.stats));
  assert.ok(after.stages[0].stats.right_rows > 0 && after.stages[0].stats.intersection_rows > 0, '删除后不归零');
  assert.equal(after.parties[1].dataset_name, before.parties[1].dataset_name);
  assert.ok(after.parties[1].dataset_name);
  const hist = (await okData('GET', '/projects/p1/psi/pipelines')).items;
  assert.deepEqual(hist.find((x) => x.pipeline_id === pipe.pipeline_id).stages[1].stats, before.stages[1].stats);
  // 被删的数据集不能再用于新流水线
  assert.equal((await call('POST', '/projects/p1/psi/pipelines', pipeBody())).code, 40400);
});

test('[PSI-DATA-02] 上传文件的脱敏样例取文件真实前几行（D36）；未解析的文件不给样例；样例行形状不对被拒', async (t) => {
  const { okData, call, tick } = boot(t);
  const PSI = loadPsiPage();
  const prof = JSON.parse(JSON.stringify(PSI.csvProfile('series_id,trade_date,ceo2_price,grade\nCeO2-A,2026-10-01,7350,4N\nCeO2-B,2026-10-02,7420,5N\n')));
  assert.deepEqual(prof.sample, [['CeO2-A', '2026-10-01', '7350', '4N'], ['CeO2-B', '2026-10-02', '7420', '5N']]);
  const f = await okData('POST', '/files', { file: { name: 'ceo2_price.csv', size: 90 }, purpose: 'dataset', project_id: 'p1' });
  const base = { name: '氧化铈报价', party_id: 'party-b', source_type: 'file', source: { file_id: f.file_id },
    id_column: 'series_id', time_column: 'trade_date', row_count: prof.row_count, columns: prof.columns };
  const ds = await okData('POST', '/projects/p1/datasets', { ...base, sample_rows: prof.sample });
  assert.equal(ds.sample_rows, undefined, '原始样例不随响应下发');
  tick(1200);
  const v = await okData('GET', '/datasets/' + ds.dataset_id);
  assert.equal(v.preview.length, 2, '文件只有 2 行时只显示 2 行');
  assert.match(v.preview[0].series_id, /^[0-9a-f]{6}…$/);
  assert.notEqual(v.preview[0].series_id, v.preview[1].series_id, '哈希前缀来自各行真实值');
  assert.deepEqual(v.preview.map((r) => r.trade_date), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(v.preview.map((r) => r.ceo2_price), ['7,300 – 7,400', '7,400 – 7,500']);
  assert.equal(v.preview[0].grade, '***');

  const raw = await okData('POST', '/projects/p1/datasets', { name: '镧现货', party_id: 'party-b', source_type: 'file',
    source: { file_id: f.file_id }, id_column: 'series_id' });
  tick(1200);
  const rv = await okData('GET', '/datasets/' + raw.dataset_id);
  assert.deepEqual(rv.preview, []);
  assert.match(rv.preview_note, /未在浏览器解析/);

  for (const sr of [[['only-one-col']], [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]], 'x']) {
    assert.equal((await call('POST', '/projects/p1/datasets', { ...base, name: 'bad' + JSON.stringify(sr).length, sample_rows: sr })).code, 40002);
  }
});

test('[PSI-PIPE-01][PSI-PIPE-02] 交集不足时求交阶段失败（D37）：后两阶段跳过、不生成训练任务、给出原因', async (t) => {
  const { okData, call, tick, M } = boot(t);
  await okData('GET', '/projects/p1/datasets');
  const f = await okData('POST', '/files', { file: { name: 'tiny.csv', size: 60 }, purpose: 'dataset', project_id: 'p1' });
  const tiny = await okData('POST', '/projects/p1/datasets', { name: '两行小表', party_id: 'party-b', source_type: 'file',
    source: { file_id: f.file_id }, id_column: 'credit_code_hash', row_count: 2,
    columns: [{ name: 'credit_code_hash', type: 'string' }, { name: 'stock_t', type: 'float' }] });
  tick(1200);
  const jobsBefore = (await okData('GET', '/projects/p1/fl/jobs')).total;
  const pipe = await okData('POST', '/projects/p1/psi/pipelines', pipeBody({
    parties: [PARTIES[0], { party_id: 'party-b', dataset_id: tiny.dataset_id, id_column: 'credit_code_hash' }],
    training: { fl_job_config: { task_type: 'classification', algorithm: 'xgb', aggregation: 'he', node_ids: NODES }, auto_start: false }
  }));
  let ev = null;
  const seen = [];
  M.subscribe('/psi/pipelines/' + pipe.pipeline_id + '/events', {
    pipeline_finished: (e) => { ev = e; }, stage_progress: (s) => seen.push(s.stage + ':' + s.status)
  });
  tick(30 * 160);
  assert.equal(ev.status, 'failed');
  assert.equal(ev.fl_job_id, null);
  assert.match(ev.error, /求交结果 1 条，少于联合训练所需的最少 100 条/);   // 2 行 → round(2 × 0.4769) = 1
  assert.ok(!seen.includes('align:running'), '特征对齐不应开始');
  const v = await okData('GET', '/psi/pipelines/' + pipe.pipeline_id);
  assert.equal(v.status, 'failed');
  assert.deepEqual(v.stages.map((s) => s.status), ['failed', 'skipped', 'skipped']);
  assert.equal(v.stages[0].stats.intersection_rows, 1);
  assert.equal(v.fl_job_id, null);
  assert.equal((await okData('GET', '/projects/p1/fl/jobs')).total, jobsBefore, '不生成训练任务');
  // 失败的流水线不能作为训练数据来源
  const r = await call('POST', '/projects/p1/fl/jobs', { task_type: 'classification', algorithm: 'xgb', aggregation: 'he', node_ids: NODES,
    dataset_source: { type: 'psi_pipeline', pipeline_id: pipe.pipeline_id } });
  assert.equal(r.code, 40901);
  // 小表交集不再按千取整：5 000 行 × 120 万行 → round(5000 × 0.4769) = 2385 条，≥ 100 可继续
  const f2 = await okData('POST', '/files', { file: { name: 'mid.csv', size: 4096 }, purpose: 'dataset', project_id: 'p1' });
  const mid = await okData('POST', '/projects/p1/datasets', { name: '五千行表', party_id: 'party-b', source_type: 'file',
    source: { file_id: f2.file_id }, id_column: 'credit_code_hash', row_count: 5000,
    columns: [{ name: 'credit_code_hash', type: 'string' }, { name: 'stock_t', type: 'float' }] });
  tick(1200);
  const pm = await okData('POST', '/projects/p1/psi/pipelines', pipeBody({
    parties: [PARTIES[0], { party_id: 'party-b', dataset_id: mid.dataset_id, id_column: 'credit_code_hash' }] }));
  tick(30 * 60);
  const mv = await okData('GET', '/psi/pipelines/' + pm.pipeline_id);
  assert.equal(mv.stages[0].stats.intersection_rows, 2385);
  assert.notEqual(mv.status, 'failed');
  assert.equal(mv.stages[1].stats.rows, 2385);
  await okData('POST', '/psi/pipelines/' + pm.pipeline_id + '/cancel');
  // 演示环境刷新中断（内核把运行中记录置 failed 并写 error）：在未完成的阶段失败，之后跳过
  const p2 = await okData('POST', '/projects/p1/psi/pipelines', pipeBody());
  tick(30 * 70);
  const raw = M._db.psiPipelines[p2.pipeline_id];
  clearInterval(raw._timer);
  raw.status = 'failed';
  raw.error = '演示环境页面刷新，运行中的任务被中断，请重新发起';
  const iv = await okData('GET', '/psi/pipelines/' + p2.pipeline_id);
  assert.deepEqual(iv.stages.map((s) => s.status), ['finished', 'failed', 'skipped']);
  assert.match(iv.error, /中断/);
  // 模板合并与参数校验
  assert.equal((await call('POST', '/projects/p1/psi/pipelines', pipeBody({ params: { batch_size: 7 } }))).code, 40003);
  assert.equal((await call('POST', '/projects/p1/psi/pipelines', pipeBody({ template_id: 'tpl_nope' }))).code, 40400);
});

/* ---------- 算法配置 ---------- */

test('[PSI-ALGO-01] 三种 PSI 协议：ECDH-PSI / KKRT / 非平衡 PSI，均标注 128 位安全强度', async (t) => {
  const { okData, call } = boot(t);
  const items = (await okData('GET', '/psi/protocols')).items;
  assert.deepEqual(items.map((p) => p.protocol), ['ecdh', 'kkrt', 'unbalanced']);
  items.forEach((p) => assert.equal(p.security.security_bits, 128, p.protocol));
  const ecdh = items[0];
  assert.deepEqual(ecdh.params.find((x) => x.key === 'curve').options.map((o) => o.value), ['Curve25519', 'P-256']);
  assert.match(items[1].security.detail, /λ = 128/);
  // 内核字段保持兼容
  assert.equal(ecdh.params[0].label, '椭圆曲线');
  assert.equal((await call('PUT', '/projects/p1/psi/config', { protocol: 'rsa' })).code, 40000);
});

test('[PSI-ALGO-02] 参数调优：按协议给出参数类型与范围；类型 / 越界 / 未知参数被拒，合法参数保存为当前配置', async (t) => {
  const { okData, call } = boot(t);
  const def = await okData('GET', '/projects/p1/psi/config');
  assert.equal(def.protocol, 'ecdh');
  assert.equal(def.source, 'default');
  const kkrt = (await okData('GET', '/psi/protocols')).items[1];
  const cf = kkrt.params.find((x) => x.key === 'cuckoo_bucket_factor');
  assert.deepEqual([cf.type, cf.min, cf.max], ['float', 1.1, 2.0]);

  const bads = [
    [{ protocol: 'ecdh', params: { batch_size: 100 } }, 40003, /1024 – 65536/],
    [{ protocol: 'ecdh', params: { batch_size: 2048.5 } }, 40002, /整数/],
    [{ protocol: 'ecdh', params: { point_compression: 'yes' } }, 40002, /布尔/],
    [{ protocol: 'ecdh', params: { curve: 'secp256k1' } }, 40003, /Curve25519 \/ P-256/],
    [{ protocol: 'kkrt', params: { ot_security_lambda: 80 } }, 40003, /128 \/ 256/],
    [{ protocol: 'kkrt', params: { curve: 'P-256' } }, 40000, /没有参数 curve/]
  ];
  for (const [body, code, rx] of bads) {
    const r = await call('PUT', '/projects/p1/psi/config', body);
    assert.equal(r.code, code, r.message);
    assert.match(r.message, rx);
  }
  const saved = await okData('PUT', '/projects/p1/psi/config', { protocol: 'kkrt', params: { cuckoo_bucket_factor: 1.5 } });
  assert.equal(saved.source, 'manual');
  assert.equal(saved.params.cuckoo_bucket_factor, 1.5);
  assert.equal(saved.params.ot_security_lambda, 128, '未传参数取协议默认值');
  assert.equal((await okData('GET', '/projects/p1/psi/config')).protocol, 'kkrt');
  // 配置按项目隔离
  assert.equal((await okData('GET', '/projects/p2/psi/config')).protocol, 'ecdh');
});

test('[PSI-ALGO-03] 配置模板：内置模板 + 保存 / 加载 / 删除；重名、非法参数、删内置被拒', async (t) => {
  const { okData, call } = boot(t);
  const seed = (await okData('GET', '/projects/p1/psi/templates')).items;
  assert.equal(seed.length, 2);
  assert.ok(seed.every((x) => x.builtin));

  const tpl = await okData('POST', '/projects/p1/psi/templates', { name: '稀土报价 · 非平衡', protocol: 'unbalanced',
    params: { small_set_party_id: 'party-a', oprf_batch_size: 1024 } });
  assert.equal(tpl.params.poly_degree, 1305);
  const list = (await okData('GET', '/projects/p1/psi/templates')).items;
  assert.equal(list[0].template_id, tpl.template_id, '最新在前');
  assert.equal((await okData('GET', '/projects/p1/psi/templates?protocol=unbalanced')).total, 1);

  // 加载 = 设为当前配置
  const cfg = await okData('PUT', '/projects/p1/psi/config', { protocol: tpl.protocol, params: tpl.params, template_id: tpl.template_id });
  assert.equal(cfg.source, 'template');
  assert.equal(cfg.template_name, '稀土报价 · 非平衡');
  assert.equal((await call('PUT', '/projects/p1/psi/config', { protocol: 'ecdh', params: {}, template_id: tpl.template_id })).code, 40000);

  assert.equal((await call('POST', '/projects/p1/psi/templates', { name: '稀土报价 · 非平衡', protocol: 'ecdh', params: {} })).code, 40902);
  assert.equal((await call('POST', '/projects/p1/psi/templates', { name: '', protocol: 'ecdh', params: {} })).code, 40000);
  assert.equal((await call('POST', '/projects/p1/psi/templates', { name: 'x', protocol: 'ecdh', params: { batch_size: 0 } })).code, 40003);
  assert.equal((await call('DELETE', '/psi/templates/' + seed[0].template_id)).code, 40901);

  await okData('DELETE', '/psi/templates/' + tpl.template_id);
  assert.equal((await call('GET', '/psi/templates/' + tpl.template_id)).code, 40400);
  const after = await okData('GET', '/projects/p1/psi/config');
  assert.equal(after.template_id, null, '模板删除后当前配置不再引用它');
  assert.equal(after.protocol, 'unbalanced');
});

test('[PSI-ALGO-04] 自适应路由：按规模与网络推荐协议，给出三协议耗时 / 通信量对比、理由与典型场景；非法输入被拒', async (t) => {
  const { okData, call } = boot(t);
  const advise = (b) => okData('POST', '/psi/route-advice', b);

  const unb = await advise({ left_rows: 100000000, right_rows: 10000, bandwidth_mbps: 100, latency_ms: 30 });
  assert.equal(unb.recommended.protocol, 'unbalanced');
  assert.equal(unb.recommended.params.small_set_party_id, 'party-b', '小集合方为行数少的一方');
  assert.match(unb.reason, /100 : 1/);
  assert.equal(unb.estimates.length, 3);
  unb.estimates.forEach((e) => {
    assert.ok(e.total_sec > 0 && e.comm_mb > 0, e.protocol);
    assert.equal(e.security_bits, 128);
  });

  // ECDH 通信量 ≈ (n_A + n_B) × 32 字节
  const lan = await advise({ left_rows: 1000000, right_rows: 1000000, bandwidth_mbps: 1000, latency_ms: 1 });
  const ecdh = lan.estimates.find((e) => e.protocol === 'ecdh');
  assert.equal(ecdh.comm_mb, Number((2e6 * 32 / 1048576).toFixed(2)));
  const kkrt = lan.estimates.find((e) => e.protocol === 'kkrt');
  assert.ok(kkrt.comm_mb > ecdh.comm_mb && kkrt.compute_sec < ecdh.compute_sec, 'KKRT 通信更高但计算更快');
  assert.equal(lan.recommended.protocol, 'kkrt');

  // 窄带宽下通信成为瓶颈，转向 ECDH，并调大分块减少往返
  const slow = await advise({ left_rows: 1000000, right_rows: 1000000, bandwidth_mbps: 5, latency_ms: 40 });
  assert.equal(slow.recommended.protocol, 'ecdh');
  assert.equal(slow.recommended.params.batch_size, 65536);
  // 同输入同输出
  assert.deepEqual(await advise({ left_rows: 1000000, right_rows: 1000000, bandwidth_mbps: 5, latency_ms: 40 }), slow);

  // 采用推荐写回当前配置
  const cfg = await okData('PUT', '/projects/p1/psi/config', { protocol: slow.recommended.protocol, params: slow.recommended.params, source: 'route_advice' });
  assert.equal(cfg.source, 'route_advice');
  assert.equal(cfg.params.batch_size, 65536);

  const bench = (await okData('GET', '/psi/benchmarks')).items;
  assert.equal(bench.length, 6);
  assert.deepEqual([...new Set(bench.map((b) => b.scale_label))], ['10 万 × 10 万', '100 万 × 100 万', '1 亿 × 1 万']);
  assert.equal(bench.find((b) => b.scenario_id === 's3_wan').recommended, 'unbalanced');

  const bads = [
    [{ right_rows: 1, bandwidth_mbps: 1, latency_ms: 1 }, 40000],
    [{ left_rows: 'many', right_rows: 1, bandwidth_mbps: 1, latency_ms: 1 }, 40002],
    [{ left_rows: 1.5, right_rows: 1, bandwidth_mbps: 1, latency_ms: 1 }, 40002],
    [{ left_rows: 1, right_rows: 1, bandwidth_mbps: 0, latency_ms: 1 }, 40003],
    [{ left_rows: 1, right_rows: 1, bandwidth_mbps: 1, latency_ms: 5000 }, 40003]
  ];
  for (const [b, code] of bads) assert.equal((await call('POST', '/psi/route-advice', b)).code, code, JSON.stringify(b));
});

/* ---------- 平台集成 ---------- */

test('[PSI-PIPE-01] 一键启动：用当前算法配置启动 安全求交→特征对齐→联合训练，完成后生成 FL 任务；非法两方被拒', async (t) => {
  const { okData, call, tick, M } = boot(t);
  await okData('GET', '/projects/p1/datasets');
  const cfg = await okData('PUT', '/projects/p1/psi/config', { protocol: 'kkrt', params: { hash_count: 4 } });
  const fl = { task_type: 'classification', algorithm: 'xgb', aggregation: 'he', node_ids: NODES };
  const pipe = await okData('POST', '/projects/p1/psi/pipelines',
    pipeBody({ protocol: cfg.protocol, params: cfg.params, training: { fl_job_config: fl, auto_start: false } }));
  assert.equal(pipe.protocol, 'kkrt');
  assert.equal(pipe.status, 'running');
  assert.deepEqual(pipe.stages.map((s) => s.stage), ['intersect', 'align', 'train']);

  let done = null;
  M.subscribe('/psi/pipelines/' + pipe.pipeline_id + '/events', { pipeline_finished: (e) => { done = e; } });
  const last = {};
  M.subscribe('/psi/pipelines/' + pipe.pipeline_id + '/events', { stage_progress: (st) => { last[st.stage] = st.status; } });
  tick(30 * 160);
  assert.equal(done.status, 'finished');
  assert.deepEqual(last, { intersect: 'finished', align: 'finished', train: 'finished' }, 'SSE 最后一帧三阶段均为已完成');
  const job = await okData('GET', '/fl/jobs/' + done.fl_job_id);
  assert.deepEqual(job.dataset_source, { type: 'psi_pipeline', pipeline_id: pipe.pipeline_id });
  assert.equal(done.target_project.project_id, 'p1');

  const bads = [
    pipeBody({ parties: [PARTIES[0], { ...PARTIES[1], party_id: 'party-a' }] }),
    pipeBody({ parties: [PARTIES[0]] }),
    pipeBody({ parties: [PARTIES[0], { ...PARTIES[1], id_column: 'nope' }] })
  ];
  for (const b of bads) assert.equal((await call('POST', '/projects/p1/psi/pipelines', b)).code, 40000);
  assert.equal((await call('POST', '/projects/p1/psi/pipelines', pipeBody({ parties: [PARTIES[0], { ...PARTIES[1], dataset_id: 'ds_x' }] }))).code, 40400);
});

test('[PSI-PIPE-02] 进度跟踪：各阶段状态、进度、执行时长、数据量随 SSE 推进；取消后归零，不存在的流水线 40400', async (t) => {
  const { okData, call, tick, M } = boot(t);
  await okData('GET', '/projects/p1/datasets');
  const pipe = await okData('POST', '/projects/p1/psi/pipelines', pipeBody());
  const seen = {};
  M.subscribe('/psi/pipelines/' + pipe.pipeline_id + '/events', { stage_progress: (s) => { seen[s.stage] = s; } });

  tick(30 * 60);   // 约 120 个百分点：求交完成、对齐进行中
  let v = await okData('GET', '/psi/pipelines/' + pipe.pipeline_id);
  assert.equal(v.stages[0].status, 'finished');
  assert.equal(v.stages[0].duration_sec, 46);
  assert.ok(v.stages[0].stats.intersection_rows > 0 && v.stages[0].stats.intersection_rows <= Math.min(v.stages[0].stats.left_rows, v.stages[0].stats.right_rows));
  assert.equal(v.stages[1].status, 'running');
  assert.ok(v.stages[1].progress_pct > 0 && v.stages[1].progress_pct < 100);
  assert.equal(v.stages[1].stats.feature_dim, 68);
  assert.equal(v.stages[2].status, 'pending');
  assert.equal(v.stages[2].duration_sec, null);
  assert.equal(seen.align.status, 'running', 'SSE 推送阶段进度');

  // 历史列表可恢复最近一条（页面切回时用）
  const hist = (await okData('GET', '/projects/p1/psi/pipelines')).items;
  assert.equal(hist[hist.length - 1].pipeline_id, pipe.pipeline_id);

  v = await okData('POST', '/psi/pipelines/' + pipe.pipeline_id + '/cancel');
  assert.equal(v.status, 'canceled');
  assert.ok(v.stages.every((s) => s.progress_pct === 0));
  assert.equal((await call('GET', '/psi/pipelines/psi_nope')).code, 40400);
});
