# 隐私计算平台控制台 · 后端接口文档

> 版本：v1.1（草案） · 日期：2026-10-20
> v1.1 变更：联邦学习新增任务类型（分类 / 时序预测）、任务列表与新建任务；隐私求交新增数据接入（数据集登记）；见各节「v1.1」标注与 [10. 接口总表](#10-接口总表) #47–#52
> 依据：前端设计稿 `隐私计算平台控制台演示 – 控制台演示 · 五大模块（可操作）.html`
> 范围：控制台全部五个模块（联邦学习 / 同态加密 / 多方安全计算 / 隐私求交 / 差分隐私）+ 公共接口

当前前端所有数值都是本地模拟（`setInterval` + 公式）。本文档定义把模拟替换成真实后端所需的全部接口。每个接口都标注了它对应的前端控件或展示字段。

---

## 目录

0. [通用约定](#0-通用约定)
1. [公共接口（用户 / 项目）](#1-公共接口)
2. [联邦学习 FL](#2-联邦学习-fl)
3. [同态加密 HE](#3-同态加密-he)
4. [多方安全计算 MPC](#4-多方安全计算-mpc)
5. [隐私求交 PSI](#5-隐私求交-psi)（含 v1.1 数据接入）
6. [差分隐私 DP](#6-差分隐私-dp)
7. [实时推送（SSE）](#7-实时推送sse)
8. [枚举汇总](#8-枚举汇总)
9. [错误码](#9-错误码)
10. [接口总表](#10-接口总表)
11. [前端待接线清单](#11-前端待接线清单)

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

---

## 2. 联邦学习 FL

页面：「联邦学习 / 过程管控 — 训练任务监控」

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
| `algorithm` | string | 是 | | 必须在该任务类型的 `algorithms` 内：分类 `lr` / `xgb` / `cnn` / `custom`；时序 `lstm` / `tcn` / `custom` |
| `model_file_id` | string | 条件 | | `algorithm = custom` 时必填，来自 [1.4](#14-文件上传) |
| `aggregation` | string | 是 | | `ss` 秘密共享聚合 / `he` 同态加密聚合，对应「聚合策略」下拉 |
| `total_rounds` | int | 否 | 30 | 聚合总轮次，1–200 |
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
| `eta_sec` | number \| null | 预估剩余时长（平滑滤波预测），未开始为 null | 「预估剩余时间」 |
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

参数与响应格式同上。

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

### 2.11 项目节点管理

对应：「添加节点」按钮（前端尚未接线，见 [第 11 节](#11-前端待接线清单)）。

**列出项目下可用节点**

```
GET /projects/{project_id}/nodes
```

响应 `data.items[]`：`node_id`、`ip`、`port`、`role`、`role_label`、`data_partition`、`online`(bool)、`last_heartbeat_at`。

**添加节点**

```
POST /projects/{project_id}/nodes
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `node_id` | string | 是 | 全局唯一，小写字母、数字、`-` |
| `ip` | string | 是 | IPv4 / IPv6 |
| `port` | int | 是 | 1–65535 |
| `role` | string | 是 | `trainer` / `aggregator` |
| `data_partition` | string | 条件 | `role = trainer` 时必填 |
| `data_dir` | string | 否 | 节点本地数据目录（节点只访问该目录） |

```json
{ "node_id": "node-beijing-03", "ip": "10.40.3.9", "port": 8471, "role": "trainer", "data_partition": "part-C", "data_dir": "/data/fl/part-c" }
```

响应 `data`：新节点对象。后端应做连通性检查，不可达时返回 `42201`。

**删除节点**

```
DELETE /projects/{project_id}/nodes/{node_id}
```

节点正被运行中任务使用时返回 `40901`。

---

## 3. 同态加密 HE

页面：「同态加密 / 应用集成 — 加密 — 计算 — 解密 全流程」

流程 4 步：① 生成密钥对 → ② 加密 → ③ 密态运算 → ④ 解密。私钥始终留在平台密钥服务，接口只传 `key_id`。

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
| `library` | string | 例 `Pyfhel (Paillier)` |
| `input_type` | string | `integer`（需定点化）/ `float` / `integer_exact` |
| `supported_ops` | string[] | 见下 |
| `key_params` | object | 密钥参数说明 |

`supported_ops` 取值：`add_ct_ct` 密文+密文、`mul_ct_pt` 密文×明文、`mul_ct_ct` 密文×密文。

```json
{
  "items": [
    { "scheme": "paillier", "name": "Paillier", "description": "半同态 · 整数加、数乘", "library": "Pyfhel (Paillier)", "input_type": "integer", "supported_ops": ["add_ct_ct", "mul_ct_pt"], "key_params": { "key_size_bits": 2048 } },
    { "scheme": "ckks", "name": "CKKS", "description": "全同态 · 浮点近似计算", "library": "SEAL TenSEAL (CKKS)", "input_type": "float", "supported_ops": ["add_ct_ct", "mul_ct_ct", "mul_ct_pt"], "key_params": { "poly_modulus_degree": 8192 } },
    { "scheme": "bgv", "name": "BGV", "description": "全同态 · 整数精确计算", "library": "SEAL (BGV)", "input_type": "integer_exact", "supported_ops": ["add_ct_ct", "mul_ct_ct", "mul_ct_pt"], "key_params": { "poly_modulus_degree": 8192 } }
  ]
}
```

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

### 3.6 重置 / 销毁密钥

对应：「重置」按钮。切换算法、修改明文、修改精度时，前端也会回到第 0 步，建议同时调用。

```
DELETE /he/keys/{key_id}
```

删除该密钥及其下所有密文。响应 `data`：`{ "key_id": "hek_5c2e", "destroyed": true }`。

---

## 4. 多方安全计算 MPC

页面：「多方安全计算 / 运维监控 — 协议执行监控」

### 4.1 协议列表 + 性能预估

对应：「协议」下拉、「性能预估」条（参与方、数据规模、预估计算耗时、预估通信耗时、当前算子）。

```
GET /projects/{project_id}/mpc/estimate
```

Query：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | `ss` 秘密共享 / `gc` 混淆电路 / `ot` 不经意传输扩展 |
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

算子取值（`MpcOperator`）：

| 协议 | 算子 key | 名称 |
|---|---|---|
| `ss` | `secure_product` / `secure_mean` | 安全求积 / 安全求均值 |
| `gc` | `secure_compare` / `logic_op` | 安全比较 / 逻辑运算 |
| `ot` | `vector_ot` | 向量 OT |

### 4.2 创建 MPC 任务

对应：「开始执行」按钮（首次点击）。

```
POST /projects/{project_id}/mpc/tasks
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | `ss` / `gc` / `ot` |
| `operator` | string | 是 | 见 4.1 算子表 |
| `parties` | array | 是 | 参与方，至少 2 个 |
| `parties[].party_id` | string | 是 | |
| `parties[].role` | string | 是 | `input` 输入方 / `compute` 计算方 / `output` 输出方 |
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
| `alarms[].type` | string | `comm_anomaly` 通信量异常 / `node_offline` / `timeout` |
| `alarms[].party_id` | string | 告警参与方（「定位节点」按钮用） |
| `alarms[].ratio_to_mean` | number \| null | 通信量 / 三方均值，例 2.1 |
| `alarms[].message` | string | 告警文案 |
| `alarms[].raised_at` | string | |
| `started_at` | string \| null | |
| `finished_at` | string \| null | |

**异常判定规则**（与前端现有逻辑一致，建议后端采用）：执行 5 个 tick 之后，某参与方 `comm_bytes > 所有参与方均值 × 1.35` 即判为 `abnormal` 并产生 `comm_anomaly` 告警。阈值 `1.35` 做成后端可配置项。

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

### 4.6 导出报表

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

---

## 5. 隐私求交 PSI

页面：「隐私求交 / 平台集成 — 安全求交 → 特征对齐 → 联合训练」

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
| `source` | object | 是 | `file`：`{ "file_id", "file_name" }`，`file_id` 来自 [1.4](#14-文件上传)（`purpose = dataset`）<br>`database`：`{ "jdbc_url", "table" }`，`jdbc_url` 以 `jdbc:mysql|postgresql|oracle|hive2://` 开头<br>`hdfs`：`{ "path" }`，以 `hdfs://` 开头 |
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

#### 5.0.4 数据集详情

对应：列表「详情」按钮展开的字段与脱敏样例。

```
GET /datasets/{dataset_id}
```

响应 `data`：同 5.0.2 单项，另加 `preview[]`：前 3 行、前 6 列样例。求交键只给哈希前缀（例 `f7f1c3…`），字符串类特征列打码 `***`，数值列给归一化值。`ready` 之前 `preview = []`。

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

---

## 6. 差分隐私 DP

页面：「差分隐私 / 效果评估 — 隐私预算与模型效用」

DP 作用于联邦学习任务：梯度聚合前自动加噪。配置挂在 FL 任务上。

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

---

## 7. 实时推送（SSE）

长任务用 Server-Sent Events 推送增量。前端用 `EventSource`（需要带 token 时用 `?access_token=` 或 fetch-based SSE 库）。

### 7.1 端点

| 端点 | 用途 |
|---|---|
| `GET /fl/jobs/{job_id}/events` | 联邦训练：状态变化、每轮指标、节点上传 |
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
| FL | `round_completed` | `{ "job_id", "round", "global_metrics": { "<key>": number }, "global_loss", "global_accuracy", "node_metrics": [{ "node_id", "<key>": number, "upload_kb" }], "elapsed_sec", "eta_sec", "dp": { "epsilon_spent", "epsilon_used" } }`；`<key>` 为任务 `metrics_spec[].key`，`global_loss` / `global_accuracy` 为兼容字段，非分类任务为 null（v1.1） |
| FL | `node_status_changed` | `{ "node_id", "status" }` |
| FL | `job_failed` | `{ "job_id", "reason" }` |
| MPC | `metrics` | 同 [4.3](#43-获取任务详情实时监控) 的 `parties[]`，推送频率 ≤ 2 次/秒 |
| MPC | `alarm_raised` | 同 4.3 `alarms[]` 单条 |
| MPC | `status_changed` | `{ "task_id", "status" }` |
| PSI | `stage_progress` | `{ "stage", "status", "progress_pct", "duration_sec", "stats" }` |
| PSI | `pipeline_finished` | `{ "pipeline_id", "status", "fl_job_id", "target_project" }` |

示例：

```
event: round_completed
id: 12
data: {"job_id":"fl_20260922_01","round":12,"global_loss":0.3171,"global_accuracy":0.8423,"node_metrics":[{"node_id":"node-shanghai-01","loss":0.3671,"accuracy":0.8123,"upload_kb":151.4}],"elapsed_sec":50.4,"eta_sec":75.6,"dp":{"epsilon_spent":0.0667,"epsilon_used":0.8}}

```

---

## 8. 枚举汇总

| 枚举 | 取值 |
|---|---|
| `ProjectType` | `production` / `pilot` / `sandbox` |
| `FlJobStatus` | `Created` / `Running` / `Paused` / `Success` / `Failed` / `Terminated` |
| `FlTaskType` | `classification` 分类 / `timeseries` 时序预测（v1.1） |
| `FlAlgorithm` | `lr` 逻辑回归 / `xgb` XGBoost / `cnn` CNN / `lstm` LSTM / `tcn` TCN / `custom` 自定义上传模型（`lstm`、`tcn` v1.1，仅时序） |
| `FlMetricKey` | 分类 `loss` / `accuracy`；时序 `rmse` / `mae`（v1.1） |
| `FlAggregation` | `ss` 秘密共享聚合 / `he` 同态加密聚合 |
| `FlNodeRole` | `trainer` 训练节点 / `aggregator` 聚合节点 |
| `FlNodeStatus` | `pending` / `uploading` / `suspended` / `completed` / `released` / `offline` |
| `FlMetricScope` | `global` / `nodes` |
| `HeScheme` | `paillier` / `ckks` / `bgv` |
| `HeOp` | `add` / `mul` |
| `MpcProtocol` | `ss` 秘密共享 / `gc` 混淆电路 / `ot` 不经意传输扩展 |
| `MpcOperator` | `secure_product` / `secure_mean` / `secure_compare` / `logic_op` / `vector_ot` |
| `MpcPartyRole` | `input` / `compute` / `output` |
| `MpcTaskStatus` | `pending` / `running` / `stopped` / `finished` / `failed` |
| `MpcPartyStatus` | `pending` / `running` / `finished` / `abnormal` |
| `MpcAlarmType` | `comm_anomaly` / `node_offline` / `timeout` |
| `FilePurpose` | `fl_model` / `dataset`（v1.1） |
| `DatasetSourceType` | `file` / `database` / `hdfs`（v1.1） |
| `DatasetStatus` | `importing` / `ready` / `failed`（v1.1） |
| `PsiProtocol` | `ecdh` / `kkrt` / `unbalanced` |
| `PsiStage` | `intersect` / `align` / `train` |
| `PsiStageStatus` | `pending` / `running` / `finished` / `failed` / `skipped` |
| `PsiPipelineStatus` | `pending` / `running` / `finished` / `failed` / `canceled` |
| `DpMechanism` | `gaussian` / `laplace` |
| `DpDelta` | `1e-4` / `1e-5` / `1e-6` |

> 注意：前端设计稿内部用 `unbal`、`gauss`、`lap` 作为状态值，对接时前端需映射为 `unbalanced`、`gaussian`、`laplace`。

---

## 9. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | 40000 | 请求参数格式错误 |
| 400 | 40001 | 该加密方案不支持此运算（如 Paillier 密文乘密文） |
| 400 | 40002 | 数值不合法 |
| 400 | 40003 | 参数超出允许范围 |
| 401 | 40100 | 未登录或 token 失效 |
| 403 | 40300 | 无权访问该项目 / 资源 |
| 404 | 40400 | 资源不存在 |
| 404 | 40402 | 密钥不存在、已销毁或已过期 |
| 409 | 40901 | 当前状态不允许该操作 |
| 409 | 40902 | 资源已存在（如节点 ID 重复） |
| 422 | 42201 | 节点连通性检查失败 |
| 422 | 42202 | 隐私预算已耗尽 |
| 429 | 42900 | 请求过于频繁 |
| 500 | 50000 | 服务内部错误 |
| 502 | 50201 | 计算引擎 / 节点通信失败 |
| 504 | 50401 | 计算引擎超时 |

---

## 10. 接口总表

| # | 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|---|
| 1 | 公共 | GET | `/me` | 当前用户 |
| 2 | 公共 | GET | `/platform/info` | 平台名称、环境 |
| 3 | 公共 | GET | `/projects` | 项目列表 |
| 4 | 公共 | POST | `/files` | 文件上传 |
| 5 | FL | GET | `/projects/{project_id}/fl/jobs` | 训练任务列表（v1.1 支持 `task_type` 过滤） |
| 6 | FL | POST | `/projects/{project_id}/fl/jobs` | 创建训练任务 |
| 7 | FL | GET | `/fl/jobs/{job_id}` | 任务详情 |
| 8 | FL | PATCH | `/fl/jobs/{job_id}` | 修改算法 / 聚合策略 |
| 9 | FL | POST | `/fl/jobs/{job_id}/actions` | 启动 / 暂停 / 恢复 / 终止 / 重置 |
| 10 | FL | GET | `/fl/jobs/{job_id}/metrics` | 收敛曲线数据 |
| 11 | FL | GET | `/fl/jobs/{job_id}/he-public-key` | 查看聚合公钥 |
| 12 | FL | GET | `/fl/jobs/{job_id}/metrics/export` | 导出任务指标 CSV |
| 13 | FL | GET | `/projects/{project_id}/fl/metrics/export` | 按项目导出 CSV |
| 14 | FL | GET | `/fl/jobs/{job_id}/nodes` | 任务参与节点 |
| 15 | FL | GET | `/projects/{project_id}/nodes` | 项目节点列表 |
| 16 | FL | POST | `/projects/{project_id}/nodes` | 添加节点 |
| 17 | FL | DELETE | `/projects/{project_id}/nodes/{node_id}` | 删除节点 |
| 18 | FL | GET | `/fl/jobs/{job_id}/events` | SSE 推送 |
| 19 | HE | GET | `/he/schemes` | 加密方案列表 |
| 20 | HE | POST | `/he/keys` | ① 生成密钥对 |
| 21 | HE | POST | `/he/encrypt` | ② 加密 |
| 22 | HE | POST | `/he/evaluate` | ③ 密态运算 |
| 23 | HE | POST | `/he/decrypt` | ④ 解密 + 校验 |
| 24 | HE | DELETE | `/he/keys/{key_id}` | 重置 / 销毁密钥 |
| 25 | MPC | GET | `/projects/{project_id}/mpc/estimate` | 协议算子 + 性能预估 |
| 26 | MPC | POST | `/projects/{project_id}/mpc/tasks` | 创建任务 |
| 27 | MPC | GET | `/mpc/tasks/{task_id}` | 实时监控详情 |
| 28 | MPC | POST | `/mpc/tasks/{task_id}/actions` | 开始 / 停止 / 重置 |
| 29 | MPC | GET | `/projects/{project_id}/mpc/tasks` | 历史任务 |
| 30 | MPC | GET | `/projects/{project_id}/mpc/tasks/export` | 导出报表 |
| 31 | MPC | GET | `/mpc/tasks/{task_id}/events` | SSE 推送 |
| 32 | PSI | GET | `/psi/protocols` | 协议 + 默认参数 |
| 33 | PSI | POST | `/projects/{project_id}/psi/templates` | 保存模板 |
| 34 | PSI | GET | `/projects/{project_id}/psi/templates` | 模板列表 |
| 35 | PSI | GET | `/psi/templates/{template_id}` | 加载模板 |
| 36 | PSI | DELETE | `/psi/templates/{template_id}` | 删除模板 |
| 37 | PSI | POST | `/projects/{project_id}/psi/pipelines` | 启动流水线 |
| 38 | PSI | GET | `/psi/pipelines/{pipeline_id}` | 流水线详情 |
| 39 | PSI | POST | `/psi/pipelines/{pipeline_id}/cancel` | 取消 / 重置 |
| 40 | PSI | GET | `/projects/{project_id}/psi/pipelines` | 流水线历史 |
| 41 | PSI | GET | `/psi/pipelines/{pipeline_id}/events` | SSE 推送 |
| 42 | DP | GET | `/fl/jobs/{job_id}/dp` | DP 配置 |
| 43 | DP | PUT | `/fl/jobs/{job_id}/dp` | 更新 DP 配置 |
| 44 | DP | POST | `/dp/estimate` | 噪声 / 效用 / 曲线 / 直方图预估 |
| 45 | DP | GET | `/fl/jobs/{job_id}/dp/budget` | 预算消耗 |
| 46 | DP | GET | `/fl/jobs/{job_id}/dp/audit` | 隐私审计记录 |
| 47 | FL | GET | `/fl/task-types` | 任务类型目录（v1.1） |
| 48 | 数据接入 | GET | `/psi/parties` | 参与方列表（v1.1） |
| 49 | 数据接入 | GET | `/projects/{project_id}/datasets` | 数据集列表（v1.1） |
| 50 | 数据接入 | POST | `/projects/{project_id}/datasets` | 接入数据集（v1.1） |
| 51 | 数据接入 | GET | `/datasets/{dataset_id}` | 数据集详情 + 脱敏样例（v1.1） |
| 52 | 数据接入 | DELETE | `/datasets/{dataset_id}` | 删除数据集登记（v1.1） |

---

## 11. 前端待接线清单

设计稿里以下控件目前没有真实逻辑，对接时需要前端补：

| 控件 | 位置 | 现状 | 对接接口 |
|---|---|---|---|
| 添加节点 | FL · 参与方节点 | 按钮无点击事件 | 16 |
| 导出 CSV | FL · 收敛曲线 | 点击空操作 | 12 |
| 定位节点 | MPC · 告警条 | 按钮无点击事件 | 用 `alarms[].party_id` 高亮卡片或跳转节点详情 |
| 导出报表 | MPC · 历史任务 | 点击空操作 | 30 |
| 参数调优 | PSI · 左侧 | 只读展示，不可编辑 | 32 返回 `editable`，前端改为输入框 |
| 加载模板 | PSI · 左侧 | 只改提示文字，无模板选择 | 34 → 35 |
| 前往训练 | PSI · 完成提示 | 仅切到 FL 页 | 用 38 返回的 `fl_job_id` 定位任务 |
| 已完成迭代轮次 | DP · 左侧 | 可拖动滑块（演示） | 改为只读，值取 45 |
| 当前项目 | 顶栏下拉 | 切换后各模块数据不变 | 切换后重新拉取各模块数据 |
