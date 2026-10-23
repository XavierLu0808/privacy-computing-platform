## 5. 隐私求交 PSI（v1.2 增补）

v1.2 起隐私求交拆为三个二级页面：数据接入 `#/psi/data`、算法配置 `#/psi/algo`、平台集成 `#/psi/pipe`。本片段只写 v1.2 新增或升级的接口；数据接入（5.0）、模板读取 / 删除、流水线（5.3–5.6）的请求体与响应沿用 API.md §5 原文，下面只补差异。

协议与参数只在算法配置页维护，保存为项目的「当前配置」（5.7）。平台集成页读取当前配置或某个已保存模板来启动流水线。

### 5.0.3 接入数据集（v1.2 差异，缺陷 D13）

验收编号：PSI-DATA-01。`POST /projects/{project_id}/datasets` 在 API.md 5.0.3 基础上，`source_type = file` 时可多传两个字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `row_count` | int | 否 | 前端解析文件得到的数据行数（CSV：非空行数 − 1 行表头），≥ 0 |
| `columns[]` | array | 与 `row_count` 同传 | `{ name, type }`，`name` 符合 `[A-Za-z_][A-Za-z0-9_]*` 且不重复，`type` 为 `string` / `int` / `float` / `date` |

- 前端对 `.csv` 且 ≤ 256 MB 的文件在浏览器内读取：首行为表头，按前 200 行推断类型（全整数 `int`、全数值 `float`、`YYYY-MM-DD` 或 `YYYY/MM/DD` 开头 `date`，其余 `string`）；提交时求交键列强制 `string`、时间列强制 `date`。表头列名不合法或重复时不上传，弹窗内提示。
- 传了 `row_count` / `columns`：求交键列、时间列须在 `columns` 内，否则 `40000`；`row_count` 非非负整数、`columns` 格式不对 `40002`。数据集按提交值登记，`source.row_count_basis = "parsed"`。
- 未传（Parquet、超大 CSV）：行数 = round(文件字节数 ÷ 64)，`source.row_count_basis = "size_estimate"`，界面行数显示「约 N（估算）」，详情注明「按文件大小 ÷ 64 字节 / 行估算」。
- 文件来源的 `source` 另带 `file_name`、`size_bytes`。真实后端应以服务端解析结果为准，可用前端值做一致性复核。

### 5.4 流水线详情（v1.2 差异，缺陷 D14）

验收编号：PSI-DATA-03、PSI-PIPE-02。流水线 `finished` 后，`stages[].stats`（两方行数、交集条数、对齐条数与特征维度）与 `parties[].dataset_name` 固化为快照，不再随数据集变化；`GET /psi/pipelines/{pipeline_id}` 与 `GET /projects/{project_id}/psi/pipelines` 多返回 `stats_snapshot_at`（快照时间，未完成时无此字段）。`DELETE /datasets/{dataset_id}` 删除前先为引用它的已完成流水线生成快照；被运行中流水线引用时仍返回 `40901`。

### 5.1 协议列表与默认参数（v1.2 升级）

验收编号：PSI-ALGO-01、PSI-ALGO-02。对应：算法配置页「PSI 协议」三张单选卡、安全强度说明框、「参数调优」各控件；平台集成页「求交配置」摘要。

```
GET /psi/protocols
```

在 v1.1 字段基础上增加：

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

### 参数校验规则（5.2 / 5.7 共用）

- 未传的参数取协议默认值；传了协议没有的键 → `40000`。
- `bool` 非布尔、数值非数字、`int` 非整数 → `40002`。
- 数值越界、`enum` 不在选项内 → `40003`。
- 未知协议 → `40000`。

### 5.2 参数模板（v1.2 升级）

验收编号：PSI-ALGO-03。对应：算法配置页「配置模板」卡（名称输入框 +「保存为模板」、模板列表的「加载」「删除」）；平台集成页「配置来源」下拉。

**模板列表** `GET /projects/{project_id}/psi/templates?protocol=`

- 首次访问项目时播种 2 个内置模板（`builtin = true`）：`tpl_{project_id}_wan_ecdh`「跨机构专线 · ECDH 大分块」、`tpl_{project_id}_lan_kkrt`「同机房百万级 · KKRT 默认」。
- `items[]` 按 `created_at` 倒序（最新在前），每项多一个字段 `builtin`。

**保存模板** `POST /projects/{project_id}/psi/templates`

请求体同 API.md 5.2。新增校验：`name` 去首尾空格后必填 `40000`、不超过 40 字 `40003`、同项目重名 `40902`；`params` 按上方参数校验规则，响应里的 `params` 是补全默认值后的完整参数。

**删除模板** `DELETE /psi/templates/{template_id}`

内置模板 → `40901`；不存在 → `40400`。若某项目当前配置引用了该模板，当前配置参数保留，`template_id` 置空、`source` 改为 `manual`。

### 5.7 当前求交配置（v1.2 新增）

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

### 5.8 求交协议自适应路由（v1.2 新增，合同 C-16）

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

### 5.9 典型场景性能参考（v1.2 新增）

验收编号：PSI-ALGO-04（同时满足 V5「提供典型场景的性能参考」）。对应：算法配置页「典型场景性能参考」表。

```
GET /psi/benchmarks
```

3 种规模（10 万 × 10 万、100 万 × 100 万、1 亿 × 1 万）× 2 种网络（局域网 1000 Mbps / 1 ms，广域网 100 Mbps / 30 ms）共 6 行，与 5.8 同一估算模型。

`data.items[]`：`{ scenario_id, scale_label, network_label, left_rows, right_rows, bandwidth_mbps, latency_ms, recommended, estimates: [{ protocol, total_sec, comm_mb, offline_sec }] }`；`data.model_note` 为「估算值，非实测」说明。

### 5.3 启动一键流水线（v1.2 差异）

验收编号：PSI-PIPE-01、PSI-PIPE-02。平台集成页「配置来源」选「当前算法配置」时，请求体 `protocol` / `params` 取 5.7 的当前配置；选某个模板时取该模板的 `protocol` / `params` 并附 `template_id`。`training.fl_job_config` 固定为 `{ task_type: classification, algorithm: xgb, aggregation: he, node_ids: 项目全部节点 }`，`auto_start = false`。完成后「前往训练」跳 `#/fed/proc` 并定位 `fl_job_id`。

页面离开再回到平台集成页时，先 `GET /psi/pipelines/{pipeline_id}`（或项目无记录时取 `GET /projects/{project_id}/psi/pipelines` 最后一项）恢复展示，状态为 `running` 时重新订阅 `/psi/pipelines/{pipeline_id}/events`。

说明：mock 内核的流水线接口当前不对 `params` 做 5.1 的规格校验（已由 5.7 保存时校验）；真实后端应在 5.3 同样执行参数校验规则。
