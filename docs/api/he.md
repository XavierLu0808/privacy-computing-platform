# 同态加密 HE（v1.2 增补）

页面：「同态加密 / 算法管理」`#/he/algo`（页面模块 `HEA`，js/he-algo.js）、「同态加密 / 应用集成」`#/he/app`（页面模块 `HE`，js/he.js）。

本片段在 API.md §3（方案列表、四步流程、销毁密钥）的基础上新增算法目录、底层库配置、编码、运算验证、参数寻优、密钥生命周期、流程测试模拟和性能日志接口。§3.2 `POST /he/keys` 与 §3.6 `DELETE /he/keys/{key_id}` 的请求和响应保持兼容，只补充字段。mock 实现在 js/mock/he.js，自有数据在 `k.db.he`；写内核数据的位置：`db.heKeys`（生成、轮换、播种密钥）和 `db.heCiphers`（销毁密钥时删除其下密文，与内核行为一致）。

错误码沿用 API.md §9：`40000` 参数不合法、`40001` 方案或库不支持该操作、`40002` 值格式错误、`40003` 越界（含明文空间溢出、参数不可行）、`40400` 不存在、`40402` 密钥不存在或已销毁、`40901` 当前状态不允许。

## H.1 算法目录

服务：HE-ALGO-01、HE-ALGO-02。对应「算法目录」表。

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
| `default_library` | string | 默认底层库，见 H.2 |
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

## H.2 底层库与支持矩阵

服务：HE-ALGO-03。对应「加密算法配置」矩阵。

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

## H.3 项目默认加密配置

服务：HE-ALGO-03、HE-ALGO-07。

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

## H.4 数据类型自动转换（定点编码）

服务：HE-ALGO-06、HE-ALGO-07。对应「数据类型自动转换与精度设置」。

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
| `plaintext_space` | 同 H.1 |
| `sweep[]` | p = 0…8 逐档：`precision`、`scale_factor`、`max_abs_error`、`error_bound`、`max_encoded_bits`、`overflow`、`mul_overflow`（同精度两数相乘后是否溢出） |

编码规则：`encoded = round(x · 10^p)`，按十进制字符串逐位四舍五入（`1.005` 在 p = 2 时得 `101`），不经过二进制浮点；解码 `encoded / 10^p`。

错误：`values` 为空 `40000`；非数值 `40002`；超过 64 个或精度越界 `40003`。

## H.5 运算验证

服务：HE-ALGO-04、HE-ALGO-05。对应「运算验证」。一次请求完成 密钥生成 → 编码 → 加密 → 密态运算 → 解密，与明文直接计算逐元素比较。

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
- 耗时与密文大小按统一模型（与 H.6 参数寻优、四步流程共用，1 KB = 1024 字节）：CKKS / BGV 一条密文打包整组（4096 / 8192 槽位），Paillier / TFHE 每个数一条。单条密文：CKKS 2 × N × L × 8 字节，N = 8192、L = 3 → 384 KB，乘法重缩放后 L = 2 → 256 KB；BGV N = 8192、L = 4（SEAL 默认 [43, 43, 44, 44, 44] 去掉特殊素数）→ 512 KB；Paillier 2 × 2048 bit = 0.5 KB；TFHE FheInt32 16 × (2048 + 1) × 8 字节 = 256.1 KB。CKKS / BGV 耗时用 H.6 规则 4 的同一公式（N = 8192、L = 3：密钥生成约 21.5 ms、加密 2.4 ms、加法 0.07 ms、乘法 2.9 ms、解密 0.26 ms）。响应附 `ciphertext_kb_each` 与 `ciphertext_formula`。

错误：方案或 op 未知、A/B 个数不符 `40000`；Paillier + `mul` 或库不支持 `40001`；非数值 `40002`；精度越界、超过 64 个、明文空间溢出 `40003`。

## H.6 密态计算参数寻优（CKKS）

服务：HE-ALGO-08（合同 C-13）。对应「密态计算参数智能寻优」。

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
4. 性能估算：以 SEAL 4.1 单线程 N = 8192、L = 3 的量级（加法约 0.07 ms，乘法含重线性化与重缩放约 2.9 ms）为基准，加法按 N·L、乘法按 N·log2 N·L·(L+1) 外推；密文大小 = 2 × N × L × 8 字节（L = 深度 + 1，1 KB = 1024 字节）。运算验证（H.5）与四步流程（H.7.0）使用同一函数，同参数下数值一致。

错误：安全强度不在 128/192/256 `40000`；深度、精度、批大小越界 `40003`；N ≤ 32768 内无可行解 `40003`（`data.total_modulus_bits`）。

## H.7 密钥生命周期

### H.7.0 四步流程的耗时口径与日志（包装 API.md §3.3–3.5）

`POST /he/encrypt`、`POST /he/evaluate`、`POST /he/decrypt` 由 mock 扩展以 routeFirst 接管，请求与响应字段不变；耗时与 `size_kb` 改用 H.5 的统一模型（CKKS 加密单条 384 KB，密文乘法结果 256 KB）。会话密钥（`purpose = session`）从生成开始逐步记账，解密完成后写入性能日志（H.10，来源 `session`「全流程配置」）；`session_summary.total_elapsed_ms / total_ciphertext_kb` 为本次会话实际记账之和，`logged = true`、`log_source = 'session'`。重置销毁密钥后日志保留。

服务：HE-APP-03（HE-APP-01 的四步流程也经过这些接口）。对应「密钥管理」。

### H.7.1 生成密钥（兼容 API.md §3.2）

```
POST /he/keys
```

在 §3.2 字段基础上新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_id` | string | 是 | 现在强制校验项目存在 |
| `purpose` | string | 否 | `session`（默认，四步流程）/ `fl_aggregation`（联邦聚合，受轮换策略管理） |
| `key_params.key_size_bits` | int | 否 | 仅 Paillier：2048 / 3072 / 4096 |
| `node_ids` | string[] | 否 | 生成后立即分发到这些节点 |

响应在 §3.2 字段外补充：`purpose`、`status`（`active` / `rotated` / `destroyed`）、`storage`、`distributed_to[]`（`node_id`、`distributed_at`）、`rotated_from`、`rotated_to`、`rotated_at`、`rotate_reason`（`manual` / `auto`）、`destroyed_at`、`next_rotation_at`。

同一项目同一时间只允许一把在用的 `fl_aggregation` 密钥（不区分方案）：新钥生成后，该项目其余在用的聚合密钥（含其他模块写入 `db.heKeys` 的）标记为 `rotated`，`rotated_to` 指向新钥，`rotate_reason = 'superseded'`，并同步写 `db.heKeys[id].status / rotated_to`；响应附 `superseded_key_ids[]`。会话密钥不受影响。轮换（H.7.4）同样同步写 `db.heKeys`。

错误：方案未知、`project_id` 缺失、`purpose` 或 `key_size_bits` 非法 `40000`；节点不属于本项目 `40400`。

### H.7.2 密钥列表

```
GET /he/keys?project_id=p1&status=active,rotated&purpose=fl_aggregation
```

响应：`{ items[], total, policy }`，按生成时间倒序，含已销毁记录。首次访问项目时播种 1 把在用的 Paillier 聚合密钥（12 天前生成）及其轮换前的旧钥（42 天前生成，12 天前自动轮换），均分发到项目全部节点。查询时执行自动轮换：策略启用且 `fl_aggregation` 密钥生成满 `period_days` 天即轮换。

### H.7.3 分发

```
POST /he/keys/{key_id}/distribute
```

`{ "node_ids": ["node-shanghai-01"] }`，已分发的节点保持不变，新节点追加。错误：`node_ids` 为空 `40000`；密钥不存在 `40402`；节点不属于本项目 `40400`；密钥非 `active` `40901`。

### H.7.4 轮换

```
POST /he/keys/{key_id}/rotate
```

生成同方案、同用途的新钥，整体继承旧钥 `key_params`（如 CKKS 的 `poly_modulus_degree` / `coeff_modulus_bits` / `scale_bits`）与分发节点；旧钥标记 `rotated`，保留用于解密历史密文。响应 `{ old_key, new_key }`。错误：密钥不存在 `40402`；非 `active` `40901`。

### H.7.5 销毁（兼容 API.md §3.6）

```
DELETE /he/keys/{key_id}
```

删除密钥与其下全部密文，列表保留 `destroyed` 记录。重复销毁 `40402`。

### H.7.6 加密前的密钥状态检查（包装 API.md §3.3）

`POST /he/encrypt` 由 mock 扩展以 routeFirst 接管，请求与响应字段不变，加密前先检查密钥状态：已轮换返回 `40901`「密钥已轮换，只能用于解密历史密文」（`data = { status: 'rotated', rotated_to }`），已销毁或不存在返回 `40402`。状态检查先于参数校验。解密（§3.5）不受影响，已轮换密钥仍可解密历史密文。

### H.7.7 外部模块写入的密钥

其他模块（如 fed-sec 聚合与安全页）可直接写 `db.heKeys[key_id]`，本模块在列表、分发、轮换时为其补建元数据。识别字段：`project_id`（必需）、`scheme`（缺省 `paillier`）、`purpose`（只有 `fl_aggregation` 受轮换策略管理，其余视为 `session`）、`status`（`active` / `rotated` / `destroyed`，缺省 `active`；外部事后把 `status` 改为 `rotated` / `destroyed` 会同步过来）、`created_at`（缺失时不参与自动轮换）、`distributed_to` 或 `node_ids`（字符串数组或 `{ node_id, distributed_at }` 数组）、`key_params`（缺省 `{}`；CKKS 为 `{ poly_modulus_degree, coeff_modulus_bits, scale_bits }`，Paillier 为 `{ key_size_bits }`）、可选 `rotated_from` / `rotated_to` / `rotated_at` / `rotate_reason`（本模块元数据为空时从 `db.heKeys` 同步）。

展示：CKKS / BGV 显示「N=8192 · log₂Q=200 bit」（`coeff_modulus_bits` 可为总位数或各素数位数数组，数组时求和），Paillier 显示「密钥长度 2048 bit」。顶层 `key_size_bits` 在 CKKS 下是 log₂Q 兼容字段，前端不用它展示。本模块生成的 CKKS 默认 `key_params = { poly_modulus_degree: 8192, coeff_modulus_bits: 200, scale_bits: 40 }`，BGV 为 `{ poly_modulus_degree: 8192, coeff_modulus_bits: 218, plain_modulus: 1032193 }`。

### H.7.8 自动轮换策略

```
GET /projects/{project_id}/he/rotation-policy
PUT /projects/{project_id}/he/rotation-policy
```

`{ "enabled": true, "period_days": 30 }`。默认启用、30 天。保存后立即按新周期检查一次。错误：`enabled` 非布尔 `40000`；周期不在 1–365 `40003`；项目不存在 `40400`。

## H.8 联邦学习一键启用同态加密

服务：HE-APP-02。复用已有接口，不新增：

- `GET /projects/{project_id}/fl/jobs`：选择任务。
- `PATCH /fl/jobs/{job_id}` `{ "aggregation": "he" }`：启用。前端只对 `Created` / `Terminated` / `Failed` 状态开放按钮，其余状态给出原因与「去过程管控」入口；后端对 `Running` / `Paused` 返回 `40901`。
- `GET /fl/jobs/{job_id}/he-public-key`：显示聚合公钥（key_id、Paillier 2048 bit、指纹、公钥前 64 位）。

## H.9 流程测试模拟

服务：HE-APP-04。对应「流程测试模拟」。

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

## H.10 加解密性能日志

服务：HE-APP-05。对应「加解密性能日志」。

```
GET /projects/{project_id}/he/logs?source=fl_job&ref_id=fl_p1_002
GET /projects/{project_id}/he/logs/export?source=&ref_id=        （CSV 下载）
```

`source`：`session`（全流程配置）/ `simulation` / `fl_job`，不传为全部。响应：`items[]`（`log_id`、`source`、`ref_id`、`ref_name`、`round`、`stage`、`stage_label`、`scheme`、`party`、`elapsed_ms`、`ciphertext_kb`、`ciphertext_count`、`recorded_at`）、`total`、`refs[]`（筛选下拉）、`summary[]`（按环节：`count`、`total_elapsed_ms`、`avg_elapsed_ms`、`total_ciphertext_kb`）、`timing_basis`（耗时口径说明）。

来源：

- 全流程配置：四步流程每次解密完成后，按实际执行的 密钥生成 / 加密 / 密态运算 / 解密 各记 1 条。
- 流程测试：每次模拟展开为 密钥生成 1 条 + 每个参与方加密 1 条 + 密态聚合 1 条 + 解密 1 条。
- 训练任务：`aggregation = he` 且已跑的每一轮，每个训练节点加密 1 条 + 聚合方密态聚合 1 条 + 密钥服务解密 1 条；密文条数 = ⌈模型参数量 / 32⌉（参数量读内核 `k.MODEL_PARAMS`：lr 69、xgb 2176、cnn 61706、lstm 203143、tcn 37959、custom 20000，例如 xgb → 68 条、34 KB / 节点 / 轮），单条 0.5 KB（2 × 2048 bit），按节点侧 16 线程批处理 + CRT 解密计（加密 0.213 ms / 条、聚合 0.05 ms / 条 / 方、解密 0.066 ms / 条），±6% 确定性抖动。各训练节点并行加密，每轮墙钟 = 最慢节点加密 + 聚合 + 解密，小于每轮训练时长 4.2 秒（参数量最大的 LSTM 203143 维 → 6349 条，约 1.35 + 0.63 + 0.42 ≈ 2.4 秒）。

CSV 列：`来源,任务或测试 ID,名称,轮次,环节,方案,节点或参与方,耗时(ms),密文大小(KB),密文条数,记录时间(UTC+8)`，时间用内核 `fmtLocal` 写成 `2026-10-23 22:58:02 +08:00`，UTF-8 BOM。错误：`source` 非法 `40000`；项目不存在 `40400`。

## 接口总表（增补）

| 方法 | 路径 | 验收编号 |
|---|---|---|
| GET | `/he/algorithms` | HE-ALGO-01、HE-ALGO-02 |
| GET | `/he/libraries` | HE-ALGO-03 |
| GET / PUT | `/projects/{project_id}/he/config` | HE-ALGO-03、HE-ALGO-07 |
| POST | `/he/encode` | HE-ALGO-06、HE-ALGO-07 |
| POST | `/he/verify` | HE-ALGO-04、HE-ALGO-05 |
| POST | `/he/param-optimize` | HE-ALGO-08 |
| POST | `/he/keys`（字段增补） | HE-APP-01、HE-APP-03 |
| GET | `/he/keys` | HE-APP-03 |
| POST | `/he/keys/{key_id}/distribute` | HE-APP-03 |
| POST | `/he/keys/{key_id}/rotate` | HE-APP-03 |
| POST | `/he/encrypt`（加密前检查密钥状态） | HE-APP-01、HE-APP-03 |
| POST | `/he/evaluate`、`/he/decrypt`（统一耗时模型、会话记日志） | HE-APP-01、HE-APP-05 |
| DELETE | `/he/keys/{key_id}`（保留销毁记录） | HE-APP-01、HE-APP-03 |
| GET / PUT | `/projects/{project_id}/he/rotation-policy` | HE-APP-03 |
| POST / GET | `/projects/{project_id}/he/simulations` | HE-APP-04 |
| GET | `/projects/{project_id}/he/logs` | HE-APP-05 |
| GET | `/projects/{project_id}/he/logs/export` | HE-APP-05 |
