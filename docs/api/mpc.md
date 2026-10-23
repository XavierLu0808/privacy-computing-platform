# 多方安全计算 MPC（v1.2 增补）

页面：「多方安全计算 / 协议管理」`#/mpc/proto`（页面模块 `MPCP`，js/mpc-proto.js）、「多方安全计算 / 运维监控」`#/mpc/ops`（页面模块 `MPC`，js/mpc.js）。

本片段在 API.md §4 的基础上新增协议目录、参与方候选、项目级协议参数、多步计算流程、试运行、扩展性能预估、任务对比与带筛选的报表导出。§4.1–§4.5 的请求和响应保持兼容（只补字段）：旧调用 `protocol + operator + parties[].role` 仍可用。mock 实现在 js/mock/mpc.js，用 `routeFirst` 覆盖内核 §4 的 5 条 MPC 路由，自有数据在 `k.db.mpc`（`tasks` / `params` / `seeded`），不写内核的 `db.mpcTasks`；只读内核 `db.nodes`（参与方候选取自项目节点）与 `db.projects`。

错误码沿用 API.md §9：`40000` 参数不合法（含流程类型不匹配、参与方 / 角色不满足要求）、`40001` 算子与协议不兼容、`40002` 值格式错误、`40003` 越界、`40400` 不存在、`40901` 当前状态不允许。所有校验错误在 `data.field` 给出出错字段（如 `steps[1].protocol`、`parties`、`frac_bits`）。

v1.2 与 §4.3 的差异：异常判定规则由「通信量 > 均值 × 1.35」改为「通信量或计算耗时偏离全部参与方均值超过阈值（默认 50%）」，阈值可在创建任务时配置；新增告警类型 `compute_anomaly`。

## M.1 协议与算子目录

服务：MPC-PROTO-01、MPC-PROTO-02、MPC-PROTO-03、MPC-PROTO-04。对应「协议目录」三张卡片与流程编排的算子下拉。

```
GET /mpc/protocols
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `protocols[]` | array | 3 个协议 |
| `protocols[].protocol` | string | `ss` 秘密共享 / `gc` 混淆电路 / `ot` 不经意传输扩展 |
| `protocols[].name` / `full_name` | string | 例 `秘密共享` / `加法秘密共享（Additive Secret Sharing）` |
| `protocols[].principle` | string | 原理一句话 |
| `protocols[].security_models[]` | array | `[{ key: "semi_honest", name: "半诚实" }, { key: "malicious", name: "恶意" }]`，第一个为默认 |
| `protocols[].security_note` | string | 安全模型说明及其代价 |
| `protocols[].rounds_note` | string | 通信轮数特征 |
| `protocols[].operators` | string[] | 适用算子 key |
| `protocols[].params_schema[]` | array | 参数定义，见 M.3 |
| `protocols[].default_params` | object | 默认参数 |
| `protocols[].acc` | string | 对应验收编号 |
| `operators[]` | array | 7 个算子 |
| `operators[].key` / `name` | string | 见下表 |
| `operators[].protocols` | string[] | 兼容协议 |
| `operators[].io` | object | 输入类型 → 输出类型，例 `{ "parties": "vector", "vector": "scalar" }` |
| `operators[].desc` | string | 语义说明 |
| `value_types[]` | array | `parties` 各方私有数据 / `vector` 密态向量 / `scalar` 密态标量 / `bool_vector` 密态布尔向量 / `bool` 密态布尔值 |
| `roles[]` | array | `input` 输入方 / `compute` 计算方 / `output` 输出方 |

算子（`MpcOperator`，v1.2 新增 `secure_sum`、`secure_max`）：

| key | 名称 | 协议 | 输入 → 输出 | 算子参数 `operand` |
|---|---|---|---|---|
| `secure_sum` | 安全求和 | ss | parties → vector（逐行求和）；vector → scalar（全部行求和） | — |
| `secure_product` | 安全求积 | ss | parties → vector（逐行相乘）；vector → vector、scalar → scalar（乘公开系数） | 非首步必填 `factor`（number） |
| `secure_mean` | 安全求均值 | ss | parties → vector；vector → scalar | — |
| `secure_compare` | 安全比较 | gc | parties → bool_vector（前两个输入方逐行比较，百万富翁问题）；vector → bool_vector；scalar → bool | 非首步必填 `threshold`（number）、`cmp`（`gt` / `lt`，默认 `gt`） |
| `secure_max` | 安全最大值 | gc | parties → vector；vector → scalar | — |
| `logic_op` | 逻辑运算 | gc | bool_vector → bool（`and` / `or`）；bool → bool、bool_vector → bool_vector（`not`） | `mode`：`and` / `or` / `not` |
| `vector_ot` | 向量 OT | ot | parties → vector（各输入方第 i 行）；vector → scalar（第 i 个元素） | 必填 `index`（整数，1 ≤ i ≤ 数据行数） |

## M.2 参与方候选

服务：MPC-PROTO-05。对应「参与方与角色」表格。

```
GET /projects/{project_id}/mpc/parties
```

响应 `data`：`{ items[], min_parties: 3 }`。`items[]`：`party_id`（`party-a` …）、`tag`（`A`）、`name`（`参与方 A`）、`node_id`（项目节点 ID，例 `node-ganzhou-03`）、`ip`、`online`、`default_roles`（建议角色，例 `["input", "compute"]`）。项目节点不足 3 个时补齐 `node-mpc-0x` 虚拟节点。错误：`40400` 项目不存在。

## M.3 协议参数（项目级）

服务：MPC-PROTO-06。对应「协议参数」卡（协议页签、高级模式、恢复默认、保存参数）。

```
GET    /projects/{project_id}/mpc/params
PUT    /projects/{project_id}/mpc/params/{protocol}     body: { "params": { … } }
DELETE /projects/{project_id}/mpc/params/{protocol}     恢复默认
```

GET 响应 `data.items[]`：`{ protocol, params, defaults, customized }`；PUT / DELETE 响应单个协议的同结构对象。PUT 以默认值为底合并请求字段并整体校验；保存后该项目新建任务、预估、试运行在未显式传 `params` 时都使用保存值。

参数定义（`params_schema[]` 字段：`key`、`label`、`type`（`enum` / `int` / `bool`）、`options` 或 `min` / `max`、`default`、`unit`、`desc`）：

| 协议 | key | 名称 | 类型 / 范围 | 默认 |
|---|---|---|---|---|
| ss | `ring_bits` | 环大小 ℓ | enum 32 / 64 / 128 bit | 64 |
| ss | `frac_bits` | 定点小数位 f | int 0–64 bit，且 ≤ ℓ / 2 | 16 |
| ss | `security_model` | 安全模型 | `semi_honest` / `malicious` | `semi_honest` |
| gc | `free_xor` | Free-XOR | bool | true |
| gc | `half_gates` | 半门优化 | bool | true |
| gc | `bit_width` | 电路位宽 b | int 8–64 bit | 32 |
| gc | `security_model` | 安全模型 | 同上 | `semi_honest` |
| ot | `base_ot_count` | 基础 OT 数 k | int 128–256 次 | 128 |
| ot | `batch_size` | 扩展批大小 B | int 1,024–1,048,576 条 / 批 | 65,536 |
| ot | `security_model` | 安全模型 | 同上 | `semi_honest` |

计算安全参数 κ = 128 bit 固定。错误：未知协议 `40400`；未知参数 `40000`；类型不符或不在枚举内 `40002`；越界 `40003`（`data.min` / `data.max` 给出边界）。

## M.4 性能预估

服务：MPC-PROTO-07。对应「性能预估」卡（数据规模、带宽、RTT 输入，4 个指标，逐步明细，公式说明）。

```
POST /projects/{project_id}/mpc/estimate
GET  /projects/{project_id}/mpc/estimate?protocol=&operator=&steps=&party_count=&party_ids=&data_rows=&bandwidth_mbps=&rtt_ms=
```

POST 请求：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是 | 计算流程，同 M.5 |
| `party_count` | int | 否 | 3–8，默认 3；给了 `parties[]` 时取其长度 |
| `data_rows` | int | 否 | 每个输入方的数据行数 m，1–100,000,000，默认 1,200,000 |
| `bandwidth_mbps` | number | 否 | 单方链路带宽，1–10,000 Mbps，默认 100 |
| `rtt_ms` | number | 否 | 往返时延，0–1,000 ms，默认 20 |
| `params` | object | 否 | `{ ss: {…}, gc: {…}, ot: {…} }`，未给的用项目保存值 |

GET 兼容 §4.1：只传 `protocol`（+ 可选 `operator`）时按该算子的默认单步流程预估，并返回 `protocol`、`operators[]`；`steps=secure_sum:ss,secure_mean:ss` 形式可传多步（无算子参数）。

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `party_count` / `data_rows` | int | n / m |
| `est_compute_sec` | number | 预估计算耗时（秒）：Σ 各步单方关键路径计算时间，各方并行 |
| `est_comm_sec` | number | 预估通信耗时（秒）= 传输 + 时延 |
| `comm_breakdown` | object | `transfer_sec` = (通信量 / n) × 8 / 带宽；`latency_sec` = 总轮数 × RTT |
| `est_total_sec` | number | 计算 + 通信 |
| `est_comm_bytes` / `est_comm_mb` | int / number | 预估通信量：全体参与方发送字节之和；MB = 字节 / 1,048,576 |
| `rounds` | int | 总交互轮数 |
| `steps[]` | array | 逐步明细 `{ index, name, operator?, protocol, bytes, compute_sec, rounds, formula }`；含「输入分享」（index 0）与协议切换时的「A2Y / Y2A 份额转换」（index x.5） |
| `assumptions` | object | `bandwidth_mbps`、`rtt_ms`、`kappa_bits` |
| `formula` | object | `compute`、`comm_volume`、`comm_time` 公式文本 |
| `params` | object | 仅 POST：实际采用的三协议参数 |

代价模型（单元素，w = ℓ / 8 字节，κ = 16 字节；计算常数为原型标定值）：

| 步骤 | 通信字节 | 轮数 | 单方计算 |
|---|---|---|---|
| 输入分享（首步为 ss 且作用于各方数据） | n(n−1) · w · m | 1 | m × 0.5 µs × ℓ/64 |
| ss 求和 | 0（本地） | 0 | 元素数 × n × 0.4 µs |
| ss 求均值 | n(n−1) · w × 输出元素数（定点截断 1 次打开） | 1 | 同求和 + 截断 1.5 µs / 元素 |
| ss 求积（各方数据） | 2 · n(n−1) · w · m · (n−1)（每次 Beaver 乘法打开 2 个值） | 2⌈log₂ n⌉ | m × (n−1) × 2 µs |
| ss 求积（乘公开系数） | n(n−1) · w × 元素数 | 1 | 1.5 µs / 元素 |
| gc 门电路 | AND 门数 × (半门 2κ / GRR3 3κ) + XOR 门数 × (Free-XOR 0 / 3κ) + 输入比特 × 3κ | 4 | AND 0.25 / 0.35 µs，XOR 0.01 / 0.3 µs，输入 0.6 µs / bit |
| 比较 b 位 | AND = b，XOR = 3b | | |
| 最大值 k 个数 | AND = 2b(k−1)，XOR = 5b(k−1) | | |
| ot 向量 OT | n · m · (k/8 + 16) + k × 96（基础 OT） | 3 + 2⌈m / B⌉ | m × 0.6 µs × k/128 + k × 0.5 ms |
| A2Y 转换（ss → gc） | 元素数 × (b × AND 代价 + 2b × 48) | 2 | 元素数 × b × 0.25 µs |
| Y2A 转换（gc → ss） | 元素数 × b × (16 + 2w) | 2 | 元素数 × b × 0.6 µs |

恶意模型：ss 通信 ×2、计算 ×2.2；gc 通信与计算 ×3；ot ×1.05。

错误：`party_count` < 3 → `40000`，> 8 → `40003`；`data_rows` 非整数 → `40002`，越界 → `40003`；带宽 / RTT 越界 → `40003`；流程错误同 M.5；GET 中 `operator` 与 `protocol` 不兼容 → `40001`。

## M.5 计算流程试运行

服务：MPC-PROTO-01 至 MPC-PROTO-05。对应「计算流程编排」卡的「试运行」按钮与结果区。

```
POST /projects/{project_id}/mpc/flows/dry-run
```

请求：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是 | 1–8 步 |
| `steps[].operator` | string | 是 | 见 M.1 |
| `steps[].protocol` | string | 是 | 必须在该算子的 `protocols` 内，否则 `40001` |
| `steps[].operand` | object | 视算子 | 见 M.1 |
| `parties[]` | array | 是 | 同 M.6 |
| `params` | object | 否 | 同 M.4 |

```json
{
  "steps": [
    { "operator": "secure_sum", "protocol": "ss" },
    { "operator": "secure_mean", "protocol": "ss" },
    { "operator": "secure_compare", "protocol": "gc", "operand": { "cmp": "gt", "threshold": 1266000 } }
  ],
  "parties": [
    { "party_id": "party-a", "roles": ["input", "compute"] },
    { "party_id": "party-b", "roles": ["input", "compute"] },
    { "party_id": "party-c", "roles": ["compute", "output"] }
  ]
}
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `trial_rows` | int | 4（每个输入方 4 行氧化钕 Nd₂O₃ 月度成交价，元/吨，按项目与参与方种子确定性生成） |
| `inputs[]` | array | 每个输入方：`party_id`、`name`、`rows`、`unit`、`share_kind`、`shares[]`（每个计算方一条 `{ holder_id, holder_name, values[] }`，十六进制份额）。**不含明文** |
| `steps[]` | array | `{ index, operator, name, protocol, in_type, out_type, visibility, share_kind, share_preview }`；`visibility` 为 `secret`（中间结果保持份额）或 `revealed_to_output`（最后一步） |
| `result` | object | `{ type, value, revealed_to[], revealed_to_names[] }`，只对输出方公开 |
| `stats` | object | 试运行规模下的 `comm_bytes`、`rounds`、`compute_sec` |
| `warnings[]` | string[] | 例：结果超出模 2^ℓ 环的定点可表示范围（|x| ≥ 2^(ℓ−1−f)） |

份额生成：ss 为加法秘密共享，`enc = round(x · 2^f) mod 2^ℓ`，前 C−1 份由种子哈希生成，最后一份 = enc − Σ 前份 mod 2^ℓ，C 为计算方数，因此 Σ 全部份额 mod 2^ℓ = enc；gc 展示 128 bit 导线标签；ot 展示 64 bit 掩码消息。

流程校验规则（按步骤顺序，`data.field = steps[i].*`）：

| 规则 | 错误码 |
|---|---|
| 步骤数 0 或 > 8 | 40000 |
| 未知算子 / 未知协议 | 40000 |
| 算子与协议不兼容（例：安全比较选秘密共享） | 40001 |
| 上一步输出类型不在本算子 `io` 内（例：逻辑运算作用于各方数据，AND 作用于单个布尔值） | 40000 |
| 比较缺阈值、求积缺系数、OT 行号非整数、比较方式或逻辑模式取值错误 | 40002 |
| OT 行号越界（试运行 1–4，任务 1–data_rows） | 40003 |
| 比较各方数据但输入方 < 2 | 40000 |

## M.6 创建任务（扩展 §4.2）

服务：MPC-PROTO-04、MPC-PROTO-05、MPC-PROTO-06、MPC-OPS-04。对应协议管理页底部「创建任务并进入监控」，成功后前端执行 `App.go('mpc', { sub: 'ops', taskId })`。

```
POST /projects/{project_id}/mpc/tasks
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是* | 同 M.5；*未传时可用 §4.2 的 `protocol` + `operator`，按该算子默认流程 |
| `parties[]` | array | 是 | ≥ 3 方 |
| `parties[].party_id` | string | 是 | 来自 M.2 |
| `parties[].roles` | string[] | 是* | 子集 of `input` / `compute` / `output`；*兼容 §4.2 单值 `role` |
| `name` | string | 否 | ≤ 40 字 |
| `data_rows` | int | 否 | 同 M.4 |
| `bandwidth_mbps` / `rtt_ms` | number | 否 | 同 M.4 |
| `params` | object | 否 | 同 M.4 |
| `anomaly_threshold_pct` | number | 否 | 异常判定阈值，10–200（%），默认 50 |
| `auto_start` | bool | 否 | 默认 true |

参与方校验：少于 3 方 `40000`；重复 `40000`；不存在 `40400`；角色为空或缺少输入方 / 计算方 / 输出方任一 `40000`；角色取值错误 `40002`；流程用到秘密共享或混淆电路时计算方 < 2 `40000`（份额与混淆表需分属不共谋的两方）。

响应 `data`：任务详情（M.7）。

## M.7 任务详情（扩展 §4.3）

服务：MPC-OPS-01 至 MPC-OPS-04。对应运维监控页的任务摘要、4 个指标卡、告警条、参与方卡片。

```
GET /mpc/tasks/{task_id}
```

在 §4.3 字段基础上新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 任务名称 |
| `protocols` | string[] | 流程用到的协议；`protocol` / `operator` 保留为第一步 |
| `steps[]` | array | `{ operator, name, protocol, operand, in_type, out_type }` |
| `readonly` | bool | 历史播种任务为 true（不能重置） |
| `progress_pct` | number | 执行进度（%） |
| `data_rows` / `params` | | 创建时采用的值 |
| `estimate` | object | `est_compute_sec`、`est_comm_sec`、`est_comm_mb`、`rounds` |
| `anomaly_rule` | object | `threshold_pct`、`min_ticks`（5）、`metrics`（`comm_bytes`、`compute_sec`）、`description` |
| `parties[].roles` | string[] | 全部角色；`role` 保留为第一个 |
| `parties[].node_id` | string | 节点 ID |
| `parties[].comm_bytes` | int | 累计发送字节 |
| `parties[].compute_sec` | number | 累计本地计算耗时（秒） |
| `parties[].comm_sec` | number | 累计通信耗时（秒） |
| `parties[].interaction_rounds` | int | 已完成轮次 |
| `parties[].comm_deviation_pct` / `compute_deviation_pct` | number | (本方 − 全部参与方均值) / 均值 × 100 |
| `summary` | object | `total_comm_bytes`、`mean_comm_bytes`、`max_compute_sec`、`mean_compute_sec`、`duration_sec`（最慢一方计算 + 通信）、`interaction_rounds`、`abnormal_parties` |
| `alarms[].type` | string | 新增 `compute_anomaly` |
| `alarms[].node_id` / `deviation_pct` / `threshold_pct` | | 告警定位与判定依据 |
| `created_at` | string | |

异常判定：执行满 `min_ticks` 个心跳后，某方 |comm_bytes − 均值| / 均值 > `threshold_pct`% 产生 `comm_anomaly`，|compute_sec − 均值| / 均值 > `threshold_pct`% 产生 `compute_anomaly`，该方 `status = abnormal`。告警 `raised_at` 为首次触发时间，`message` 中的累计值随心跳更新。

演示数据说明：指标按任务创建时的性能预估结果逐心跳（420 ms，共 30 个）线性推进，各方带 ±6% 的确定性扰动（种子 = task_id + party_id）；`node-ganzhou-03`（p1）与 `node-chengdu-06`（p2）设为链路降级节点（通信 ×2.4、计算 ×2.2），用于演示异常检测；p3 无降级节点。

SSE `/mpc/tasks/{task_id}/events`：`metrics` 事件数据为 `{ parties, summary, progress_pct, alarms }`；`alarm_raised`、`status_changed` 同 §7。

## M.8 任务控制（同 §4.4）

```
POST /mpc/tasks/{task_id}/actions     body: { "action": "start" | "stop" | "reset" }
```

v1.2 收紧状态校验：`running` 时 `start` → `40901`；非 `running` 时 `stop` → `40901`；`finished` 时 `start` → `40901`；`readonly` 历史任务 `reset` → `40901`；未知动作 → `40000`。

## M.9 历史任务列表（扩展 §4.5）

服务：MPC-OPS-05。对应「历史 MPC 任务」表格与运维监控页顶部「监控任务」下拉（`status=all`）。

```
GET /projects/{project_id}/mpc/tasks?status=&protocol=&start_time=&end_time=&task_ids=&page=&page_size=
```

| 参数 | 说明 |
|---|---|
| `status` | 逗号分隔，默认 `finished,failed`；`all` 为全部 |
| `protocol` | 流程中任一步使用该协议即命中 |
| `start_time` / `end_time` | `YYYY-MM-DD`，按结束日期（+08:00）过滤，未结束按创建日期；格式错 `40002`，起止颠倒 `40000` |
| `task_ids` | 逗号分隔 |

`items[]` 在 §4.5 基础上新增：`name`、`protocols`、`flow`（例 `安全求和 → 安全求均值 → 安全比较`）、`data_rows`、`mean_comm_bytes`、`interaction_rounds`、`alarm_count`、`progress_pct`、`created_at`、`started_at`。`total_duration_sec` = 最慢一方的计算 + 通信耗时。按结束时间倒序。每个项目播种 6 条历史任务（2026-09-12 至 2026-10-20）。

## M.10 两任务对比

服务：MPC-OPS-05。对应历史表格勾选 2 个任务后的「对比所选」与对比面板。

```
GET /projects/{project_id}/mpc/tasks/compare?task_ids=A,B
```

响应 `data`：`{ tasks: [itemA, itemB], baseline: A, metrics[] }`；`metrics[]`：`{ key, label, unit, note, values: [a, b], diff_pct }`，`diff_pct = (b − a) / a × 100`。指标：总通信量（MB）、单方平均通信量（MB）、总耗时（秒）、轮次交互数（轮）、参与方数（方）、数据规模（行）、每万行耗时（秒，= 总耗时 / (行数 / 10,000)）、异常告警数（条）。

错误：数量不是 2 或两个相同 → `40000`；任务不存在或不属于该项目 → `40400`。

## M.11 导出报表（带筛选）

服务：MPC-OPS-05。对应「导出报表」与对比面板的「导出对比报表」。

```
GET /projects/{project_id}/mpc/reports/export?format=csv&protocol=&start_time=&end_time=&task_ids=
```

过滤参数同 M.9。响应 CSV（UTF-8 BOM），列：任务 ID、任务名称、计算流程、协议、参与方数、数据规模(行)、总通信量(MB)、单方平均通信量(MB)、总耗时(秒)、轮次交互数(轮)、异常告警数(条)、开始时间、结束时间、状态。`task_ids` 恰为 2 个时追加对比段（指标、单位、两任务值、差异 %）。§4.6 的 `/mpc/tasks/export` 在内核中只输出固定历史，前端 v1.2 改用本接口；真实后端可二者合一。

## M.12 接口清单

| # | 方法 | 路径 | 验收编号 | 新增 / 扩展 |
|---|---|---|---|---|
| 1 | GET | `/mpc/protocols` | MPC-PROTO-01/02/03/04 | 新增 |
| 2 | GET | `/projects/{project_id}/mpc/parties` | MPC-PROTO-05 | 新增 |
| 3 | GET | `/projects/{project_id}/mpc/params` | MPC-PROTO-06 | 新增 |
| 4 | PUT | `/projects/{project_id}/mpc/params/{protocol}` | MPC-PROTO-06 | 新增 |
| 5 | DELETE | `/projects/{project_id}/mpc/params/{protocol}` | MPC-PROTO-06 | 新增 |
| 6 | POST | `/projects/{project_id}/mpc/estimate` | MPC-PROTO-07 | 新增 |
| 7 | GET | `/projects/{project_id}/mpc/estimate` | MPC-PROTO-07 | 扩展 §4.1 |
| 8 | POST | `/projects/{project_id}/mpc/flows/dry-run` | MPC-PROTO-01..05 | 新增 |
| 9 | POST | `/projects/{project_id}/mpc/tasks` | MPC-PROTO-04/05/06 | 扩展 §4.2 |
| 10 | GET | `/mpc/tasks/{task_id}` | MPC-OPS-01..04 | 扩展 §4.3 |
| 11 | POST | `/mpc/tasks/{task_id}/actions` | MPC-OPS-01..03 | 扩展 §4.4 |
| 12 | GET | `/projects/{project_id}/mpc/tasks` | MPC-OPS-05 | 扩展 §4.5 |
| 13 | GET | `/projects/{project_id}/mpc/tasks/compare` | MPC-OPS-05 | 新增 |
| 14 | GET | `/projects/{project_id}/mpc/reports/export` | MPC-OPS-05 | 新增（替代 §4.6） |
