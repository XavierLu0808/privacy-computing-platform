# 隐私计算平台控制台 · 后端接口文档

> 版本：v1.2（草案） · 日期：2026-10-24
> v1.2 变更：并入各模块的接口增补：项目与节点、数据隔离、算法库与参数模板、过程管控、聚合与安全、技术指标评估、HE 算法管理与密钥生命周期、MPC 协议管理与运维监控、PSI 算法配置与自适应路由、DP 隐私机制与框架集成。接口总数由 52 个增至 129 个（v1.2 新增 77 个）；逐条变更见 [附录 A](#附录-a--v12-变更说明)，全量接口见 [10. 接口总表](#10-接口总表)
> v1.1 变更：联邦学习新增任务类型（分类 / 时序预测）、任务列表与新建任务；隐私求交新增数据接入（数据集登记）；见各节「v1.1」标注
> 依据：v1.2 前端接口约定。早期单页演示设计稿已从运行仓库移除，可在 Git 历史中查阅。
> 范围：控制台全部五个模块（联邦学习 / 同态加密 / 多方安全计算 / 隐私求交 / 差分隐私）+ 公共接口

当前前端所有数值都是本地模拟（`setInterval` + 公式）。本文档定义把模拟替换成真实后端所需的全部接口。每个接口都标注了它对应的前端控件或展示字段。v1.2 新增或升级的小节标注「（v1.2）」，并保留验收编号（如 `FL-ORCH-01`）。

---

## 目录

0. [通用约定](#0-通用约定)
1. [公共接口（用户 / 项目）](#1-公共接口)
2. [联邦学习 FL](#2-联邦学习-fl)（含 v1.2 项目与节点、数据隔离、算法库、过程管控、聚合与安全、技术指标评估）
3. [同态加密 HE](#3-同态加密-he)（含 v1.2 算法管理、密钥生命周期、流程测试）
4. [多方安全计算 MPC](#4-多方安全计算-mpc)（含 v1.2 协议管理、流程编排、运维监控）
5. [隐私求交 PSI](#5-隐私求交-psi)（含 v1.1 数据接入、v1.2 算法配置与自适应路由）
6. [差分隐私 DP](#6-差分隐私-dp)（含 v1.2 会计方式、隐私机制、框架集成）
7. [实时推送（SSE）](#7-实时推送sse)
8. [枚举汇总](#8-枚举汇总)
9. [错误码](#9-错误码)
10. [接口总表](#10-接口总表)
11. [前端待接线清单](#11-前端待接线清单)
12. [附录 A · v1.2 变更说明](#附录-a--v12-变更说明)
13. [附录 B · v1.2 项目与算法库落库语义](#附录-b--v12-项目与算法库落库语义)

---

## 0. 通用约定

### 0.1 基础

| 项 | 约定 |
|---|---|
| Base URL | `https://<host>/api/v1` |
| 协议 | HTTPS |
| 请求体 | `Content-Type: application/json; charset=utf-8`（文件上传除外，用 `multipart/form-data`） |
| 响应体 | JSON，UTF-8 |
| 字段命名 | `snake_case` |
| 时间 | ISO 8601，带时区，例 `2026-09-18T16:42:00+08:00` |
| 时长 | 数字，单位写在字段名里：`_ms` 毫秒、`_sec` 秒 |
| 数据量 | 数字，单位写在字段名里：`_bytes` 字节、`_kb` KB |
| 数值格式化 | **后端返回原始数值，前端负责格式化**（如 `"1 分 12 秒"`、`"184.6 MB"`、保留 4 位小数） |
| ID | 字符串，由后端生成 |

### 0.2 鉴权

所有接口（除登录外）需带请求头：

```http
Authorization: Bearer <access_token>
```

未登录返回 HTTP `401`，业务码 `40100`。

### 0.3 统一响应包

成功：

```json
{
  "code": 0,
  "message": "ok",
  "data": { },
  "request_id": "req_8f3a2c1d"
}
```

失败：

```json
{
  "code": 40001,
  "message": "Paillier 不支持密文乘密文",
  "data": null,
  "request_id": "req_8f3a2c1d"
}
```

HTTP 状态码与 `code` 同时生效：2xx 成功；4xx 客户端错误；5xx 服务端错误。错误码见 [第 9 节](#9-错误码)。

### 0.4 分页

列表接口统一用 query 参数：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `page` | int | 否 | 1 | 页码，从 1 开始 |
| `page_size` | int | 否 | 20 | 每页条数，最大 100 |

分页响应的 `data`：

```json
{
  "items": [ ],
  "page": 1,
  "page_size": 20,
  "total": 57
}
```

### 0.5 项目作用域

顶栏「当前项目」下拉框决定作用域。挂在项目下的资源用路径 `/projects/{project_id}/...`；已有 ID 的资源（任务、会话）直接用 `/fl/jobs/{job_id}` 这类路径，后端自行校验该资源属于用户可访问的项目。

### 0.6 实时数据

训练进度、MPC 执行、PSI 流水线都是长任务。后端提供两种方式，前端二选一：

1. **SSE 推送（推荐）**：见 [第 7 节](#7-实时推送sse)
2. **轮询**：每 1–2 秒调一次对应的 `GET` 详情接口

### 0.7 校验错误与 `data` 约定（v1.2）

- 参数校验类错误（`40000` / `40002` / `40003`）在 `data.field` 给出出错字段路径，如 `ss.threshold`、`steps[1].protocol`、`config.sample_count`，界面据此把错误标在对应输入框下；越界时可带 `data.min` / `data.max`。
- 状态类错误（`40901`）按需带 `data.allowed_actions`（任务动作）、`data.job_ids`（占用资源的运行中任务）、`data.missing_node_ids` / `data.offline_node_ids`（启动预检）。
- 下载类接口（CSV / JSON 文件）成功时直接返回文件流，不走统一响应包；下载接口无法返回错误包时（mock 抛出带原因的错误），页面应在下载前先用对应的查询接口校验条件与条数。
- 各接口的数值边界以所在小节为准；错误码含义的扩展见 [第 9 节](#9-错误码)。

---

## 1. 公共接口

### 1.1 获取当前用户

对应：顶栏右上角头像（显示 `R`）。

```
GET /me
```

请求参数：无

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `user_id` | string | 用户 ID |
| `display_name` | string | 显示名 |
| `avatar_text` | string | 头像字母，例 `"R"` |
| `avatar_url` | string \| null | 头像图片 |
| `roles` | string[] | 角色，例 `["admin"]` |

```json
{
  "user_id": "u_1001",
  "display_name": "Rui",
  "avatar_text": "R",
  "avatar_url": null,
  "roles": ["admin"]
}
```

### 1.2 获取平台信息

对应：顶栏「[平台名称] 控制台」、环境徽标「演示数据 · 非真实业务环境」。

```
GET /platform/info
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `platform_name` | string | 平台名称 |
| `environment` | string | `demo` / `sandbox` / `production` |
| `environment_label` | string | 徽标文案 |
| `version` | string | 后端版本 |

```json
{
  "platform_name": "隐私计算平台",
  "environment": "demo",
  "environment_label": "演示数据 · 非真实业务环境",
  "version": "1.0.0"
}
```

### 1.3 项目列表

对应：顶栏「当前项目」下拉框。

```
GET /projects
```

Query：分页参数（可选）；`keyword` string，按名称模糊搜索（可选）

响应 `data.items[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` | string | 项目 ID，例 `p1` |
| `name` | string | 例 `"风控联合建模 · 2026Q3"` |
| `type` | string | 项目类型，见 `ProjectType` |
| `created_at` | string | 创建时间 |

```json
{
  "items": [
    { "project_id": "p1", "name": "风控联合建模 · 2026Q3", "type": "production", "created_at": "2026-07-01T10:00:00+08:00" },
    { "project_id": "p2", "name": "营销人群拓展 · 试点", "type": "pilot", "created_at": "2026-08-12T09:30:00+08:00" },
    { "project_id": "p3", "name": "跨机构反欺诈 · 沙箱", "type": "sandbox", "created_at": "2026-09-01T14:20:00+08:00" }
  ],
  "page": 1, "page_size": 20, "total": 3
}
```

v1.2 起（FL-ORCH-01 / 04），`items[]` 在上表基础上增加以下字段（顶栏下拉只用 `project_id` / `name`，向后兼容），`keyword` 与分页参数见上：

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

### 1.4 文件上传

对应：联邦学习「新建任务 → 算法 = 自定义上传模型」；隐私求交「接入数据 → 上传文件」（v1.1）。

```
POST /files
Content-Type: multipart/form-data
```

| 表单字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | 是 | 文件本体 |
| `purpose` | string | 是 | `fl_model` 模型文件 / `dataset` 数据集文件（v1.1） |
| `project_id` | string | 是 | 所属项目 |

响应 `data`：

```json
{
  "file_id": "f_77a1",
  "file_name": "my_model.py",
  "size_bytes": 20480,
  "sha256": "9c1e…",
  "uploaded_at": "2026-09-22T10:00:00+08:00"
}
```

### 1.5 创建项目（v1.2）

验收编号：FL-ORCH-01。对应：任务编排页「新建项目」。

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

响应 `data`：项目对象（同 1.3 的 `items[]`），例 `"target": { "metric": "rmse", "label": "RMSE（归一化）", "op": "<=", "value": 0.12, "task_type": "timeseries" }`。`seed_demo` 不传或为 `false` 时新项目没有节点，前端随后调用 `App.reloadProjects(project_id)` 切换顶栏。

| 情形 | code |
|---|---|
| 名称为空 / 指标不在枚举内 / 基准模型不支持该训练目标的任务类型 / `seed_demo` 不是布尔值 | 40000 |
| 目标值不是数字 | 40002 |
| 名称超长、轮数不在 1–200、目标值越界 | 40003 |
| 基准模型或版本不存在 | 40400 |
| 项目名称重复 | 40902 |

### 1.6 项目详情 / 修改（v1.2）

验收编号：FL-ORCH-04。对应：任务编排页「项目配置」卡的查看与保存。

```
GET   /projects/{project_id}
PATCH /projects/{project_id}
```

PATCH 字段同 1.5，均可选，只校验传入字段；`base_algorithm` 与 `model_version` 成对校验（只传其一时用当前值补齐）。成功后 `revision` +1，记录 `updated_by` / `updated_at`。项目不存在 40400，其余错误码同 1.5。

### 1.7 导出项目配置（v1.2）

验收编号：FL-ORCH-04。对应：项目配置卡「导出配置文件」。

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

---

## 2. 联邦学习 FL

页面：「联邦学习 / 过程管控 — 训练任务监控」

v1.2 起联邦学习扩展为四个二级页面：任务编排 `#/fed/orch`（页面模块 `FLO`，`web/js/fl-orch.js`）、过程管控 `#/fed/proc`（`FL`，`web/js/fl.js`）、聚合与安全 `#/fed/agg`（`FLA`）、技术指标验证 `#/fed/eval`（`FLE`）。mock 实现：`web/js/mock/fed-orch.js`（任务编排与过程管控）；测试：`web/tests/fed-orch.test.mjs`、`web/tests/fed-proc.test.mjs`。聚合与安全 / 技术指标验证的 mock 数据命名空间：`k.db.fla[project_id]`（已保存的聚合配置）、`k.db.flaKeys[project_id]`（聚合密钥对）、`k.db.fle[eval_id]`（评估记录）；技术指标评估会调用内核 `seedProject(project_id)` 确保项目的 `ds_{project_id}_ree_price` 数据集存在（与内核首次访问项目时的播种行为一致，不改内核字段）。

v1.2 内容分布：项目管理见 [1.3](#13-项目列表) / [1.5–1.7](#15-创建项目v12)；任务状态机、任务对象、创建、动作、曲线、导出、节点的升级写在 2.1–2.11 各小节的「v1.2」块；新增小节为 [2.12 聚合配置](#212-聚合配置v12)、[2.13 技术指标评估](#213-技术指标评估v12)、[2.14 数据隔离](#214-数据隔离v12)、[2.15 算法库](#215-算法库v12)、[2.16 预估剩余时间与历史指标](#216-预估剩余时间与历史指标v12)。

### 2.0 任务类型目录（v1.1）

对应：「新建训练任务」弹窗的任务类型切换、算法下拉；监控区两张指标卡与两张收敛曲线的标题、量纲。

```
GET /fl/task-types
```

响应 `data.items[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_type` | string | `FlTaskType`：`classification` 分类 / `timeseries` 时序预测 |
| `name` | string | 中文名 |
| `description` | string | 说明文字 |
| `algorithms` | string[] | 该类型可选算法，取值见 `FlAlgorithm` |
| `metrics` | array | 固定 2 项，依次对应第 1、2 张指标卡与曲线 |
| `metrics[].key` | string | 指标键，出现在任务详情 `global_metrics`、曲线点、SSE、CSV 列中 |
| `metrics[].label` | string | 展示名 |
| `metrics[].y_min` / `y_max` | number | 曲线纵轴量纲 |
| `metrics[].better` | string | `lower` 越低越好 / `higher` 越高越好 |
| `metrics[].digits` | int | 展示保留小数位 |
| `requires_timeseries` | bool | 为 `true` 时创建任务必须传 `timeseries` |

```json
{
  "items": [
    {
      "task_type": "classification", "name": "分类", "description": "二分类 / 多分类，如风控违约预测",
      "algorithms": ["lr", "xgb", "cnn", "custom"],
      "metrics": [
        { "key": "loss", "label": "Loss", "y_min": 0, "y_max": 1, "better": "lower", "digits": 4 },
        { "key": "accuracy", "label": "Accuracy", "y_min": 0.5, "y_max": 1, "better": "higher", "digits": 4 }
      ],
      "requires_timeseries": false
    },
    {
      "task_type": "timeseries", "name": "时序预测", "description": "按时间窗口预测未来值，如交易额、流量预测",
      "algorithms": ["lstm", "tcn", "custom"],
      "metrics": [
        { "key": "rmse", "label": "RMSE（归一化）", "y_min": 0, "y_max": 1, "better": "lower", "digits": 4 },
        { "key": "mae", "label": "MAE（归一化）", "y_min": 0, "y_max": 0.8, "better": "lower", "digits": 4 }
      ],
      "requires_timeseries": true
    }
  ]
}
```

时序预测的 RMSE / MAE 按目标列做 min-max 归一化后计算（取值 0–1 量级），不同数据集之间可比。

### 2.1 任务状态机

状态值（`FlJobStatus`）：`Created` 已创建、`Running` 运行中、`Paused` 已暂停、`Success` 已完成、`Failed` 失败、`Terminated` 已终止。

| 当前状态 | 允许的动作 | 目标状态 |
|---|---|---|
| `Created` | start | `Running` |
| `Running` | pause | `Paused` |
| `Running` | terminate | `Terminated` |
| `Running` | （跑完全部轮次） | `Success` |
| `Running` | （异常） | `Failed` |
| `Paused` | resume | `Running` |
| `Paused` | terminate | `Terminated` |
| `Terminated` / `Failed` | start | `Running`（从第 0 轮重开） |
| 任意状态 | reset | `Created`（非 Running 时） |

不允许的动作返回 HTTP `409`，业务码 `40901`。

按钮可用性由前端根据 `status` 计算，规则同上表（前端现有逻辑：`Running` 或 `Success` 时禁用「启动训练」；非 `Running` 禁用「暂停」；非 `Paused` 禁用「恢复」；非 `Running`/`Paused` 禁用「强制终止」）。

#### v1.2 补充 · 按动作的迁移矩阵（FL-PROC-01）

迁移表与上表一致（内核实现，不允许的动作返回 `40901`，`data.allowed_actions` 给出当前可执行动作）；下表另列出 `reset` 与自动迁移：

| 当前状态 | start | pause | resume | terminate | reset | 自动 |
|---|---|---|---|---|---|---|
| Created | Running | | | | Created | |
| Running | | Paused | | Terminated | | 跑满轮次 → Success；参与节点心跳丢失 → Failed |
| Paused | | | Running（断点续训） | Terminated | Created | |
| Success | | | | | Created | |
| Failed | Running（第 0 轮重开） | | | | Created | |
| Terminated | Running（第 0 轮重开） | | | | Created | |

### 2.2 训练任务列表

对应：「训练任务」列表（v1.1）。页面进入联邦学习模块时调用，默认选中列表第一项（最新创建）。

```
GET /projects/{project_id}/fl/jobs
```

Query：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | string | 否 | 按状态过滤，多个用逗号分隔 |
| `task_type` | string | 否 | 按任务类型过滤（v1.1），对应列表右上「任务类型」下拉 |
| `latest` | bool | 否 | `true` 时只返回最近一个任务 |
| 分页参数 | | 否 | |

响应 `data.items[]`：结构同 [2.4 任务详情](#24-获取任务详情)，按 `created_at` 倒序（最新在前）。

v1.2：列表项增加过程管控与算法引用字段（`allowed_actions`、`state_history`、`runtime`、`algo_ref`、`algo_ref_name`、`params` 等），见 [2.4 的 v1.2 新增字段](#v12-新增字段fl-proc-01--07fl-orch-06--07)；过滤参数不变。

### 2.3 创建训练任务

对应：「＋ 新建训练任务」弹窗（v1.1）。

```
POST /projects/{project_id}/fl/jobs
```

请求体：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | 否 | 自动生成 | 任务名 |
| `task_type` | string | 否 | `classification` | `classification` / `timeseries`（v1.1），见 [2.0](#20-任务类型目录v11) |
| `algorithm` | string | 是 | | 必须在该任务类型的 `algorithms` 内：分类 `lr` / `xgb` / `cnn` / `custom`；时序 `lstm` / `tcn` / `custom`；v1.2 起也可传已注册算法（`alg_*`）或本项目自定义模型（`mdl_*`）的 `algo_id`，见下文「v1.2 扩展」 |
| `model_file_id` | string | 条件 | | `algorithm = custom` 时必填，来自 [1.4](#14-文件上传) |
| `aggregation` | string | 条件 | | `ss` 秘密共享聚合 / `he` 同态加密聚合，对应「聚合策略」下拉；v1.2：未传时取项目的 `aggregation_default`（聚合与安全页设定），仍未设置才必填 |
| `total_rounds` | int | 否 | 项目配置的 `total_rounds`，未配置为 30 | 聚合总轮次，1–200 |
| `node_ids` | string[] | 是 | | 参与节点，须属于本项目，至少 2 个训练节点 + 1 个聚合节点 |
| `dp_enabled` | bool | 否 | false | 是否启用差分隐私，配置见 [第 6 节](#6-差分隐私-dp) |
| `dataset_source` | object | 否 | | 数据来源，二选一：<br>`{ "type": "dataset", "dataset_ids": ["ds_…"] }` 已接入数据集（见 [5.0](#50-数据接入v11)，须 `ready`）（v1.1）<br>`{ "type": "psi_pipeline", "pipeline_id": "psi_…" }` 已完成的 PSI 流水线 |
| `timeseries` | object | 条件 | | `task_type = timeseries` 时必填（v1.1） |
| `timeseries.time_column` | string | 是 | | 时间列；`dataset_source.type = dataset` 时须存在于所选数据集 |
| `timeseries.window_size` | int | 是 | | 回看窗口（天），1–365 |
| `timeseries.horizon` | int | 是 | | 预测步长（天），1–90 |

```json
{
  "algorithm": "xgb",
  "aggregation": "he",
  "total_rounds": 30,
  "node_ids": ["node-shanghai-01", "node-hangzhou-02", "node-center-agg"],
  "dp_enabled": true
}
```

时序任务示例：

```json
{
  "name": "网点客流预测 · TCN",
  "task_type": "timeseries",
  "algorithm": "tcn",
  "aggregation": "ss",
  "total_rounds": 30,
  "node_ids": ["node-shanghai-01", "node-hangzhou-02", "node-center-agg"],
  "dataset_source": { "type": "dataset", "dataset_ids": ["ds_p1_a_txn_ts"] },
  "timeseries": { "time_column": "txn_date", "window_size": 30, "horizon": 7 }
}
```

响应 `data`：任务详情，`status = "Created"`。

校验失败：

| 情形 | code | message 示例 |
|---|---|---|
| 算法不属于该任务类型 | 40000 | `时序预测任务不支持算法 lr，可选：lstm / tcn / custom` |
| 时序任务缺 `timeseries.time_column` | 40000 | `时序任务必须指定时间列 time_column` |
| `window_size` / `horizon` 越界 | 40003 | `预测步长必须是 1 – 90 的整数` |
| 时间列不在所选数据集中 | 40000 | `所选数据集中没有时间列 dt` |
| 节点不足 | 40000 | `至少选择 2 个训练节点和 1 个聚合节点` |
| 节点不属于本项目 / 数据集或流水线不存在 | 40400 | |
| 数据集未就绪 / 流水线未完成 | 40901 | |
| `custom` 未传 `model_file_id` | 40000 | `自定义模型需要先上传模型文件` |

#### v1.2 扩展 · 注册算法、参数与项目默认值（FL-ORCH-06 / 07 / 09）

在上表基础上：

| 字段 | 说明 |
|---|---|
| `algorithm` | 除 `lr` / `xgb` / `cnn` / `lstm` / `tcn` / `custom` 外，可传已注册算法（`alg_*`）或本项目自定义模型（`mdl_*`）的 `algo_id`；服务端映射为 `algorithm = custom` + 该算法当前版本的 `model_file_id` |
| `params` | 可选，按所选算法当前版本 schema 校验并补默认值 |
| `template_id` | 可选，记录参数来源模板 |
| `aggregation` | 未传时取 `aggregation_default`（聚合与安全页的项目策略），仍未设置则按原规则必填 |
| `total_rounds` | 未传时取项目配置 `total_rounds` |
| `name` | 未传且使用注册算法 / 自定义模型时默认「{算法名} {版本} · {任务类型}」 |

响应在任务详情基础上增加 `algo_ref`（`{ algo_id, name, kind, version, template_id? }`，使用内置算法时同样返回）、`params` 与 `algo_ref_name`。`algo_ref_name` 仅在 `algorithm = custom` 且来自注册算法 / 自定义模型时有值，例「稀土价格 Transformer v1.2.0（已注册）」「违约树模型 v1.0.0（自定义模型）」，其余为 `null`；任务列表、任务详情、任务动作三个接口同样返回这三个字段（过滤参数与 §2.2 一致），过程管控页的「算法」列、当前任务头和算法下拉用它显示真实算法名。`PATCH /fl/jobs/{job_id}` 仍为内核实现，响应不含这三个字段，前端在算法未变时沿用原值。内置算法且不带 `params` 时行为与 §2.3 完全一致。

| 新增情形 | code |
|---|---|
| 注册算法 / 自定义模型不支持该任务类型 | 40000 |
| 参数不在 schema 中 | 40000 |
| 参数类型或枚举不符 | 40002 |
| 参数越界 | 40003 |
| 自定义模型不属于本项目 | 40400 |

### 2.4 获取任务详情

对应：状态徽标、任务状态机、4 张指标卡、聚合策略说明。

```
GET /fl/jobs/{job_id}
```

响应 `data`：

| 字段 | 类型 | 说明 | 前端展示 |
|---|---|---|---|
| `job_id` | string | 任务 ID | |
| `project_id` | string | 项目 ID | |
| `name` | string | 任务名（v1.1） | 列表、「当前任务」 |
| `task_type` | string | `FlTaskType`（v1.1） | 类型标签 |
| `metrics_spec` | array | 同 2.0 `metrics`（v1.1） | 两张指标卡与曲线的标题、量纲 |
| `node_ids` | string[] | 参与节点（v1.1） | 「当前任务」说明 |
| `dataset_source` | object \| null | 同 2.3（v1.1） | 「当前任务」说明 |
| `timeseries` | object \| null | 同 2.3，非时序任务为 null（v1.1） | 「当前任务」说明 |
| `status` | string | `FlJobStatus` | 右上徽标、状态机高亮 |
| `algorithm` | string | `lr`/`xgb`/`cnn`/`custom` | 「算法」下拉 |
| `aggregation` | string | `ss`/`he` | 「聚合策略」下拉 |
| `aggregation_info` | object | 聚合细节，见下 | 控制条右侧说明文字 |
| `current_round` | int | 已完成轮次 | 「聚合轮次」大字 |
| `total_rounds` | int | 总轮次 | 「/ 30」 |
| `progress_pct` | int | 0–100 | 进度条 |
| `global_metrics` | object \| null | 最新一轮全局指标，键为 `metrics_spec[].key`，例 `{ "rmse": 0.1833, "mae": 0.1395 }`，未开始为 null（v1.1） | 第 1、2 张指标卡 |
| `global_metrics_prev` | object \| null | 上一轮全局指标（v1.1） | 「上一轮 …」 |
| `global_loss` | number \| null | 最新一轮全局 Loss，未开始或非分类任务为 null（兼容 v1.0，新前端读 `global_metrics`） | |
| `global_loss_prev` | number \| null | 上一轮全局 Loss（兼容字段） | |
| `global_accuracy` | number \| null | 最新一轮全局 Accuracy（兼容字段，非分类任务为 null） | |
| `global_accuracy_prev` | number \| null | 上一轮 Accuracy（兼容字段） | |
| `elapsed_sec` | number | 已用时长 | 「已用 …」 |
| `eta_sec` | number \| null | 预估剩余时长（v1.2：EMA 指数平滑，α = 0.3，见 [2.16.1](#2161-预估剩余时间)），未开始为 null | 「预估剩余时间」 |
| `dp_enabled` | bool | 是否启用 DP | |
| `created_at` | string | | |
| `started_at` | string \| null | | |
| `finished_at` | string \| null | | |
| `failure_reason` | string \| null | `Failed` 时的原因 | |

`aggregation_info`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | `ss` / `he` |
| `threshold` | int \| null | `ss` 时的门限 t，例 2 |
| `share_count` | int \| null | `ss` 时的份额数 n，例 3 |
| `he_key_ready` | bool \| null | `he` 时密钥对是否已生成 |
| `he_public_key_id` | string \| null | `he` 时公钥 ID，可调 [2.8](#28-查看聚合公钥) 查看 |

前端文案映射：`ss` → `秘密共享聚合 · 门限 {threshold} / {share_count}`；`he` → `同态加密聚合 · 密钥对已生成，公钥可查看`。

```json
{
  "job_id": "fl_20260922_01",
  "project_id": "p1",
  "status": "Running",
  "algorithm": "xgb",
  "aggregation": "he",
  "aggregation_info": { "type": "he", "threshold": null, "share_count": null, "he_key_ready": true, "he_public_key_id": "hek_91ab" },
  "current_round": 12,
  "total_rounds": 30,
  "progress_pct": 40,
  "global_loss": 0.3171,
  "global_loss_prev": 0.3502,
  "global_accuracy": 0.8423,
  "global_accuracy_prev": 0.8301,
  "elapsed_sec": 50.4,
  "eta_sec": 75.6,
  "dp_enabled": true,
  "created_at": "2026-09-22T09:58:00+08:00",
  "started_at": "2026-09-22T10:00:00+08:00",
  "finished_at": null,
  "failure_reason": null
}
```

#### v1.2 新增字段（FL-PROC-01 / 07、FL-ORCH-06 / 07）

任务详情 / 列表 / 动作响应新增：

| 字段 | 说明 |
|---|---|
| `allowed_actions` | 当前状态可执行的动作 |
| `state_history[]` | `{ from, to, action, at, operator, reason }`，`action` 取 `create` / `start` / `pause` / `resume` / `terminate` / `reset` / `complete`（跑满轮次）/ `fail`（异常） |
| `failure_reason` | `Failed` 时的原因，例「节点 node-hangzhou-02 心跳丢失，第 4 轮聚合未完成」 |
| `runtime` | `{ allocated_at, image, released, released_at, workers[] }`，`workers[]` 为 `{ node_id, role, container_id, pid, cpu_cores, memory_mb, status, started_at, released_at }`，`status` 取 `running` / `suspended` / `killed` / `completed` / `failed` |
| `checkpoint` | 最近一次断点（见 2.6 的 v1.2 扩展），无则 `null` |
| `elapsed_sec` / `eta_sec` | 按 [2.16.1](#2161-预估剩余时间) 的逐轮耗时与平滑公式计算 |
| `eta` | `{ method, alpha, ema_round_sec, avg_round_sec, eta_naive_sec }` |
| `algo_ref` | `{ algo_id, name, kind, version, template_id? }`，使用内置算法时同样返回 |
| `params` | 创建时按算法当前版本 schema 校验并补默认值后的参数 |
| `algo_ref_name` | 仅 `algorithm = custom` 且来自注册算法 / 自定义模型时有值，例「稀土价格 Transformer v1.2.0（已注册）」，其余为 `null`；过程管控页「算法」列、当前任务头和算法下拉用它显示真实算法名 |

`PATCH /fl/jobs/{job_id}` 仍是内核实现，响应不含以上字段，前端沿用上次的值。

### 2.5 修改任务配置

对应：「算法」「聚合策略」下拉切换。只允许在 `Created` / `Terminated` / `Failed` 状态修改，否则返回 `40901`。

```
PATCH /fl/jobs/{job_id}
```

请求体（字段全部可选，只传要改的）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `algorithm` | string | 须属于任务类型的 `algorithms`；`task_type` 创建后不可改 |
| `model_file_id` | string | `custom` 时必填 |
| `aggregation` | string | `ss`/`he` |
| `total_rounds` | int | |
| `dp_enabled` | bool | |

```json
{ "algorithm": "lr", "aggregation": "ss" }
```

响应 `data`：更新后的任务详情。

v1.2 补充：`algorithm` 仍只接受任务类型 `algorithms` 内的内置值与 `custom`，不接受已注册算法 / 自定义模型的 `algo_id`（它们只能在创建时指定，见 2.3）；响应不含 v1.2 新增字段（见 2.4），前端在算法未变时沿用原值；`Running` / `Paused` 时修改一律 `40901`。联邦学习「一键启用同态加密」即 `PATCH { "aggregation": "he" }`（见 [3.14](#314-联邦学习一键启用同态加密v12)）。

### 2.6 任务控制动作

对应控制条 5 个按钮：启动训练 / 暂停 / 恢复 / 强制终止 / 重置。

```
POST /fl/jobs/{job_id}/actions
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | 是 | `start` / `pause` / `resume` / `terminate` / `reset` |
| `reason` | string | 否 | 操作原因，`terminate` 时建议填写，写入审计日志 |

```json
{ "action": "pause" }
```

响应 `data`：动作执行后的任务详情。状态不允许时返回 HTTP `409`：

```json
{ "code": 40901, "message": "当前状态 Success 不允许执行 start", "data": { "status": "Success", "allowed_actions": ["reset"] }, "request_id": "req_…" }
```

#### v1.2 扩展 · 启动预检与资源分配（FL-PROC-01 / 02）

对应：过程管控页控制条。动作表见 2.1 的 v1.2 补充。

`start` 与 `resume` 在执行前做三项检查，任一失败则任务状态不变：

| 检查 | 失败情形 | code |
|---|---|---|
| 项目配置 | 任务所属项目不存在 | 40400 |
| 节点可用性 | 参与节点已从项目移除 | 40901（`data.missing_node_ids`） |
| | 参与节点离线（`online = false`） | 42201（`data.offline_node_ids`） |
| | 在册节点不足 2 个训练节点 + 1 个聚合节点 | 40000 |
| 算法兼容性 | 算法不在任务类型的可选列表；`custom` 的模型文件不存在；注册算法不支持该任务类型 | 40000 |

通过后响应带 `preflight[]`（`{ item, passed, detail }`），`start` 时为每个参与节点分配一个训练容器（镜像 `registry.local/fl-runtime:1.2.0`，训练节点 4 核 / 8 GB，聚合节点 2 核 / 4 GB），写入 `runtime.workers`。

#### v1.2 扩展 · 暂停、恢复与强制终止（FL-PROC-03 / 04）

- `pause`：停止聚合循环，保存断点 `{ checkpoint_id, round, saved_at, path, global_model_sha256, global_model_bytes, global_metrics, optimizer_state, node_cursors[] }`，`path` 形如 `/data/fl/ckpt/{job_id}/round_005.ckpt`，`node_cursors` 为各训练节点的数据读取位置；容器状态改为 `suspended`。
- `resume`：重新预检，容器恢复 `running`，响应带 `resumed_from_round`，下一轮从「断点轮次 + 1」开始，已存储的轮次不重复不丢失。
- `terminate`：停止聚合循环，全部容器以 SIGKILL 结束（`status = killed`，记录 `released_at`），`runtime.released = true`，状态迁移到 `Terminated`；之后节点的 `running_job_count` 归零。
- `reset`：清空指标、断点和运行资源。

### 2.7 获取训练指标曲线

对应：「收敛曲线」两张图（分类为 Loss / Accuracy，时序为 RMSE / MAE，按 `metrics_spec`），「显示：仅全局 / 各参与节点」下拉。

```
GET /fl/jobs/{job_id}/metrics
```

Query：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `scope` | string | 否 | `global` | `global` 仅全局 / `nodes` 全局 + 各节点 |
| `from_round` | int | 否 | 1 | 起始轮次 |
| `to_round` | int | 否 | 当前轮次 | 结束轮次 |

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `total_rounds` | int | 横轴最大值 |
| `metrics_spec` | array | 同 2.0 `metrics`（v1.1） |
| `series` | array | 曲线列表 |
| `series[].key` | string | `global` 或节点 ID |
| `series[].label` | string | 图例文字，例 `全局`、`node-shanghai-01` |
| `series[].points` | array | 按轮次升序 |
| `series[].points[].round` | int | 轮次 |
| `series[].points[].<key>` | number | 每个 `metrics_spec[].key` 一个字段：分类 `loss` / `accuracy`，时序 `rmse` / `mae` |
| `series[].points[].recorded_at` | string | 写入时间 |

`scope=global` 时只返回 `key = global` 一条。图例颜色由前端固定分配。

```json
{
  "total_rounds": 30,
  "series": [
    {
      "key": "global",
      "label": "全局",
      "points": [
        { "round": 1, "loss": 0.9265, "accuracy": 0.6076, "recorded_at": "2026-09-22T10:00:04+08:00" },
        { "round": 2, "loss": 0.8123, "accuracy": 0.6512, "recorded_at": "2026-09-22T10:00:08+08:00" }
      ]
    },
    {
      "key": "node-shanghai-01",
      "label": "node-shanghai-01",
      "points": [ { "round": 1, "loss": 0.9765, "accuracy": 0.5776, "recorded_at": "2026-09-22T10:00:04+08:00" } ]
    }
  ]
}
```

#### v1.2 扩展 · 查询条件与曲线绘制（FL-PROC-05 / 06）

`GET /fl/jobs/{job_id}/metrics?scope=&from_round=&to_round=&start_time=&end_time=`：新增 `start_time` / `end_time`（按写入时间过滤，ISO 8601），`from_round` / `to_round` 生效并校验，返回格式不变。每轮聚合后写入全局与每个参与节点的指标（分类 `loss` / `accuracy`，时序 `rmse` / `mae`）及 `recorded_at`。

| 情形 | code |
|---|---|
| `scope` 不是 `global` / `nodes` | 40000 |
| 轮次不是正整数；时间不是 ISO 8601 | 40002 |
| `from_round > to_round`；`start_time` 晚于 `end_time` | 40003 |
| 任务不存在 | 40400 |

错误提示使用界面上的中文字段名（开始时间、结束时间、起始轮次、结束轮次、曲线范围），例「开始时间不能晚于结束时间」。

页面曲线用 ECharts 5.5.1（`web/vendor/echarts.min.js`）绘制：两张折线图分别对应 `metrics_spec[0]` / `[1]`，横轴轮次 1 – `total_rounds`，纵轴 `y_min` – `y_max`，tooltip 显示「第 N 轮」与各曲线数值，每轮推送实时追加，容器尺寸变化时 resize，切换项目时 dispose。聚合节点不持有训练数据，内核每轮只为训练节点生成本地指标；`scope = nodes` 返回全局 + 各训练节点，历史查询与 CSV 同样只含训练节点。切换「显示」时页面先收起 tooltip 再整体替换曲线，避免 tooltip 引用已删除的序列。

### 2.8 查看聚合公钥

对应：聚合策略说明「公钥可查看」。

```
GET /fl/jobs/{job_id}/he-public-key
```

响应 `data`：

```json
{
  "key_id": "hek_91ab",
  "scheme": "paillier",
  "key_size_bits": 2048,
  "public_key": "3f9a1c…（完整公钥）",
  "fingerprint": "SHA256:6b1f…",
  "created_at": "2026-09-22T09:58:10+08:00"
}
```

私钥不对外暴露，无对应接口。

#### v1.2 扩展 · 项目密钥优先（FL-AGG-04）

mock 用 `routeFirst` 覆盖内核路由：任务为同态聚合且所属项目有有效项目密钥（2.12.6）时，返回该密钥，过程管控页「查看公钥」与同态应用集成页看到的公钥与聚合与安全页一致；否则按内核原逻辑返回。响应字段保持 §2.8 结构（`key_id`、`scheme`、`key_size_bits`、`public_key`、`fingerprint`、`created_at`），项目密钥另附 `poly_modulus_degree`、`coeff_modulus_bits`、`source = "project"`；CKKS 没有模数位数，`key_size_bits` 取系数模数总位数 log₂Q。错误码：`40400` 任务不存在或任务不是同态聚合。

### 2.9 导出指标 CSV

对应：「导出 CSV」按钮；图表下方提示「可按时间范围或项目 ID 查询并导出 CSV」。

```
GET /fl/jobs/{job_id}/metrics/export
```

Query：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `scope` | string | 否 | `nodes` | `global` / `nodes` |
| `start_time` | string | 否 | | 按写入时间过滤 |
| `end_time` | string | 否 | | 按写入时间过滤 |

响应：**直接返回文件流**，不走统一响应包。

```http
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="fl_20260922_01_metrics.csv"
```

CSV 列：前三列与最后一列固定，中间按任务类型的指标键（v1.1）。分类任务：

```csv
job_id,round,series,loss,accuracy,recorded_at
fl_20260922_01,1,global,0.9265,0.6076,2026-09-22T10:00:04+08:00
fl_20260922_01,1,node-shanghai-01,0.9765,0.5776,2026-09-22T10:00:04+08:00
```

时序任务：

```csv
job_id,round,series,rmse,mae,recorded_at
fl_p1_003,1,global,0.6828,0.5094,2026-10-20T09:40:04+08:00
```

按项目跨任务导出：

```
GET /projects/{project_id}/fl/metrics/export?start_time=…&end_time=…
```

参数同上；v1.2 起 CSV 列与过滤条件改为 [2.16.2](#2162-历史指标查询与导出) 的固定列（含 `project_id`、`task_type`），不再与单任务 CSV「格式同上」。

#### v1.2 扩展 · 时间范围生效（FL-PROC-08）

单任务导出 `GET /fl/jobs/{job_id}/metrics/export` 的列为 `job_id,round,series,<指标键>,recorded_at(UTC+8)`，默认 `scope = nodes`，`start_time` / `end_time` 按写入时间过滤，时间非法或开始晚于结束时导出失败并给出原因。

### 2.10 获取参与方节点（任务维度）

对应：「参与方节点」表格。

```
GET /fl/jobs/{job_id}/nodes
```

响应 `data.items[]`：

| 字段 | 类型 | 说明 | 表格列 |
|---|---|---|---|
| `node_id` | string | 例 `node-shanghai-01` | 节点 ID |
| `ip` | string | 例 `10.22.6.14` | IP / 端口 |
| `port` | int | 例 `8471` | IP / 端口 |
| `role` | string | `trainer` 训练节点 / `aggregator` 聚合节点 | 角色 |
| `role_label` | string | 例 `参与方 / 训练节点` | 角色 |
| `data_partition` | string \| null | 例 `part-A`；聚合节点为 null（前端显示 `—`） | 数据分区 |
| `round_upload_kb` | number \| null | 本轮梯度上传量，未开始为 null | 本轮梯度上传 |
| `status` | string | `FlNodeStatus`，见下 | 状态 |

`FlNodeStatus`：`pending` 待启动、`uploading` 上传中、`suspended` 已挂起、`completed` 已完成、`released` 已释放、`offline` 离线。

```json
{
  "items": [
    { "node_id": "node-shanghai-01", "ip": "10.22.6.14", "port": 8471, "role": "trainer", "role_label": "参与方 / 训练节点", "data_partition": "part-A", "round_upload_kb": 151.4, "status": "uploading" },
    { "node_id": "node-hangzhou-02", "ip": "10.31.8.27", "port": 8471, "role": "trainer", "role_label": "参与方 / 训练节点", "data_partition": "part-B", "round_upload_kb": 131.1, "status": "uploading" },
    { "node_id": "node-center-agg", "ip": "10.10.1.5", "port": 9090, "role": "aggregator", "role_label": "聚合方 / 协调节点", "data_partition": null, "round_upload_kb": 169.2, "status": "uploading" }
  ],
  "page": 1, "page_size": 20, "total": 3
}
```

v1.2（FL-PROC-02）：项目节点置 `online = false`（心跳丢失，见 2.11.3）后，该节点在任务维度的 `status` 为 `offline`，使用它的 `Running` 任务转 `Failed`；启动 / 恢复前的节点预检见 2.6 的 v1.2 扩展。

### 2.11 项目节点管理

对应：「添加节点」按钮（前端尚未接线，见 [第 11 节](#11-前端待接线清单)）。

**列出项目下可用节点**

```
GET /projects/{project_id}/nodes
```

响应 `data.items[]`：`node_id`、`ip`、`port`、`role`、`role_label`、`data_partition`、`online`(bool)、`last_heartbeat_at`；v1.2 增加 `data_dir`、`running_job_count`（见 2.11.1）。

**添加节点**

```
POST /projects/{project_id}/nodes
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `node_id` | string | 是 | 项目内唯一（v1.1 草案写作「全局唯一」，v1.2 以项目内唯一为准，见附录 A），小写字母、数字、`-`，≤ 40 个字符 |
| `ip` | string | 是 | IPv4 / IPv6 |
| `port` | int | 是 | 1–65535 |
| `role` | string | 是 | `trainer` / `aggregator` |
| `data_partition` | string | 条件 | `role = trainer` 时必填 |
| `data_dir` | string | 否 | 节点本地数据目录（节点只访问该目录）；v1.2：须为绝对路径，训练节点缺省为 `/data/fl/{project_id}/{分区小写}`，聚合节点为 `null` |

```json
{ "node_id": "node-beijing-03", "ip": "10.40.3.9", "port": 8471, "role": "trainer", "data_partition": "part-C", "data_dir": "/data/fl/part-c" }
```

响应 `data`：新节点对象。后端应做连通性检查，不可达时返回 `42201`。

**删除节点**

```
DELETE /projects/{project_id}/nodes/{node_id}
```

节点正被运行中任务使用时返回 `40901`。

#### 2.11.1 节点对象扩展（v1.2）

验收编号：FL-ORCH-02。

节点对象在上文基础上增加：`data_dir`（本地数据目录，训练节点默认 `/data/fl/{project_id}/{分区小写}`，聚合节点为 `null`）、`last_heartbeat_at`、`running_job_count`（使用该节点且状态为 Running / Paused 的任务数）。

#### 2.11.2 添加节点校验（v1.2）

`POST /projects/{project_id}/nodes`，字段见上。校验：

| 情形 | code |
|---|---|
| 节点 ID 不是小写字母 / 数字 / `-`；角色不是 `trainer` / `aggregator`；训练节点缺数据分区；缺 IP 或端口 | 40000 |
| IP 不是合法 IPv4 / IPv6；IP 为特殊地址（0.0.0.0、255.255.255.255、0.0.0.0/8、回环 127.0.0.0/8 与 ::1、组播 224.0.0.0/4 与 ff00::/8、保留 240.0.0.0/4、按 /24 子网的网络地址 x.x.x.0 与广播地址 x.x.x.255、::），message 说明原因；数据分区含非法字符；`data_dir` 不是绝对路径 | 40002 |
| 端口不在 1–65535；节点 ID 超过 40 个字符 | 40003 |
| 节点 ID 在项目内重复 | 40902 |
| 连通性检查失败（mock：`192.0.2.0/24` 文档保留网段视为不可达） | 42201 |

#### 2.11.3 编辑节点（v1.2）

```
PATCH /projects/{project_id}/nodes/{node_id}
```

可改 `node_id`、`ip`、`port`、`role`、`data_partition`、`data_dir`、`online`（bool，见 2.6 的 v1.2 扩展），只校验传入字段，规则同 2.11.2。额外规则：

| 情形 | code |
|---|---|
| 节点被运行中任务使用时修改 `node_id` / `role` / `data_partition` / `data_dir`（IP 与端口可改） | 40901，`data.job_ids` 列出任务 |
| 节点已被任何历史任务引用时修改 `node_id`（节点 ID 是任务引用节点的稳定标识） | 40901 |
| 新 `node_id` 与已有节点重复 | 40902 |
| 节点不存在 | 40400 |

改为聚合节点时 `data_partition`、`data_dir` 置空。

#### 2.11.4 删除节点（v1.2）

`DELETE /projects/{project_id}/nodes/{node_id}`：节点被运行中任务使用时返回 40901（`data.job_ids`），不存在 40400。

### 2.12 聚合配置（v1.2）

一个项目一份聚合配置，保存后任务编排页新建任务时读取 `strategy` 作为默认聚合方式。未保存过的项目返回平台默认值（`saved = false`）。

#### 2.12.1 配置对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `strategy` | string | `ss` 秘密共享聚合 / `he` 同态加密聚合 |
| `ss.parties` | int | 参与方数量 n，2–16，默认取项目训练节点数 |
| `ss.threshold` | int | 门限 t，2 ≤ t ≤ n |
| `ss.dropout_tolerance` | int | 掉线容忍数 d，0 ≤ d ≤ n − t |
| `ss.field_bits` | int | 有限域位数，16–64，且 ≥ `sparsification.quant_bits` + ⌈log₂n⌉（n 方求和不溢出） |
| `ss.mask_rotation_rounds` | int | 掩码种子轮换周期（轮），1–100 |
| `he.scheme` | string | `paillier` / `ckks` |
| `he.key_size_bits` | int | Paillier 模数位数：`2048` / `3072` / `4096` |
| `he.precision_bits` | int | Paillier 定点编码精度（二进制位），8–53 |
| `he.batch_size` | int | 批打包大小。Paillier：1–128 且 批打包 × (精度 + ⌈log₂n⌉ + 1) ≤ 密钥长度 − 1；CKKS：1 – N/2 |
| `he.poly_modulus_degree` | int | CKKS 多项式阶数 N：`4096` / `8192` / `16384` / `32768` |
| `he.coeff_modulus_bits` | int | CKKS 系数模数总位数，≥ 缩放因子位数 + 20，≤ 128 bit 安全上限（4096: 109，8192: 218，16384: 438，32768: 881） |
| `he.scale_bits` | int | CKKS 缩放因子 Δ = 2^`scale_bits`，20–60 |
| `sparsification.enabled` | bool | 是否启用 Top-k 稀疏化；关闭时 ρ = 100%、不传下标 |
| `sparsification.topk_ratio` | number | Top-k 保留比例 ρ，0.001–1（界面按百分比 0.1%–100% 展示） |
| `sparsification.error_feedback` | bool | 误差反馈：未上传的梯度残差累积到下一轮 |
| `sparsification.quant_bits` | int | 量化位数：`4` / `8` / `16` / `32` |
| `updated_at` | string | 最近保存时间 |

`he` 下只校验当前 `scheme` 用到的字段，另一方案的字段原样保存。

校验失败统一返回 `data.field`（如 `ss.threshold`），界面据此把错误标在对应输入框下：`40000` 缺字段或枚举不合法，`40002` 非数字 / 非整数，`40003` 越界（含跨字段约束）。

#### 2.12.2 获取聚合配置

验收编号：FL-AGG-01、FL-AGG-02、FL-AGG-03、FL-AGG-07。对应：聚合与安全页全部表单的初始值、「套用推荐配置」、推荐配置说明行。

```
GET /projects/{project_id}/fl/aggregation
```

响应 `data`：配置对象全部字段，外加：

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` / `project_name` | string | |
| `saved` | bool | 是否保存过；`false` 时返回的是平台默认配置 |
| `trainer_count` | int | 项目训练节点数 |
| `he_key` | object \| null | 当前有效密钥摘要（见 2.12.6） |
| `he_key_matches` | bool | 当前有效密钥与已保存的 `he` 参数是否一致 |
| `estimate` | object | 按已保存配置算的通信量估算（见 2.12.5） |
| `defaults` | object | 平台默认配置（恢复默认用） |
| `recommended` | object | 推荐配置：`ss`、`he.paillier`、`he.ckks`、`sparsification` |
| `limits` | object | 参数取值范围（供界面提示） |

推荐规则：门限 t = ⌊n/2⌋ + 1（多数派），掉线容忍 d = n − t，掩码种子每 10 轮轮换；Paillier 2048 bit、精度 24 bit，批打包取明文空间能容纳的最大值 ⌊2047 / (24 + ⌈log₂n⌉ + 1)⌋（n = 3 时为 75）；CKKS N = 8192、系数模数 200 bit、Δ = 2⁴⁰、4096 槽。

```json
{
  "project_id": "p1", "project_name": "稀土氧化物价格联合预测 · 2026Q4", "saved": false,
  "strategy": "ss",
  "ss": { "parties": 3, "threshold": 2, "dropout_tolerance": 0, "field_bits": 16, "mask_rotation_rounds": 5 },
  "he": { "scheme": "paillier", "key_size_bits": 2048, "precision_bits": 24, "batch_size": 16, "poly_modulus_degree": 8192, "coeff_modulus_bits": 218, "scale_bits": 40 },
  "sparsification": { "enabled": true, "topk_ratio": 0.15, "error_feedback": true, "quant_bits": 8 },
  "updated_at": null, "trainer_count": 3, "he_key": null, "he_key_matches": false,
  "estimate": { "kept": 30472, "ratio": 7.8038, "…": "见 2.12.5" },
  "recommended": { "ss": { "parties": 3, "threshold": 2, "dropout_tolerance": 1, "field_bits": 16, "mask_rotation_rounds": 10 }, "…": "…" }
}
```

错误码：`40400` 项目不存在。

#### 2.12.3 保存聚合配置

验收编号：FL-AGG-06（以及 FL-AGG-02 / 03 / 07 的参数落库）。对应：页头「保存到项目」。

```
PUT /projects/{project_id}/fl/aggregation
```

请求体：配置对象（`strategy`、`ss`、`he`、`sparsification`，缺省字段按平台默认补齐）。落库为 `k.db.fla[project_id] = { strategy, ss, he, sparsification, updated_at }`。

响应 `data`：同 2.12.2。

错误码：`40000` / `40002` / `40003` 参数不合法（`data.field` 指出字段）；`40901` 策略为 `he` 但项目没有有效密钥对，或有效密钥的方案 / 长度（CKKS 为 N 与系数模数）与 `he` 参数不一致（`data.field = "he_key"`）；`40400` 项目不存在。失败时不覆盖已保存配置。

#### 2.12.4 恢复默认

验收编号：FL-AGG-05。对应：页头「恢复默认」及确认弹窗。

```
POST /projects/{project_id}/fl/aggregation/reset
```

请求体：空。把项目配置恢复为平台默认（秘密共享聚合，t = 2，有限域 16 bit，掩码每 5 轮轮换，Top-k 15%，量化 8 bit，开启误差反馈）并立即保存。已生成的密钥对不动。

响应 `data`：同 2.12.2。错误码：`40400`。

#### 2.12.5 通信量实时估算（不落库）

验收编号：FL-AGG-07（同时承担 FL-AGG-02 / 03 表单的实时校验）。对应：「梯度稀疏化」卡的四个指标、公式说明框；任意参数改动后 220 ms 去抖调用。

```
POST /projects/{project_id}/fl/aggregation/estimate
```

请求体：配置对象。响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `strategy` | string | |
| `client_count` | int | n（取 `ss.parties`） |
| `model` / `model_params` | string / int | 估算用模型：2 层 LSTM（128 隐藏单元，输入 9 维，步长 7），P 取内核参数量表 `MODEL_PARAMS.lstm` = 203,143 |
| `index_bits` | int | 单个下标编码位数 ⌈log₂P⌉ = 18 |
| `rho` / `kept` | number / int | 保留比例 ρ、保留梯度数 k = ⌈ρ × P⌉ |
| `upload_bytes_per_client` | number | 每客户端每轮上行字节 |
| `download_bytes_per_client` | number | 每客户端每轮下行字节 |
| `index_bytes` | number | 下行下标集合字节 |
| `seed_bytes` | number | 掩码种子协商每轮平均字节（仅 `ss`） |
| `ciphertext_bits` / `ciphertext_count` | int \| null | 同态模式下单密文位数与每客户端密文个数 |
| `ours_bytes` | number | 本算法单轮通信总量 |
| `fedavg_bytes` | number | FedAvg 单轮通信总量 |
| `ratio` | number | 通信压缩比 = `fedavg_bytes` ÷ `ours_bytes` |
| `min_ratio_required` / `meets_contract` | int / bool | 合同阈值 6 与是否达到 |

计算公式（全局 Top-k：服务端按上一轮聚合结果下发统一下标集合，客户端只上传这些位置，秘密共享掩码与同态密文槽位因此对齐，上行不带下标）：

- FedAvg 单轮 = n × (P × 32 + P × 32) bit
- 上行（秘密共享）= k × `field_bits`；上行（同态）= ⌈k / `batch_size`⌉ × 单密文位数（Paillier 2 × `key_size_bits`，CKKS 2 × N × `coeff_modulus_bits`）
- 下行 = k × 32（聚合后的明文更新）+ min(k × 18, P)（下一轮下标集合，列表与位图取小）
- 掩码种子协商 = n × (n − 1) × 2 × 256 / `mask_rotation_rounds`（X25519 公钥 256 bit，仅秘密共享）
- 本算法单轮 = n × (上行 + 下行) + 种子协商

默认配置（n = 3，ρ = 15%，有限域 16 bit）下：k = 30,472，每客户端上行 59.5 KB，本算法单轮 610.1 KB，FedAvg 单轮 4.6 MB，压缩比 7.80 倍。

错误码：同 2.12.3 的参数校验错误。

#### 2.12.6 密钥对

验收编号：FL-AGG-04。对应：同态加密聚合下的「同态加密密钥对」卡：「生成密钥对」「查看公钥」、密钥列表。

```
POST /projects/{project_id}/fl/aggregation/keys
```

请求体：`{ "he": { …同态参数… } }`，按 2.12.1 校验。生成新密钥后，项目原有效密钥状态变为 `rotated`。私钥由平台密钥服务托管，接口只返回 `private_key_ref`（KMS 引用），不返回任何私钥材料。

响应 `data`（公钥详情，同 `GET …/public-key`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key_id` | string | 例 `flk_0001` |
| `project_id` / `project_name` | string | 所属项目 |
| `scheme` | string | `paillier` / `ckks` |
| `key_size_bits` | int \| null | Paillier 模数位数 |
| `poly_modulus_degree` / `coeff_modulus_bits` | int \| null | CKKS 参数 |
| `security_bits` | int | 安全强度（Paillier 2048 / 3072 / 4096 → 112 / 128 / 152；CKKS 按 HE 标准取 128） |
| `generator` | string \| null | Paillier 生成元 `g = n + 1` |
| `public_key` | string | 十六进制。Paillier 为完整模数 n；CKKS 公钥体积大，只给前 512 bit 预览 |
| `public_key_bytes` | int | 完整公钥字节数 |
| `public_key_truncated` | bool | 是否为预览 |
| `fingerprint` | string | `SHA256:` + 64 位十六进制 |
| `private_key_ref` | string | 私钥在 KMS 中的引用，例 `kms://fl-agg/p1/flk_0001` |
| `status` | string | `active` / `rotated` / `destroyed` |
| `created_at` | string | 生成时间 |

错误码：`40000` / `40002` / `40003` 同态参数不合法；`40400` 项目不存在。

```
GET /projects/{project_id}/fl/aggregation/keys
```

响应 `data`：分页列表，最新在前，每项为密钥摘要（`key_id`、`scheme`、`key_size_bits`、`poly_modulus_degree`、`coeff_modulus_bits`、`fingerprint`、`status`、`created_at`）。

```
GET /projects/{project_id}/fl/aggregation/public-key
```

返回当前有效密钥的公钥详情。错误码：`40402` 项目当前没有在用的聚合密钥（例如在同态加密页销毁了在用密钥）；`40400` 项目不存在。

`GET …/aggregation`、`…/keys`、`…/public-key`、`PUT …/aggregation`、`POST …/reset` 在读取项目密钥前先确保同态模块已为该项目播种聚合密钥，因此首次进入即显示同态模块在用的聚合密钥，初始状态、密钥列表与过程管控口径一致。`GET /fl/jobs/{job_id}/he-public-key` 不触发播种，保证与同一时刻任务详情的 `he_public_key_id` 一致。

与同态加密模块共用一套密钥（约定见 [3.13.5](#3135-外部模块写入的密钥)）：

- 生成时只写内核 `k.db.heKeys[key_id]`：`project_id`、`scheme`、`purpose = "fl_aggregation"`、`status = "active"`、`created_at`、`distributed_to`（项目全部节点）、`key_params`（Paillier `{ key_size_bits }`；CKKS `{ poly_modulus_degree, coeff_modulus_bits, scale_bits }`）、`rotated_from`，另带兼容字段 `key_size_bits`（CKKS 取 log₂Q）。同态模块列出时自行补建生命周期元数据，这把密钥也可直接用于 §3 四步流程。
- 生成前先触发同态模块对该项目的密钥播种，再把项目其余在用的聚合密钥的 `k.db.heKeys[id].status` 改为 `rotated`（`rotated_to` 指向新密钥），保证项目同时只有一把在用的聚合密钥。
- 项目有效聚合密钥 = 同态模块生命周期表中 `status = active` 的 `fl_aggregation` 密钥（包括同态页播种或轮换出的 `hek_` 密钥）；表中没有的按 `k.db.heKeys[id].status` 判断。`k.db.flaKeys[project_id]` 是它的镜像，每次读取时同步，内核 `aggregationInfo` 读它，因此任务详情 `aggregation_info.he_public_key_id`、`GET /fl/jobs/{job_id}/he-public-key`、本页公钥三者一致。同态页销毁后状态为 `destroyed`，`GET …/public-key` 返回 `40402`。

### 2.13 技术指标评估（v1.2）

验收编号：FL-EVAL-01、FL-EVAL-02、FL-EVAL-03（合同 T-01、T-02）。对应：技术指标验证页三张评估卡、指标总览、历史评估记录。

页面顶部固定显示数据来源说明：「当前数值来自原型内置评估引擎的仿真结果」。

评估是异步长任务：创建后约 3–4 秒完成（mock 每 400 ms 推进一步），进度用 SSE 推送，也可轮询详情。同一项目同一类评估同时只能有一个在运行。结果确定可复现：同项目、同配置结果完全一致。

#### 2.13.1 评估类型与配置

| `kind` | 验收编号 | 配置字段（范围，默认） |
|---|---|---|
| `gradient_attack` | FL-EVAL-01 | `sample_count` 攻击样本数（20–1000，200）；`max_iterations` 攻击迭代次数（50–2000，300）；`target_client` 被攻击客户端（`all` / `party-a` / `party-b` / `party-c`，`all`）；`seed`（0–99999，2026） |
| `compression` | FL-EVAL-02 | `rounds` 训练轮次（5–100，20）；`topk_ratio`（0.001–1，取项目已保存配置）；`quant_bits`（4 / 8 / 16 / 32，取项目配置）；`error_feedback`（bool，取项目配置）；`field_bits`（max(16, `quant_bits` + ⌈log₂n⌉) 至 64，n = 3 客户端，与 2.12.1 同一约束；取项目配置） |
| `accuracy` | FL-EVAL-03 | `rounds` 联邦轮次（10–200，50）；`local_epochs` 本地训练轮数（1–5，1）；`partition`（`iid` / `dirichlet`，`iid`）；`seed`（0–99999，2026） |

```
GET /projects/{project_id}/fl/evaluations/defaults
```

响应 `data`：`{ gradient_attack: {…}, compression: {…}, accuracy: {…}, mse_threshold: 0.0025, model, model_params }`。

#### 2.13.2 创建评估

```
POST /projects/{project_id}/fl/evaluations
```

请求体：`{ "kind": "gradient_attack", "config": { "sample_count": 200 } }`，`config` 缺省字段取默认。

响应 `data`：评估记录（`status = running`、`progress = 0`）。

错误码：`40000` `kind` 或枚举不合法；`40002` / `40003` 配置越界（`data.field` 如 `config.sample_count`）；`40901` 同类评估正在运行；`40400` 项目不存在。

#### 2.13.3 评估记录

```
GET /fl/evaluations/{eval_id}
GET /projects/{project_id}/fl/evaluations?kind=
```

列表最新在前，`kind` 可选过滤。评估记录字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `eval_id` | string | 例 `fle_0003` |
| `kind` / `kind_label` | string | 评估类型与中文名 |
| `config` | object | 规整后的配置 |
| `status` | string | `running` / `finished` |
| `progress` | int | 0–100 |
| `stage` | string | 当前阶段文字，如「运行 iDLG 攻击（本算法）」 |
| `started_at` / `finished_at` | string | |
| `result` | object \| null | 完成后给出，见下 |
| `passed` | bool \| null | 是否达到合同阈值 |

`gradient_attack` 的 `result`：

| 字段 | 说明 |
|---|---|
| `scenario` | `dataset_id`（`ds_{project}_ree_price`）、`dataset_name`、`dataset_rows`、`server_count = 1`、`client_count = 3`、`model`、`model_params`、`window_size = 30`、`feature_count = 9`、`horizon = 7`、`batch_size = 1`、`mse_threshold = 0.0025`、`normalization = "min-max"` |
| `groups[]` | `key = ours`（本算法：稀疏化 + 安全聚合 + DP）与 `key = fedavg`（对照：明文 FedAvg） |
| `groups[].attacks[]` | `attack`（`DLG` / `iDLG`）、`sample_count`、`success_count`、`success_rate`（0–1，界面按百分比展示）、`mean_mse`（全部攻击样本还原 MSE 的算术平均） |
| `max_success_rate_required` | 0.05 |
| `max_success_rate` / `passed` | 本算法两类攻击中较高的成功率，≤ 0.05 为达标 |

判定口径：还原样本与原始样本在 Min-Max 归一化空间逐元素 MSE ≤ 0.0025 记为还原成功（等价 RMSE ≤ 0.05）。默认配置下本算法 DLG、iDLG 均为 0 / 200（0.0%），明文 FedAvg 约 84% / 85%。

`compression` 的 `result`：

| 字段 | 说明 |
|---|---|
| `scenario` | 同一时序任务，`client_count = 3`，`strategy = ss`，`model_params = 203143`，`index_bits = 18` |
| `rounds[]` | `round`、`kept`（本轮保留梯度数）、`kept_ratio`、`fedavg_bytes`、`ours_bytes`、`ratio`（本轮压缩比） |
| `fedavg_avg_bytes` / `ours_avg_bytes` | 两者单轮平均通信总量（字节） |
| `ratio` | 单轮平均通信压缩比 = `fedavg_avg_bytes` ÷ `ours_avg_bytes`，≥ 6 为达标 |
| `utility` | `fedavg.{rmse, mae}`、`ours.{rmse, mae}`（测试集，Min-Max 归一化价格）、`rmse_increase_pct`、`mae_increase_pct`（本算法相对 FedAvg 的变化百分比） |

每轮通信量按 2.12.5 公式计算（掩码种子每 10 轮协商），保留数量按梯度能量动态调整：ρ_r = ρ × (1 + 0.3 × e^−(r−1)/4 + 抖动)，前几轮偏多、随收敛回落。默认配置下 20 轮平均压缩比约 7.4 倍，RMSE 相对 FedAvg 增加约 1.3%。

`accuracy` 的 `result`：

| 字段 | 说明 |
|---|---|
| `scenario` | `client_count = 3`、`privacy`（隐私保护组合说明）、`optimizer`、`centralized_epochs`（= `rounds` × `local_epochs`） |
| `datasets[]` | `dataset`（`MNIST` / `CIFAR-10`）、`model`、`centralized_accuracy`、`federated_accuracy`（0–1）、`drop_pp`（下降幅度，百分点）、`relative_drop_pct`（相对下降 %）、`passed`（`drop_pp` ≤ 3） |
| `max_drop_pp_required` | 3 |
| `passed` | 两个数据集均达标 |

默认配置下 MNIST 下降约 0.7 个百分点，CIFAR-10 约 2.0 个百分点；联邦轮次取 10 时 CIFAR-10 约 4.2 个百分点（未达标）。

#### 2.13.4 进度推送（SSE）

```
GET /fl/evaluations/{eval_id}/events
```

| 事件 | data |
|---|---|
| `progress` | `{ eval_id, progress, stage }` |
| `finished` | 完整评估记录（含 `result`） |

#### 2.13.5 导出评估报告

```
GET /fl/evaluations/{eval_id}/export
```

返回 CSV（UTF-8 BOM），文件名 `{eval_id}_{kind}_report.csv`。内容：评估 ID、评估项、项目、起止时间（列名「开始时间（UTC+8）」「完成时间（UTC+8）」，按内核 `fmtLocal` 写成 `2026-10-23 22:10:05 +08:00`）、配置 JSON，以及该类评估的结果表（攻击：组别 × 攻击方法的样本数 / 成功数 / 成功率 / 平均 MSE；压缩比：逐轮通信量 MB 与平均压缩比、RMSE / MAE 对比；精度：两数据集的集中式 / 联邦 Accuracy、下降百分点、相对下降），末尾写合同要求与判定。评估未完成或不存在时不可导出。

### 2.14 数据隔离（v1.2）

验收编号：FL-ORCH-03。对应：任务编排页「数据隔离」卡。

#### 2.14.1 隔离视图

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

#### 2.14.2 检测

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

### 2.15 算法库（v1.2）

对应：任务编排页「算法库」。内置 / 已注册 / 自定义三类算法统一用 `algo_id` 引用，创建任务时的选用方式见 2.3 的 v1.2 扩展。

#### 2.15.1 算法列表与详情

验收编号：FL-ORCH-05 / 06 / 07（详情含 FL-ORCH-08）。

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
- `params_schema`：当前版本的参数 schema（JSON Schema 子集，见 2.15.2）。
- `versions[]`：`{ version, is_current, created_at, created_by, note, file_id, structure }`，新版本在前。
- `history[]`：`{ action: publish | rollback, from_version, to_version, operator, at, reason }`，最新在前。

算法不存在 40400。

#### 2.15.2 注册算法

验收编号：FL-ORCH-06 / 08。

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
| 名称超长、新版本号不大于已有最高版本 | 40003 |
| 与内置算法同名、同名同版本已存在 | 40902 |

schema 不是合法 JSON 时，message 给出中文原因与出错位置（行列号从 1 开始），不含浏览器英文原文，例「参数 schema 不是合法 JSON：第 1 行第 19 列，属性名必须用英文双引号包裹」；其他原因有「内容不完整，缺少结尾的括号或引号」「此处缺少逗号或右花括号 }」「字符串缺少结尾的双引号」等。

#### 2.15.3 自定义模型上传与结构校验

验收编号：FL-ORCH-07 / 08。

先 `POST /files`（`purpose = fl_model`，§1.4），再：

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

#### 2.15.4 版本回滚

验收编号：FL-ORCH-08。

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

#### 2.15.5 参数模板

验收编号：FL-ORCH-09。

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

### 2.16 预估剩余时间与历史指标（v1.2）

#### 2.16.1 预估剩余时间

验收编号：FL-PROC-07。

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

#### 2.16.2 历史指标查询与导出

验收编号：FL-PROC-08。

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

任务类型不适用的指标留空。错误码同 2.7 的 v1.2 扩展，另有项目或任务不存在 40400。下载接口无法返回错误包（mock 抛出带原因的错误），页面导出前先用 `GET /fl/metrics` 校验条件和条数。

---

## 3. 同态加密 HE

页面：「同态加密 / 应用集成 — 加密 — 计算 — 解密 全流程」

流程 4 步：① 生成密钥对 → ② 加密 → ③ 密态运算 → ④ 解密。私钥始终留在平台密钥服务，接口只传 `key_id`。

v1.2 起同态加密拆为两个二级页面：「同态加密 / 算法管理」`#/he/algo`（页面模块 `HEA`，`js/he-algo.js`）与「同态加密 / 应用集成」`#/he/app`（页面模块 `HE`，`js/he.js`）。在上述四步流程（3.1–3.6）之外新增算法目录、底层库配置、编码、运算验证、参数寻优、密钥生命周期、流程测试模拟和性能日志接口（3.7 起）；3.2 `POST /he/keys`、3.3 `POST /he/encrypt` 与 3.6 `DELETE /he/keys/{key_id}` 的请求保持兼容，只补充字段与校验。mock 实现在 `js/mock/he.js`，自有数据在 `k.db.he`；写内核数据的位置：`db.heKeys`（生成、轮换、播种密钥）和 `db.heCiphers`（销毁密钥时删除其下密文，与内核行为一致）。

本模块新接口的错误码沿用第 9 节：`40000` 参数不合法、`40001` 方案或库不支持该操作、`40002` 值格式错误、`40003` 越界（含明文空间溢出、参数不可行）、`40400` 不存在、`40402` 密钥不存在或已销毁、`40901` 当前状态不允许。

### 3.1 获取加密方案列表

对应：「加密算法」下拉、「底层库」说明、「密态运算」下拉选项文案。

```
GET /he/schemes
```

响应 `data.items[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `scheme` | string | `paillier` / `ckks` / `bgv` |
| `name` | string | 例 `Paillier` |
| `description` | string | 例 `半同态 · 整数加、数乘` |
| `library` | string | 例 `python-paillier (phe)` |
| `input_type` | string | `integer`（需定点化）/ `float` / `integer_exact` |
| `supported_ops` | string[] | 见下 |
| `key_params` | object | 密钥参数说明 |

`supported_ops` 取值：`add_ct_ct` 密文+密文、`mul_ct_pt` 密文×明文、`mul_ct_ct` 密文×密文。

```json
{
  "items": [
    { "scheme": "paillier", "name": "Paillier", "description": "半同态 · 整数加、数乘", "library": "python-paillier (phe)", "input_type": "integer", "supported_ops": ["add_ct_ct", "mul_ct_pt"], "key_params": { "key_size_bits": 2048 } },
    { "scheme": "ckks", "name": "CKKS", "description": "全同态 · 浮点近似计算", "library": "SEAL TenSEAL (CKKS)", "input_type": "float", "supported_ops": ["add_ct_ct", "mul_ct_ct", "mul_ct_pt"], "key_params": { "poly_modulus_degree": 8192 } },
    { "scheme": "bgv", "name": "BGV", "description": "全同态 · 整数精确计算", "library": "SEAL (BGV)", "input_type": "integer_exact", "supported_ops": ["add_ct_ct", "mul_ct_ct", "mul_ct_pt"], "key_params": { "poly_modulus_degree": 8192 } }
  ]
}
```

v1.2：方案与底层库的完整目录见 [3.7 算法目录](#37-算法目录v12) 与 [3.8 底层库与支持矩阵](#38-底层库与支持矩阵v12)；Paillier 的底层库为 python-paillier (phe) 1.5，`library` 字段与 3.8 矩阵一致。

### 3.2 ① 生成密钥对

对应：「① 生成密钥对」按钮；执行面板第 ① 条日志。

```
POST /he/keys
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scheme` | string | 是 | `paillier` / `ckks` / `bgv` |
| `project_id` | string | 是 | 当前项目 |
| `key_params` | object | 否 | 覆盖默认参数，如 `{ "key_size_bits": 3072 }` |

```json
{ "scheme": "ckks", "project_id": "p1" }
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key_id` | string | 密钥 ID，后续步骤都用它 |
| `scheme` | string | |
| `key_params` | object | 例 `{ "poly_modulus_degree": 8192 }` 或 `{ "key_size_bits": 2048 }` |
| `public_key_preview` | string | 公钥前 56 个十六进制字符，前端末尾加 `…` |
| `elapsed_ms` | number | 耗时 |
| `created_at` | string | |
| `expires_at` | string | 密钥到期时间（平台自动轮换 / 销毁） |

```json
{
  "key_id": "hek_5c2e",
  "scheme": "ckks",
  "key_params": { "poly_modulus_degree": 8192 },
  "public_key_preview": "a3f09c1d2b7e4f6a8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d",
  "elapsed_ms": 8.5,
  "created_at": "2026-09-22T10:10:00+08:00",
  "expires_at": "2026-09-23T10:10:00+08:00"
}
```

#### v1.2 增补 · 生成密钥的新字段（HE-APP-01 / 03）

在上表字段基础上新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_id` | string | 是 | 现在强制校验项目存在 |
| `purpose` | string | 否 | `session`（默认，四步流程）/ `fl_aggregation`（联邦聚合，受轮换策略管理） |
| `key_params.key_size_bits` | int | 否 | 仅 Paillier：2048 / 3072 / 4096 |
| `node_ids` | string[] | 否 | 生成后立即分发到这些节点 |

响应在上表字段外补充：`purpose`、`status`（`active` / `rotated` / `destroyed`）、`storage`、`distributed_to[]`（`node_id`、`distributed_at`）、`rotated_from`、`rotated_to`、`rotated_at`、`rotate_reason`（`manual` / `auto`）、`destroyed_at`、`next_rotation_at`。

同一项目同一时间只允许一把在用的 `fl_aggregation` 密钥（不区分方案）：新钥生成后，该项目其余在用的聚合密钥（含其他模块写入 `db.heKeys` 的）标记为 `rotated`，`rotated_to` 指向新钥，`rotate_reason = 'superseded'`，并同步写 `db.heKeys[id].status / rotated_to`；响应附 `superseded_key_ids[]`。会话密钥不受影响。轮换（3.13.3）同样同步写 `db.heKeys`。

错误：方案未知、`project_id` 缺失、`purpose` 或 `key_size_bits` 非法 `40000`；节点不属于本项目 `40400`。

### 3.3 ② 加密

对应：「明文 A」「明文 B」输入框、「浮点数转换精度」滑块（0–8）、「② 加密」按钮；执行面板第 ② 条日志、Paillier 定点化说明。

```
POST /he/encrypt
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | string | 是 | 来自 3.2 |
| `precision` | int | 是 | 保留小数位 0–8 |
| `values` | array | 是 | 待加密明文，1–N 个 |
| `values[].name` | string | 是 | 例 `A`、`B` |
| `values[].value` | string | 是 | 明文数值，**用字符串传**避免浮点精度丢失，例 `"128.75"` |

```json
{
  "key_id": "hek_5c2e",
  "precision": 4,
  "values": [
    { "name": "A", "value": "128.75" },
    { "name": "B", "value": "64.25" }
  ]
}
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ciphertexts[]` | array | 与请求 `values` 一一对应 |
| `ciphertexts[].name` | string | `A` / `B` |
| `ciphertexts[].ciphertext_id` | string | 密文 ID |
| `ciphertexts[].preview` | string | 密文前 56 个十六进制字符 |
| `ciphertexts[].size_kb` | number | 单条密文大小 |
| `ciphertexts[].encoded_integer` | string \| null | Paillier 定点化后的整数，例 `"1287500"`；其他方案为 null |
| `scale_exponent` | int | 定点化倍数的指数，即 `×10^precision` |
| `elapsed_ms` | number | 总加密耗时 |

```json
{
  "ciphertexts": [
    { "name": "A", "ciphertext_id": "hec_a01", "preview": "9d2f…", "size_kb": 262.1, "encoded_integer": null },
    { "name": "B", "ciphertext_id": "hec_b01", "preview": "41c8…", "size_kb": 262.1, "encoded_integer": null }
  ],
  "scale_exponent": 4,
  "elapsed_ms": 37.2
}
```

校验：`value` 不是合法数字 → `40002`；`precision` 超出 0–8 → `40003`；`key_id` 已销毁或过期 → `40402`。

#### v1.2 增补 · 加密前检查密钥状态（HE-APP-01 / 03）

`POST /he/encrypt` 由 mock 扩展以 routeFirst 接管，请求与响应字段不变，加密前先检查密钥状态：已轮换返回 `40901`「密钥已轮换，只能用于解密历史密文」（`data = { status: 'rotated', rotated_to }`），已销毁或不存在返回 `40402`。状态检查先于参数校验。解密（§3.5）不受影响，已轮换密钥仍可解密历史密文。

### 3.4 ③ 密态运算

对应：「密态运算」下拉（密文加法 A ⊕ B / 密文乘法 A ⊗ B / Paillier 下为明文数乘 A ⊗ b）、「③ 密态运算」按钮；执行面板第 ③ 条日志。

```
POST /he/evaluate
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | string | 是 | |
| `op` | string | 是 | `add` 加法 / `mul` 乘法 |
| `left_ciphertext_id` | string | 是 | 左操作数（密文 A） |
| `right_ciphertext_id` | string | 条件 | 右操作数为密文时填（`add`，或 CKKS/BGV 的 `mul`） |
| `right_plaintext` | string | 条件 | 右操作数为明文时填（Paillier 的 `mul`，即「明文数乘」） |

规则：`right_ciphertext_id` 和 `right_plaintext` 二选一。Paillier + `mul` + `right_ciphertext_id` → 返回 `40001`「Paillier 不支持密文乘密文」。

```json
{
  "key_id": "hek_5c2e",
  "op": "add",
  "left_ciphertext_id": "hec_a01",
  "right_ciphertext_id": "hec_b01"
}
```

Paillier 数乘示例：

```json
{
  "key_id": "hek_p001",
  "op": "mul",
  "left_ciphertext_id": "hec_a02",
  "right_plaintext": "64.25"
}
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `result_ciphertext_id` | string | 结果密文 ID |
| `expression` | string | 例 `Enc(A) ⊕ Enc(B)` |
| `preview` | string | 结果密文前 56 个十六进制字符 |
| `size_kb` | number | 结果密文大小 |
| `elapsed_ms` | number | 运算耗时 |
| `noise_budget_remaining` | int \| null | CKKS/BGV 剩余噪声预算（bit）；Paillier 为 null |

```json
{
  "result_ciphertext_id": "hec_r01",
  "expression": "Enc(A) ⊕ Enc(B)",
  "preview": "e7b1…",
  "size_kb": 262.1,
  "elapsed_ms": 7.4,
  "noise_budget_remaining": 98
}
```

### 3.5 ④ 解密

对应：「④ 解密」按钮；执行面板第 ④ 条日志、底部「校验通过」绿框。

```
POST /he/decrypt
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | string | 是 | |
| `ciphertext_id` | string | 是 | 一般为 3.4 的 `result_ciphertext_id` |
| `verify` | bool | 否 | 默认 `true`：用明文直接计算做一致性校验（仅演示/测试环境开放） |

```json
{ "key_id": "hek_5c2e", "ciphertext_id": "hec_r01", "verify": true }
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `plaintext` | string | 解密结果，按 `precision` 保留小数，例 `"193.0000"` |
| `elapsed_ms` | number | 解密耗时 |
| `verification` | object \| null | `verify=true` 时返回 |
| `verification.expected` | string | 明文直接计算结果 |
| `verification.matched` | bool | 是否一致 |
| `verification.abs_error` | string | 绝对误差（CKKS 为近似计算，可能非 0） |
| `session_summary` | object | 本次流程汇总 |
| `session_summary.total_elapsed_ms` | number | 累计耗时（执行面板右上「累计耗时」） |
| `session_summary.total_ciphertext_kb` | number | 累计密文体积 |
| `session_summary.logged` | bool | 是否已记入训练日志 |

```json
{
  "plaintext": "193.0000",
  "elapsed_ms": 12.8,
  "verification": { "expected": "193.0000", "matched": true, "abs_error": "0.0000" },
  "session_summary": { "total_elapsed_ms": 65.9, "total_ciphertext_kb": 786.3, "logged": true }
}
```

#### v1.2 增补 · 四步流程的耗时口径与日志（HE-APP-01 / 05）

`POST /he/encrypt`、`POST /he/evaluate`、`POST /he/decrypt` 由 mock 扩展以 routeFirst 接管，请求与响应字段不变；耗时与 `size_kb` 改用 3.11 的统一模型（CKKS 加密单条 384 KB，密文乘法结果 256 KB）。会话密钥（`purpose = session`）从生成开始逐步记账，解密完成后写入性能日志（3.16，来源 `session`「全流程配置」）；`session_summary.total_elapsed_ms / total_ciphertext_kb` 为本次会话实际记账之和，`logged = true`、`log_source = 'session'`。重置销毁密钥后日志保留。

### 3.6 重置 / 销毁密钥

对应：「重置」按钮。切换算法、修改明文、修改精度时，前端也会回到第 0 步，建议同时调用。

```
DELETE /he/keys/{key_id}
```

删除该密钥及其下所有密文。响应 `data`：`{ "key_id": "hek_5c2e", "destroyed": true }`。

#### v1.2 增补 · 保留销毁记录（HE-APP-01 / 03）

删除密钥与其下全部密文，列表保留 `destroyed` 记录。重复销毁 `40402`。

### 3.7 算法目录（v1.2）

验收编号：HE-ALGO-01、HE-ALGO-02。对应「算法目录」表。

```
GET /he/algorithms
```

响应 `data.items[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `scheme` | string | `paillier` / `ckks` / `bgv` / `tfhe` |
| `name` | string | 例 `Paillier` |
| `family` | string | `phe` 半同态 / `fhe` 全同态 |
| `family_label` | string | 例 `半同态` |
| `supported_ops` | string[] | `add_ct_ct` 密文+密文、`mul_ct_pt` 密文×明文、`mul_ct_ct` 密文×密文 |
| `plaintext_type` | string | `integer`（浮点需定点化）/ `float` / `integer_exact` |
| `plaintext_label` | string | 明文类型说明 |
| `security_bits` | int | 默认参数下的经典安全强度（位） |
| `security_note` | string | 安全强度依据 |
| `default_library` | string | 默认底层库，见 3.8 |
| `libraries` | string[] | 支持该方案的底层库 |
| `typical_params` | string | 典型参数 |
| `plaintext_space` | object \| null | 整数方案的明文空间：`bits`、`max_abs`（可选）、`label`；CKKS 为 null |

```json
{ "items": [
  { "scheme": "paillier", "name": "Paillier", "family": "phe", "family_label": "半同态", "supported_ops": ["add_ct_ct", "mul_ct_pt"],
    "plaintext_type": "integer", "security_bits": 112, "default_library": "phe", "libraries": ["phe"],
    "typical_params": "模数 n = 2048 bit，密文 4096 bit（0.5 KB / 条）", "plaintext_space": { "bits": 2046, "label": "|m| < 2^2045（…）" } },
  { "scheme": "bgv", "name": "BGV", "family": "fhe", "supported_ops": ["add_ct_ct", "mul_ct_ct", "mul_ct_pt"], "plaintext_type": "integer_exact",
    "security_bits": 128, "default_library": "seal", "libraries": ["seal", "pyfhel", "openfhe"],
    "plaintext_space": { "bits": 20, "max_abs": 516096, "label": "|m| ≤ 516096（t = 1032193 的对称区间）" } }
] }
```

### 3.8 底层库与支持矩阵（v1.2）

验收编号：HE-ALGO-03。对应「加密算法配置」矩阵。

```
GET /he/libraries
```

响应 `data`：`schemes`（列顺序）、`items[]`：`library`（`seal` / `pyfhel` / `openfhe` / `tfhe-rs` / `phe`）、`name`、`language`、`schemes`、`matrix`（`{ scheme: bool }`）、`note`。

| 底层库 | Paillier | CKKS | BGV | TFHE |
|---|---|---|---|---|
| Microsoft SEAL 4.1 / TenSEAL 0.3 | 否 | 是 | 是 | 否 |
| Pyfhel 3.4 | 否 | 是 | 是 | 否 |
| OpenFHE 1.2 | 否 | 是 | 是 | 是（BinFHE） |
| TFHE-rs 0.7 | 否 | 否 | 否 | 是 |
| python-paillier (phe) 1.5 | 是 | 否 | 否 | 否 |

### 3.9 项目默认加密配置（v1.2）

验收编号：HE-ALGO-03、HE-ALGO-07。

```
GET /projects/{project_id}/he/config
PUT /projects/{project_id}/he/config
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scheme` | string | 是 | 默认方案 |
| `library` | string | 是 | 默认底层库 |
| `precision` | int | 否 | 默认保留小数位 0–8，不传保持原值 |

```json
{ "scheme": "bgv", "library": "openfhe", "precision": 3 }
```

响应：`{ project_id, scheme, library, precision, updated_at }`；未保存过时返回平台默认 `ckks / seal / 4`，`updated_at = null`。

错误：方案或库未知 `40000`；库不支持该方案 `40001`（message 列出可选库，`data = { scheme, library }`）；精度越界 `40003`；项目不存在 `40400`。

### 3.10 数据类型自动转换（定点编码）（v1.2）

验收编号：HE-ALGO-06、HE-ALGO-07。对应「数据类型自动转换与精度设置」。

```
POST /he/encode
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scheme` | string | 是 | 目标方案 |
| `values` | string[] | 是 | 1–64 个数，字符串传递 |
| `precision` | int | 是 | 保留小数位 0–8 |

响应 `data`：

| 字段 | 说明 |
|---|---|
| `mode` | `fixed_point`（整数方案 + 含小数）/ `integer`（全为整数，缩放因子 1）/ `native`（CKKS，无需转换） |
| `converted` | 是否做了定点化 |
| `scale_factor` / `scale_exponent` | 缩放因子 10^p 及 p |
| `items[]` | `input`、`encoded_integer`（字符串）、`encoded_bits`、`decoded`、`abs_error` |
| `max_abs_error` / `error_bound` | 最大量化误差 / 理论上界 0.5 × 10^-p |
| `overflow` | 编码整数是否超出明文空间 |
| `plaintext_space` | 同 3.7 |
| `sweep[]` | p = 0…8 逐档：`precision`、`scale_factor`、`max_abs_error`、`error_bound`、`max_encoded_bits`、`overflow`、`mul_overflow`（同精度两数相乘后是否溢出） |

编码规则：`encoded = round(x · 10^p)`，按十进制字符串逐位四舍五入（`1.005` 在 p = 2 时得 `101`），不经过二进制浮点；解码 `encoded / 10^p`。

错误：`values` 为空 `40000`；非数值 `40002`；超过 64 个或精度越界 `40003`。

### 3.11 运算验证（v1.2）

验收编号：HE-ALGO-04、HE-ALGO-05。对应「运算验证」。一次请求完成 密钥生成 → 编码 → 加密 → 密态运算 → 解密，与明文直接计算逐元素比较。

```
POST /he/verify
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scheme` | string | 是 | `paillier` / `ckks` / `bgv` / `tfhe` |
| `library` | string | 否 | 指定底层库时校验是否支持 |
| `op` | string | 是 | `add` 密文加 / `mul` 密文乘 / `mul_plain` 明文数乘 |
| `a` | string[] | 是 | 操作数 A，1–64 个 |
| `b` | string[] | 是 | 与 A 等长；`mul_plain` 可只给 1 个标量 |
| `precision` | int | 是 | 定点精度 0–8 |

```json
{ "scheme": "ckks", "op": "mul", "a": ["41.2356", "0.6821", "0.3957"], "b": ["1.035", "0.982", "1.012"], "precision": 4 }
```

响应 `data`：`mode`（`integer` / `fixed_point` / `ckks_native`）、`scale_exponent_a`、`scale_exponent_b`、`result_scale_exponent`、`ckks_scale_bits`、`rows[]`（`index`、`a`、`b`、`expected`、`decrypted`、`abs_error`、`encoded_a`、`encoded_b`、`encoded_result`）、`max_abs_error`、`steps[]`（`stage`、`label`、`elapsed_ms`、`size_kb`、`detail`）、`total_elapsed_ms`。

计算规则：

- 整数方案（Paillier / BGV / TFHE）：加法两边同缩放 10^p；乘法各操作数独立缩放（整数操作数不放大），结果缩放为两者指数之和；整数运算用 BigInt 精确计算后解码。任一编码值或结果超出明文空间返回 `40003`。
- CKKS：缩放因子 Δ = 2^40，解密值 = 明文结果 + 确定性仿真噪声，加法噪声幅度 (1 + |结果|) · 2^-28，乘法（含重缩放）幅度 (1 + |结果|) · 2^-22，同输入同输出。
- 耗时与密文大小按统一模型（与 3.12 参数寻优、四步流程共用，1 KB = 1024 字节）：CKKS / BGV 一条密文打包整组（4096 / 8192 槽位），Paillier / TFHE 每个数一条。单条密文：CKKS 2 × N × L × 8 字节，N = 8192、L = 3 → 384 KB，乘法重缩放后 L = 2 → 256 KB；BGV N = 8192、L = 4（SEAL 默认 [43, 43, 44, 44, 44] 去掉特殊素数）→ 512 KB；Paillier 2 × 2048 bit = 0.5 KB；TFHE FheInt32 16 × (2048 + 1) × 8 字节 = 256.1 KB。CKKS / BGV 耗时用 3.12 规则 4 的同一公式（N = 8192、L = 3：密钥生成约 21.5 ms、加密 2.4 ms、加法 0.07 ms、乘法 2.9 ms、解密 0.26 ms）。响应附 `ciphertext_kb_each` 与 `ciphertext_formula`。

错误：方案或 op 未知、A/B 个数不符 `40000`；Paillier + `mul` 或库不支持 `40001`；非数值 `40002`；精度越界、超过 64 个、明文空间溢出 `40003`。

### 3.12 密态计算参数寻优（CKKS）（v1.2）

验收编号：HE-ALGO-08（合同 C-13）。对应「密态计算参数智能寻优」。

```
POST /he/param-optimize
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `security_bits` | int | 是 | 128 / 192 / 256 |
| `mult_depth` | int | 是 | 乘法深度 1–30 |
| `precision_digits` | int | 是 | 精度需求，小数位 1–8 |
| `batch_size` | int | 是 | 每条密文要装的数值个数 1–16384 |

响应 `data`：`recommended`、`candidates[]`（2–3 个，含小一档 N 的不可行对照）、`rules[]`（寻优依据文字）、`security_table[]`。每个方案：`poly_modulus_degree`、`coeff_modulus_bits`、`total_modulus_bits`、`max_modulus_bits`、`margin_bits`、`scale_bits`、`integer_bits`、`slots`、`est_add_ms`、`est_mul_ms`、`ciphertext_kb`、`feasible`、`reasons[]`、`recommended`。

```json
{
  "recommended": { "poly_modulus_degree": 8192, "coeff_modulus_bits": [60, 40, 40, 60], "total_modulus_bits": 200, "max_modulus_bits": 218,
    "margin_bits": 18, "scale_bits": 40, "integer_bits": 20, "slots": 4096, "est_add_ms": 0.07, "est_mul_ms": 2.9, "ciphertext_kb": 384, "feasible": true }
}
```

寻优规则：

1. Δ 位数 = ⌈d · log2 10⌉ + 20（d 为小数位，20 bit 为编码与重缩放噪声余量），限制在 20–60 bit。
2. 模数链 = [q0, Δ × 深度, P]，q0 = P = min(60, Δ + 20)。
3. N 取满足「总模数 ≤ HomomorphicEncryption.org 安全标准上限」且「N / 2 ≥ 批大小」的最小值。上限表（三元秘密、经典攻击，与 SEAL `CoeffModulus::MaxBitCount` 相同）：128 位 N = 1024/2048/4096/8192/16384/32768 → 27/54/109/218/438/881 bit；192 位 → 19/37/75/152/305/611；256 位 → 14/29/58/118/237/476。
4. 性能估算：以 SEAL 4.1 单线程 N = 8192、L = 3 的量级（加法约 0.07 ms，乘法含重线性化与重缩放约 2.9 ms）为基准，加法按 N·L、乘法按 N·log2 N·L·(L+1) 外推；密文大小 = 2 × N × L × 8 字节（L = 深度 + 1，1 KB = 1024 字节）。运算验证（3.11）与四步流程（3.5）使用同一函数，同参数下数值一致。

错误：安全强度不在 128/192/256 `40000`；深度、精度、批大小越界 `40003`；N ≤ 32768 内无可行解 `40003`（`data.total_modulus_bits`）。

### 3.13 密钥生命周期（v1.2）

验收编号：HE-APP-03（HE-APP-01 的四步流程也经过这些接口）。对应「密钥管理」。

生成见 [3.2](#32-①-生成密钥对)（含 v1.2 新字段）、加密前状态检查见 [3.3](#33-②-加密)、销毁见 [3.6](#36-重置--销毁密钥)；以下为列表、分发、轮换、自动轮换策略与外部模块写入的约定。

#### 3.13.1 密钥列表

```
GET /he/keys?project_id=p1&status=active,rotated&purpose=fl_aggregation
```

响应：`{ items[], total, policy }`，按生成时间倒序，含已销毁记录。首次访问项目时播种 1 把在用的 Paillier 聚合密钥（12 天前生成）及其轮换前的旧钥（42 天前生成，12 天前自动轮换），均分发到项目全部节点。查询时执行自动轮换：策略启用且 `fl_aggregation` 密钥生成满 `period_days` 天即轮换。

#### 3.13.2 分发

```
POST /he/keys/{key_id}/distribute
```

`{ "node_ids": ["node-shanghai-01"] }`，已分发的节点保持不变，新节点追加。错误：`node_ids` 为空 `40000`；密钥不存在 `40402`；节点不属于本项目 `40400`；密钥非 `active` `40901`。

#### 3.13.3 轮换

```
POST /he/keys/{key_id}/rotate
```

生成同方案、同用途的新钥，整体继承旧钥 `key_params`（如 CKKS 的 `poly_modulus_degree` / `coeff_modulus_bits` / `scale_bits`）与分发节点；旧钥标记 `rotated`，保留用于解密历史密文。响应 `{ old_key, new_key }`。错误：密钥不存在 `40402`；非 `active` `40901`。

#### 3.13.4 自动轮换策略

```
GET /projects/{project_id}/he/rotation-policy
PUT /projects/{project_id}/he/rotation-policy
```

`{ "enabled": true, "period_days": 30 }`。默认启用、30 天。保存后立即按新周期检查一次。错误：`enabled` 非布尔 `40000`；周期不在 1–365 `40003`；项目不存在 `40400`。

#### 3.13.5 外部模块写入的密钥

其他模块（如 fed-sec 聚合与安全页）可直接写 `db.heKeys[key_id]`，本模块在列表、分发、轮换时为其补建元数据。识别字段：`project_id`（必需）、`scheme`（缺省 `paillier`）、`purpose`（只有 `fl_aggregation` 受轮换策略管理，其余视为 `session`）、`status`（`active` / `rotated` / `destroyed`，缺省 `active`；外部事后把 `status` 改为 `rotated` / `destroyed` 会同步过来）、`created_at`（缺失时不参与自动轮换）、`distributed_to` 或 `node_ids`（字符串数组或 `{ node_id, distributed_at }` 数组）、`key_params`（缺省 `{}`；CKKS 为 `{ poly_modulus_degree, coeff_modulus_bits, scale_bits }`，Paillier 为 `{ key_size_bits }`）、可选 `rotated_from` / `rotated_to` / `rotated_at` / `rotate_reason`（本模块元数据为空时从 `db.heKeys` 同步）。

展示：CKKS / BGV 显示「N=8192 · log₂Q=200 bit」（`coeff_modulus_bits` 可为总位数或各素数位数数组，数组时求和），Paillier 显示「密钥长度 2048 bit」。顶层 `key_size_bits` 在 CKKS 下是 log₂Q 兼容字段，前端不用它展示。本模块生成的 CKKS 默认 `key_params = { poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40 }`，BGV 为 `{ poly_modulus_degree: 8192, coeff_modulus_bits: 218, plain_modulus: 1032193 }`。

### 3.14 联邦学习一键启用同态加密（v1.2）

验收编号：HE-APP-02。复用已有接口，不新增：

- `GET /projects/{project_id}/fl/jobs`：选择任务。
- `PATCH /fl/jobs/{job_id}` `{ "aggregation": "he" }`：启用。前端只对 `Created` / `Terminated` / `Failed` 状态开放按钮，其余状态给出原因与「去过程管控」入口；后端对 `Running` / `Paused` 返回 `40901`。
- `GET /fl/jobs/{job_id}/he-public-key`：显示聚合公钥（key_id、Paillier 2048 bit、指纹、公钥前 64 位）。

### 3.15 流程测试模拟（v1.2）

验收编号：HE-APP-04。对应「流程测试模拟」。

```
POST /projects/{project_id}/he/simulations
GET  /projects/{project_id}/he/simulations
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scheme` | string | 否 | `paillier`（默认）/ `ckks` |
| `dim` | int | 是 | 梯度维度 1000 / 10000 |
| `parties` | int | 是 | 参与方数 2–5 |
| `precision` | int | 否 | Paillier 定点精度 0–8，默认 6 |
| `tolerance` | number | 否 | 最大绝对误差容差 (0, 1]，默认 1e-4 |

响应：`sim_id`、输入回显、`max_abs_error`、`mean_abs_error`、`passed`、`conclusion`、`steps[]`（`keygen` / `encrypt` / `aggregate` / `decrypt`，含 `elapsed_ms`、`ciphertext_kb`、`ciphertext_count`、`detail`）、`checks[]`（`name`、`passed`、`detail`）、`total_elapsed_ms`、`created_at`。

耗时口径：Paillier 按节点侧 16 线程批处理、CRT 解密（单条打包密文 加密 3.4 / 16 ≈ 0.213 ms、聚合 0.8 / 16 = 0.05 ms / 方、解密 4.2 / 4 / 16 ≈ 0.066 ms），各参与方在各自节点同时加密，`total_elapsed_ms` = 密钥生成 + 一次加密 + 聚合 + 解密。

规则：每个参与方生成 `dim` 维 N(0, 0.02²) 模拟梯度（种子 = 项目 + 方案 + 维度 + 参与方数）。Paillier：逐元素 round(g · 10^p) 后整数求和再除回，每 32 个定点数打包为 1 条 2048 bit 明文（64 bit 槽位）；CKKS：按 4096 槽位打包，聚合噪声 √参与方数 · 2^-28。校验项：密文条数一致、聚合维度一致、最大绝对误差 ≤ 容差、Paillier 槽位不溢出（求和后定点整数 ≤ 64 bit）。

错误：方案不支持、维度不在 {1000, 10000} `40000`；参与方数、精度、容差越界 `40003`；项目不存在 `40400`。

### 3.16 加解密性能日志（v1.2）

验收编号：HE-APP-05。对应「加解密性能日志」。

```
GET /projects/{project_id}/he/logs?source=fl_job&ref_id=fl_p1_002
GET /projects/{project_id}/he/logs/export?source=&ref_id=        （CSV 下载）
```

`source`：`session`（全流程配置）/ `simulation` / `fl_job`，不传为全部。响应：`items[]`（`log_id`、`source`、`ref_id`、`ref_name`、`round`、`stage`、`stage_label`、`scheme`、`party`、`elapsed_ms`、`ciphertext_kb`、`ciphertext_count`、`recorded_at`）、`total`、`refs[]`（筛选下拉）、`summary[]`（按环节：`count`、`total_elapsed_ms`、`avg_elapsed_ms`、`total_ciphertext_kb`）、`job_bases[]`、`timing_basis`（计算口径说明）。

来源：

- 全流程配置：四步流程每次解密完成后，按实际执行的 密钥生成 / 加密 / 密态运算 / 解密 各记 1 条。
- 流程测试：每次模拟展开为 密钥生成 1 条 + 每个参与方加密 1 条 + 密态聚合 1 条 + 解密 1 条。
- 训练任务：`aggregation = he` 且已跑的每一轮，每个训练节点加密 1 条 + 聚合方密态聚合 1 条 + 密钥服务解密 1 条。计算口径与界面同源：
  - 密钥：`GET /fl/jobs/{job_id}/he-public-key`（任务实际绑定的聚合公钥）。Paillier 单条密文 = 2 × 密钥位数 / 8 字节（2048 bit → 0.5 KB，3072 bit → 0.75 KB）；CKKS / BGV 按 3.11 的 2 × N × L × 8 字节（只给总位数 log₂Q 时按 q0 与特殊素数各 60 bit、中间素数 40 bit 估 L）。
  - 条数：⌈⌈参数量 × Top-k 保留比例⌉ / 每条打包个数⌉。参数量读内核 `k.MODEL_PARAMS`（lr 69、xgb 2176、cnn 61706、lstm 203143、tcn 37959、custom 20000）；保留比例与打包个数读 `GET /projects/{project_id}/fl/aggregation` 的 `sparsification`（未启用按 100%）与 `he.batch_size`（方案与密钥一致时采用，否则 Paillier 取 ⌊位数 / 64⌋、CKKS 取 N / 2）。稀疏化按全局 Top-k 掩码（各方共享同一组索引）计，索引以明文随附、不计入密文。例：xgb、Top-k 15%、每条 16 个 → ⌈327 / 16⌉ = 21 条。
  - 耗时：节点侧 16 线程批处理、CRT 解密；Paillier 2048 bit 单条 加密 0.213 ms、聚合 0.05 ms / 方、解密 0.066 ms，加解密按 (位数 / 2048)³、聚合按 (位数 / 2048)² 缩放；CKKS / BGV 按 3.12 规则 4 的模型 / 16。±6% 确定性抖动；各训练节点并行加密，每轮墙钟 = 最慢节点加密 + 聚合 + 解密，小于每轮训练时长 4.2 秒。
  - 响应附 `job_bases[]`（`key_id`、`key_label`、`ciphertext_kb_each`、`slots_per_ciphertext`、`topk_ratio`、`values_uploaded`、`ciphertext_count`、`text`），`timing_basis` 汇总以上口径并逐任务写明。

CSV 列：`来源,任务或测试 ID,名称,轮次,环节,方案,节点或参与方,耗时(ms),密文大小(KB),密文条数,记录时间(UTC+8)`，时间用内核 `fmtLocal` 写成 `2026-10-23 22:58:02 +08:00`，UTF-8 BOM。错误：`source` 非法 `40000`；项目不存在 `40400`。

---

## 4. 多方安全计算 MPC

页面：「多方安全计算 / 运维监控 — 协议执行监控」

v1.2 起多方安全计算拆为两个二级页面：「多方安全计算 / 协议管理」`#/mpc/proto`（页面模块 `MPCP`，`js/mpc-proto.js`）与「多方安全计算 / 运维监控」`#/mpc/ops`（页面模块 `MPC`，`js/mpc.js`）。在 4.1–4.6 基础上新增协议目录、参与方候选、项目级协议参数、多步计算流程、试运行、扩展性能预估与任务对比（4.7 起）。4.1–4.5 的请求和响应保持兼容（只补字段）：旧调用 `protocol + operator + parties[].role` 仍可用。mock 实现在 `js/mock/mpc.js`，用 `routeFirst` 覆盖内核 4.1–4.5 的 MPC 路由，自有数据在 `k.db.mpc`（`tasks` / `params` / `seeded`），不写内核的 `db.mpcTasks`；只读内核 `db.nodes`（参与方候选取自项目节点）与 `db.projects`。

本模块新接口的错误码沿用第 9 节：`40000` 参数不合法（含流程类型不匹配、参与方 / 角色不满足要求）、`40001` 算子与协议不兼容、`40002` 值格式错误、`40003` 越界、`40400` 不存在、`40901` 当前状态不允许。所有校验错误在 `data.field` 给出出错字段（如 `steps[1].protocol`、`parties`、`frac_bits`）。

v1.2 与 v1.1 的主要差异：异常判定规则由「通信量 > 均值 × 1.35」改为「通信量或计算耗时偏离全部参与方均值超过阈值（默认 50%）」，阈值可在创建任务时配置；新增告警类型 `compute_anomaly`。

### 4.1 协议列表 + 性能预估

对应：「协议」下拉、「性能预估」条（参与方、数据规模、预估计算耗时、预估通信耗时、当前算子）。

```
GET /projects/{project_id}/mpc/estimate
```

Query：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 条件 | `ss` 秘密共享 / `gc` 混淆电路 / `ot` 不经意传输扩展；v1.2：传了 `steps` 时可不传 |
| `operator` | string | 否 | 算子，不传则用该协议默认算子 |
| `party_ids` | string | 否 | 逗号分隔；不传用项目默认参与方 |

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `protocol` | string | |
| `operators` | array | 该协议支持的算子 `[{ "key": "secure_mean", "name": "安全求均值" }]` |
| `party_count` | int | 参与方数，例 3 |
| `data_rows` | int | 数据规模（条），例 1200000 |
| `est_compute_sec` | number | 预估计算耗时 |
| `est_comm_sec` | number | 预估通信耗时 |

```json
{
  "protocol": "ss",
  "operators": [
    { "key": "secure_product", "name": "安全求积" },
    { "key": "secure_mean", "name": "安全求均值" }
  ],
  "party_count": 3,
  "data_rows": 1200000,
  "est_compute_sec": 26,
  "est_comm_sec": 22
}
```

算子取值（`MpcOperator`，v1.2 扩为 7 个，完整定义见 [4.7](#47-协议与算子目录v12)）：

| 协议 | 算子 key | 名称 |
|---|---|---|
| `ss` | `secure_sum` / `secure_product` / `secure_mean` | 安全求和（v1.2 新增） / 安全求积 / 安全求均值 |
| `gc` | `secure_compare` / `secure_max` / `logic_op` | 安全比较 / 安全最大值（v1.2 新增） / 逻辑运算 |
| `ot` | `vector_ot` | 向量 OT |

#### v1.2 扩展 · 多步流程与带宽 / 时延参数（MPC-PROTO-07）

Query 在上表基础上增加 `steps`、`party_count`、`data_rows`、`bandwidth_mbps`、`rtt_ms`；此时 `protocol` 不再必填（传了 `steps` 即可）。

GET 兼容 §4.1：只传 `protocol`（+ 可选 `operator`）时按该算子的默认单步流程预估，并返回 `protocol`、`operators[]`；`steps=secure_sum:ss,secure_mean:ss` 形式可传多步（无算子参数）。

响应字段、代价模型与错误码同 [4.10](#410-性能预估v12)（该节另给出 POST 形式，可传完整流程、参与方与协议参数）。

### 4.2 创建 MPC 任务

对应：「开始执行」按钮（首次点击）。

```
POST /projects/{project_id}/mpc/tasks
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 条件 | `ss` / `gc` / `ot`；v1.2：未传 `steps` 时必填 |
| `operator` | string | 条件 | 见 4.1 算子表；v1.2：未传 `steps` 时必填 |
| `parties` | array | 是 | 参与方，v1.2 起至少 3 个（v1.1 为 2 个） |
| `parties[].party_id` | string | 是 | |
| `parties[].role` | string | 是 | `input` 输入方 / `compute` 计算方 / `output` 输出方；v1.2 起可用 `roles[]` 传多个角色，单值 `role` 仍兼容 |
| `auto_start` | bool | 否 | 默认 `true`，创建后立即执行 |

```json
{
  "protocol": "ss",
  "operator": "secure_mean",
  "parties": [
    { "party_id": "party-a", "role": "input" },
    { "party_id": "party-b", "role": "compute" },
    { "party_id": "party-c", "role": "output" }
  ],
  "auto_start": true
}
```

响应 `data`：任务详情（同 4.3）。

#### v1.2 扩展 · 流程、参数与异常阈值（MPC-PROTO-04 / 05 / 06、MPC-OPS-04）

对应协议管理页底部「创建任务并进入监控」，成功后前端执行 `App.go('mpc', { sub: 'ops', taskId })`。在上表基础上：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是* | 同 4.11；*未传时可用 §4.2 的 `protocol` + `operator`，按该算子默认流程 |
| `parties[]` | array | 是 | ≥ 3 方 |
| `parties[].party_id` | string | 是 | 来自 4.8 |
| `parties[].roles` | string[] | 是* | 子集 of `input` / `compute` / `output`；*兼容 §4.2 单值 `role` |
| `name` | string | 否 | ≤ 40 字 |
| `data_rows` | int | 否 | 同 4.10 |
| `bandwidth_mbps` / `rtt_ms` | number | 否 | 同 4.10 |
| `params` | object | 否 | 同 4.10 |
| `anomaly_threshold_pct` | number | 否 | 异常判定阈值，10–200（%），默认 50 |
| `auto_start` | bool | 否 | 默认 true |

参与方校验：少于 3 方 `40000`；重复 `40000`；不存在 `40400`；角色为空或缺少输入方 / 计算方 / 输出方任一 `40000`；角色取值错误 `40002`；流程用到秘密共享或混淆电路时计算方 < 2 `40000`（份额与混淆表需分属不共谋的两方）。

响应 `data`：任务详情（4.3）。

### 4.3 获取任务详情（实时监控）

对应：3 张参与方卡片（通信量、计算耗时、轮次交互次数、状态）、告警条。

```
GET /mpc/tasks/{task_id}
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 例 `mpc-20260922-01` |
| `protocol` | string | |
| `operator` | string | |
| `status` | string | `MpcTaskStatus`：`pending` 待执行 / `running` 执行中 / `stopped` 已停止 / `finished` 已结束 / `failed` 失败 |
| `parties[]` | array | 参与方实时指标 |
| `parties[].party_id` | string | |
| `parties[].tag` | string | 头像字母，例 `A` |
| `parties[].name` | string | 例 `参与方 A` |
| `parties[].role` | string | `input` / `compute` / `output` |
| `parties[].ip` | string | 例 `10.22.6.14` |
| `parties[].status` | string | `MpcPartyStatus`：`pending` 待执行 / `running` 执行中 / `finished` 已结束 / `abnormal` 异常 |
| `parties[].comm_bytes` | int | 累计通信量 |
| `parties[].compute_sec` | number | 累计计算耗时 |
| `parties[].interaction_rounds` | int | 轮次交互次数 |
| `alarms[]` | array | 告警列表，空数组表示无告警 |
| `alarms[].alarm_id` | string | |
| `alarms[].type` | string | `comm_anomaly` 通信量异常 / `compute_anomaly` 计算耗时异常（v1.2 新增） / `node_offline` / `timeout` |
| `alarms[].party_id` | string | 告警参与方（「定位节点」按钮用） |
| `alarms[].ratio_to_mean` | number \| null | 通信量 / 三方均值，例 2.1（v1.2 起判定依据为 `deviation_pct`，见下） |
| `alarms[].message` | string | 告警文案 |
| `alarms[].raised_at` | string | |
| `started_at` | string \| null | |
| `finished_at` | string \| null | |

**异常判定规则（v1.2，取代 v1.1 的「通信量 > 均值 × 1.35」）**：执行满 `min_ticks`（5）个心跳后，某参与方的通信量或计算耗时偏离全部参与方均值超过阈值（默认 50%，创建任务时用 `anomaly_threshold_pct` 配置，10–200）即判为 `abnormal`：|comm_bytes − 均值| / 均值 > 阈值产生 `comm_anomaly`，|compute_sec − 均值| / 均值 > 阈值产生 `compute_anomaly`。字段与细节见下方「v1.2 新增字段」。

进度条宽度由前端计算：通信量条 = 本方 / 最大值；耗时条同理。

```json
{
  "task_id": "mpc-20260922-01",
  "protocol": "ss",
  "operator": "secure_mean",
  "status": "running",
  "parties": [
    { "party_id": "party-a", "tag": "A", "name": "参与方 A", "role": "input", "ip": "10.22.6.14", "status": "running", "comm_bytes": 37748736, "compute_sec": 8.8, "interaction_rounds": 63 },
    { "party_id": "party-b", "tag": "B", "name": "参与方 B", "role": "compute", "ip": "10.31.8.27", "status": "running", "comm_bytes": 40768635, "compute_sec": 9.5, "interaction_rounds": 63 },
    { "party_id": "party-c", "tag": "C", "name": "参与方 C", "role": "output", "ip": "10.44.2.61", "status": "abnormal", "comm_bytes": 88709530, "compute_sec": 20.7, "interaction_rounds": 63 }
  ],
  "alarms": [
    { "alarm_id": "al_01", "type": "comm_anomaly", "party_id": "party-c", "ratio_to_mean": 1.6, "message": "检测到参与方 C 的通信量为三方均值的 1.60 倍，显著偏离基线，建议检查其网络链路与分片规模。", "raised_at": "2026-09-22T10:20:03+08:00" }
  ],
  "started_at": "2026-09-22T10:20:00+08:00",
  "finished_at": null
}
```

#### v1.2 新增字段（MPC-OPS-01 至 04）

对应运维监控页的任务摘要、4 个指标卡、告警条、参与方卡片。在上表字段基础上新增：

在上表字段基础上新增：

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
| `parties[].status` | string | 跟随任务：`abnormal` 优先，其次 `running` / `stopped`（任务停止后，累计指标保留）/ `pending` / `finished` |
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

### 4.4 任务控制

对应：「开始执行 / 停止执行 / 继续执行」按钮、「重置」按钮。

```
POST /mpc/tasks/{task_id}/actions
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | 是 | `start` 开始或继续 / `stop` 停止 / `reset` 清零指标回到 `pending` |

按钮文案映射：`running` → 「停止执行」；`pending` → 「开始执行」；`stopped` → 「继续执行」。

响应 `data`：任务详情。`finished` 状态下 `start` 返回 `40901`（需新建任务）。

#### v1.2 扩展 · 收紧状态校验

v1.2 收紧状态校验：`running` 时 `start` → `40901`；非 `running` 时 `stop` → `40901`；`finished` 时 `start` → `40901`；`readonly` 历史任务 `reset` → `40901`；未知动作 → `40000`。

### 4.5 历史任务列表

对应：「历史 MPC 任务」表格。

```
GET /projects/{project_id}/mpc/tasks
```

Query：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | string | 否 | 默认 `finished,failed` |
| `protocol` | string | 否 | |
| `start_time` / `end_time` | string | 否 | 按结束时间过滤 |
| 分页参数 | | 否 | |

响应 `data.items[]`：

| 字段 | 类型 | 表格列 |
|---|---|---|
| `task_id` | string | 任务 ID |
| `protocol` | string | 协议 / 算子 |
| `operator` | string | 协议 / 算子 |
| `party_count` | int | 参与方（前端拼「3 方」） |
| `total_comm_bytes` | int | 总通信量 |
| `total_duration_sec` | number | 总耗时 |
| `finished_at` | string | 结束时间 |
| `status` | string | |

```json
{
  "items": [
    { "task_id": "mpc-20260918-07", "protocol": "ss", "operator": "secure_mean", "party_count": 3, "total_comm_bytes": 193566310, "total_duration_sec": 72, "finished_at": "2026-09-18T16:42:00+08:00", "status": "finished" },
    { "task_id": "mpc-20260917-12", "protocol": "gc", "operator": "secure_compare", "party_count": 3, "total_comm_bytes": 642043084, "total_duration_sec": 228, "finished_at": "2026-09-17T11:05:00+08:00", "status": "finished" }
  ],
  "page": 1, "page_size": 20, "total": 4
}
```

#### v1.2 扩展 · 筛选与新增列（MPC-OPS-05）

验收编号：MPC-OPS-05。对应「历史 MPC 任务」表格与运维监控页顶部「监控任务」下拉（`status=all`）。

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

### 4.6 导出报表（v1.2 改用新接口）

验收编号：MPC-OPS-05。对应：历史任务表格的「导出报表」与对比面板的「导出对比报表」。v1.2 前端改用下面的 `/projects/{project_id}/mpc/reports/export`；v1.1 的 `/projects/{project_id}/mpc/tasks/export` 在内核中只输出固定历史，保留兼容、前端不再调用，真实后端可二者合一。

```
GET /projects/{project_id}/mpc/reports/export?format=csv&protocol=&start_time=&end_time=&task_ids=
```

过滤参数同 4.5。响应 CSV（UTF-8 BOM），列：任务 ID、任务名称、计算流程、协议（中文，多协议用「 + 」连接）、参与方数、数据规模(行)、总通信量(MB)、单方平均通信量(MB)、总耗时(秒)、轮次交互数(轮)、异常告警数(条)、开始时间(UTC+8)、结束时间(UTC+8)、状态（中文：待执行 / 执行中 / 已停止 / 已结束 / 失败）。时间用内核 `k.fmtLocal` 写成 `2026-10-23 22:58:02 +08:00`。带 `task_ids` 时明细行按请求顺序输出；恰为 2 个时追加对比段，表头「任务 A：… / 任务 B：… / 差异 (B − A) / A (%)」，A / B 顺序与数值与 4.12 对比接口一致。§4.6 的 `/mpc/tasks/export` 在内核中只输出固定历史，前端 v1.2 改用本接口；真实后端可二者合一。

#### 旧接口（v1.1，保留兼容）

对应：「导出报表」按钮。

```
GET /projects/{project_id}/mpc/tasks/export
```

Query：`format`（`xlsx` / `csv`，默认 `xlsx`）；其余过滤参数同 4.5。

响应：文件流。

```http
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="mpc_tasks_p1_20260922.xlsx"
```

列：任务 ID、协议、算子、参与方数、总通信量(MB)、总耗时(秒)、开始时间、结束时间、状态。

### 4.7 协议与算子目录（v1.2）

验收编号：MPC-PROTO-01、MPC-PROTO-02、MPC-PROTO-03、MPC-PROTO-04。对应「协议目录」三张卡片与流程编排的算子下拉。

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
| `protocols[].params_schema[]` | array | 参数定义，见 4.9 |
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

### 4.8 参与方候选（v1.2）

验收编号：MPC-PROTO-05。对应「参与方与角色」表格。

```
GET /projects/{project_id}/mpc/parties
```

响应 `data`：`{ items[], min_parties: 3 }`。`items[]`：`party_id`（`party-a` …）、`tag`（`A`）、`name`（`参与方 A`）、`node_id`（项目节点 ID，例 `node-ganzhou-03`）、`ip`、`online`、`default_roles`（建议角色，例 `["input", "compute"]`）。项目节点不足 3 个时补齐 `node-mpc-0x` 虚拟节点。错误：`40400` 项目不存在。

### 4.9 协议参数（项目级）（v1.2）

验收编号：MPC-PROTO-06。对应「协议参数」卡（协议页签、高级模式、恢复默认、保存参数）。

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

### 4.10 性能预估（v1.2）

验收编号：MPC-PROTO-07。对应「性能预估」卡（数据规模、带宽、RTT 输入，4 个指标，逐步明细，公式说明）。

```
POST /projects/{project_id}/mpc/estimate
GET  /projects/{project_id}/mpc/estimate?protocol=&operator=&steps=&party_count=&party_ids=&data_rows=&bandwidth_mbps=&rtt_ms=
```

POST 请求：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是 | 计算流程，同 4.11 |
| `party_count` | int | 否 | 3–8，默认 3，此时按 n 方都是输入 + 计算方估算 |
| `parties[]` | array | 否 | `[{ party_id, roles }]`，给出时取其长度为 n，并按角色计算输入分享；无输入方或无计算方 `40000` |
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
| 输入分享（首步为 ss 且作用于各方数据） | [I × (C − 1) + I₀] · w · m：只有输入方发送份额，每个输入方拆成 C 份（C = 计算方数），兼任计算方的自留 1 份；I = 输入方数，I₀ = 不兼任计算方的输入方数（原为 n(n−1) · w · m） | 1 | m × 0.5 µs × ℓ/64 |
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

错误：`party_count` < 3 → `40000`，> 8 → `40003`；`data_rows` 非整数 → `40002`，越界 → `40003`；带宽 / RTT 越界 → `40003`；流程错误同 4.11；GET 中 `operator` 与 `protocol` 不兼容 → `40001`。

### 4.11 计算流程试运行（v1.2）

验收编号：MPC-PROTO-01 至 MPC-PROTO-05。对应「计算流程编排」卡的「试运行」按钮与结果区。

```
POST /projects/{project_id}/mpc/flows/dry-run
```

请求：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `steps[]` | array | 是 | 1–8 步 |
| `steps[].operator` | string | 是 | 见 4.7 |
| `steps[].protocol` | string | 是 | 必须在该算子的 `protocols` 内，否则 `40001` |
| `steps[].operand` | object | 视算子 | 见 4.7 |
| `parties[]` | array | 是 | 同 4.2 |
| `params` | object | 否 | 同 4.10 |

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
| `warnings[]` | string[] | 例：结果超出模 2^ℓ 环的定点可表示范围（\|x\| ≥ 2^(ℓ−1−f)） |

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

### 4.12 两任务对比（v1.2）

验收编号：MPC-OPS-05。对应历史表格勾选 2 个任务后的「对比所选」与对比面板。

```
GET /projects/{project_id}/mpc/tasks/compare?task_ids=A,B
```

响应 `data`：`{ tasks: [itemA, itemB], baseline: A, metrics[] }`；`metrics[]`：`{ key, label, unit, note, values: [a, b], diff_pct }`，`diff_pct = (b − a) / a × 100`。指标：总通信量（MB）、单方平均通信量（MB）、总耗时（秒）、轮次交互数（轮）、参与方数（方）、数据规模（行）、每万行耗时（秒，= 总耗时 / (行数 / 10,000)）、异常告警数（条）。

错误：数量不是 2 或两个相同 → `40000`；任务不存在或不属于该项目 → `40400`。

---

## 5. 隐私求交 PSI

页面：「隐私求交 / 平台集成 — 安全求交 → 特征对齐 → 联合训练」

v1.2 起隐私求交拆为三个二级页面：数据接入 `#/psi/data`、算法配置 `#/psi/algo`、平台集成 `#/psi/pipe`。数据接入（5.0）、模板读取、流水线（5.3–5.6）的请求体与响应沿用 v1.1，v1.2 在 5.1、5.2、5.3 各节追加「v1.2」块，并新增 5.7–5.9。协议与参数只在算法配置页维护，保存为项目的「当前配置」（5.7）；平台集成页读取当前配置或某个已保存模板来启动流水线。

### 5.0 数据接入（v1.1）

页面：「隐私求交 → ① 数据接入」页签。各参与方在本地登记参与求交 / 训练的数据集，平台只保存元数据与 schema，原始数据不出参与方节点。

#### 5.0.1 参与方列表

对应：「所属参与方」下拉、列表「参与方」过滤、求交页签两行参与方。

```
GET /psi/parties
```

响应 `data.items[]`：`{ "party_id": "party-a", "party_name": "参与方 A" }`。

#### 5.0.2 数据集列表

```
GET /projects/{project_id}/datasets
```

Query：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `party_id` | string | 否 | 按参与方过滤 |
| `status` | string | 否 | `DatasetStatus` |
| `has_time_column` | bool | 否 | `true` 时只返回带时间列的数据集（新建时序任务用） |
| 分页参数 | | 否 | |

响应 `data.items[]`（倒序，最新在前）：

| 字段 | 类型 | 说明 | 前端展示 |
|---|---|---|---|
| `dataset_id` | string | | 列表第 1 列小字 |
| `project_id` | string | | |
| `name` | string | 数据集名称 | 列表第 1 列 |
| `party_id` / `party_name` | string | 所属参与方 | 「参与方」 |
| `source_type` | string | `DatasetSourceType`：`file` / `database` / `hdfs` | 「来源」 |
| `source` | object | 来源地址，结构随 `source_type`，见 5.0.3 | 「来源地址」 |
| `status` | string | `DatasetStatus`：`importing` 接入中 / `ready` 已就绪 / `failed` 失败 | 「状态」 |
| `row_count` | int \| null | 行数，`ready` 前为 null | 「行数」 |
| `columns[]` | array | `{ "name", "type" }`，`type` 为 `string` / `int` / `float` / `date` | 详情「字段」 |
| `feature_count` | int | 特征列数（不含求交键、时间列、标签列） | 详情；特征对齐维度 = 两方之和 |
| `id_column` | string | 求交键列 | 「求交键 / 时间列」 |
| `time_column` | string \| null | 时间列，可用于时序任务 | 同上 |
| `error` | string \| null | `failed` 时原因 | |
| `created_at` | string | | |

#### 5.0.3 接入数据集

对应：「＋ 接入数据」弹窗。

```
POST /projects/{project_id}/datasets
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 同一参与方下不可重名 |
| `party_id` | string | 是 | 来自 5.0.1 |
| `source_type` | string | 是 | `file` / `database` / `hdfs` |
| `source` | object | 是 | `file`：`{ "file_id", "file_name" }`，`file_id` 来自 [1.4](#14-文件上传)（`purpose = dataset`）<br>`database`：`{ "jdbc_url", "table" }`，`jdbc_url` 以 `jdbc:mysql\|postgresql\|oracle\|hive2://` 开头<br>`hdfs`：`{ "path" }`，以 `hdfs://` 开头 |
| `id_column` | string | 是 | 求交键列名，`[A-Za-z_][A-Za-z0-9_]*` |
| `time_column` | string | 否 | 时间列名，同上规则 |

```json
{
  "name": "消费月度汇总",
  "party_id": "party-b",
  "source_type": "database",
  "source": { "jdbc_url": "jdbc:mysql://10.31.8.27:3306/biz", "table": "consume_monthly" },
  "id_column": "phone_hash",
  "time_column": "stat_month"
}
```

响应 `data`：数据集（`status = "importing"`）。后端异步做连通性检查与 schema 探测，完成后转 `ready`（失败转 `failed` 并填 `error`）；前端在存在 `importing` 时轮询 5.0.2。

错误：参数不合法 `40000`；`file_id` 不存在 `40400`；同名 `40902`；连通性检查失败 `42201`。

#### v1.2 差异 · 文件解析与样例（PSI-DATA-01）

验收编号：PSI-DATA-01。`POST /projects/{project_id}/datasets` 在 §5.0.3 基础上，`source_type = file` 时可多传两个字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `row_count` | int | 否 | 前端解析文件得到的数据行数（CSV：非空行数 − 1 行表头），≥ 0 |
| `columns[]` | array | 与 `row_count` 同传 | `{ name, type }`，`name` 符合 `[A-Za-z_][A-Za-z0-9_]*` 且不重复，`type` 为 `string` / `int` / `float` / `date` |

- 前端对 `.csv` 且 ≤ 256 MB 的文件在浏览器内读取：首行为表头，按前 200 行推断类型（全整数 `int`、全数值 `float`、`YYYY-MM-DD` 或 `YYYY/MM/DD` 开头 `date`，其余 `string`）；提交时求交键列强制 `string`、时间列强制 `date`。表头列名不合法或重复时不上传，弹窗内提示。
- 传了 `row_count` / `columns`：求交键列、时间列须在 `columns` 内，否则 `40000`；`row_count` 非非负整数、`columns` 格式不对 `40002`。数据集按提交值登记，`source.row_count_basis = "parsed"`。
- 未传（Parquet、超大 CSV）：行数 = round(文件字节数 ÷ 64)，`source.row_count_basis = "size_estimate"`，界面行数显示「约 N（估算）」，详情注明「按文件大小 ÷ 64 字节 / 行估算」。
- 文件来源的 `source` 另带 `file_name`、`size_bytes`。真实后端应以服务端解析结果为准，可用前端值做一致性复核。

- `sample_rows`（可选，与 `row_count` 同传）：文件前 3 行原始值，二维数组，每行列数与 `columns` 一致、行数 ≤ 3 且 ≤ `row_count`，否则 `40002`。样例只保存在本参与方节点用于详情预览，不在任何响应中原样返回。

#### 5.0.4 数据集详情

对应：列表「详情」按钮展开的字段与脱敏样例。

```
GET /datasets/{dataset_id}
```

响应 `data`：同 5.0.2 单项，另加 `preview[]`：前 3 行、前 6 列样例。求交键只给哈希前缀（例 `f7f1c3…`），字符串类特征列打码 `***`，数值列给归一化值。`ready` 之前 `preview = []`。

#### v1.2 差异 · 样例预览规则（PSI-DATA-02）

验收编号：PSI-DATA-02。`GET /datasets/{dataset_id}` 的 `preview[]` 规则：

| 来源 | `preview[]` | `preview_note` |
|---|---|---|
| 文件，登记时带了 `sample_rows` | 文件真实前 3 行（不足 3 行按实际行数）脱敏后的值 | `null` |
| 文件，只有表头 | `[]` | `无样例（文件只有表头）` |
| 文件，浏览器未解析（Parquet / 超大 CSV） | `[]` | `无样例（文件未在浏览器解析）` |
| 数据库 / HDFS | mock 不连真实数据源，为稳定模拟样例；真实后端取源表前 3 行脱敏 | `null` |
| 尚未就绪 | `[]` | `接入完成后显示样例` |

脱敏按列类型：求交键 → 真实值哈希的 6 位十六进制前缀加「…」；`string` → `***`；`int` / `float` → 按两位有效数字区间化（如 7350 → `7,300 – 7,400`）；`date` → 原值。只取前 6 列。

#### 5.0.5 删除数据集

```
DELETE /datasets/{dataset_id}
```

只删登记信息，参与方本地数据不受影响。被运行中的流水线使用时返回 `40901`。

### 5.1 协议列表与默认参数

对应：左侧「PSI 协议」3 个单选卡、「参数调优」列表（随协议切换）。

```
GET /psi/protocols
```

响应 `data.items[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `protocol` | string | `ecdh` / `kkrt` / `unbalanced` |
| `name` | string | 例 `ECDH-PSI` |
| `description` | string | 卡片说明文字 |
| `params[]` | array | 默认参数 |
| `params[].key` | string | 参数键 |
| `params[].label` | string | 参数名 |
| `params[].value` | string \| number \| bool | 参数值 |
| `params[].display` | string | 展示文案 |
| `params[].editable` | bool | 是否可编辑 |

```json
{
  "items": [
    {
      "protocol": "ecdh", "name": "ECDH-PSI", "description": "基于椭圆曲线，通信量小，适合两方中等规模集合",
      "params": [
        { "key": "curve", "label": "椭圆曲线", "value": "Curve25519", "display": "Curve25519", "editable": true },
        { "key": "hash", "label": "哈希算法", "value": "SHA-256", "display": "SHA-256（point hashing）", "editable": true },
        { "key": "batch_size", "label": "分块大小", "value": 8192, "display": "8 192 条 / 批", "editable": true },
        { "key": "point_compression", "label": "曲线点压缩", "value": true, "display": "开启", "editable": true }
      ]
    },
    {
      "protocol": "kkrt", "name": "KKRT（基于 OT）", "description": "基于不经意传输扩展，大集合下计算最快，通信量较高",
      "params": [
        { "key": "ot_security_lambda", "label": "OT 扩展安全参数 λ", "value": 128, "display": "128", "editable": true },
        { "key": "cuckoo_bucket_factor", "label": "布谷鸟哈希桶数", "value": 1.27, "display": "1.27 n", "editable": true },
        { "key": "hash_count", "label": "哈希函数个数", "value": 3, "display": "3", "editable": true },
        { "key": "bloom_fpr_log2", "label": "布隆过滤器假阳率", "value": -40, "display": "2⁻⁴⁰", "editable": true }
      ]
    },
    {
      "protocol": "unbalanced", "name": "非平衡 PSI", "description": "两方集合规模差距大时使用，小集合方开销显著降低",
      "params": [
        { "key": "small_set_party_id", "label": "小集合持有方", "value": "party-b", "display": "参与方 B（12 万条）", "editable": true },
        { "key": "oprf_batch_size", "label": "OPRF 批大小", "value": 4096, "display": "4 096", "editable": true },
        { "key": "preprocess_cache_ttl_hours", "label": "大集合预处理缓存", "value": 24, "display": "开启（TTL 24 h）", "editable": true },
        { "key": "poly_degree", "label": "多项式插值次数", "value": 1305, "display": "1 305", "editable": true }
      ]
    }
  ]
}
```

#### v1.2 升级 · 参数规格与安全强度（PSI-ALGO-01 / 02）

验收编号：PSI-ALGO-01、PSI-ALGO-02。对应：算法配置页「PSI 协议」三张单选卡、安全强度说明框、「参数调优」各控件；平台集成页「求交配置」摘要。

在上表字段基础上增加：

| 字段 | 类型 | 说明 |
|---|---|---|
| `security.security_bits` | int | 计算安全强度（位），三种协议均为 `128` |
| `security.basis` | string | 安全基础（困难假设 / 原语） |
| `security.detail` | string | 安全参数说明 |
| `security.threat_model` | string | 敌手模型 |
| `params[].type` | string | `enum` 下拉 / `int` 整数 / `float` 小数 / `bool` 开关 |
| `params[].options[]` | array | `enum` 时的可选值 `{ value, label }` |
| `params[].min` / `max` / `step` | number | `int` / `float` 时的取值范围与步长 |
| `params[].unit` | string | 单位，如 `条 / 批` |
| `params[].hint` | string | 参数说明 |

参数规格：

| 协议 | 参数 | 类型 | 范围 / 选项 | 默认 |
|---|---|---|---|---|
| `ecdh` | `curve` | enum | `Curve25519` / `P-256` | `Curve25519` |
| | `hash` | enum | `SHA-256` / `SM3` | `SHA-256` |
| | `batch_size` | int | 1024 – 65536，步长 1024 | 8192 |
| | `point_compression` | bool | | `true` |
| `kkrt` | `ot_security_lambda` | enum | `128` / `256` | 128 |
| | `cuckoo_bucket_factor` | float | 1.1 – 2.0 | 1.27 |
| | `hash_count` | int | 2 – 4 | 3 |
| | `bloom_fpr_log2` | int | −64 – −30（假阳率 = 2 的该次方） | −40 |
| `unbalanced` | `small_set_party_id` | enum | `party-a` / `party-b` | `party-b` |
| | `oprf_batch_size` | int | 256 – 16384 | 4096 |
| | `preprocess_cache_ttl_hours` | int | 0 – 168（0 = 不缓存） | 24 |
| | `poly_degree` | int | 255 – 4095 | 1305 |

安全强度：

| 协议 | 计算安全 | 依据 |
|---|---|---|
| ECDH-PSI | 128 位 | ECDDH 假设；Curve25519 与 NIST P-256 离散对数求解复杂度约 2¹²⁸ |
| KKRT | 128 位 | 基础 OT（Curve25519）+ OT 扩展，计算安全参数 λ = 128，PRF 为 AES-128；布谷鸟哈希 / 布隆过滤器失败率 2⁻⁴⁰（40 位统计安全） |
| 非平衡 PSI | 128 位 | ECDH-OPRF（P-256）+ BFV 同态多项式求值（环维度 8192，按 HomomorphicEncryption.org 标准取 128 位） |

```json
{
  "protocol": "kkrt", "name": "KKRT（基于 OT）",
  "security": { "security_bits": 128, "basis": "基础 OT（基于 Curve25519）+ IKNP 式 OT 扩展 + 伪随机函数（AES-128）", "detail": "OT 扩展计算安全参数 λ = 128 …", "threat_model": "半诚实（semi-honest）" },
  "params": [
    { "key": "cuckoo_bucket_factor", "label": "布谷鸟哈希桶数", "value": 1.27, "display": "1.27 n", "editable": true,
      "type": "float", "min": 1.1, "max": 2.0, "step": 0.01, "unit": "× n", "hint": "桶数 = 系数 × 接收方集合大小 …" }
  ]
}
```

#### 参数校验规则（5.2 / 5.7 共用）

- 未传的参数取协议默认值；传了协议没有的键 → `40000`。
- `bool` 非布尔、数值非数字、`int` 非整数 → `40002`。
- 数值越界、`enum` 不在选项内 → `40003`。
- 未知协议 → `40000`。

### 5.2 参数模板

对应：「保存为模板」「加载模板」按钮，下方模板状态文字。

**保存模板**

```
POST /projects/{project_id}/psi/templates
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 例 `ECDH-PSI · 默认参数` |
| `protocol` | string | 是 | |
| `params` | object | 是 | `{ key: value }`，键同 5.1 `params[].key` |

```json
{
  "name": "ECDH-PSI · 默认参数",
  "protocol": "ecdh",
  "params": { "curve": "Curve25519", "hash": "SHA-256", "batch_size": 8192, "point_compression": true }
}
```

响应 `data`：`{ "template_id": "tpl_01", "name": "…", "protocol": "ecdh", "params": { }, "created_at": "…" }`

**模板列表**

```
GET /projects/{project_id}/psi/templates?protocol=ecdh
```

响应 `data.items[]`：同上结构。

**获取单个模板（加载）**

```
GET /psi/templates/{template_id}
```

**删除模板**

```
DELETE /psi/templates/{template_id}
```

#### v1.2 升级 · 内置模板与校验（PSI-ALGO-03）

验收编号：PSI-ALGO-03。对应：算法配置页「配置模板」卡（名称输入框 +「保存为模板」、模板列表的「加载」「删除」）；平台集成页「配置来源」下拉。

**模板列表** `GET /projects/{project_id}/psi/templates?protocol=`

- 首次访问项目时播种 2 个内置模板（`builtin = true`）：`tpl_{project_id}_wan_ecdh`「跨机构专线 · ECDH 大分块」、`tpl_{project_id}_lan_kkrt`「同机房百万级 · KKRT 默认」。
- `items[]` 按 `created_at` 倒序（最新在前），每项多一个字段 `builtin`。

**保存模板** `POST /projects/{project_id}/psi/templates`

请求体同 §5.2。新增校验：`name` 去首尾空格后必填 `40000`、不超过 40 字 `40003`、同项目重名 `40902`；`params` 按上方参数校验规则，响应里的 `params` 是补全默认值后的完整参数。

**删除模板** `DELETE /psi/templates/{template_id}`

内置模板 → `40901`；不存在 → `40400`。若某项目当前配置引用了该模板，当前配置参数保留，`template_id` 置空、`source` 改为 `manual`。

### 5.3 启动一键流水线

对应：「一键启动 / 重新执行」按钮。流水线 3 阶段：安全求交 → 特征对齐 → 联合训练。

```
POST /projects/{project_id}/psi/pipelines
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | `ecdh` / `kkrt` / `unbalanced` |
| `params` | object | 否 | 不传用协议默认参数 |
| `template_id` | string | 否 | 传了则用模板参数，`params` 覆盖同名键 |
| `parties` | array | 是 | 恰好两方，`party_id` 不同（v1.1 起由「求交数据」两行下拉选择，不再写死） |
| `parties[].party_id` | string | 是 | 来自 5.0.1 |
| `parties[].dataset_id` | string | 是 | 来自 5.0.2，须属于该参与方且 `status = ready` |
| `parties[].id_column` | string | 是 | 求交键列名，须存在于该数据集 `columns` |
| `alignment` | object | 是 | 特征对齐配置 |
| `alignment.feature_columns` | string[] | 否 | 不传则取全部特征列 |
| `training` | object | 否 | 联合训练阶段；不传则流水线只跑到特征对齐 |
| `training.fl_job_config` | object | 否 | 同 [2.3](#23-创建训练任务) 请求体（`dataset_source` 由后端自动填） |
| `training.auto_start` | bool | 否 | 默认 `false`：只把对齐样本写入联邦项目，由用户在 FL 模块手动启动 |

```json
{
  "protocol": "ecdh",
  "template_id": "tpl_01",
  "parties": [
    { "party_id": "party-a", "dataset_id": "ds_a_user", "id_column": "phone_hash" },
    { "party_id": "party-b", "dataset_id": "ds_b_user", "id_column": "phone_hash" }
  ],
  "alignment": { "feature_columns": [] },
  "training": { "fl_job_config": { "algorithm": "xgb", "aggregation": "he", "node_ids": ["node-shanghai-01", "node-hangzhou-02", "node-center-agg"] }, "auto_start": false }
}
```

响应 `data`：流水线详情（同 5.4）。

`training.fl_job_config` 传入时，联合训练阶段结束后按该配置新建 FL 任务（`dataset_source = { "type": "psi_pipeline", … }`），`fl_job_id` 即新任务；不传时把对齐样本挂到项目最新任务上。

校验失败：两方相同 / 不足两方 / 列不存在 / 数据集不属于该参与方 → `40000`；数据集不存在 → `40400`；数据集未就绪 → `40901`。

#### v1.2 差异 · 配置来源（PSI-PIPE-01 / 02）

验收编号：PSI-PIPE-01、PSI-PIPE-02。平台集成页「配置来源」选「当前算法配置」时，请求体 `protocol` / `params` 取 5.7 的当前配置；选某个模板时取该模板的 `protocol` / `params` 并附 `template_id`。`training.fl_job_config` 固定为 `{ task_type: classification, algorithm: xgb, aggregation: he, node_ids: 项目全部节点 }`，`auto_start = false`。完成后「前往训练」跳 `#/fed/proc` 并定位 `fl_job_id`。

页面离开再回到平台集成页时，先 `GET /psi/pipelines/{pipeline_id}`（或项目无记录时取 `GET /projects/{project_id}/psi/pipelines` 最后一项）恢复展示，状态为 `running` 时重新订阅 `/psi/pipelines/{pipeline_id}/events`。

- 请求校验与 §5.3 一致，另外：`params` 按「参数校验规则」校验（`40000` / `40002` / `40003`）；传 `template_id` 时模板须属于本项目（否则 `40400`）、协议一致（否则 `40000`），模板参数与 `params` 合并（`params` 覆盖同名键）。
- 交集估算（mock）：n_min = 两方较小行数，n_min < 10 000 时交集 = round(n_min × 0.4769)，否则按千取整 round(n_min × 0.4769 ÷ 1000) × 1000；真实后端为实际求交结果。
- 安全求交阶段结束时，交集条数少于 **100 条**（联合训练最少对齐样本数）时流水线 `status = failed`，`error` 写明交集条数、阈值和两方求交键，`stages[0].status = failed`，特征对齐与联合训练 `status = skipped`（`progress_pct = 0`，`duration_sec = null`，`stats = {}`），`fl_job_id = null`，不生成训练任务；该流水线不能作为 FL 任务的 `dataset_source`（`40901`）。
- SSE `pipeline_finished` 在失败时也会推送：`{ "pipeline_id", "status": "failed", "fl_job_id": null, "target_project": null, "error": "求交结果 0 条，少于联合训练所需的最少 100 条对齐样本…" }`。页面显示红色失败说明，「一键启动」变为「重新执行」。
- 演示环境刷新中断（内核把运行中流水线置 `failed` 并写 `error`）时，当时未完成的阶段标 `failed`，之后的阶段标 `skipped`。

### 5.4 获取流水线详情

对应：3 张阶段卡（状态、进度条、执行时长、数据量、附加说明）、完成后的绿框「前往训练」。

```
GET /psi/pipelines/{pipeline_id}
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `pipeline_id` | string | |
| `protocol` | string | |
| `parties[]` | array | 请求里的两方，另加 `party_name`、`dataset_name`（v1.1） |
| `status` | string | `PsiPipelineStatus`：`pending` / `running` / `finished` / `failed` / `canceled` |
| `stages[]` | array | 固定 3 项，按顺序 |
| `stages[].stage` | string | `intersect` 安全求交 / `align` 特征对齐 / `train` 联合训练 |
| `stages[].name` | string | 中文名 |
| `stages[].status` | string | `pending` 待执行 / `running` 执行中 / `finished` 已完成 / `failed` 失败 / `skipped` 跳过 |
| `stages[].progress_pct` | int | 0–100 |
| `stages[].duration_sec` | number \| null | 执行时长 |
| `stages[].stats` | object | 阶段统计，见下 |
| `target_project` | object \| null | 对齐样本写入的联邦项目 `{ "project_id": "p1", "name": "风控联合建模 · 2026Q3" }` |
| `fl_job_id` | string \| null | 联合训练阶段创建的 FL 任务 ID（「前往训练」跳转用） |
| `error` | string \| null | 失败原因 |
| `created_at` / `finished_at` | string | |

`stages[].stats` 按阶段：

| 阶段 | 字段 | 说明 | 前端展示 |
|---|---|---|---|
| `intersect` | `left_rows` / `right_rows` | 两方原始条数（即所选数据集 `row_count`） | `120.0 万 ↔ 86.4 万` |
| `intersect` | `intersection_rows` | 交集条数 | `交集 41.2 万条` |
| `align` | `rows` / `feature_dim` | 对齐后条数、特征维度（两方 `feature_count` 之和） | `41.2 万条 / 68 维` |
| `train` | `rows` | 训练样本数 | `41.2 万条` |

```json
{
  "pipeline_id": "psi_20260922_03",
  "protocol": "ecdh",
  "status": "running",
  "stages": [
    { "stage": "intersect", "name": "安全求交", "status": "finished", "progress_pct": 100, "duration_sec": 46, "stats": { "left_rows": 1200000, "right_rows": 864000, "intersection_rows": 412000 } },
    { "stage": "align", "name": "特征对齐", "status": "running", "progress_pct": 55, "duration_sec": 10, "stats": { "rows": 412000, "feature_dim": 68 } },
    { "stage": "train", "name": "联合训练", "status": "pending", "progress_pct": 0, "duration_sec": null, "stats": {} }
  ],
  "target_project": { "project_id": "p1", "name": "风控联合建模 · 2026Q3" },
  "fl_job_id": null,
  "error": null,
  "created_at": "2026-09-22T10:30:00+08:00",
  "finished_at": null
}
```

#### v1.2 差异 · 完成后固化统计快照（PSI-DATA-03、PSI-PIPE-02）

验收编号：PSI-DATA-03、PSI-PIPE-02。流水线 `finished` 后，`stages[].stats`（两方行数、交集条数、对齐条数与特征维度）与 `parties[].dataset_name` 固化为快照，不再随数据集变化；`GET /psi/pipelines/{pipeline_id}` 与 `GET /projects/{project_id}/psi/pipelines` 多返回 `stats_snapshot_at`（快照时间，未完成时无此字段）。`DELETE /datasets/{dataset_id}` 删除前先为引用它的已完成流水线生成快照；被运行中流水线引用时仍返回 `40901`。

### 5.5 取消 / 重置流水线

对应：「重置」按钮。

```
POST /psi/pipelines/{pipeline_id}/cancel
```

请求体：无。运行中的流水线被中止，状态变 `canceled`。已结束的流水线调用返回成功（幂等）。

响应 `data`：流水线详情。

### 5.6 流水线历史

```
GET /projects/{project_id}/psi/pipelines
```

Query：`status`、分页参数。响应 `data.items[]`：同 5.4。

### 5.7 当前求交配置（v1.2）

验收编号：PSI-ALGO-02、PSI-ALGO-03、PSI-ALGO-04、PSI-PIPE-01。对应：算法配置页「保存为当前配置」、模板「加载」、「采用推荐」三个写入口；参数调优卡底部「当前配置：…」；平台集成页「求交配置」卡。

```
GET /projects/{project_id}/psi/config
PUT /projects/{project_id}/psi/config
```

PUT 请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | `ecdh` / `kkrt` / `unbalanced` |
| `params` | object | 否 | 按参数校验规则，缺省键取默认值 |
| `template_id` | string | 否 | 加载模板时传；须属于本项目且协议一致，否则 `40400` / `40000` |
| `source` | string | 否 | `manual`（默认）/ `template` / `route_advice`；传了 `template_id` 时强制为 `template` |

响应 `data`（GET 同）：

```json
{
  "project_id": "p1", "protocol": "ecdh",
  "params": { "curve": "Curve25519", "hash": "SHA-256", "batch_size": 65536, "point_compression": true },
  "template_id": null, "template_name": null,
  "source": "route_advice", "updated_at": "2026-10-23T14:52:00+08:00"
}
```

从未保存过时 `source = "default"`、`updated_at = null`，参数为 ECDH-PSI 默认值。配置按项目隔离。

错误：`40000` / `40002` / `40003`（参数）、`40400`（模板不存在）。

### 5.8 求交协议自适应路由（v1.2）

验收编号：PSI-ALGO-04。对应：算法配置页「求交协议自适应路由」卡（四个输入框 +「计算推荐」、推荐结论框、三协议对比表、「采用推荐」）。

```
POST /psi/route-advice
```

| 字段 | 类型 | 必填 | 范围 | 说明 |
|---|---|---|---|---|
| `left_rows` | int | 是 | 1 – 10¹⁰ | 参与方 A 数据量（行） |
| `right_rows` | int | 是 | 1 – 10¹⁰ | 参与方 B 数据量（行） |
| `bandwidth_mbps` | number | 是 | 0.1 – 100000 | 网络带宽（Mbps） |
| `latency_ms` | number | 是 | 0 – 2000 | 单向网络延迟（ms） |

响应 `data`：

| 字段 | 说明 |
|---|---|
| `input` | 回显请求 |
| `size_ratio` | 规模比 = 较大行数 ÷ 较小行数，保留 2 位 |
| `recommended` | `{ protocol, name, params }`，`params` 可直接 PUT 到 5.7 |
| `reason` | 推荐理由（中文） |
| `estimates[]` | 三种协议各一项：`total_sec` 在线预估耗时（秒）、`compute_sec` 计算（秒）、`network_sec` 网络（秒）、`comm_mb` 通信量（MB，1 MB = 1048576 字节）、`rounds` 往返次数、`offline_sec` 离线预处理（秒，仅非平衡 PSI 非 0）、`security_bits`、`params`（估算所用参数） |
| `model_note` | 「估算值，非实测」说明 |

```json
{
  "input": { "left_rows": 100000000, "right_rows": 10000, "bandwidth_mbps": 100, "latency_ms": 30 },
  "size_ratio": 10000,
  "recommended": { "protocol": "unbalanced", "name": "非平衡 PSI", "params": { "small_set_party_id": "party-b", "oprf_batch_size": 4096, "preprocess_cache_ttl_hours": 24, "poly_degree": 1305 } },
  "reason": "两方规模比 10000 : 1，超过 100 : 1 时非平衡 PSI 的在线开销只与小集合规模线性相关；大集合离线预处理约 400 秒，缓存期内复用；预估在线耗时 6.19 秒，比 ECDH-PSI 少 99.5%、KKRT（基于 OT） 少 98.4%。",
  "estimates": [
    { "protocol": "ecdh", "total_sec": 1239.23, "compute_sec": 800.08, "network_sec": 439.15, "comm_mb": 3052.06, "rounds": 3052, "offline_sec": 0, "security_bits": 128 },
    { "protocol": "kkrt", "total_sec": 390.11, "comm_mb": 2856.9, "offline_sec": 0, "security_bits": 128 },
    { "protocol": "unbalanced", "total_sec": 6.19, "comm_mb": 3.7, "offline_sec": 400, "security_bits": 128 }
  ]
}
```

错误：缺字段 `40000`；非数字 / 行数非整数 `40002`；越界 `40003`。同输入同输出。

**估算模型**（n_A、n_B 为两方行数，n_l = max、n_s = min，B 为带宽 Mbps，L 为单向延迟 ms）：

- 在线耗时 = 计算耗时 + 网络耗时；网络耗时 = 通信字节 × 8 ÷ (B × 10⁶) + 往返次数 × 2L ÷ 1000。
- ECDH-PSI：计算 = 2 (n_A + n_B) 次曲线标量乘 × 4 µs（Curve25519，8 线程；P-256 取 6 µs）；通信 = (n_A + n_B) × 32 字节（P-256 且关闭点压缩时 65 字节），两方各 n 行时即 2 × n × 32 字节；往返 = 2 × ⌈n_l ÷ batch_size⌉。
- KKRT：计算 = (n_A + n_B) × 1.5 µs + 0.2 s 基础 OT；通信 = cuckoo_bucket_factor × n_s × 64 字节 + hash_count × n_l × (40 + log₂(n_A n_B)) ÷ 8 字节；往返 4 次。通信量高于 ECDH，计算快。
- 非平衡 PSI：离线预处理 = n_l × 4 µs（缓存期内复用，不计入在线耗时）；在线计算 = n_s × 40 µs + n_l × 0.05 µs；通信 = n_s × (64 + 12 ⌈log₂ n_l⌉) 字节；往返 = 2 × ⌈n_s ÷ oprf_batch_size⌉ + 2。规模比 > 100 时优势明显。
- 推荐参数：ECDH 在 L ≥ 20 ms 时 `batch_size = 65536`，否则 8192；非平衡 PSI 的 `small_set_party_id` 取行数较少的一方，n_s < 10⁴ 时 `oprf_batch_size = 1024`；其余取默认值。
- 推荐 = 在线预估耗时最短的协议；第二名耗时在第一名 110% 以内且通信量更小时改推第二名。

### 5.9 典型场景性能参考（v1.2）

验收编号：PSI-ALGO-04（同时满足 V5「提供典型场景的性能参考」）。对应：算法配置页「典型场景性能参考」表。

```
GET /psi/benchmarks
```

3 种规模（10 万 × 10 万、100 万 × 100 万、1 亿 × 1 万）× 2 种网络（局域网 1000 Mbps / 1 ms，广域网 100 Mbps / 30 ms）共 6 行，与 5.8 同一估算模型。

`data.items[]`：`{ scenario_id, scale_label, network_label, left_rows, right_rows, bandwidth_mbps, latency_ms, recommended, estimates: [{ protocol, total_sec, comm_mb, offline_sec }] }`；`data.model_note` 为「估算值，非实测」说明。

---

## 6. 差分隐私 DP

页面：「差分隐私 / 效果评估 — 隐私预算与模型效用」

DP 作用于联邦学习任务：梯度聚合前自动加噪。配置挂在 FL 任务上。

v1.2 起差分隐私拆为三个二级页面：「差分隐私 / 隐私机制」（`#/dp/mech`，`DPM`）、「差分隐私 / 效果评估」（`#/dp/eval`，`DP`）、「差分隐私 / 框架集成」（`#/dp/fw`，`DPF`）。三个页面共用一个「当前训练任务」（按项目记忆，顶部「训练任务」下拉），DP 参数一律以 `GET /fl/jobs/{job_id}/dp` 为准。6.1–6.5 原有接口保持兼容，v1.2 增补的字段以「v1.2 增补」块并入各节；新接口为 6.6 起。mock 实现在 `web/js/mock/dp.js`。

### 6.0 通用约定与会计方法（v1.2）

**会计方式 `accountant`**（决定「总预算 ε 在 T 轮里怎么分」以及「已消耗 ε 怎么累计」）：

| 值 | 名称 | 累计 ε（单步 ε₀ 重复 t 次） | 累计 δ |
|---|---|---|---|
| `basic` | 基础组合（数值与 v1.1 完全一致） | `t · ε₀` | 高斯 `t · δ`；拉普拉斯 0 |
| `advanced` | 高级组合（Dwork–Rothblum–Vadhan 2010） | `min(t·ε₀, ε₀·√(2t·ln(1/δ′)) + t·ε₀·(e^ε₀ − 1))`，δ′ = δ | 高斯 `t·δ + δ′`；拉普拉斯 `δ′` |
| `rdp` | RDP 会计（任务默认；Mironov 2017，Moments Accountant 的 Rényi 形式，不计子采样放大） | `min_α [t · ε(α) + ln(1/δ) / (α − 1)]`，α ∈ {1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 32, 48, 64, 96, 128, 256}；拉普拉斯再与 `t·ε₀` 取小 | `δ` |

单步 RDP：高斯 `ε(α) = α / (2z²)`，z = σ / Δ；拉普拉斯 `ε(α) = 1/(α−1) · ln[α/(2α−1) · e^((α−1)/λ) + (α−1)/(2α−1) · e^(−α/λ)]`，λ = b / Δ。

**噪声定标**：

- `basic`：`ε₀ = ε_总 / T`；高斯 `z = √(2 ln(1.25/δ)) / ε₀`，拉普拉斯 `λ = 1 / ε₀`。
- `advanced` / `rdp`：对噪声倍数 z（或 λ）二分求解，使 T 轮累计 ε 恰为 `ε_总`。
- 每轮噪声尺度 `σ = z · C`（拉普拉斯 `b = λ · C`），C 为裁剪阈值（梯度 L2 敏感度）。「单轮机制 ε」= 把单轮单独看作 (ε, δ)-DP 时的 ε₀ = `√(2 ln(1.25/δ)) / z`。

**时序任务效用**：RMSE / MAE = 无噪声基线 × (1 + 1.2 · e^(−ε_eq / 2.2))，拉普拉斯再乘 1.05；基线取内核 `metricsAt('timeseries', T, 0)`（该任务无噪声训练 T 轮后的全局指标）。e^(−ε/2.2) 与分类公式的饱和项相同。

**模型效用估算**：沿用 v1.1 的 `utility(ε) = 0.62 + 0.30 · (1 − e^(−ε/2.2))`（拉普拉斯再减 0.015），但 ε 取「与当前噪声相同的基础组合等效总 ε」`ε_eq = ε₀ · T`，即效用随实际注入的噪声大小变化，而不是随账面 ε。

**任务 DP 配置扩展字段**（`GET / PUT /fl/jobs/{job_id}/dp`，不传则保持原值）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `accountant` | string | `basic` / `advanced` / `rdp`，默认 `rdp`（显式指定 `basic` 时数值与 v1.1 一致） |
| `clip_mode` | string | `fixed` 固定裁剪 / `adaptive` 自适应裁剪（每轮 C 取上一轮样本梯度范数中位数，首轮用 `clip_norm`） |
| `apply_to` | string | 恒为 `gradient`（统计查询走 6.8 的项目级配置） |
| `policy_id` / `policy_dimension` | string \| null | 由策略下发时写入；手动改 ε / 机制 / C 后清空 |

SSE：mock 挂 `k.db.dpAccount(job, round)`，内核 jobTick 推送 `round_completed.dp = { epsilon_spent, epsilon_used, accountant }` 时用它，与 6.4 / 6.5 同一会计方式。

写入内核数据说明：mock 写 `job.dp` 的上述字段（DP 配置本来就挂在任务上）；非运行态读取时把 `job.dp.total_rounds` 同步为任务的 `total_rounds`、`job.dp.provider` 同步为平台当前实现。训练运行期间的配置另存快照 `k.db.dpx.snap[job_id]`，训练结束后再改配置不影响该次运行的预算、审计与 hook 记录。

### 6.1 获取 DP 配置

对应：左侧「DP 机制配置」全部控件、底部「DP 已启用」徽标。

```
GET /fl/jobs/{job_id}/dp
```

响应 `data`：

| 字段 | 类型 | 说明 | 控件 |
|---|---|---|---|
| `enabled` | bool | 是否启用 | 「DP 已启用」徽标 |
| `mechanism` | string | `gaussian` 高斯 / `laplace` 拉普拉斯 | 两个切换按钮 |
| `epsilon_total` | number | 总隐私预算 ε，范围 0.2–10，步长 0.1 | 「隐私预算 ε（总）」滑块 |
| `clip_norm` | number | 梯度裁剪阈值 C，范围 0.2–4，步长 0.1 | 「梯度裁剪阈值 C」滑块 |
| `delta` | string | 松弛参数 δ：`1e-4` / `1e-5` / `1e-6`，仅高斯机制 | 「松弛参数 δ」下拉 |
| `total_rounds` | int | 总迭代轮次 | 「/ 30」 |
| `provider` | string | 实现来源，例 `secretflow-native` | 底部说明「基于隐语原生 DP 模块」 |
| `updated_at` | string | | |

```json
{
  "enabled": true,
  "mechanism": "gaussian",
  "epsilon_total": 2.0,
  "clip_norm": 1.0,
  "delta": "1e-5",
  "total_rounds": 30,
  "provider": "secretflow-native",
  "updated_at": "2026-09-22T09:58:00+08:00"
}
```

### 6.2 更新 DP 配置

对应：切换机制、拖动 ε / C 滑块、切换 δ。

```
PUT /fl/jobs/{job_id}/dp
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `enabled` | bool | 是 | |
| `mechanism` | string | 是 | `gaussian` / `laplace` |
| `epsilon_total` | number | 是 | 0.2–10 |
| `clip_norm` | number | 是 | 0.2–4 |
| `delta` | string | 条件 | `mechanism = gaussian` 时必填 |

```json
{ "enabled": true, "mechanism": "gaussian", "epsilon_total": 2.0, "clip_norm": 1.0, "delta": "1e-5" }
```

约束：任务 `Running` / `Paused` 时不允许修改（已消耗的预算不可回退），返回 `40901`。参数越界返回 `40003`。

响应 `data`：更新后的配置。

#### v1.2 增补 · 配置的扩展字段（DP-MECH-02）

对应：隐私机制页「参数配置 → 梯度（联邦训练任务）」表单、效果评估页左栏。

请求：§6.2 原字段 + 上表扩展字段。

```json
{ "enabled": true, "mechanism": "gaussian", "epsilon_total": 2.0, "clip_norm": 1.0, "delta": "1e-5", "accountant": "rdp", "clip_mode": "adaptive" }
```

响应 `data`：

```json
{
  "enabled": true, "mechanism": "gaussian", "epsilon_total": 2.0, "clip_norm": 1.0, "delta": "1e-5",
  "total_rounds": 30, "provider": "secretflow-native", "updated_at": "2026-10-23T22:05:00+08:00",
  "accountant": "rdp", "clip_mode": "adaptive", "apply_to": "gradient", "policy_id": null, "policy_dimension": null
}
```

错误码：`40400` 任务不存在；`40901` 任务 Running / Paused；`40003` ε 不在 0.2–10 或 C 不在 0.2–4；`40002` δ 不是 `1e-4 / 1e-5 / 1e-6`；`40000` mechanism / accountant / clip_mode 非法、高斯缺 δ。

### 6.3 参数预估（不落库）

对应：拖动滑块时实时刷新的「当前噪声参数」框、3 张指标卡、趋势曲线、噪声分布直方图。

前端拖滑块很频繁，**前端需做 300 ms 防抖**再调用。

```
POST /dp/estimate
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mechanism` | string | 是 | `gaussian` / `laplace` |
| `epsilon_total` | number | 是 | |
| `clip_norm` | number | 是 | |
| `delta` | string | 条件 | 高斯时必填 |
| `total_rounds` | int | 是 | |
| `baseline_job_id` | string | 否 | 用该任务的无噪声基线估算效用；不传用项目默认基线 |
| `histogram_bins` | int | 否 | 默认 13 |

```json
{ "mechanism": "gaussian", "epsilon_total": 2.0, "clip_norm": 1.0, "delta": "1e-5", "total_rounds": 30, "histogram_bins": 13 }
```

响应 `data`：

| 字段 | 类型 | 说明 | 前端展示 |
|---|---|---|---|
| `epsilon_per_round` | number | `epsilon_total / total_rounds` | 「每轮 ε 消耗」 |
| `noise_scale` | number | 高斯为 σ，拉普拉斯为 b | 「当前噪声参数」 |
| `noise_scale_name` | string | `sigma` / `b` | |
| `formula` | string | 高斯 `σ = C · √(2 ln(1.25/δ)) / ε_每轮`；拉普拉斯 `b = C / ε_每轮` | 公式说明 |
| `baseline_accuracy` | number | 无噪声基线，例 0.921 | 「无噪声基线 0.921」 |
| `estimated_accuracy` | number | 预估模型效用 | 「模型效用（Accuracy）」 |
| `accuracy_loss` | number | `baseline - estimated` | 「损失 …」 |
| `curve[]` | array | 每轮趋势，长度 = `total_rounds` | 趋势曲线 |
| `curve[].round` | int | | |
| `curve[].cumulative_epsilon` | number | 累计 ε | 棕色线 |
| `curve[].estimated_accuracy` | number | 该轮预估效用 | 蓝色线 |
| `histogram[]` | array | 噪声分布，从 −3σ 到 +3σ 等分 | 直方图 |
| `histogram[].x` | number | 分箱中心（以 σ 或 b 为单位） | |
| `histogram[].density` | number | 概率密度，0–1 归一化 | 柱高 |

计算公式（与前端现有逻辑一致）：

- 每轮 ε：`ε_round = ε_total / total_rounds`
- 高斯：`σ = C · sqrt(2 · ln(1.25 / δ)) / ε_round`
- 拉普拉斯：`b = C / ε_round`

曲线归一化由前端做（「两条曲线按各自量纲归一化绘制」），后端返回原始值。

```json
{
  "epsilon_per_round": 0.0667,
  "noise_scale": 72.672,
  "noise_scale_name": "sigma",
  "formula": "σ = C · √(2 ln(1.25/δ)) / ε_每轮",
  "baseline_accuracy": 0.921,
  "estimated_accuracy": 0.852,
  "accuracy_loss": 0.069,
  "curve": [
    { "round": 1, "cumulative_epsilon": 0.0667, "estimated_accuracy": 0.629 },
    { "round": 2, "cumulative_epsilon": 0.1333, "estimated_accuracy": 0.637 }
  ],
  "histogram": [
    { "x": -3.0, "density": 0.011 },
    { "x": 0.0, "density": 1.0 },
    { "x": 3.0, "density": 0.011 }
  ]
}
```

#### v1.2 增补 · 会计方式与噪声倍数（DP-EVAL-01 / 02、DP-MECH-02）

对应：效果评估页噪声参数框、指标卡、趋势曲线；隐私机制页「按当前参数预估」。

请求增补 `accountant`（可选，默认 `rdp`，与任务默认一致；显式传 `basic` 时数值与 v1.1 一致）。响应增补：

| 字段 | 说明 |
|---|---|
| `accountant` | 本次使用的会计方式 |
| `noise_multiplier` | 噪声倍数 z（或 λ）= 噪声尺度 / C |
| `epsilon_per_round` | `basic` 为 ε_总 / T；其余为单轮机制 ε₀ |
| `epsilon_per_round_avg` | ε_总 / T |
| `delta_total` | 按会计方式的累计 δ |
| `curve[].cumulative_epsilon` | 按会计方式累计 |
| `task_type` / `primary_metric` | 由 `baseline_job_id` 对应任务（或 body.task_type）决定：分类 `accuracy`，时序 `rmse` |
| `metrics[]` | 按任务 `metrics_spec`：`{ key, label, better, baseline, estimated, change_pct }`；分类为 Accuracy（越高越好），时序为 RMSE / MAE（归一化，越低越好） |
| `curve[].estimated_rmse` | 仅时序任务；此时 `estimated_accuracy`、`baseline_accuracy`、`accuracy_loss` 均为 `null` |

显式 `accountant = basic` 时 `noise_scale`、`estimated_accuracy`、`curve` 与 v1.1 逐位一致；注意 v1.1 调用方不传该字段时现在按 RDP 计算。错误码：`40000` mechanism 非法、高斯缺 δ、accountant 非法、ε / C / T 非正数。

### 6.4 预算消耗

对应：「已消耗隐私预算」卡（ε 值、进度条、占总预算 %）、「已完成迭代轮次」、趋势图上的虚线游标。

> 设计稿里「已完成迭代轮次」是可拖动滑块（演示用）。接入真实后端后，该值来自任务实际进度，建议改为只读。

```
GET /fl/jobs/{job_id}/dp/budget
```

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `epsilon_total` | number | 总预算 |
| `epsilon_used` | number | 已消耗 |
| `used_pct` | int | 0–100 |
| `rounds_completed` | int | 已完成轮次（游标位置） |
| `total_rounds` | int | |
| `exhausted` | bool | 预算是否耗尽（耗尽后任务应自动停止） |

```json
{ "epsilon_total": 2.0, "epsilon_used": 0.8, "used_pct": 40, "rounds_completed": 12, "total_rounds": 30, "exhausted": false }
```

#### v1.2 增补 · 按会计方式累计（DP-EVAL-01、DP-FW-04）

对应：效果评估页「已消耗隐私预算」、框架集成页工作流第 5 步。

响应增补 `accountant`、`delta_total`（已完成轮次的累计 δ）、`dp_active`（本次运行是否启用 DP）。`epsilon_used` 按会计方式累计，`used_pct = round(epsilon_used / epsilon_total × 100)`。

```json
{ "epsilon_total": 2.4, "epsilon_used": 1.207, "used_pct": 50, "rounds_completed": 8, "total_rounds": 30, "exhausted": false, "accountant": "rdp", "delta_total": 0.00001, "dp_active": true }
```

### 6.5 隐私审计记录

对应：「隐私审计记录 · 最近 5 轮」表格。

```
GET /fl/jobs/{job_id}/dp/audit
```

Query：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `limit` | int | 否 | 5 | 返回最近 N 轮，按轮次倒序 |
| `from_round` / `to_round` | int | 否 | | 指定区间 |

响应 `data.items[]`：

| 字段 | 类型 | 表格列 |
|---|---|---|
| `round` | int | 轮次（前端拼「第 12 轮」） |
| `epsilon_spent` | number | ε 消耗 |
| `mechanism` | string | 噪声添加详情 |
| `noise_scale` | number | 噪声添加详情（σ 或 b） |
| `delta` | string \| null | 噪声添加详情（仅高斯） |
| `clip_norm` | number | 裁剪阈值 |
| `recorded_at` | string | |

无记录时返回空数组，前端显示「尚未开始迭代」。

```json
{
  "items": [
    { "round": 12, "epsilon_spent": 0.0667, "mechanism": "gaussian", "noise_scale": 72.672, "delta": "1e-5", "clip_norm": 1.0, "recorded_at": "2026-09-22T10:00:50+08:00" },
    { "round": 11, "epsilon_spent": 0.0667, "mechanism": "gaussian", "noise_scale": 72.672, "delta": "1e-5", "clip_norm": 1.0, "recorded_at": "2026-09-22T10:00:46+08:00" }
  ]
}
```

#### v1.2 增补 · 审计字段与导出（DP-EVAL-03）

对应：效果评估页「隐私审计记录」表、「查看全部」弹窗、「导出 CSV」。

```
GET /fl/jobs/{job_id}/dp/audit?limit=5|all&from_round=&to_round=
GET /fl/jobs/{job_id}/dp/audit/export        （文件下载，CSV，UTF-8 BOM）
```

`limit` 为非负整数或 `all`（`0` 同 `all`）。响应 `data = { items[], total }`，items 按轮次倒序，每条增补：

| 字段 | 说明 |
|---|---|
| `epsilon_spent` | 本轮 ε 增量 = 累计ε(r) − 累计ε(r−1)（RDP 下逐轮递减） |
| `epsilon_cumulative` | 截至本轮累计 ε |
| `accountant` / `noise_multiplier` | 会计方式、噪声倍数 |
| `clip_norm` / `clip_mode` | 本轮实际裁剪阈值（自适应时逐轮变化） |
| `clip_ratio` | 被裁剪的样本梯度占比（0–1） |
| `noise_l2` / `signal_l2` / `snr` | 见 6.11 |
| `source` | `engine` 训练引擎逐轮写入；`seed_history` 播种的历史任务按其配置回放 |

CSV 列：`job_id,round,accountant,mechanism,epsilon_spent,epsilon_cumulative,noise_scale,noise_multiplier,delta,clip_norm,clip_ratio_pct,noise_l2,recorded_at(UTC+8)`，时间用内核 `fmtLocal` 写成 `2026-10-23 22:10:05 +08:00`。错误码：`40400`、`40002`（limit 非法）。

### 6.6 机制目录（v1.2）

对应：隐私机制页「差分隐私机制」卡。验收编号 DP-MECH-01。

```
GET /dp/mechanisms
```

响应 `data.items[]`：`mechanism`、`name`、`guarantee`（`(ε, δ)-DP` / `ε-DP（纯差分隐私，δ = 0）`）、`definition`、`noise`、`sensitivity`、`scenarios[]`、`params[]`（`{ key, name, min, max, step }` 或 `{ key, name, options }`）。

### 6.7 效用-隐私平衡（v1.2）

对应：效果评估页「效用-隐私平衡分析」卡。验收编号 DP-EVAL-02（合同 C-09）。

```
POST /dp/tradeoff
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `mechanism` / `clip_norm` / `delta` / `total_rounds` | 是 | 同 6.3 |
| `accountant` | 否 | 默认 `rdp`；显式传 `basic` 按基础组合 |
| `epsilons` | 否 | ε 网格，默认 `[0.2, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10]`，每个 0.05–20 |
| `max_accuracy_loss` | 否 | 分类平衡点阈值，默认 0.03（3 个百分点） |
| `max_metric_increase_pct` | 否 | 时序平衡点阈值：RMSE 相对基线增幅，默认 10（%） |
| `baseline_job_id` / `task_type` | 否 | 决定按 Accuracy 还是 RMSE 评估 |

```json
{ "accountant": "rdp", "baseline_accuracy": 0.921, "max_accuracy_loss": 0.03,
  "points": [{ "epsilon_total": 1, "noise_scale": 26.848, "estimated_accuracy": 0.894, "accuracy_loss": 0.027 }],
  "recommended_epsilon": 1 }
```

响应增补 `task_type`、`metric`（主指标 `{ key, label, better, baseline }`）、`rule`（平衡点规则文字）、`points[].metric_value`、`points[].metric_change_pct`；时序任务 `baseline_accuracy = null`。`recommended_epsilon` = 满足 `rule` 的最小 ε，没有则 `null`。错误码：`40000`、`40003`（网格越界）。

### 6.8 自适应噪声注入（v1.2）

对应：隐私机制页「自适应噪声注入」页签。验收编号 DP-MECH-03（合同 C-07）。

```
POST /dp/adaptive-noise
```

**字段模式** `target = field`（默认）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `dataset_id` / `column` | 是 | 数值型（`float`）字段，例 `ds_p1_ree_price` / `ceo2_price` |
| `query` | 否 | `mean` 全量均值（覆盖全部记录）/ `group_mean` 月度均价（每组 21 个交易日） |
| `mechanism` / `epsilon` / `delta` | 是 | 单次查询 ε 0.05–10；高斯需 δ |

算法：字段按对数正态拟合（稀土价格字段的中位数、对数标准差见 mock `FIELD_MODEL`，其他字段按数据集 ID 与字段名哈希给出稳定参数）。敏感度 `Δ = (U − L) / n`，n 为单次查询覆盖记录数。

- 固定裁剪：`[L, U] = [0, 公开取值上界]`（业务规则给定，不看数据：Nd₂O₃ 2,000,000 元/吨，CeO₂ / La₂O₃ 150,000 元/吨），全部 ε 用于加噪。
- 自适应裁剪：候选 `[P1, P99]`、`[P2.5, P97.5]`、`[P5, P95]`、`[P10, P90]`，10% 预算用于差分隐私分位数估计，90% 用于加噪；裁剪偏差 `E[clip(X)] − E[X]` 按对数正态截断期望解析计算；`RMSE = √(噪声方差 + 偏差²)`，取 RMSE 最小的候选。
- 噪声：拉普拉斯 `b = Δ / ε`、标准差 `√2·b`；高斯 `σ = Δ·√(2 ln(1.25/δ)) / ε`。

响应：`stats`（`median`、`mean`、`p01`、`p05`、`p95`、`p99`、`log_sd`、`public_lower`、`public_upper`）、`fixed` 与 `adaptive`（`lower`、`upper`、`sensitivity`、`epsilon_used`、`noise_scale`、`noise_std`、`bias`、`rmse`、`rel_error_pct`）、`candidates[]`、`recommended`（`adaptive` / `fixed`）、`noise_reduction_pct`、`rmse_reduction_pct`、`unit`、`group_size`。

**梯度模式** `target = gradient`，`job_id` 必填：样本梯度 L2 范数中位数按 `m(r) = 0.25 + 0.9·e^(−r/12)`、对数标准差 0.5 建模；返回逐轮 `update_norm_median`、`clip_fixed`、`clip_adaptive`、`clip_ratio_fixed`、`clip_ratio_adaptive`、`noise_fixed`、`noise_adaptive`，以及 `fixed_clip_norm`（固定基准：已启用自适应时为切换前的固定 C，记在 `job.dp.clip_norm_fixed`）、`initial_clip_norm`、`summary`（含 `adaptive_better`；`noise_reduction_pct` 为负表示自适应噪声更多，界面显示「噪声增加」）和 `recommended_clip_norm`（第 ⌈T/2⌉ 轮中位数，取一位小数，夹在 0.2–4）。

错误码：`40400` 数据集 / 任务不存在；`40901` 数据集未导入完成；`40000` 字段不存在、参数非法；`40001` 字段不是数值型；`40003` ε 越界；`40002` δ 非法。

#### 统计查询配置与发布

对应：隐私机制页「参数配置 → 统计查询（数据集字段）」。验收编号 DP-MECH-02、DP-MECH-03。

```
GET  /projects/{project_id}/dp/query-config
PUT  /projects/{project_id}/dp/query-config
POST /projects/{project_id}/dp/query
GET  /projects/{project_id}/dp/queries
```

配置字段：`mechanism`、`epsilon`（单次查询，0.05–10）、`delta`、`dataset_id`、`column`、`query`、`clip_mode`（`fixed` / `adaptive`）。

`POST …/dp/query` 两种用法：带上述字段直接发布；或 `{ policy_id, dimension_key }` 按策略的查询维度发布（消耗该维度 1 次，参数取自策略）。响应 **不含真实值**，只返回 `noisy_value`（已裁回裁剪区间，属后处理不耗预算）、`unit`、`clip_lower`、`clip_upper`、`sensitivity`、`noise_scale`、`expected_rmse`、`epsilon_spent`、`release_id`。`GET …/dp/queries` 返回发布记录与 `epsilon_spent_total`（基础组合累加）。

错误码：同 6.8；按策略发布时 `40400` 策略 / 维度不存在、`40001` 该维度是训练维度、`40901` 该维度次数已用完。

### 6.9 组合定理对比（v1.2）

对应：隐私机制页「策略动态编排 → 组合定理对比」。验收编号 DP-MECH-04（合同 C-08）。

```
POST /dp/compose
```

```json
{ "mechanism": "gaussian", "epsilon_per_step": 0.0667, "delta": "1e-5", "rounds": 30 }
```

响应：`noise_multiplier`、`results.{basic, advanced, rdp}.{epsilon, delta_total}`（rdp 另有最优阶 `alpha`）、`curve[]`（`{ t, basic, advanced, rdp }`，最多约 60 个点）。上例结果：基础 2.001、高级 1.891、RDP 0.365。错误码：`40000`、`40003`（ε₀ 不在 0.001–5 或 T 不是 1–1000 的整数）、`40002`。

### 6.10 DP 策略编排与下发（v1.2）

对应：隐私机制页「新建 DP 策略」「已编排策略」，框架集成页工作流第 2 步「选用已编排策略」。验收编号 DP-MECH-04、DP-FW-04。

```
POST /projects/{project_id}/dp/policies
GET  /projects/{project_id}/dp/policies
POST /dp/policies/{policy_id}/apply
```

创建请求：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 项目内唯一 |
| `accountant` / `mechanism` | 是 | 维度内多步组合的会计方式、机制 |
| `epsilon_total` | 是 | 策略总预算 0.2–50 |
| `delta` | 是 | 每个维度的 δ |
| `dimensions[]` | 是 | 1–8 个；`{ key, label, kind, weight }` |
| `dimensions[].kind = training` | | 另需 `job_id`、`sensitivity`（C，0.2–4）；步数 = 任务总轮数 |
| `dimensions[].kind = query` | | 另需 `dataset_id`、`column`、`query`、`steps`（1–1000 次）、`clip_mode` |

分配规则：维度之间按顺序组合相加，`ε_i = ε_总 · w_i / Σw`；维度内按 `accountant` 反解每步噪声。每个维度返回 `epsilon`、`share_pct`、`steps`、`epsilon_per_step`、`noise_multiplier`、`noise_scale`（训练维度）、`delta_total`、`noise_by_accountant.{basic,advanced,rdp}`（三种会计方式下的每步噪声倍数对比）；策略返回 `delta_total`（各维度累计 δ 之和）。

下发：`POST /dp/policies/{policy_id}/apply`，body 可选 `dimension_keys[]`。先整体校验再写入（全部成功或全部不写）：把训练维度写入绑定任务的 `job.dp`（`enabled = true`、`epsilon_total = ε_i`、`clip_norm = C`、`accountant`、`policy_id`、`policy_dimension`）。

```json
{ "policy_id": "dpp_0003", "applied": [{ "dimension_key": "d1", "job_id": "fl_p1_002", "job_name": "供应商违约预测 · XGBoost", "epsilon_total": 2.4, "noise_scale": 11.533 }], "applied_at": "2026-10-23T22:06:00+08:00" }
```

错误码：`40000` 名称为空、枚举非法、维度数不对；`40902` 策略重名或维度 key 重复；`40003` 权重、预算、步数、C 越界，或下发时 ε_i 超出任务允许的 0.2–10；`40002` δ 非法；`40400` 绑定任务 / 数据集不存在；`40001` 策略无训练维度；`40901` 绑定任务运行中。

### 6.11 框架集成（v1.2）

#### 实现与接口映射

对应：框架集成页「隐语集成 · DP 适配层」。验收编号 DP-FW-01。

```
GET /dp/providers
PUT /dp/provider        { "provider": "opacus" }
```

`GET` 返回 `current` 与 `items[]`（`provider`、`name`、`library`、`version_note`、`mechanisms`、`accountants`、`mapping[]`）。`mapping[]` = `{ iface, impl, source, note }`：`iface` 为平台统一接口（`DPStrategy.build`、`GradientDP.gaussian`、`GradientDP.laplace`、`Accountant.spent`、`SecureAggregator.aggregate`），`source = native` 表示框架自带类（类路径以部署环境的包版本为准），`adapter` 表示平台适配层补齐的实现。

实现按项目选用。`GET /dp/providers?project_id=` 返回该项目当前实现。`PUT /dp/provider { provider, project_id }` 只改该项目内待启动 / 失败 / 已终止（Created / Failed / Terminated）任务的 `job.dp.provider`；训练中 / 已暂停任务沿用原实现直到本次训练结束；已完成任务保留训练时的实现记录（重置回待启动后才跟随项目当前实现）；其他项目不受影响。响应 `{ project_id, current, affected_jobs, affected_job_ids[], kept_running[], kept_finished[] }`（后两者为 `{ job_id, status, provider }`）。错误码 `40000` 未知实现或缺 project_id。

#### DP hook 链

对应：框架集成页「DP 初始化与 hook 链」。验收编号 DP-FW-02。

```
GET /fl/jobs/{job_id}/dp/hooks
```

响应：`initialized`（启用 DP 且已启动过）、`initialized_at`、`hook_point = before_aggregate`、`provider`、`trainers`、`steps[]`（`key`：`load` → `train` → `clip` → `noise` → `agg` → `account`；`name`、`impl`、`dp`、`status`：`pending` / `active` / `done` / `skipped`、`calls`、`last_called_at`、`detail`）。调用次数：load / train / clip / noise 为「已完成轮数 × 训练参与方数」，agg / account 为已完成轮数；本次运行未启用 DP 时 clip / noise / account 为 `skipped` 且次数为 0。

#### 框架内部 DP 指标

对应：框架集成页「框架内部 DP 指标」。验收编号 DP-FW-03。

```
GET /fl/jobs/{job_id}/dp/metrics?bins=21
```

| 字段 | 说明 |
|---|---|
| `rounds[]` | 每轮 `clip_ratio`、`clip_norm`、`update_norm_median`、`noise_l2`、`signal_l2`、`snr` |
| `summary` | `clip_ratio_avg`、`noise_l2_last`、`snr_last`、`snr_db_last = 10·log10(snr²)`、`model_dim`、`trainers`、`noise_scale`；无 DP 轮次时为 `null` |
| `histogram[]` | 末轮噪声坐标抽样 4000 个（以 σ 或 b 为单位，种子 = job_id + 轮次），`{ x, count, density（峰值归一）, theory（理论密度峰值归一） }` |

计算：`clip_ratio = P(‖g‖₂ > C) = 1 − Φ((ln C − ln m(r)) / 0.5)`；聚合后噪声范数高斯 `‖n‖₂ = σ·√d`、拉普拉斯 `b·√(2d)`，d 为单次上传参数维度，取内核 `k.MODEL_PARAMS`（逻辑回归 69、XGBoost 2,176、CNN 61,706、LSTM 203,143、TCN 37,959、自定义 20,000）；按 DP-SGD 逐样本裁剪：每个参与方每轮对 B = 256 个样本梯度逐个裁剪后求和再加噪，信号 `‖Σ clip(g)‖₂` 取上界 `n · B · E[min(‖g‖₂, C)]`；`snr = 信号 / 噪声`。错误码：`40400`、`40003`（bins 不是 5–61 的整数）。

#### 初始化检查

对应：框架集成页工作流第 3 步。验收编号 DP-FW-04（合同 C-10）。

```
POST /fl/jobs/{job_id}/dp/init-check
```

响应 `{ ok, checks[], checked_at }`，`checks[]` 依次为 `enabled`（任务已启用 DP）、`params`（参数在允许范围）、`provider`（当前实现支持该机制与会计方式）、`calibration`（噪声倍数有限且为正）、`aggregation`（已配置 HE / SS 安全聚合）、`nodes`（训练参与方 ≥ 2）、`status`（任务状态可启动：Created / Failed / Terminated）。全部通过 `ok = true`。错误码 `40400`。

端到端工作流（DP-FW-04）的调用顺序：`GET /projects/{id}/fl/jobs` → `PUT /fl/jobs/{id}/dp` 或 `POST /dp/policies/{id}/apply` → `POST /fl/jobs/{id}/dp/init-check` → `POST /fl/jobs/{id}/actions { action: start }`（前端跳转 `App.go('fed', { sub: 'proc', focusJobId })`）→ `GET /fl/jobs/{id}/dp/budget`、`/dp/audit`（效果评估页）。

---

## 7. 实时推送（SSE）

长任务用 Server-Sent Events 推送增量。前端用 `EventSource`（需要带 token 时用 `?access_token=` 或 fetch-based SSE 库）。

### 7.1 端点

| 端点 | 用途 |
|---|---|
| `GET /fl/jobs/{job_id}/events` | 联邦训练：状态变化、每轮指标、节点上传 |
| `GET /fl/evaluations/{eval_id}/events` | 联邦学习技术指标评估：进度、完成（v1.2） |
| `GET /mpc/tasks/{task_id}/events` | MPC：参与方指标、告警 |
| `GET /psi/pipelines/{pipeline_id}/events` | PSI：阶段进度 |

响应头：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

### 7.2 事件格式

```
event: <事件名>
id: <递增序号，断线重连用 Last-Event-ID>
data: <JSON>

```

后端每 15 秒发一次心跳：`: ping`。

### 7.3 事件清单

| 端点 | event | data |
|---|---|---|
| FL | `status_changed` | `{ "job_id", "status", "previous_status", "at" }` |
| FL | `round_completed` | `{ "job_id", "round", "global_metrics": { "<key>": number }, "global_loss", "global_accuracy", "node_metrics": [{ "node_id", "<key>": number, "upload_kb" }], "elapsed_sec", "eta_sec", "dp": { "epsilon_spent", "epsilon_used" } }`；`<key>` 为任务 `metrics_spec[].key`，`global_loss` / `global_accuracy` 为兼容字段，非分类任务为 null（v1.1）；v1.2：`eta_sec` 与 `elapsed_sec` 为 EMA 平滑值（α = 0.3，见 [2.16.1](#2161-预估剩余时间)，页面直接使用推送值），`dp` 按任务 `accountant` 累计并附 `accountant`（见 [6.0](#60-通用约定与会计方法v12)） |
| FL | `node_status_changed` | `{ "node_id", "status" }` |
| FL | `job_failed` | `{ "job_id", "reason" }` |
| FL 评估 | `progress` | `{ "eval_id", "progress", "stage" }`（v1.2，见 [2.13.4](#2134-进度推送sse)） |
| FL 评估 | `finished` | 完整评估记录，含 `result`（v1.2，见 [2.13.3](#2133-评估记录)） |
| MPC | `metrics` | v1.2：`{ "parties", "summary", "progress_pct", "alarms" }`（`parties[]` 同 [4.3](#43-获取任务详情实时监控)，v1.1 只推 `parties[]`），推送频率 ≤ 2 次/秒 |
| MPC | `alarm_raised` | 同 4.3 `alarms[]` 单条 |
| MPC | `status_changed` | `{ "task_id", "status" }` |
| PSI | `stage_progress` | `{ "stage", "status", "progress_pct", "duration_sec", "stats" }` |
| PSI | `pipeline_finished` | `{ "pipeline_id", "status", "fl_job_id", "target_project", "error" }`；v1.2：失败时也推送（`status = failed`，`fl_job_id = null`，`error` 写明原因，见 [5.3](#53-启动一键流水线)） |

示例：

```
event: round_completed
id: 12
data: {"job_id":"fl_20260922_01","round":12,"global_loss":0.3171,"global_accuracy":0.8423,"node_metrics":[{"node_id":"node-shanghai-01","loss":0.3671,"accuracy":0.8123,"upload_kb":151.4}],"elapsed_sec":50.4,"eta_sec":75.6,"dp":{"epsilon_spent":0.0667,"epsilon_used":0.8,"accountant":"basic"}}

```

---

## 8. 枚举汇总

| 枚举 | 取值 |
|---|---|
| `ProjectType` | `production` / `pilot` / `sandbox` |
| `ProjectTargetMetric` | `accuracy` / `auc` / `loss`（分类）、`rmse` / `mae`（时序，归一化值）（v1.2） |
| `ProjectTargetOp` | `<=`（`loss` / `rmse` / `mae`）/ `>=`（`accuracy` / `auc`）（v1.2） |
| `FlJobStatus` | `Created` / `Running` / `Paused` / `Success` / `Failed` / `Terminated` |
| `FlJobAction` | `start` / `pause` / `resume` / `terminate` / `reset`（v1.2 补充枚举名） |
| `FlStateAction` | `create` / `start` / `pause` / `resume` / `terminate` / `reset` / `complete`（跑满轮次）/ `fail`（异常），`state_history[].action`（v1.2） |
| `FlWorkerStatus` | `running` / `suspended` / `killed` / `completed` / `failed`，`runtime.workers[].status`（v1.2） |
| `FlTaskType` | `classification` 分类 / `timeseries` 时序预测（v1.1） |
| `FlAlgorithm` | `lr` 逻辑回归 / `xgb` XGBoost / `cnn` CNN / `lstm` LSTM / `tcn` TCN / `custom` 自定义上传模型（`lstm`、`tcn` v1.1，仅时序）；v1.2 创建任务时另可传已注册算法 `alg_*` / 自定义模型 `mdl_*` 的 `algo_id`，服务端映射为 `custom` |
| `FlAlgoKind` | `builtin` 内置 / `registered` 已注册 / `custom` 自定义模型（v1.2） |
| `FlModelFormat` | `pkl` / `pt` / `h5` / `onnx`（v1.2） |
| `FlAlgoAction` | `publish` / `rollback`，`history[].action`（v1.2） |
| `FlMetricKey` | 分类 `loss` / `accuracy`；时序 `rmse` / `mae`（v1.1） |
| `FlAggregation` | `ss` 秘密共享聚合 / `he` 同态加密聚合 |
| `FlNodeRole` | `trainer` 训练节点 / `aggregator` 聚合节点 |
| `FlNodeStatus` | `pending` / `uploading` / `suspended` / `completed` / `released` / `offline` |
| `FlMetricScope` | `global` / `nodes` |
| `FlIsolationCheckType` | `dir_access` 目录访问检测 / `payload` 传输内容审计（v1.2） |
| `FlIsolationResult` | `allowed` / `denied`（目录访问）、`passed`（传输审计）（v1.2） |
| `FlPayloadFieldKind` | `gradient` / `metadata` / `metric` / `model_param`（v1.2） |
| `FlAggStrategy` | 同 `FlAggregation`（项目聚合配置 `strategy`，v1.2） |
| `FlSparseQuantBits` | `4` / `8` / `16` / `32`（`sparsification.quant_bits`，v1.2） |
| `FlHeKeyStatus` | `active` / `rotated` / `destroyed`（v1.2，聚合密钥与 HE 密钥共用） |
| `FlEvalKind` | `gradient_attack` 梯度反演攻击 / `compression` 通信压缩比 / `accuracy` 精度对比（v1.2） |
| `FlEvalStatus` | `running` / `finished`（v1.2） |
| `FlEvalPartition` | `iid` / `dirichlet`（v1.2） |
| `FlAttackMethod` | `DLG` / `iDLG`（v1.2） |
| `HeScheme` | `paillier` / `ckks` / `bgv`；v1.2 算法目录另有 `tfhe`（`/he/schemes` 仍为前三项，目录见 3.7） |
| `HeFamily` | `phe` 半同态 / `fhe` 全同态（v1.2） |
| `HeLibrary` | `seal` / `pyfhel` / `openfhe` / `tfhe-rs` / `phe`（v1.2；Paillier 为 `phe`） |
| `HeSupportedOp` | `add_ct_ct` / `mul_ct_pt` / `mul_ct_ct`（v1.2 补充枚举名） |
| `HeOp` | `add` / `mul`；运算验证（3.11）另有 `mul_plain` 明文数乘（v1.2） |
| `HeEncodeMode` | `fixed_point` / `integer` / `native`（3.10，v1.2） |
| `HeVerifyMode` | `integer` / `fixed_point` / `ckks_native`（3.11，v1.2） |
| `HeKeyPurpose` | `session` 会话（默认，四步流程）/ `fl_aggregation` 联邦聚合（v1.2） |
| `HeKeyStatus` | `active` / `rotated` / `destroyed`（v1.2） |
| `HeRotateReason` | `manual` / `auto` / `superseded`（v1.2；`superseded` 见附录 A 矛盾项） |
| `HeLogSource` | `session` 四步流程 / `simulation` / `fl_job`（v1.2） |
| `MpcProtocol` | `ss` 秘密共享 / `gc` 混淆电路 / `ot` 不经意传输扩展 |
| `MpcOperator` | `secure_sum` / `secure_product` / `secure_mean` / `secure_compare` / `secure_max` / `logic_op` / `vector_ot`（`secure_sum`、`secure_max` v1.2 新增） |
| `MpcValueType` | `parties` 各方私有数据 / `vector` / `scalar` / `bool_vector` / `bool`（v1.2） |
| `MpcSecurityModel` | `semi_honest` 半诚实 / `malicious` 恶意（v1.2） |
| `MpcCompareMode` | 比较方式 `gt` / `lt`；逻辑模式 `and` / `or` / `not`（v1.2） |
| `MpcPartyRole` | `input` / `compute` / `output` |
| `MpcTaskStatus` | `pending` / `running` / `stopped` / `finished` / `failed` |
| `MpcPartyStatus` | `pending` / `running` / `finished` / `abnormal` |
| `MpcAlarmType` | `comm_anomaly` / `compute_anomaly`（v1.2）/ `node_offline` / `timeout` |
| `MpcStepVisibility` | `secret` 中间结果保持份额 / `revealed_to_output` 最后一步只对输出方公开（v1.2） |
| `FilePurpose` | `fl_model` / `dataset`（v1.1） |
| `DatasetSourceType` | `file` / `database` / `hdfs`（v1.1） |
| `DatasetStatus` | `importing` / `ready` / `failed`（v1.1） |
| `PsiProtocol` | `ecdh` / `kkrt` / `unbalanced` |
| `PsiParamType` | `enum` / `int` / `float` / `bool`（`params[].type`，v1.2） |
| `PsiConfigSource` | `default`（仅 GET，未保存过）/ `manual` / `template` / `route_advice`（v1.2） |
| `PsiRowCountBasis` | `parsed` 文件解析 / `size_estimate` 按文件大小估算，`source.row_count_basis`（v1.2） |
| `PsiStage` | `intersect` / `align` / `train` |
| `PsiStageStatus` | `pending` / `running` / `finished` / `failed` / `skipped` |
| `PsiPipelineStatus` | `pending` / `running` / `finished` / `failed` / `canceled` |
| `DpMechanism` | `gaussian` / `laplace` |
| `DpDelta` | `1e-4` / `1e-5` / `1e-6` |
| `DpAccountant` | `basic` 基础组合 / `advanced` 高级组合 / `rdp` RDP 会计（任务默认）（v1.2） |
| `DpClipMode` | `fixed` / `adaptive`（v1.2） |
| `DpQueryKind` | `mean` 全量均值 / `group_mean` 月度均价（v1.2） |
| `DpDimensionKind` | `training` / `query`（v1.2） |
| `DpHookStatus` | `pending` / `active` / `done` / `skipped`（v1.2） |

> 注意：前端设计稿内部用 `unbal`、`gauss`、`lap` 作为状态值，对接时前端需映射为 `unbalanced`、`gaussian`、`laplace`。

---

## 9. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | 40000 | 请求参数格式错误（v1.2 含：缺必填字段、枚举不合法、流程类型不匹配、参与方 / 角色不满足要求、算子 / 协议 / 方案未知） |
| 400 | 40001 | 方案 / 算子 / 底层库不支持此操作（如 Paillier 密文乘密文、安全比较选秘密共享、库不支持方案）；v1.2 另用于：隔离检测的目标节点是聚合节点、DP 字段不是数值型、删除平台预置参数模板、DP 策略无训练维度 |
| 400 | 40002 | 数值不合法 / 值格式错误（非数字、非整数、版本号格式错误、schema 不是合法 JSON） |
| 400 | 40003 | 参数超出允许范围（v1.2 含跨字段约束、明文空间溢出、参数不可行） |
| 401 | 40100 | 未登录或 token 失效 |
| 403 | 40300 | 无权访问该项目 / 资源 |
| 404 | 40400 | 资源不存在（v1.2 含项目、任务、节点、算法、版本、模板、数据集、策略、评估记录） |
| 404 | 40402 | 密钥不存在、已销毁或已过期；v1.2 另含：项目尚未生成聚合密钥对 |
| 409 | 40901 | 当前状态不允许该操作；v1.2 另含：密钥已轮换不能加密、同类评估正在运行、内置模板不可删、指定版本已是当前版本、节点被运行中任务使用、启动预检发现参与节点已从项目移除、数据集未导入完成、绑定任务运行中。`data` 可带 `allowed_actions` / `job_ids` / `missing_node_ids` |
| 409 | 40902 | 资源已存在（如项目内节点 ID 重复；v1.2 另含项目名称、同名同版本算法、参数模板、DP 策略 / 维度 key 重名） |
| 422 | 42201 | 节点连通性检查失败；v1.2 另含：启动 / 恢复任务前参与节点离线（`data.offline_node_ids`） |
| 422 | 42202 | 隐私预算已耗尽 |
| 429 | 42900 | 请求过于频繁 |
| 500 | 50000 | 服务内部错误 |
| 502 | 50201 | 计算引擎 / 节点通信失败 |
| 504 | 50401 | 计算引擎超时 |

v1.2 没有新增业务码，只扩展了上述码的适用场景；具体触发条件见各接口小节的错误表。

---

## 10. 接口总表

共 129 个接口：v1.1 原有 52 个，v1.2 新增 77 个（「状态」列标「新」）；v1.1 已有、v1.2 升级的标「改」。验收编号为空表示该接口不属于任一验收项。

| # | 模块 | 方法 | 路径 | 说明 | 验收编号 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 公共 | GET | `/me` | 当前用户 | — | — |
| 2 | 公共 | GET | `/platform/info` | 平台名称、环境 | — | — |
| 3 | 公共 | GET | `/projects` | 项目列表（v1.2 返回项目配置字段，支持 keyword） | FL-ORCH-01 / 04 | 改 |
| 4 | 公共 | POST | `/files` | 文件上传 | — | — |
| 5 | 公共 | POST | `/projects` | 创建项目 | FL-ORCH-01 | 新 |
| 6 | 公共 | GET | `/projects/{project_id}` | 项目详情（含配置） | FL-ORCH-04 | 新 |
| 7 | 公共 | PATCH | `/projects/{project_id}` | 修改项目配置 | FL-ORCH-04 | 新 |
| 8 | 公共 | GET | `/projects/{project_id}/config/export` | 导出项目配置 JSON | FL-ORCH-04 | 新 |
| 9 | FL | GET | `/fl/task-types` | 任务类型目录（v1.1） | — | — |
| 10 | FL | GET | `/projects/{project_id}/fl/jobs` | 训练任务列表（v1.1 支持 task_type 过滤；v1.2 补过程管控与算法引用字段） | FL-ORCH-06 / 07、FL-PROC-01 / 07 | 改 |
| 11 | FL | POST | `/projects/{project_id}/fl/jobs` | 创建训练任务（v1.2 支持注册算法、params、项目默认值） | FL-ORCH-06 / 07 / 09 | 改 |
| 12 | FL | GET | `/fl/jobs/{job_id}` | 任务详情（v1.2 补 allowed_actions、runtime、checkpoint 等） | FL-PROC-01 / 07、FL-ORCH-06 / 07 | 改 |
| 13 | FL | PATCH | `/fl/jobs/{job_id}` | 修改算法 / 聚合策略（仅 Created / Terminated / Failed） | — | — |
| 14 | FL | POST | `/fl/jobs/{job_id}/actions` | 启动 / 暂停 / 恢复 / 终止 / 重置（v1.2 含预检、断点、资源释放） | FL-PROC-01 至 04 | 改 |
| 15 | FL | GET | `/fl/jobs/{job_id}/metrics` | 收敛曲线数据（v1.2 轮次与时间范围生效） | FL-PROC-05 / 06 | 改 |
| 16 | FL | GET | `/fl/jobs/{job_id}/he-public-key` | 查看聚合公钥（v1.2 项目密钥优先） | FL-AGG-04 | 改 |
| 17 | FL | GET | `/fl/jobs/{job_id}/metrics/export` | 导出任务指标 CSV（v1.2 时间范围生效） | FL-PROC-08 | 改 |
| 18 | FL | GET | `/projects/{project_id}/fl/metrics/export` | 按项目导出 CSV（v1.2 固定列） | FL-PROC-08 | 改 |
| 19 | FL | GET | `/fl/jobs/{job_id}/nodes` | 任务参与节点（v1.2 离线状态） | FL-PROC-02 | 改 |
| 20 | FL | GET | `/projects/{project_id}/nodes` | 项目节点列表（v1.2 补 data_dir、running_job_count） | FL-ORCH-02 | 改 |
| 21 | FL | POST | `/projects/{project_id}/nodes` | 添加节点（v1.2 校验 IP / 端口、连通性） | FL-ORCH-02 | 改 |
| 22 | FL | PATCH | `/projects/{project_id}/nodes/{node_id}` | 编辑节点 / 置离线 | FL-ORCH-02、FL-PROC-01 / 02 | 新 |
| 23 | FL | DELETE | `/projects/{project_id}/nodes/{node_id}` | 删除节点（运行中任务使用时拒绝） | FL-ORCH-02 | 改 |
| 24 | FL | GET (SSE) | `/fl/jobs/{job_id}/events` | SSE 推送（v1.2 eta 为 EMA 平滑值） | — | 改 |
| 25 | FL | GET | `/fl/jobs/{job_id}/eta` | 平滑剩余时间与逐轮耗时 | FL-PROC-07 | 新 |
| 26 | FL | GET | `/fl/metrics` | 历史指标查询（项目 / 任务 / 时间范围） | FL-PROC-08 | 新 |
| 27 | FL | GET | `/fl/metrics/export` | 历史指标 CSV | FL-PROC-08 | 新 |
| 28 | FL | GET | `/projects/{project_id}/fl/aggregation` | 获取聚合配置 | FL-AGG-01 / 02 / 03 / 07 | 新 |
| 29 | FL | PUT | `/projects/{project_id}/fl/aggregation` | 保存聚合配置 | FL-AGG-06 | 新 |
| 30 | FL | POST | `/projects/{project_id}/fl/aggregation/reset` | 恢复默认聚合配置 | FL-AGG-05 | 新 |
| 31 | FL | POST | `/projects/{project_id}/fl/aggregation/estimate` | 通信量实时估算 | FL-AGG-07 | 新 |
| 32 | FL | POST | `/projects/{project_id}/fl/aggregation/keys` | 生成聚合密钥对 | FL-AGG-04 | 新 |
| 33 | FL | GET | `/projects/{project_id}/fl/aggregation/keys` | 聚合密钥列表 | FL-AGG-04 | 新 |
| 34 | FL | GET | `/projects/{project_id}/fl/aggregation/public-key` | 查看当前有效公钥 | FL-AGG-04 | 新 |
| 35 | FL | GET | `/projects/{project_id}/fl/evaluations/defaults` | 评估默认配置 | FL-EVAL-01 / 02 / 03 | 新 |
| 36 | FL | POST | `/projects/{project_id}/fl/evaluations` | 创建评估 | FL-EVAL-01 / 02 / 03 | 新 |
| 37 | FL | GET | `/projects/{project_id}/fl/evaluations` | 评估记录列表 | FL-EVAL-01 / 02 / 03 | 新 |
| 38 | FL | GET | `/fl/evaluations/{eval_id}` | 评估详情 | FL-EVAL-01 / 02 / 03 | 新 |
| 39 | FL | GET (SSE) | `/fl/evaluations/{eval_id}/events` | 评估进度推送 | FL-EVAL-01 / 02 / 03 | 新 |
| 40 | FL | GET | `/fl/evaluations/{eval_id}/export` | 导出评估报告 CSV | FL-EVAL-01 / 02 / 03 | 新 |
| 41 | FL | GET | `/projects/{project_id}/isolation` | 数据隔离视图 | FL-ORCH-03 | 新 |
| 42 | FL | POST | `/projects/{project_id}/isolation/checks` | 越权访问检测 / 传输内容审计 | FL-ORCH-03 | 新 |
| 43 | FL | GET | `/fl/algorithms` | 算法库列表 | FL-ORCH-05 / 06 / 07 | 新 |
| 44 | FL | GET | `/fl/algorithms/{algo_id}` | 算法详情 | FL-ORCH-05 / 08 | 新 |
| 45 | FL | POST | `/fl/algorithms` | 注册算法 / 发布新版本 | FL-ORCH-06 / 08 | 新 |
| 46 | FL | POST | `/projects/{project_id}/fl/models` | 登记自定义模型（结构校验） | FL-ORCH-07 / 08 | 新 |
| 47 | FL | POST | `/fl/algorithms/{algo_id}/actions` | 版本回滚 | FL-ORCH-08 | 新 |
| 48 | FL | GET | `/fl/algorithms/{algo_id}/templates` | 参数模板列表 | FL-ORCH-09 | 新 |
| 49 | FL | POST | `/fl/algorithms/{algo_id}/templates` | 另存参数模板 | FL-ORCH-09 | 新 |
| 50 | FL | DELETE | `/fl/param-templates/{template_id}` | 删除自定义模板 | FL-ORCH-09 | 新 |
| 51 | HE | GET | `/he/schemes` | 加密方案列表 | — | — |
| 52 | HE | POST | `/he/keys` | ① 生成密钥对（v1.2 补 purpose、node_ids、状态字段） | HE-APP-01 / 03 | 改 |
| 53 | HE | POST | `/he/encrypt` | ② 加密（v1.2 先检查密钥状态） | HE-APP-01 / 03 | 改 |
| 54 | HE | POST | `/he/evaluate` | ③ 密态运算（v1.2 统一耗时模型） | HE-APP-01 / 05 | 改 |
| 55 | HE | POST | `/he/decrypt` | ④ 解密 + 校验（v1.2 统一耗时模型、会话记日志） | HE-APP-01 / 05 | 改 |
| 56 | HE | DELETE | `/he/keys/{key_id}` | 重置 / 销毁密钥（v1.2 保留销毁记录） | HE-APP-01 / 03 | 改 |
| 57 | HE | GET | `/he/algorithms` | 算法目录 | HE-ALGO-01 / 02 | 新 |
| 58 | HE | GET | `/he/libraries` | 底层库与支持矩阵 | HE-ALGO-03 | 新 |
| 59 | HE | GET | `/projects/{project_id}/he/config` | 项目默认加密配置 | HE-ALGO-03 / 07 | 新 |
| 60 | HE | PUT | `/projects/{project_id}/he/config` | 保存项目默认加密配置 | HE-ALGO-03 / 07 | 新 |
| 61 | HE | POST | `/he/encode` | 定点编码 | HE-ALGO-06 / 07 | 新 |
| 62 | HE | POST | `/he/verify` | 运算验证 | HE-ALGO-04 / 05 | 新 |
| 63 | HE | POST | `/he/param-optimize` | CKKS 参数寻优 | HE-ALGO-08 | 新 |
| 64 | HE | GET | `/he/keys` | 密钥列表 | HE-APP-03 | 新 |
| 65 | HE | POST | `/he/keys/{key_id}/distribute` | 密钥分发 | HE-APP-03 | 新 |
| 66 | HE | POST | `/he/keys/{key_id}/rotate` | 密钥轮换 | HE-APP-03 | 新 |
| 67 | HE | GET | `/projects/{project_id}/he/rotation-policy` | 读取自动轮换策略 | HE-APP-03 | 新 |
| 68 | HE | PUT | `/projects/{project_id}/he/rotation-policy` | 保存自动轮换策略 | HE-APP-03 | 新 |
| 69 | HE | POST | `/projects/{project_id}/he/simulations` | 运行流程测试模拟 | HE-APP-04 | 新 |
| 70 | HE | GET | `/projects/{project_id}/he/simulations` | 模拟记录列表 | HE-APP-04 | 新 |
| 71 | HE | GET | `/projects/{project_id}/he/logs` | 加解密性能日志 | HE-APP-05 | 新 |
| 72 | HE | GET | `/projects/{project_id}/he/logs/export` | 导出性能日志 CSV | HE-APP-05 | 新 |
| 73 | MPC | GET | `/projects/{project_id}/mpc/estimate` | 协议算子 + 性能预估（v1.2 支持多步流程） | MPC-PROTO-07 | 改 |
| 74 | MPC | POST | `/projects/{project_id}/mpc/estimate` | 性能预估（完整流程与参数） | MPC-PROTO-07 | 新 |
| 75 | MPC | POST | `/projects/{project_id}/mpc/tasks` | 创建任务（v1.2 多步流程、≥ 3 方、阈值） | MPC-PROTO-04 / 05 / 06、MPC-OPS-04 | 改 |
| 76 | MPC | GET | `/mpc/tasks/{task_id}` | 实时监控详情（v1.2 偏离度、compute_anomaly） | MPC-OPS-01 至 04 | 改 |
| 77 | MPC | POST | `/mpc/tasks/{task_id}/actions` | 开始 / 停止 / 重置（v1.2 收紧状态校验） | MPC-OPS-01 至 03 | 改 |
| 78 | MPC | GET | `/projects/{project_id}/mpc/tasks` | 历史任务（v1.2 筛选与新增列） | MPC-OPS-05 | 改 |
| 79 | MPC | GET | `/projects/{project_id}/mpc/tasks/export` | 导出报表（v1.1，v1.2 由 reports/export 替代，保留兼容） | — | — |
| 80 | MPC | GET (SSE) | `/mpc/tasks/{task_id}/events` | SSE 推送（v1.2 metrics 事件含 summary） | MPC-OPS-01 至 04 | 改 |
| 81 | MPC | GET | `/mpc/protocols` | 协议与算子目录 | MPC-PROTO-01 至 04 | 新 |
| 82 | MPC | GET | `/projects/{project_id}/mpc/parties` | 参与方候选 | MPC-PROTO-05 | 新 |
| 83 | MPC | GET | `/projects/{project_id}/mpc/params` | 读取项目协议参数 | MPC-PROTO-06 | 新 |
| 84 | MPC | PUT | `/projects/{project_id}/mpc/params/{protocol}` | 保存协议参数 | MPC-PROTO-06 | 新 |
| 85 | MPC | DELETE | `/projects/{project_id}/mpc/params/{protocol}` | 恢复默认协议参数 | MPC-PROTO-06 | 新 |
| 86 | MPC | POST | `/projects/{project_id}/mpc/flows/dry-run` | 计算流程试运行 | MPC-PROTO-01 至 05 | 新 |
| 87 | MPC | GET | `/projects/{project_id}/mpc/tasks/compare` | 两任务对比 | MPC-OPS-05 | 新 |
| 88 | MPC | GET | `/projects/{project_id}/mpc/reports/export` | 导出报表（带筛选，CSV） | MPC-OPS-05 | 新 |
| 89 | PSI | GET | `/psi/protocols` | 协议 + 默认参数（v1.2 补参数规格与安全强度） | PSI-ALGO-01 / 02 | 改 |
| 90 | PSI | POST | `/projects/{project_id}/psi/templates` | 保存模板（v1.2 补校验） | PSI-ALGO-03 | 改 |
| 91 | PSI | GET | `/projects/{project_id}/psi/templates` | 模板列表（v1.2 含内置模板） | PSI-ALGO-03 | 改 |
| 92 | PSI | GET | `/psi/templates/{template_id}` | 加载模板 | PSI-ALGO-03 | — |
| 93 | PSI | DELETE | `/psi/templates/{template_id}` | 删除模板（v1.2 内置不可删） | PSI-ALGO-03 | 改 |
| 94 | PSI | POST | `/projects/{project_id}/psi/pipelines` | 启动流水线（v1.2 配置来源、参数校验、交集不足失败） | PSI-PIPE-01 / 02 | 改 |
| 95 | PSI | GET | `/psi/pipelines/{pipeline_id}` | 流水线详情（v1.2 完成后固化统计快照） | PSI-DATA-03、PSI-PIPE-02 | 改 |
| 96 | PSI | POST | `/psi/pipelines/{pipeline_id}/cancel` | 取消 / 重置 | — | — |
| 97 | PSI | GET | `/projects/{project_id}/psi/pipelines` | 流水线历史（v1.2 含 stats_snapshot_at） | PSI-DATA-03 | 改 |
| 98 | PSI | GET (SSE) | `/psi/pipelines/{pipeline_id}/events` | SSE 推送（v1.2 失败时也推 pipeline_finished） | PSI-PIPE-02 | 改 |
| 99 | 数据接入 | GET | `/psi/parties` | 参与方列表（v1.1） | — | — |
| 100 | 数据接入 | GET | `/projects/{project_id}/datasets` | 数据集列表（v1.1） | — | — |
| 101 | 数据接入 | POST | `/projects/{project_id}/datasets` | 接入数据集（v1.1；v1.2 文件来源可带 row_count / columns / sample_rows） | PSI-DATA-01 | 改 |
| 102 | 数据接入 | GET | `/datasets/{dataset_id}` | 数据集详情 + 脱敏样例（v1.1；v1.2 样例按文件真实前 3 行脱敏） | PSI-DATA-02 | 改 |
| 103 | 数据接入 | DELETE | `/datasets/{dataset_id}` | 删除数据集登记（v1.1；v1.2 删前固化已完成流水线快照） | PSI-DATA-03 | 改 |
| 104 | PSI | GET | `/projects/{project_id}/psi/config` | 读取当前求交配置 | PSI-ALGO-02 / 03 / 04、PSI-PIPE-01 | 新 |
| 105 | PSI | PUT | `/projects/{project_id}/psi/config` | 保存当前求交配置 | PSI-ALGO-02 / 03 / 04、PSI-PIPE-01 | 新 |
| 106 | PSI | POST | `/psi/route-advice` | 求交协议自适应路由 | PSI-ALGO-04 | 新 |
| 107 | PSI | GET | `/psi/benchmarks` | 典型场景性能参考 | PSI-ALGO-04 | 新 |
| 108 | DP | GET | `/fl/jobs/{job_id}/dp` | DP 配置（v1.2 补 accountant 等） | DP-MECH-02 | 改 |
| 109 | DP | PUT | `/fl/jobs/{job_id}/dp` | 更新 DP 配置 | DP-MECH-02 | 改 |
| 110 | DP | POST | `/dp/estimate` | 噪声 / 效用 / 曲线 / 直方图预估（v1.2 补 accountant） | DP-EVAL-01 / 02、DP-MECH-02 | 改 |
| 111 | DP | GET | `/fl/jobs/{job_id}/dp/budget` | 预算消耗（v1.2 按会计方式累计） | DP-EVAL-01、DP-FW-04 | 改 |
| 112 | DP | GET | `/fl/jobs/{job_id}/dp/audit` | 隐私审计记录（v1.2 limit=all、新字段） | DP-EVAL-03 | 改 |
| 113 | DP | GET | `/fl/jobs/{job_id}/dp/audit/export` | 导出审计记录 CSV | DP-EVAL-03 | 新 |
| 114 | DP | GET | `/dp/mechanisms` | 机制目录 | DP-MECH-01 | 新 |
| 115 | DP | POST | `/dp/tradeoff` | 效用-隐私平衡 | DP-EVAL-02 | 新 |
| 116 | DP | POST | `/dp/adaptive-noise` | 自适应噪声注入 | DP-MECH-03 | 新 |
| 117 | DP | GET | `/projects/{project_id}/dp/query-config` | 读取统计查询配置 | DP-MECH-02 / 03 | 新 |
| 118 | DP | PUT | `/projects/{project_id}/dp/query-config` | 保存统计查询配置 | DP-MECH-02 / 03 | 新 |
| 119 | DP | POST | `/projects/{project_id}/dp/query` | 发布统计查询结果 | DP-MECH-02 / 03 | 新 |
| 120 | DP | GET | `/projects/{project_id}/dp/queries` | 查询发布记录 | DP-MECH-02 / 03 | 新 |
| 121 | DP | POST | `/dp/compose` | 组合定理对比 | DP-MECH-04 | 新 |
| 122 | DP | POST | `/projects/{project_id}/dp/policies` | 创建 DP 策略 | DP-MECH-04、DP-FW-04 | 新 |
| 123 | DP | GET | `/projects/{project_id}/dp/policies` | 策略列表 | DP-MECH-04、DP-FW-04 | 新 |
| 124 | DP | POST | `/dp/policies/{policy_id}/apply` | 下发策略到任务 | DP-MECH-04、DP-FW-04 | 新 |
| 125 | DP | GET | `/dp/providers` | DP 实现与接口映射 | DP-FW-01 | 新 |
| 126 | DP | PUT | `/dp/provider` | 切换 DP 实现（按项目） | DP-FW-01 | 新 |
| 127 | DP | GET | `/fl/jobs/{job_id}/dp/hooks` | DP hook 链 | DP-FW-02 | 新 |
| 128 | DP | GET | `/fl/jobs/{job_id}/dp/metrics` | 框架内部 DP 指标 | DP-FW-03 | 新 |
| 129 | DP | POST | `/fl/jobs/{job_id}/dp/init-check` | DP 初始化检查 | DP-FW-04 | 新 |

---

## 11. 前端待接线清单

设计稿里以下控件目前没有真实逻辑，对接时需要前端补（「对接接口」列的编号对应第 10 节 v1.2 总表）：

| 控件 | 位置 | 现状 | 对接接口 |
|---|---|---|---|
| 添加节点 | FL · 参与方节点 | 按钮无点击事件 | 21 |
| 导出 CSV | FL · 收敛曲线 | 点击空操作 | 17 |
| 定位节点 | MPC · 告警条 | 按钮无点击事件 | 用 `alarms[].party_id` 高亮卡片或跳转节点详情 |
| 导出报表 | MPC · 历史任务 | 点击空操作 | 88（v1.2 前端用 reports/export；79 为 v1.1 旧接口） |
| 参数调优 | PSI · 左侧 | 只读展示，不可编辑 | 89 返回 `editable`，前端改为输入框 |
| 加载模板 | PSI · 左侧 | 只改提示文字，无模板选择 | 91 → 92 |
| 前往训练 | PSI · 完成提示 | 仅切到 FL 页 | 用 95 返回的 `fl_job_id` 定位任务 |
| 已完成迭代轮次 | DP · 左侧 | 可拖动滑块（演示） | 改为只读，值取 111 |
| 当前项目 | 顶栏下拉 | 切换后各模块数据不变 | 切换后重新拉取各模块数据 |

---

## 附录 A · v1.2 变更说明

### A.1 与 v1.1 的差异

各模块增补稿与 v1.1 不一致时一律以增补稿为准，下表逐条列出（「位置」为本文小节）。

| # | 变更项 | v1.1 | v1.2 | 位置 |
|---|---|---|---|---|
| 1 | MPC 异常判定规则 | 通信量 > 参与方均值 × 1.35 即 `abnormal`，阈值后端可配 | 通信量或计算耗时偏离全部参与方均值超过阈值（默认 50%，创建任务时用 `anomaly_threshold_pct` 配置，10%–200%），按偏离绝对值判定，执行满 5 个心跳后生效 | 4.3 |
| 2 | MPC 新增告警类型 | `comm_anomaly` / `node_offline` / `timeout` | 新增 `compute_anomaly`（计算耗时异常）；告警增加 `node_id`、`deviation_pct`、`threshold_pct`；参与方增加 `comm_deviation_pct` / `compute_deviation_pct` | 4.3、8 |
| 3 | MPC 报表导出 | `GET /projects/{id}/mpc/tasks/export`，`xlsx` / `csv` | 前端改用 `GET /projects/{id}/mpc/reports/export`（CSV，支持协议 / 时间 / `task_ids` 筛选，选 2 个任务时追加对比段）；旧接口保留兼容 | 4.6 |
| 4 | MPC 参与方与角色 | `parties` 至少 2 个，单值 `role` | 至少 3 个；`roles[]` 多角色，须覆盖输入方 / 计算方 / 输出方；流程含 ss / gc 时计算方至少 2 个；单值 `role` 仍兼容 | 4.2、4.8 |
| 5 | MPC 算子与流程 | 5 个算子，单步 `protocol + operator` | 7 个算子（新增 `secure_sum`、`secure_max`），支持 1–8 步计算流程 `steps[]`，逐步校验协议兼容与上下游类型；`protocol + operator` 旧调用仍可用 | 4.1、4.2、4.7、4.11 |
| 6 | MPC 任务控制状态校验 | `finished` 时 `start` 返回 40901 | 收紧为：`running` 时 `start`、非 `running` 时 `stop`、`finished` 时 `start`、只读历史任务 `reset` 均返回 40901；未知动作 40000 | 4.4 |
| 7 | MPC 性能预估 | `GET …/mpc/estimate`，`protocol` 必填，返回 4 个字段 | GET 增加 `steps` / `party_count` / `data_rows` / `bandwidth_mbps` / `rtt_ms`，`protocol` 在传 `steps` 时可省；新增 POST 形式（可带 `parties[]` 按角色计算输入分享），返回逐步明细、通信量、轮数、公式与采用的协议参数；输入分享通信量修正为 [I·(C−1)+I₀]·w·m（原为 n(n−1)·w·m） | 4.1、4.10 |
| 8 | MPC 任务详情与 SSE | `metrics` 事件只推 `parties[]` | 任务新增 `name` / `protocols` / `steps` / `estimate` / `anomaly_rule` / `summary` 等字段；`metrics` 事件改为 `{ parties, summary, progress_pct, alarms }` | 4.3、7.3 |
| 9 | MPC 历史列表 | 过滤 `status` / `protocol` / 结束时间，8 列 | 新增 `task_ids` 过滤；日期格式 `YYYY-MM-DD`；`items[]` 增加 `name` / `flow` / `data_rows` / `mean_comm_bytes` / `alarm_count` 等 | 4.5 |
| 10 | `PATCH /fl/jobs/{job_id}` 的适用范围 | §2.5 已限定 `Created` / `Terminated` / `Failed` | 保持不变并写明：`Running` / `Paused` 一律 40901；`algorithm` 只接受内置值与 `custom`，注册算法 / 自定义模型只能在创建任务时指定；响应不含 v1.2 新增字段 | 2.5、3.14 |
| 11 | Paillier 底层库 | 3.1 示例写 `python-paillier (phe)`，无库目录 | 底层库为 python-paillier (phe) 1.5，纳入 `/he/libraries` 方案-库支持矩阵；同一方案可配多库，项目默认配置 `ckks / seal / 4` | 3.1、3.8、3.9 |
| 12 | HE 方案范围 | `paillier` / `ckks` / `bgv` | 算法目录新增 `tfhe`（`/he/algorithms` 4 项，`/he/schemes` 仍为 3 项）；新增定点编码、运算验证、CKKS 参数寻优 | 3.7–3.12 |
| 13 | DP 默认会计方式 | 只有基础组合（ε_总 / T） | 新增 `accountant`：`basic` / `advanced` / `rdp`；任务级、`/dp/estimate`、`/dp/tradeoff` 默认均为 `rdp`；显式传 `basic` 时数值与 v1.1 逐位一致，v1.1 调用方不传该字段时现按 RDP 计算 | 6.0、6.1–6.3、6.7 |
| 14 | DP 配置 / 预算 / 审计字段 | 7 个配置字段；预算与审计按基础组合 | 配置增加 `accountant` / `clip_mode` / `apply_to` / `policy_id` / `policy_dimension`；预算增加 `accountant` / `delta_total` / `dp_active`，`epsilon_used` 按会计方式累计；审计增加累计 ε、噪声倍数、裁剪比例、信噪比、数据来源，`limit` 支持 `all`，新增 CSV 导出 | 6.1–6.5 |
| 15 | DP SSE 的 `dp` 字段 | `{ epsilon_spent, epsilon_used }` | 增加 `accountant`，累计值按会计方式 | 7.3 |
| 16 | FL 预估剩余时间 | `eta_sec` 为「平滑滤波预测」，无算法说明 | EMA：s₁ = d₁，sᵣ = 0.3·dᵣ + 0.7·sᵣ₋₁，ETA = sᵣ × 剩余轮次；`round_completed` 的 `eta_sec` / `elapsed_sec` 为同一平滑结果；新增 `GET /fl/jobs/{id}/eta` | 2.4、2.16.1、7.3 |
| 17 | 聚合密钥唯一性 | 无约定 | 同一项目同一时间只保留一把在用的 `fl_aggregation` 密钥（不区分方案）：生成新钥时其余在用聚合密钥标为 `rotated`，`rotate_reason = superseded`，响应附 `superseded_key_ids[]`；会话密钥不受影响 | 2.12.6、3.2 |
| 18 | 密钥状态与加密前检查 | 3.3 仅校验 `key_id` 已销毁或过期 40402 | 密钥状态 `active` / `rotated` / `destroyed`；`POST /he/encrypt` 先检查状态：已轮换 40901（只能解密历史密文），已销毁 40402；销毁后列表保留 `destroyed` 记录 | 3.3、3.6、3.13 |
| 19 | `POST /he/keys` | `scheme` / `project_id` / `key_params` | `project_id` 强制校验项目存在；新增 `purpose`（`session` / `fl_aggregation`）、`key_params.key_size_bits`（2048 / 3072 / 4096）、`node_ids`；响应增加状态、分发、轮换元数据 | 3.2 |
| 20 | 任务聚合公钥 | `GET /fl/jobs/{id}/he-public-key` 只返回任务自身密钥 | 同态聚合且项目有有效聚合密钥时返回项目密钥（附 `poly_modulus_degree` / `coeff_modulus_bits` / `source = project`），与聚合与安全页、同态应用集成页一致；CKKS 的 `key_size_bits` 取 log₂Q | 2.8 |
| 21 | 创建训练任务的默认值与算法来源 | `aggregation` 必填，`total_rounds` 默认 30，`algorithm` 限内置 + `custom` | `aggregation` 未传时取项目 `aggregation_default`，`total_rounds` 取项目配置；`algorithm` 可传 `alg_*` / `mdl_*`（映射为 `custom`）；新增 `params`、`template_id`，响应增加 `algo_ref` / `params` / `algo_ref_name` | 2.3、2.4 |
| 22 | 任务状态机与动作 | 状态迁移表 + 40901 | `start` / `resume` 前预检（项目、节点在册与在线、算法兼容）并分配容器，`pause` 保存断点、`resume` 从断点续训，`terminate` 以 SIGKILL 释放资源；任务新增 `allowed_actions` / `state_history` / `failure_reason` / `runtime` / `checkpoint` / `eta`；节点心跳丢失时 `Running` 任务转 `Failed` | 2.1、2.4、2.6 |
| 23 | 指标曲线与导出 | `from_round` / `to_round` 只列出，时间过滤未校验；项目 CSV「格式同上」 | 轮次与 `start_time` / `end_time` 生效并校验（40000 / 40002 / 40003）；单任务 CSV 时间范围生效；项目与跨项目 CSV 使用固定列 `project_id,job_id,task_type,round,series,loss,accuracy,rmse,mae,recorded_at`；新增 `GET /fl/metrics` 历史查询；聚合节点不产生本地指标，`scope=nodes` 与历史查询、CSV 只含训练节点 | 2.7、2.9、2.16.2 |
| 24 | 项目接口 | 只有 `GET /projects`（`project_id` / `name` / `type` / `created_at`） | `GET /projects` 增加描述、基准算法、聚合轮数、训练目标、节点 / 任务数、`aggregation_default`、`revision` 等并支持 `keyword`；新增项目创建、详情、修改、配置导出 | 1.3、1.5–1.7 |
| 25 | 节点 ID 唯一范围与节点校验 | `node_id` 全局唯一 | 项目内唯一（重复 40902），≤ 40 个字符；节点增加 `data_dir`（绝对路径）、`running_job_count`；添加节点校验 IP / 端口格式与连通性（文档保留网段 `192.0.2.0/24` 视为不可达，mock）；新增编辑节点（`online` 置离线）；被运行中任务使用时改 `node_id` / `role` / `data_partition` / `data_dir` 返回 40901 | 2.11 |
| 26 | 聚合策略归属 | 任务级 `aggregation` | 新增项目级聚合配置（秘密共享门限、同态参数、Top-k 稀疏化与量化）、通信量实时估算、聚合密钥对；保存的 `strategy` 成为任务编排页的默认聚合方式 | 2.12 |
| 27 | 技术指标评估 | 无 | 新增梯度反演攻击（成功率 ≤ 5%）、通信压缩比（≥ 6 倍）、精度对比（下降 ≤ 3 个百分点）三类异步评估，SSE 推送进度，可导出 CSV | 2.13、7 |
| 28 | 数据隔离、算法库、参数模板 | 无 | 新增数据隔离视图与检测、算法库（内置 5 个 + 注册 + 自定义模型、版本回滚）、参数模板 | 2.14、2.15 |
| 29 | PSI 协议参数规格 | `params[]` 只有 `key` / `label` / `value` / `display` / `editable` | 增加 `type` / `options` / `min` / `max` / `step` / `unit` / `hint` 与 `security.*`（三种协议均 128 位计算安全）；参数校验统一：未知键 40000，类型错 40002，越界 / 枚举外 40003 | 5.1 |
| 30 | PSI 参数模板 | 保存 / 列表 / 加载 / 删除，无校验细节 | 首次访问项目播种 2 个内置模板（`builtin`，不可删，删除 40901）；`name` 去空格后必填、≤ 40 字、同项目重名 40902；`params` 补全默认值；当前配置引用被删模板时 `template_id` 置空、`source` 改 `manual` | 5.2 |
| 31 | PSI 当前配置、自适应路由、基准 | 无 | 新增项目「当前求交配置」（`source`：`default` / `manual` / `template` / `route_advice`）、协议自适应路由（规模比 > 100 : 1 推荐非平衡 PSI 等）、典型场景性能参考；流水线配置来源可取当前配置或模板 | 5.3、5.7–5.9 |
| 32 | DP 新增能力 | 无 | 新增机制目录、效用-隐私平衡、自适应噪声（字段 / 梯度两种模式）、统计查询配置与发布、组合定理对比、策略编排与下发、框架实现切换、hook 链、框架内部指标、初始化检查 | 6.6–6.11 |
| 33 | 错误码适用范围 | 见 v1.1 第 9 节 | 不新增业务码，扩展 40000 / 40001 / 40002 / 40003 / 40400 / 40402 / 40901 / 40902 / 42201 的适用场景；校验错误在 `data.field` 给出出错字段 | 0.7、9 |
| 34 | 接口总表与枚举 | 52 个接口；`MpcOperator` 5 项、`HeScheme` 3 项 | 129 个接口（新增 77 个）并全部重新编号；第 8 节补充 v1.2 新增枚举；第 11 节接口编号同步更新 | 8、10、11 |
| 35 | 导出文件时间格式 | 未规定 | 项目配置 JSON、指标 CSV、评估报告、HE 性能日志、MPC 报表、DP 审计 CSV 的时间统一写成 `YYYY-MM-DD HH:mm:ss +08:00`（内核 `k.fmtLocal`），CSV 时间列名注明 `(UTC+8)`，项目配置 JSON 另带 `"timezone": "UTC+8"`；接口 JSON 中的时间仍为 ISO 8601 | 1.7、2.13.5、2.16.2、3.16、4.6、6.5 |
| 36 | 模型参数量口径 | 各模块各自估算 | 统一取内核 `MODEL_PARAMS`：lr 69、xgb 2,176、cnn 61,706、lstm 203,143、tcn 37,959、custom 20,000；聚合估算、隔离审计、HE 日志、DP 指标共用 | 2.12.5、2.14.2、3.16、6.11 |
| 37 | 节点 IP 校验 | 只要求合法 IPv4 / IPv6 | 特殊地址一律 40002（0.0.0.0、255.255.255.255、回环、组播、保留段、按 /24 的网络与广播地址、`::` 等），message 说明原因 | 2.11.2 |
| 38 | 数据隔离传输审计 | 无 | 梯度 / 全局参数元素数 = ⌈ρ × P⌉（ρ 取项目 Top-k 配置），`wire_bytes` 与聚合与安全页同一套公式；`payload_forbidden` 增加求交键与企业标识（`credit_code_hash`、`legal_person_hash` 等） | 2.14 |
| 39 | HE 四步流程耗时与日志 | 3.3–3.5 各自给出耗时 | `encrypt` / `evaluate` / `decrypt` 改用统一耗时模型；会话密钥逐步记账，解密完成后写性能日志（来源 `session`），`session_summary` 为实际记账之和；训练任务日志的条数与耗时按 Top-k 保留比例与批打包计算 | 3.5、3.16 |
| 40 | 聚合与安全页的密钥播种 | 无 | `GET …/aggregation`、`…/keys`、`…/public-key`、`PUT …/aggregation`、`POST …/reset` 读取项目密钥前先让同态模块播种聚合密钥；`GET /fl/jobs/{id}/he-public-key` 不触发播种，保证与任务详情一致；无在用密钥时 `…/public-key` 返回 40402 | 2.12.6 |
| 41 | 压缩比评估的 `field_bits` | 下限 `quant_bits` + 2 | 下限为 max(16, `quant_bits` + ⌈log₂n⌉)（n = 3），与聚合配置同一约束 | 2.13.1 |
| 42 | PSI 数据接入 | 文件来源只登记名称与来源 | 文件来源可带 `row_count` / `columns[]` / `sample_rows`（浏览器解析 CSV），未带时按文件大小 ÷ 64 估算行数；`preview[]` 按来源给出真实前 3 行脱敏值或说明；求交键哈希前缀展示 | 5.0.3、5.0.4 |
| 43 | PSI 流水线失败与快照 | 只有成功路径 | 求交结果少于 100 条时流水线 `failed`，后续阶段 `skipped`，不生成训练任务，SSE 失败时也推 `pipeline_finished`；完成后统计固化为快照并返回 `stats_snapshot_at`，删除数据集前先为已完成流水线生成快照；流水线启动按 5.1 规格校验参数 | 5.3、5.4、7.3 |
| 44 | DP 实现按项目选用 | `provider` 为平台全局 | `GET /dp/providers?project_id=`，`PUT /dp/provider` 须带 `project_id`，只改该项目待启动 / 失败 / 已终止任务，运行中与已完成任务保留原实现 | 6.11 |
| 45 | DP 预估与平衡的时序效用 | 只有分类 Accuracy | `/dp/estimate` 增加 `task_type` / `primary_metric` / `metrics[]` / `curve[].estimated_rmse`；`/dp/tradeoff` 增加 `baseline_job_id` / `task_type` / `max_metric_increase_pct` 与 `metric` / `rule`；时序效用 = 基线 ×（1 + 1.2·e^(−ε_eq/2.2)）；梯度模式增加 `fixed_clip_norm` 等 | 6.0、6.3、6.7、6.8 |
| 46 | MPC 参与方状态与报表 | 报表列固定 | 参与方 `status` 跟随任务（`abnormal` 优先）；报表协议与状态用中文，时间列 `(UTC+8)`，带 `task_ids` 时明细按请求顺序，恰为 2 个时追加对比段 | 4.3、4.6 |
| 47 | 校验提示文案 | 未规定 | 参数 schema 不是合法 JSON 时 message 给出中文原因与行列号；指标查询错误提示使用界面中文字段名 | 2.7、2.15.2 |

### A.2 增补稿之间的不一致与待确认项

下列问题来自各模块增补稿彼此之间或与 v1.1 之间的不一致。状态为「已解决」的在本轮增补稿中已统一，文中以统一后的口径为准。

| # | 问题 | 涉及模块 | 状态 | 处理 |
|---|---|---|---|---|
| 1 | DP 会计方式默认值不统一：任务默认 `rdp`，`/dp/estimate`、`/dp/tradeoff` 默认 `basic` | dp | 已解决 | 三处默认均为 `rdp`，显式传 `basic` 与 v1.1 一致 |
| 2 | 密钥 `rotate_reason` 响应字段只列了 `manual` / `auto`，正文却写入 `superseded` | he | 待确认 | 枚举 `HeRotateReason` 已补入 `superseded` |
| 3 | 同一算法在不同模块的参数量口径不同 | fed-sec、he、dp | 已解决 | 统一为内核 `MODEL_PARAMS`，见 A.1 第 36 条 |
| 4 | 节点 ID 唯一范围：v1.1 写「全局唯一」，任务编排为项目内唯一 | fed-orch | 已按增补稿处理 | 以项目内唯一为准 |
| 5 | 项目 CSV 导出：v1.1 写「参数与响应格式同上」，历史指标增补另定固定列 | fed-orch | 已按增补稿处理 | 以固定列为准，v1.1 描述已改 |
| 6 | MPC 报表：v1.1 支持 `xlsx` / `csv`（默认 `xlsx`），新接口只描述 CSV | mpc | 待确认 | 新接口只写 CSV，`xlsx` 仅旧接口保留 |
| 7 | MPC 告警口径：`ratio_to_mean` 与 `deviation_pct` 并存，偏低一方是否判异常 | mpc | 已解决 | 判定依据为 `deviation_pct`（偏离绝对值，通信量与计算耗时分别判定），`ratio_to_mean` 保留为兼容字段 |
| 8 | 注册算法 / 自定义模型只能在创建任务时选用，`PATCH /fl/jobs/{id}` 不接受它们的 `algo_id` | fed-orch、he | 待确认 | 在 2.5 写明 |
| 9 | 项目聚合配置的 `ss.threshold` / `ss.parties` 与任务详情 `aggregation_info.threshold` / `share_count` 的取值关系未说明 | fed-sec、v1.1 | 待确认 | 保留各自定义 |
| 10 | 压缩比评估 `field_bits` 下限与聚合配置不一致 | fed-sec | 已解决 | 统一为 max(16, `quant_bits` + ⌈log₂n⌉)，见 A.1 第 41 条 |
| 11 | 聚合与安全页与同态页首次进入的先后影响所见密钥 | fed-sec、he | 已解决 | 聚合与安全页读取前先让同态模块播种，见 A.1 第 40 条 |

---

## 附录 B · v1.2 项目与算法库落库语义

任务编排页的 mock 存在浏览器内存 `k.db.flo`，真后端按下表落库（表结构语义，字段名以实现为准）：

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
