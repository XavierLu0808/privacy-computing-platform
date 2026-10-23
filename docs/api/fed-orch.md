# 联邦学习 · 任务编排 接口（FL-ORCH-01 至 FL-ORCH-09）

对应页面：`#/fed/orch`（页面模块 `FLO`，`web/js/fl-orch.js`）；mock 实现：`web/js/mock/fed-orch.js`；测试：`web/tests/fed-orch.test.mjs`。

通用约定沿用 API.md §0：统一响应包、`snake_case`、ISO 8601 时间、分页参数 `page` / `page_size`。错误码见 API.md §9。

## 接口一览

| # | 方法 | 路径 | 说明 | 验收编号 |
|---|---|---|---|---|
| 1 | GET | `/projects` | 项目列表（v1.2 起返回项目配置字段，支持 `keyword`） | FL-ORCH-01 / 04 |
| 2 | POST | `/projects` | 创建项目 | FL-ORCH-01 |
| 3 | GET | `/projects/{project_id}` | 项目详情（含配置） | FL-ORCH-04 |
| 4 | PATCH | `/projects/{project_id}` | 修改项目配置 | FL-ORCH-04 |
| 5 | GET（下载） | `/projects/{project_id}/config/export` | 导出项目配置 JSON 文件 | FL-ORCH-04 |
| 6 | GET | `/projects/{project_id}/nodes` | 节点列表（v1.2 起增加 `data_dir`、`running_job_count`） | FL-ORCH-02 |
| 7 | POST | `/projects/{project_id}/nodes` | 添加节点（v1.2 起校验 IP / 端口格式、连通性） | FL-ORCH-02 |
| 8 | PATCH | `/projects/{project_id}/nodes/{node_id}` | 编辑节点 | FL-ORCH-02 |
| 9 | DELETE | `/projects/{project_id}/nodes/{node_id}` | 删除节点（运行中任务使用时拒绝） | FL-ORCH-02 |
| 10 | GET | `/projects/{project_id}/isolation` | 数据隔离视图：目录访问矩阵、传输字段白名单、检测记录 | FL-ORCH-03 |
| 11 | POST | `/projects/{project_id}/isolation/checks` | 越权访问检测 / 传输内容审计 | FL-ORCH-03 |
| 12 | GET | `/fl/algorithms` | 算法库列表（内置 / 已注册 / 自定义模型） | FL-ORCH-05 / 06 / 07 |
| 13 | GET | `/fl/algorithms/{algo_id}` | 算法详情：统一接口、参数 schema、版本、操作记录 | FL-ORCH-05 / 08 |
| 14 | POST | `/fl/algorithms` | 注册算法 / 发布新版本 | FL-ORCH-06 / 08 |
| 15 | POST | `/projects/{project_id}/fl/models` | 登记自定义模型（结构完整性校验） | FL-ORCH-07 / 08 |
| 16 | POST | `/fl/algorithms/{algo_id}/actions` | 版本回滚 | FL-ORCH-08 |
| 17 | GET | `/fl/algorithms/{algo_id}/templates` | 参数模板列表 | FL-ORCH-09 |
| 18 | POST | `/fl/algorithms/{algo_id}/templates` | 另存参数模板 | FL-ORCH-09 |
| 19 | DELETE | `/fl/param-templates/{template_id}` | 删除自定义模板 | FL-ORCH-09 |
| 20 | POST | `/projects/{project_id}/fl/jobs` | 创建训练任务（v1.2 扩展：注册算法、`params`、项目默认值） | FL-ORCH-06 / 07 / 09 |
| 21 | GET | `/projects/{project_id}/fl/jobs`、`/fl/jobs/{job_id}`；POST `/fl/jobs/{job_id}/actions` | 任务列表 / 详情 / 动作响应补 `algo_ref`、`params`、`algo_ref_name` | FL-ORCH-06 / 07 |

## 持久化（表结构语义）

mock 存在浏览器内存 `k.db.flo`，真后端按下表落库：

| 表 | 主键 | 主要字段 |
|---|---|---|
| `fl_project` | `project_id` | `name`（唯一）、`type`、`created_at` |
| `fl_project_config` | `project_id` | `description`、`base_algorithm`、`model_version`、`total_rounds`、`target_metric`、`target_value`、`revision`、`updated_at`、`updated_by` |
| `fl_project_node` | (`project_id`, `node_id`) | `ip`、`port`、`role`、`data_partition`、`data_dir`、`last_heartbeat_at` |
| `fl_algorithm` | `algo_id` | `name`、`kind`（builtin / registered / custom）、`project_id`（仅 custom）、`task_types`、`base_class`、`framework`、`model_format`、`current_version` |
| `fl_algorithm_version` | (`algo_id`, `version`) | `params_schema`（JSON）、`file_id`、`structure`（JSON，仅 custom）、`note`、`created_by`、`created_at` |
| `fl_algorithm_op_log` | 自增 | `algo_id`、`action`（publish / rollback）、`from_version`、`to_version`、`operator`、`reason`、`at` |
| `fl_param_template` | `template_id` | `algo_id`、`name`（同算法内唯一）、`params`（JSON）、`preset`、`created_by`、`created_at` |
| `fl_isolation_audit` | `check_id` | `project_id`、`type`、`actor_node_id`、`target_node_id`、`path`、`job_id`、`result`、`detail`、`at`、`operator` |

mock 对内核数据的写入：新建项目时向 `db.projects` 追加项目；不导入演示数据时 `db.nodes[新项目]` 置空数组、`db.seeded[新项目] = true`，导入时写 3 个演示节点后调用 `k.seedProject`；节点增删改直接写 `db.nodes`；注册算法时向 `db.files` 登记一条模型制品记录；新建任务时在内核任务对象上追加 `algo_ref`、`params`。聚合策略只读 `db.fla[project_id].strategy`（聚合与安全页维护）。

---

## 1. 项目

### 1.1 项目列表

```
GET /projects?keyword=&page=&page_size=
```

在 API.md §1.3 的基础上，`items[]` 增加以下字段（顶栏下拉只用 `project_id` / `name`，向后兼容）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | string | 项目描述 |
| `base_algorithm` | string | 基准模型的 `algo_id` |
| `base_algorithm_name` | string | 基准模型名称 |
| `model_version` | string | 基准模型版本 |
| `total_rounds` | int | 聚合轮数，新建训练任务的默认值 |
| `target` | object | 全局训练目标 `{ metric, label, op, value, task_type }`，`op` 为 `<=` 或 `>=` |
| `node_count` / `job_count` | int | 节点数 / 任务数 |
| `aggregation_default` | string \| null | 聚合与安全页设定的项目聚合策略 `ss` / `he`，未设定为 `null` |
| `revision` | int | 配置版本号，每次修改 +1 |
| `updated_at` / `updated_by` | string | 最近修改时间 / 修改人 |

### 1.2 创建项目

```
POST /projects
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 1–64 个字符，全局唯一 |
| `type` | string | 否 | `production` / `pilot`（默认）/ `sandbox` |
| `description` | string | 否 | ≤ 500 个字符 |
| `base_algorithm` | string | 是 | 内置或已注册算法的 `algo_id` |
| `model_version` | string | 是 | 须是该算法已有版本 |
| `total_rounds` | int | 是 | 1–200 |
| `target.metric` | string | 是 | `accuracy` / `auc` / `loss`（分类）、`rmse` / `mae`（时序，归一化值） |
| `target.value` | number | 是 | Accuracy / AUC / RMSE / MAE 取 (0, 1]，Loss 取 (0, 10] |
| `seed_demo` | bool | 否 | 默认 `false`（空项目）。`true` 时登记 3 个演示节点 `node-baotou-{project_id}` / `node-ganzhou-{project_id}`（训练，分区 part-A / part-B）与 `node-center-agg-{project_id}`（聚合），再按内核原逻辑播种 4 张演示数据集和 2 个示例训练任务。界面复选框「导入演示数据」默认勾选 |

比较方向由指标决定：`loss` / `rmse` / `mae` 为 `≤`，`accuracy` / `auc` 为 `≥`。训练目标所属任务类型须被基准模型支持。

```json
{
  "name": "稀土氧化物库存联合预测 · 2027Q1", "type": "pilot", "description": "三方库存数据联合建模",
  "base_algorithm": "lstm", "model_version": "1.1.0", "total_rounds": 40,
  "target": { "metric": "rmse", "value": 0.12 }
}
```

响应 `data`：项目对象（同 1.1 的 `items[]`），例 `"target": { "metric": "rmse", "label": "RMSE（归一化）", "op": "<=", "value": 0.12, "task_type": "timeseries" }`。`seed_demo` 不传或为 `false` 时新项目没有节点，前端随后调用 `App.reloadProjects(project_id)` 切换顶栏。

| 情形 | code |
|---|---|
| 名称为空 / 指标不在枚举内 / 基准模型不支持该训练目标的任务类型 / `seed_demo` 不是布尔值 | 40000 |
| 目标值不是数字 | 40002 |
| 名称超长、轮数不在 1–200、目标值越界 | 40003 |
| 基准模型或版本不存在 | 40400 |
| 项目名称重复 | 40902 |

### 1.3 项目详情 / 修改

```
GET   /projects/{project_id}
PATCH /projects/{project_id}
```

PATCH 字段同 1.2，均可选，只校验传入字段；`base_algorithm` 与 `model_version` 成对校验（只传其一时用当前值补齐）。成功后 `revision` +1，记录 `updated_by` / `updated_at`。项目不存在 40400，其余错误码同 1.2。

### 1.4 导出配置文件

```
GET /projects/{project_id}/config/export
```

下载 `fl_project_{project_id}_config.json`。文件内时间统一写成 UTC+8（`k.fmtLocal`，形如 `2026-10-23 22:10:05 +08:00`），并带 `"timezone": "UTC+8"`：

```json
{
  "schema_version": "fl-project-config/1",
  "timezone": "UTC+8", "exported_at": "2026-10-23 22:10:05 +08:00", "exported_by": "Rui",
  "project": { "project_id": "p1", "name": "稀土氧化物价格联合预测 · 2026Q4", "type": "production", "description": "…", "created_at": "…" },
  "training": { "base_algorithm": "lstm", "model_version": "1.1.0", "total_rounds": 30, "target": { "metric": "rmse", "op": "<=", "value": 0.12 }, "aggregation_default": null },
  "nodes": [{ "node_id": "node-shanghai-01", "ip": "10.22.6.14", "port": 8471, "role": "trainer", "data_partition": "part-A", "data_dir": "/data/fl/p1/part-a" }],
  "isolation_policy": { "dir_rule": "…", "channel_rule": "…", "audit_rule": "…" },
  "revision": 1, "updated_at": "…", "updated_by": "Rui"
}
```

不含任何凭据。

## 2. 节点管理（扩展 API.md §2.11）

节点对象在 API.md 基础上增加：`data_dir`（本地数据目录，训练节点默认 `/data/fl/{project_id}/{分区小写}`，聚合节点为 `null`）、`last_heartbeat_at`、`running_job_count`（使用该节点且状态为 Running / Paused 的任务数）。

### 2.1 添加节点

`POST /projects/{project_id}/nodes`，字段同 API.md §2.11。校验：

| 情形 | code |
|---|---|
| 节点 ID 不是小写字母 / 数字 / `-`；角色不是 `trainer` / `aggregator`；训练节点缺数据分区；缺 IP 或端口 | 40000 |
| IP 不是合法 IPv4 / IPv6；IP 为特殊地址（0.0.0.0、255.255.255.255、0.0.0.0/8、回环 127.0.0.0/8 与 ::1、组播 224.0.0.0/4 与 ff00::/8、保留 240.0.0.0/4、按 /24 子网的网络地址 x.x.x.0 与广播地址 x.x.x.255、::），message 说明原因；数据分区含非法字符；`data_dir` 不是绝对路径 | 40002 |
| 端口不在 1–65535；节点 ID 超过 40 个字符 | 40003 |
| 节点 ID 在项目内重复 | 40902 |
| 连通性检查失败（mock：`192.0.2.0/24` 文档保留网段视为不可达） | 42201 |

### 2.2 编辑节点

```
PATCH /projects/{project_id}/nodes/{node_id}
```

可改 `node_id`、`ip`、`port`、`role`、`data_partition`、`data_dir`、`online`（bool，见 6.1），只校验传入字段，规则同 2.1。额外规则：

| 情形 | code |
|---|---|
| 节点被运行中任务使用时修改 `node_id` / `role` / `data_partition` / `data_dir`（IP 与端口可改） | 40901，`data.job_ids` 列出任务 |
| 节点已被任何历史任务引用时修改 `node_id`（节点 ID 是任务引用节点的稳定标识） | 40901 |
| 新 `node_id` 与已有节点重复 | 40902 |
| 节点不存在 | 40400 |

改为聚合节点时 `data_partition`、`data_dir` 置空。

### 2.3 删除节点

`DELETE /projects/{project_id}/nodes/{node_id}`：节点被运行中任务使用时返回 40901（`data.job_ids`），不存在 40400。

## 3. 数据隔离

### 3.1 隔离视图

```
GET /projects/{project_id}/isolation
```

```json
{
  "policy": { "dir_rule": "每个训练节点只挂载自己的数据目录（权限 0700…）", "channel_rule": "…gRPC ModelUpdate…", "audit_rule": "…" },
  "data_dirs": [{ "node_id": "node-shanghai-01", "data_partition": "part-A", "data_dir": "/data/fl/p1/part-a" }],
  "matrix": [{ "node_id": "node-shanghai-01", "role": "trainer", "cells": [{ "owner_node_id": "node-shanghai-01", "data_dir": "/data/fl/p1/part-a", "allowed": true }] }],
  "payload_allowed": [{ "field": "weights_delta", "kind": "gradient", "label": "模型参数增量 / 梯度…" }],
  "payload_forbidden": [{ "field": "raw_rows", "label": "原始样本行（任何特征明细）" }, { "field": "id_columns", "label": "求交键与企业标识（credit_code_hash、legal_person_hash 等）" }],
  "checks": []
}
```

`matrix[i].cells[j].allowed` 只在发起节点就是目录属主时为 `true`；聚合节点没有数据目录，对所有目录均为 `false`。传输白名单：训练节点上传 `weights_delta`（gradient）/ `num_samples`（metadata）/ `local_metrics`（metric），聚合节点下发 `global_weights`（model_param）。`checks` 为最近 20 条检测记录，最新在前。

### 3.2 检测

```
POST /projects/{project_id}/isolation/checks
```

**目录访问检测** `{ "type": "dir_access", "actor_node_id": "node-shanghai-01", "target_node_id": "node-hangzhou-02" }`：

```json
{
  "check_id": "iso_0001", "type": "dir_access", "at": "…", "operator": "Rui",
  "actor_node_id": "node-shanghai-01", "target_node_id": "node-hangzhou-02",
  "path": "/data/fl/p1/part-b/train.parquet", "result": "denied",
  "detail": "open(\"/data/fl/p1/part-b/train.parquet\", O_RDONLY) 被拒绝：EACCES，node-shanghai-01 的挂载命名空间内不存在 node-hangzhou-02 的数据目录",
  "rule": "…"
}
```

本节点读自己目录 `result = allowed`。

**传输内容审计** `{ "type": "payload", "job_id": "可选，默认最近一个有训练记录的任务" }`：取该任务最后一轮各节点消息，按字段白名单检查，并与本项目全部数据集列名比对。

```json
{
  "check_id": "iso_0002", "type": "payload", "job_id": "fl_p1_001", "job_name": "稀土氧化物价格预测 · LSTM", "round": 20,
  "scanned_columns": 92, "result": "passed",
  "nodes": [
    { "node_id": "node-shanghai-01", "role": "trainer", "direction": "uplink", "round": 20, "total_bytes": 151552, "raw_fields_found": 0,
      "fields": [{ "field": "weights_delta", "kind": "gradient", "dtype": "float32", "elements": 37872, "bytes": 151488 }, { "field": "num_samples", "kind": "metadata", "dtype": "int64", "elements": 1, "bytes": 8 }, { "field": "local_metrics", "kind": "metric", "dtype": "float32", "elements": 2, "bytes": 56 }] },
    { "node_id": "node-center-agg", "role": "aggregator", "direction": "downlink", "fields": [{ "field": "global_weights", "kind": "model_param" }, { "field": "round", "kind": "metadata" }] }
  ],
  "detail": "第 20 轮 4 个节点的消息只含白名单字段…命中原始数据字段 0 个"
}
```

梯度 / 全局参数的元素数 `elements` 对同一任务的所有节点相同，等于 `kept_params = ⌈ρ × P⌉`：`P = k.MODEL_PARAMS[algorithm]`（例 LSTM 203,143、XGBoost 2,176，记在 `model_params`），`ρ` 为「聚合与安全」页项目配置 `k.db.fla[project_id].sparsification` 的 Top-k 保留比例（未开启为 1，记在 `sparsity_keep_ratio`；未保存配置时取该页默认值，`config_source = default`）。`total_bytes` 是消息明文（float32）大小；`wire_bytes` 与聚合与安全页同一套公式计算：秘密共享上行 = k × 有限域位数，同态上行 = ⌈k / 批打包⌉ × 单条密文位数（Paillier 2 × 密钥长度，CKKS 2 × N × 系数模数位数），再加样本数与本地指标；聚合节点下行 =（k × 32 + 稀疏化时的下标 min(k × ⌈log₂P⌉, P) 位）× 训练节点数（`recipients`）。`encoding` / `downlink_encoding` 给出编码说明。聚合节点开启稀疏化时多一个 `topk_indices` 字段。秘密共享把 float32 定点量化到有限域，因此 16 bit 有限域时链路量约为明文的一半，属于编码压缩而非丢弃数据；同态且不稀疏化时链路量大于明文。

| 情形 | code |
|---|---|
| `type` 不合法；`dir_access` 缺节点参数 | 40000 |
| 目标节点是聚合节点（无数据目录） | 40001 |
| 节点或任务不属于本项目 | 40400 |
| 任务尚未产生训练轮次 | 40901 |

## 4. 算法库

### 4.1 算法列表 / 详情

```
GET /fl/algorithms?kind=&task_type=&project_id=
GET /fl/algorithms/{algo_id}
```

`kind`：`builtin` / `registered` / `custom`；自定义模型只在传入所属 `project_id` 时返回。内置算法 5 个：

| algo_id | 名称 | 基类 | 实现 | 任务类型 | 当前版本 |
|---|---|---|---|---|---|
| `lr` | 逻辑回归 | `FedLogisticRegression(FedEstimator)` | SecretFlow SS-LR | 分类 | 1.2.0 |
| `xgb` | XGBoost | `FedXGBoost(FedEstimator)` | SecretFlow SecureBoost | 分类 | 1.2.0 |
| `cnn` | CNN / MLP | `FedNeuralNet(FedEstimator)`，子类 `FedMLP` / `FedCNN1D` | PyTorch 2.3 + FedAvg | 分类 | 1.1.0 |
| `lstm` | LSTM | `FedLSTM(FedSequenceModel)` | PyTorch 2.3 + FedAvg | 时序预测 | 1.1.0 |
| `tcn` | TCN | `FedTCN(FedSequenceModel)` | PyTorch 2.3 + FedAvg | 时序预测 | 1.0.0 |

列表项字段：`algo_id`、`name`、`kind`、`project_id`、`task_types`、`base_class`、`framework`、`description`、`model_format`、`current_version`、`version_count`、`template_count`、`model_file_id`（当前版本制品文件）、`structure`。详情另含：

- `interface[]`：统一接口，所有算法都是 `fit` / `predict` / `evaluate` 三个方法，`{ method, signature, input, output }`，例 `fit(X, y, *, rounds: int, aggregator: Aggregator, params: dict) -> TrainReport`；分类输入 `ndarray[n_samples, n_features]`，时序输入 `ndarray[n_samples, window_size, n_features]`；`evaluate` 分类返回 `{ loss, accuracy }`，时序返回 `{ rmse, mae }`。
- `params_schema`：当前版本的参数 schema（JSON Schema 子集，见 4.2）。
- `versions[]`：`{ version, is_current, created_at, created_by, note, file_id, structure }`，新版本在前。
- `history[]`：`{ action: publish | rollback, from_version, to_version, operator, at, reason }`，最新在前。

算法不存在 40400。

### 4.2 注册算法

```
POST /fl/algorithms
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | ≤ 40 个字符；与已注册算法同名即发布新版本；不能与内置算法同名 |
| `version` | string | 是 | `主.次.修订`；同名发布时须大于已有最高版本 |
| `task_types` | string[] | 是 | `classification` / `timeseries`，至少一个 |
| `model_format` | string | 是 | `pkl` / `pt` / `h5` / `onnx` |
| `params_schema` | object \| string | 是 | JSON 对象或 JSON 字符串 |
| `base_class` / `framework` / `description` | string | 否 | |

参数 schema 校验规则（JSON Schema 子集）：根节点只允许 `$schema` / `title` / `description` / `type` / `properties` / `required` / `additionalProperties`，`type` 必须是 `object`，`properties` 至少 1 个；参数名为小写字母、数字、下划线；参数只允许 `type`（`integer` / `number` / `string` / `boolean`）、`title`、`description`、`default`、`minimum`、`maximum`、`enum`；`minimum` / `maximum` 只用于数值且 `minimum ≤ maximum`；`enum` 非空且与 `type` 一致；`default` 须满足自身约束；`required` 中的名字须在 `properties` 中。

注册成功时登记一条模型制品文件（`file_id = f_{algo_id}_{版本去点}`），新建任务选用该算法时作为 `model_file_id`。响应：算法详情。

| 情形 | code |
|---|---|
| 缺名称、格式不在枚举、`task_types` 不合法 | 40000 |
| 版本号格式错误、schema 不是合法 JSON 或不符合子集规则 | 40002 |

schema 不是合法 JSON 时，message 给出中文原因与出错位置（行列号从 1 开始），不含浏览器英文原文，例「参数 schema 不是合法 JSON：第 1 行第 19 列，属性名必须用英文双引号包裹」；其他原因有「内容不完整，缺少结尾的括号或引号」「此处缺少逗号或右花括号 }」「字符串缺少结尾的双引号」等。
| 名称超长、新版本号不大于已有最高版本 | 40003 |
| 与内置算法同名、同名同版本已存在 | 40902 |

### 4.3 自定义模型上传与结构校验

先 `POST /files`（`purpose = fl_model`，API.md §1.4），再：

```
POST /projects/{project_id}/fl/models
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file_id` | string | 是 | 上传得到的文件 ID |
| `name` | string | 否 | 默认取文件名；同项目同名再次上传生成新版本（次版本号 +1） |
| `task_type` | string | 否 | 默认 `classification`，决定校验输入形状 |

校验项：文件格式（`.pkl` / `.pt` / `.h5` / `.onnx`）、文件大小（> 0 B）、文件头与序列化结构、层结构、输入形状。mock 的确定性规则：文件名含 `corrupt` 判为文件头损坏（按格式给出原因，例 `.h5`：「HDF5 文件签名不匹配…model_config 属性缺失」），大小为 0 判为空文件；通过时层数 = 3 + (FNV 哈希(文件名 + 大小) mod 10)，参数量 = (大小 − 512 B 文件头) / 4（float32），输入形状分类 `(batch, 68)`、时序 `(batch, 30, 11)`。

成功响应：算法详情（`kind = custom`）+ `report`：

```json
{
  "valid": true, "format": "pt", "framework": "PyTorch（TorchScript / state_dict）",
  "layers": 8, "param_count": 102912, "param_count_basis": "按 float32 每个参数 4 字节、扣除 512 B 文件头估算",
  "input_shape": ["batch", 30, 11], "output_shape": ["batch", 7],
  "checks": [{ "item": "文件格式", "passed": true, "detail": ".pt · PyTorch（TorchScript / state_dict）" }], "reason": null
}
```

| 情形 | code |
|---|---|
| 缺 `file_id`、文件用途不是 `fl_model`、未知任务类型 | 40000 |
| 结构校验失败（`data.report` 含逐项结果与原因） | 40002 |
| 名称超长 | 40003 |
| 项目或文件不存在 | 40400 |
| 同名模型已用于另一任务类型 | 40902 |

### 4.4 版本回滚

```
POST /fl/algorithms/{algo_id}/actions
```

```json
{ "action": "rollback", "version": "1.1.0", "reason": "1.2.0 分桶调整后 p2 精度下降" }
```

把当前版本指针移到指定版本，追加一条 `history`（操作人、时间、原因）。之后新建的任务使用该版本（任务 `algo_ref.version`），已创建任务不受影响。响应：算法详情。

| 情形 | code |
|---|---|
| `action` 不是 `rollback`、缺 `version` | 40000 |
| 算法或版本不存在 | 40400 |
| 指定版本已是当前版本 | 40901 |

### 4.5 参数模板

```
GET    /fl/algorithms/{algo_id}/templates
POST   /fl/algorithms/{algo_id}/templates      { "name": "浅树快训", "params": { "max_depth": 3, "n_estimators": 50 } }
DELETE /fl/param-templates/{template_id}
```

模板对象：`{ template_id, algo_id, name, params, preset, created_by, created_at }`，平台预置在前。每个内置算法预置 2–3 个模板，例 XGBoost「默认参数」`max_depth=6, eta=0.3, n_estimators=200, subsample=0.8, min_child_weight=1`、「快速基线」、「高精度（慢）」。保存时 `params` 按算法当前版本 schema 校验，未填参数补 schema 默认值。

| 情形 | code |
|---|---|
| 名称为空；参数不在 schema 中；缺必填参数 | 40000 |
| 删除平台预置模板 | 40001 |
| 参数类型或枚举不符 | 40002 |
| 名称超长；参数越界 | 40003 |
| 算法或模板不存在 | 40400 |
| 同算法下模板重名 | 40902 |

## 5. 创建训练任务（扩展 API.md §2.3）

`POST /projects/{project_id}/fl/jobs` 在 API.md §2.3 基础上：

| 字段 | 说明 |
|---|---|
| `algorithm` | 除 `lr` / `xgb` / `cnn` / `lstm` / `tcn` / `custom` 外，可传已注册算法（`alg_*`）或本项目自定义模型（`mdl_*`）的 `algo_id`；服务端映射为 `algorithm = custom` + 该算法当前版本的 `model_file_id` |
| `params` | 可选，按所选算法当前版本 schema 校验并补默认值 |
| `template_id` | 可选，记录参数来源模板 |
| `aggregation` | 未传时取 `aggregation_default`（聚合与安全页的项目策略），仍未设置则按原规则必填 |
| `total_rounds` | 未传时取项目配置 `total_rounds` |
| `name` | 未传且使用注册算法 / 自定义模型时默认「{算法名} {版本} · {任务类型}」 |

响应在任务详情基础上增加 `algo_ref`（`{ algo_id, name, kind, version, template_id? }`，使用内置算法时同样返回）、`params` 与 `algo_ref_name`。`algo_ref_name` 仅在 `algorithm = custom` 且来自注册算法 / 自定义模型时有值，例「稀土价格 Transformer v1.2.0（已注册）」「违约树模型 v1.0.0（自定义模型）」，其余为 `null`；任务列表、任务详情、任务动作三个接口同样返回这三个字段（过滤参数与 API.md §2.2 一致），过程管控页的「算法」列、当前任务头和算法下拉用它显示真实算法名。`PATCH /fl/jobs/{job_id}` 仍为内核实现，响应不含这三个字段，前端在算法未变时沿用原值。内置算法且不带 `params` 时行为与 API.md §2.3 完全一致。

| 新增情形 | code |
|---|---|
| 注册算法 / 自定义模型不支持该任务类型 | 40000 |
| 参数不在 schema 中 | 40000 |
| 参数类型或枚举不符 | 40002 |
| 参数越界 | 40003 |
| 自定义模型不属于本项目 | 40400 |

---

## 6. 过程管控（FL-PROC-01 至 FL-PROC-08）

对应页面：`#/fed/proc`（页面模块 `FL`，`web/js/fl.js`）；mock 同在 `web/js/mock/fed-orch.js`；测试：`web/tests/fed-proc.test.mjs`。

| # | 方法 | 路径 | 说明 | 验收编号 |
|---|---|---|---|---|
| 22 | POST | `/fl/jobs/{job_id}/actions` | 任务动作（扩展 API.md §2.6）：start / resume 前预检、分配容器，pause 保存断点，terminate 释放资源 | FL-PROC-01 / 02 / 03 / 04 |
| 23 | GET | `/fl/jobs/{job_id}`、`/projects/{project_id}/fl/jobs` | 任务详情 / 列表增加过程管控字段（见 6.1） | FL-PROC-01 / 07 |
| 24 | GET | `/fl/jobs/{job_id}/eta` | 平滑剩余时间与逐轮耗时 | FL-PROC-07 |
| 25 | GET | `/fl/jobs/{job_id}/metrics` | 每轮指标（扩展 API.md §2.7：`from_round` / `to_round` 与 `start_time` / `end_time` 生效并校验） | FL-PROC-05 / 06 |
| 26 | GET | `/fl/metrics` | 历史指标查询：按项目 ID / 任务 ID / 写入时间范围 | FL-PROC-08 |
| 27 | GET（下载） | `/fl/metrics/export`、`/projects/{project_id}/fl/metrics/export` | 历史指标 CSV（条件同 26） | FL-PROC-08 |
| 27b | GET（下载） | `/fl/jobs/{job_id}/metrics/export?scope=&start_time=&end_time=` | 单任务 CSV（覆盖内核实现，列与 API.md §2.9 一致，时间范围生效） | FL-PROC-08 |
| 28 | GET | `/fl/jobs/{job_id}/nodes` | 任务维度节点（扩展 API.md §2.10：离线节点 `status = offline`） | FL-PROC-02 |
| 29 | PATCH | `/projects/{project_id}/nodes/{node_id}` | 新增可选字段 `online`（bool）：置 `false` 表示心跳丢失，使用该节点的 Running 任务转 `Failed` | FL-PROC-01 / 02 |

### 6.1 状态机与任务对象新增字段

迁移表与 API.md §2.1 一致（内核实现，不允许的动作返回 `40901`，`data.allowed_actions` 给出当前可执行动作）：

| 当前状态 | start | pause | resume | terminate | reset | 自动 |
|---|---|---|---|---|---|---|
| Created | Running | | | | Created | |
| Running | | Paused | | Terminated | | 跑满轮次 → Success；参与节点心跳丢失 → Failed |
| Paused | | | Running（断点续训） | Terminated | Created | |
| Success | | | | | Created | |
| Failed | Running（第 0 轮重开） | | | | Created | |
| Terminated | Running（第 0 轮重开） | | | | Created | |

任务详情 / 列表 / 动作响应新增：

| 字段 | 说明 |
|---|---|
| `allowed_actions` | 当前状态可执行的动作 |
| `state_history[]` | `{ from, to, action, at, operator, reason }`，`action` 取 `create` / `start` / `pause` / `resume` / `terminate` / `reset` / `complete`（跑满轮次）/ `fail`（异常） |
| `failure_reason` | `Failed` 时的原因，例「节点 node-hangzhou-02 心跳丢失，第 4 轮聚合未完成」 |
| `runtime` | `{ allocated_at, image, released, released_at, workers[] }`，`workers[]` 为 `{ node_id, role, container_id, pid, cpu_cores, memory_mb, status, started_at, released_at }`，`status` 取 `running` / `suspended` / `killed` / `completed` / `failed` |
| `checkpoint` | 最近一次断点（见 6.3），无则 `null` |
| `elapsed_sec` / `eta_sec` | 按 6.4 的逐轮耗时与平滑公式计算 |
| `eta` | `{ method, alpha, ema_round_sec, avg_round_sec, eta_naive_sec }` |

`PATCH /fl/jobs/{job_id}` 仍是内核实现，响应不含以上字段，前端沿用上次的值。

### 6.2 启动预检与资源分配

`start` 与 `resume` 在执行前做三项检查，任一失败则任务状态不变：

| 检查 | 失败情形 | code |
|---|---|---|
| 项目配置 | 任务所属项目不存在 | 40400 |
| 节点可用性 | 参与节点已从项目移除 | 40901（`data.missing_node_ids`） |
| | 参与节点离线（`online = false`） | 42201（`data.offline_node_ids`） |
| | 在册节点不足 2 个训练节点 + 1 个聚合节点 | 40000 |
| 算法兼容性 | 算法不在任务类型的可选列表；`custom` 的模型文件不存在；注册算法不支持该任务类型 | 40000 |

通过后响应带 `preflight[]`（`{ item, passed, detail }`），`start` 时为每个参与节点分配一个训练容器（镜像 `registry.local/fl-runtime:1.2.0`，训练节点 4 核 / 8 GB，聚合节点 2 核 / 4 GB），写入 `runtime.workers`。

### 6.3 暂停、恢复与强制终止

- `pause`：停止聚合循环，保存断点 `{ checkpoint_id, round, saved_at, path, global_model_sha256, global_model_bytes, global_metrics, optimizer_state, node_cursors[] }`，`path` 形如 `/data/fl/ckpt/{job_id}/round_005.ckpt`，`node_cursors` 为各训练节点的数据读取位置；容器状态改为 `suspended`。
- `resume`：重新预检，容器恢复 `running`，响应带 `resumed_from_round`，下一轮从「断点轮次 + 1」开始，已存储的轮次不重复不丢失。
- `terminate`：停止聚合循环，全部容器以 SIGKILL 结束（`status = killed`，记录 `released_at`），`runtime.released = true`，状态迁移到 `Terminated`；之后节点的 `running_job_count` 归零。
- `reset`：清空指标、断点和运行资源。

### 6.4 预估剩余时间

```
GET /fl/jobs/{job_id}/eta
```

```json
{
  "job_id": "fl_p1_002", "status": "Running", "current_round": 5, "total_rounds": 30,
  "elapsed_sec": 20.1, "eta_sec": 100.5, "eta_naive_sec": 100.5,
  "avg_round_sec": 4.02, "ema_round_sec": 4.02, "method": "ema", "alpha": 0.3,
  "formula": "sᵣ = α·dᵣ + (1 − α)·sᵣ₋₁，ETA = sᵣ × (总轮次 − 已完成轮次)，α = 0.3",
  "history": [{ "round": 1, "duration_sec": 4.1, "ema_sec": 4.1, "eta_sec": 118.9 }]
}
```

- `dᵣ`：第 r 轮聚合耗时（秒）。mock 的确定性模型：基准 4.2 秒，乘以 (1 + 0.12·sin(0.8r + φ))，加 ±0.3 秒抖动，约每 11 轮出现一次慢节点拖尾（+2.4 秒），φ 由任务 ID 哈希确定。
- `s₁ = d₁`，`sᵣ = 0.3·dᵣ + 0.7·sᵣ₋₁`；`eta_sec = sᵣ × (总轮次 − r)`；未开始为 `null`，Success 为 0。
- `eta_naive_sec = 已用时间 / r × 剩余轮次`（算术平均，供对比）。
- 暂停期间不计时。SSE `round_completed` 的 `eta_sec` 与 `elapsed_sec` 同为上述平滑结果（mock 通过内核扩展点 `db.etaOf(job)` 提供，并预调内核的已用时间计数器使其等于 Σdᵣ），页面直接使用推送值；本接口用于取 α、公式与逐轮明细。

任务不存在 40400。

### 6.5 每轮指标与曲线

`GET /fl/jobs/{job_id}/metrics?scope=&from_round=&to_round=&start_time=&end_time=`：返回格式同 API.md §2.7。每轮聚合后写入全局与每个参与节点的指标（分类 `loss` / `accuracy`，时序 `rmse` / `mae`）及 `recorded_at`。

| 情形 | code |
|---|---|
| `scope` 不是 `global` / `nodes` | 40000 |
| 轮次不是正整数；时间不是 ISO 8601 | 40002 |

错误提示使用界面上的中文字段名（开始时间、结束时间、起始轮次、结束轮次、曲线范围），例「开始时间不能晚于结束时间」。
| `from_round > to_round`；`start_time` 晚于 `end_time` | 40003 |
| 任务不存在 | 40400 |

页面曲线用 ECharts 5.5.1（`web/vendor/echarts.min.js`）绘制：两张折线图分别对应 `metrics_spec[0]` / `[1]`，横轴轮次 1 – `total_rounds`，纵轴 `y_min` – `y_max`，tooltip 显示「第 N 轮」与各曲线数值，每轮推送实时追加，容器尺寸变化时 resize，切换项目时 dispose。聚合节点不持有训练数据，内核每轮只为训练节点生成本地指标；`scope = nodes` 返回全局 + 各训练节点，历史查询与 CSV 同样只含训练节点。切换「显示」时页面先收起 tooltip 再整体替换曲线，避免 tooltip 引用已删除的序列。

### 6.6 历史指标查询与导出

```
GET /fl/metrics?project_id=&job_id=&start_time=&end_time=&scope=global|nodes&page=&page_size=
```

条件都可选、可组合（都不传即全部项目）；`page_size` 默认 50、最大 500。响应：

```json
{
  "items": [{ "project_id": "p1", "job_id": "fl_p1_001", "job_name": "稀土氧化物价格预测 · LSTM", "task_type": "timeseries",
              "round": 1, "series": "global", "loss": null, "accuracy": null, "rmse": 0.6725, "mae": 0.4964, "recorded_at": "…" }],
  "page": 1, "page_size": 50, "total": 115, "job_count": 2
}
```

下载 `GET /projects/{project_id}/fl/metrics/export?…` 或 `GET /fl/metrics/export?project_id=&job_id=&…`，CSV 列固定为：

```csv
project_id,job_id,task_type,round,series,loss,accuracy,rmse,mae,recorded_at(UTC+8)
p1,fl_p1_002,classification,1,global,0.9265,0.6076,,,2026-10-23 22:10:05 +08:00
```

导出文件的时间统一用 `k.fmtLocal` 写成 UTC+8，列名注明 `(UTC+8)`；接口 JSON 中的时间仍为 ISO 8601。

任务类型不适用的指标留空。错误码同 6.5，另有项目或任务不存在 40400。下载接口无法返回错误包（mock 抛出带原因的错误），页面导出前先用 `GET /fl/metrics` 校验条件和条数。

单任务导出 `GET /fl/jobs/{job_id}/metrics/export` 的列为 `job_id,round,series,<指标键>,recorded_at(UTC+8)`，默认 `scope = nodes`，`start_time` / `end_time` 按写入时间过滤，时间非法或开始晚于结束时导出失败并给出原因。
