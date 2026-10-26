> 历史原型设计资料：本文保留早期 Mock 实现说明，不能作为当前运行或验收结论。当前启动与鉴权见根 README，接口约定见根 API.md。

## 2. 联邦学习 FL（v1.2 增补：聚合与安全、技术指标验证）

v1.2 起联邦学习新增两个二级页面：聚合与安全 `#/fed/agg`（页面模块 `FLA`）、技术指标验证 `#/fed/eval`（页面模块 `FLE`）。本片段只写新增接口，任务、指标、节点等沿用 API.md §2 原文。

mock 数据命名空间：`k.db.fla[project_id]`（已保存的聚合配置）、`k.db.flaKeys[project_id]`（聚合密钥对）、`k.db.fle[eval_id]`（评估记录）。技术指标评估会调用内核 `seedProject(project_id)` 确保项目的 `ds_{project_id}_ree_price` 数据集存在（与内核首次访问项目时的播种行为一致，不改内核字段）。

### 2.12 聚合配置

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
| `status` | string | `active` / `rotated` |
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

`GET …/aggregation`、`…/keys`、`…/public-key`、`PUT …/aggregation`、`POST …/reset` 在读取项目密钥前先确保同态模块已为该项目播种聚合密钥，因此首次进入即显示同态模块在用的聚合密钥，初始状态、密钥列表与过程管控口径一致（D24）。`GET /fl/jobs/{job_id}/he-public-key` 不触发播种，保证与同一时刻任务详情的 `he_public_key_id` 一致。

与同态加密模块共用一套密钥（约定见 docs/api/he.md H.7.7）：

- 生成时只写内核 `k.db.heKeys[key_id]`：`project_id`、`scheme`、`purpose = "fl_aggregation"`、`status = "active"`、`created_at`、`distributed_to`（项目全部节点）、`key_params`（Paillier `{ key_size_bits }`；CKKS `{ poly_modulus_degree, coeff_modulus_bits, scale_bits }`）、`rotated_from`，另带兼容字段 `key_size_bits`（CKKS 取 log₂Q）。同态模块列出时自行补建生命周期元数据，这把密钥也可直接用于 §3 四步流程。
- 生成前先触发同态模块对该项目的密钥播种，再把项目其余在用的聚合密钥的 `k.db.heKeys[id].status` 改为 `rotated`（`rotated_to` 指向新密钥），保证项目同时只有一把在用的聚合密钥。
- 项目有效聚合密钥 = 同态模块生命周期表中 `status = active` 的 `fl_aggregation` 密钥（包括同态页播种或轮换出的 `hek_` 密钥）；表中没有的按 `k.db.heKeys[id].status` 判断。`k.db.flaKeys[project_id]` 是它的镜像，每次读取时同步，内核 `aggregationInfo` 读它，因此任务详情 `aggregation_info.he_public_key_id`、`GET /fl/jobs/{job_id}/he-public-key`、本页公钥三者一致。同态页销毁后状态为 `destroyed`，`GET …/public-key` 返回 `40402`。

#### 2.12.7 任务聚合公钥（覆盖 API.md §2.8）

```
GET /fl/jobs/{job_id}/he-public-key
```

mock 用 `routeFirst` 覆盖内核路由：任务为同态聚合且所属项目有有效项目密钥（2.12.6）时，返回该密钥，过程管控页「查看公钥」与同态应用集成页看到的公钥与聚合与安全页一致；否则按内核原逻辑返回。响应字段保持 §2.8 结构（`key_id`、`scheme`、`key_size_bits`、`public_key`、`fingerprint`、`created_at`），项目密钥另附 `poly_modulus_degree`、`coeff_modulus_bits`、`source = "project"`；CKKS 没有模数位数，`key_size_bits` 取系数模数总位数 log₂Q。错误码：`40400` 任务不存在或任务不是同态聚合。

### 2.13 技术指标评估

验收编号：FL-EVAL-01、FL-EVAL-02、FL-EVAL-03（合同 T-01、T-02）。对应：技术指标验证页三张评估卡、指标总览、历史评估记录。

页面顶部固定显示数据来源说明：「当前数值来自原型内置评估引擎的仿真结果」（D02）。

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

### 接口总表增补

| # | 方法 | 路径 | 验收编号 |
|---|---|---|---|
| 1 | GET | `/projects/{project_id}/fl/aggregation` | FL-AGG-01 / 02 / 03 / 07 |
| 2 | PUT | `/projects/{project_id}/fl/aggregation` | FL-AGG-06 |
| 3 | POST | `/projects/{project_id}/fl/aggregation/reset` | FL-AGG-05 |
| 4 | POST | `/projects/{project_id}/fl/aggregation/estimate` | FL-AGG-07（及 02 / 03 实时校验） |
| 5 | POST | `/projects/{project_id}/fl/aggregation/keys` | FL-AGG-04 |
| 6 | GET | `/projects/{project_id}/fl/aggregation/keys` | FL-AGG-04 |
| 7 | GET | `/projects/{project_id}/fl/aggregation/public-key` | FL-AGG-04 |
| 7a | GET | `/fl/jobs/{job_id}/he-public-key`（覆盖 §2.8） | FL-AGG-04 |
| 8 | GET | `/projects/{project_id}/fl/evaluations/defaults` | FL-EVAL-01 / 02 / 03 |
| 9 | POST | `/projects/{project_id}/fl/evaluations` | FL-EVAL-01 / 02 / 03 |
| 10 | GET | `/projects/{project_id}/fl/evaluations` | FL-EVAL-01 / 02 / 03 |
| 11 | GET | `/fl/evaluations/{eval_id}` | FL-EVAL-01 / 02 / 03 |
| 12 | SSE | `/fl/evaluations/{eval_id}/events` | FL-EVAL-01 / 02 / 03 |
| 13 | GET | `/fl/evaluations/{eval_id}/export` | FL-EVAL-01 / 02 / 03 |
