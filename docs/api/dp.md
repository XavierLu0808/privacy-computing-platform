## 6. 差分隐私 DP（v1.2 增补）

页面：「差分隐私 / 隐私机制」（`#/dp/mech`，`DPM`）、「差分隐私 / 效果评估」（`#/dp/eval`，`DP`）、「差分隐私 / 框架集成」（`#/dp/fw`，`DPF`）。

三个页面共用一个「当前训练任务」（按项目记忆，顶部「训练任务」下拉），DP 参数一律以 `GET /fl/jobs/{job_id}/dp` 为准。§6.1–6.5 原有接口保持兼容，本节只写增补字段与新接口。mock 实现在 `web/js/mock/dp.js`。

### 6.0 通用约定与会计方法

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

### 6.1 / 6.2 获取 / 更新 DP 配置（增补）

对应：隐私机制页「参数配置 → 梯度（联邦训练任务）」表单、效果评估页左栏。服务 DP-MECH-02。

```
GET /fl/jobs/{job_id}/dp
PUT /fl/jobs/{job_id}/dp
```

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

### 6.3 参数预估（增补）

对应：效果评估页噪声参数框、指标卡、趋势曲线；隐私机制页「按当前参数预估」。服务 DP-EVAL-01、DP-EVAL-02、DP-MECH-02。

```
POST /dp/estimate
```

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

### 6.4 预算消耗（增补）

对应：效果评估页「已消耗隐私预算」、框架集成页工作流第 5 步。服务 DP-EVAL-01、DP-FW-04。

```
GET /fl/jobs/{job_id}/dp/budget
```

响应增补 `accountant`、`delta_total`（已完成轮次的累计 δ）、`dp_active`（本次运行是否启用 DP）。`epsilon_used` 按会计方式累计，`used_pct = round(epsilon_used / epsilon_total × 100)`。

```json
{ "epsilon_total": 2.4, "epsilon_used": 1.207, "used_pct": 50, "rounds_completed": 8, "total_rounds": 30, "exhausted": false, "accountant": "rdp", "delta_total": 0.00001, "dp_active": true }
```

### 6.5 隐私审计记录（增补）+ 导出

对应：效果评估页「隐私审计记录」表、「查看全部」弹窗、「导出 CSV」。服务 DP-EVAL-03。

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

### 6.6 机制目录

对应：隐私机制页「差分隐私机制」卡。服务 DP-MECH-01。

```
GET /dp/mechanisms
```

响应 `data.items[]`：`mechanism`、`name`、`guarantee`（`(ε, δ)-DP` / `ε-DP（纯差分隐私，δ = 0）`）、`definition`、`noise`、`sensitivity`、`scenarios[]`、`params[]`（`{ key, name, min, max, step }` 或 `{ key, name, options }`）。

### 6.7 效用-隐私平衡

对应：效果评估页「效用-隐私平衡分析」卡。服务 DP-EVAL-02（合同 C-09）。

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

### 6.8 自适应噪声注入

对应：隐私机制页「自适应噪声注入」页签。服务 DP-MECH-03（合同 C-07）。

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

对应：隐私机制页「参数配置 → 统计查询（数据集字段）」。服务 DP-MECH-02、DP-MECH-03。

```
GET  /projects/{project_id}/dp/query-config
PUT  /projects/{project_id}/dp/query-config
POST /projects/{project_id}/dp/query
GET  /projects/{project_id}/dp/queries
```

配置字段：`mechanism`、`epsilon`（单次查询，0.05–10）、`delta`、`dataset_id`、`column`、`query`、`clip_mode`（`fixed` / `adaptive`）。

`POST …/dp/query` 两种用法：带上述字段直接发布；或 `{ policy_id, dimension_key }` 按策略的查询维度发布（消耗该维度 1 次，参数取自策略）。响应 **不含真实值**，只返回 `noisy_value`（已裁回裁剪区间，属后处理不耗预算）、`unit`、`clip_lower`、`clip_upper`、`sensitivity`、`noise_scale`、`expected_rmse`、`epsilon_spent`、`release_id`。`GET …/dp/queries` 返回发布记录与 `epsilon_spent_total`（基础组合累加）。

错误码：同 6.8；按策略发布时 `40400` 策略 / 维度不存在、`40001` 该维度是训练维度、`40901` 该维度次数已用完。

### 6.9 组合定理对比

对应：隐私机制页「策略动态编排 → 组合定理对比」。服务 DP-MECH-04（合同 C-08）。

```
POST /dp/compose
```

```json
{ "mechanism": "gaussian", "epsilon_per_step": 0.0667, "delta": "1e-5", "rounds": 30 }
```

响应：`noise_multiplier`、`results.{basic, advanced, rdp}.{epsilon, delta_total}`（rdp 另有最优阶 `alpha`）、`curve[]`（`{ t, basic, advanced, rdp }`，最多约 60 个点）。上例结果：基础 2.001、高级 1.891、RDP 0.365。错误码：`40000`、`40003`（ε₀ 不在 0.001–5 或 T 不是 1–1000 的整数）、`40002`。

### 6.10 DP 策略编排与下发

对应：隐私机制页「新建 DP 策略」「已编排策略」，框架集成页工作流第 2 步「选用已编排策略」。服务 DP-MECH-04、DP-FW-04。

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

### 6.11 框架集成

#### 实现与接口映射

对应：框架集成页「隐语集成 · DP 适配层」。服务 DP-FW-01。

```
GET /dp/providers
PUT /dp/provider        { "provider": "opacus" }
```

`GET` 返回 `current` 与 `items[]`（`provider`、`name`、`library`、`version_note`、`mechanisms`、`accountants`、`mapping[]`）。`mapping[]` = `{ iface, impl, source, note }`：`iface` 为平台统一接口（`DPStrategy.build`、`GradientDP.gaussian`、`GradientDP.laplace`、`Accountant.spent`、`SecureAggregator.aggregate`），`source = native` 表示框架自带类（类路径以部署环境的包版本为准），`adapter` 表示平台适配层补齐的实现。

`PUT` 切换平台当前实现：非运行任务的 `job.dp.provider` 改为新实现，运行中任务沿用原实现直到本次训练结束。响应 `{ current, affected_jobs, kept_running[] }`。错误码 `40000` 未知实现。

#### DP hook 链

对应：框架集成页「DP 初始化与 hook 链」。服务 DP-FW-02。

```
GET /fl/jobs/{job_id}/dp/hooks
```

响应：`initialized`（启用 DP 且已启动过）、`initialized_at`、`hook_point = before_aggregate`、`provider`、`trainers`、`steps[]`（`key`：`load` → `train` → `clip` → `noise` → `agg` → `account`；`name`、`impl`、`dp`、`status`：`pending` / `active` / `done` / `skipped`、`calls`、`last_called_at`、`detail`）。调用次数：load / train / clip / noise 为「已完成轮数 × 训练参与方数」，agg / account 为已完成轮数；本次运行未启用 DP 时 clip / noise / account 为 `skipped` 且次数为 0。

#### 框架内部 DP 指标

对应：框架集成页「框架内部 DP 指标」。服务 DP-FW-03。

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

对应：框架集成页工作流第 3 步。服务 DP-FW-04（合同 C-10）。

```
POST /fl/jobs/{job_id}/dp/init-check
```

响应 `{ ok, checks[], checked_at }`，`checks[]` 依次为 `enabled`（任务已启用 DP）、`params`（参数在允许范围）、`provider`（当前实现支持该机制与会计方式）、`calibration`（噪声倍数有限且为正）、`aggregation`（已配置 HE / SS 安全聚合）、`nodes`（训练参与方 ≥ 2）、`status`（任务状态可启动：Created / Failed / Terminated）。全部通过 `ok = true`。错误码 `40400`。

端到端工作流（DP-FW-04）的调用顺序：`GET /projects/{id}/fl/jobs` → `PUT /fl/jobs/{id}/dp` 或 `POST /dp/policies/{id}/apply` → `POST /fl/jobs/{id}/dp/init-check` → `POST /fl/jobs/{id}/actions { action: start }`（前端跳转 `App.go('fed', { sub: 'proc', focusJobId })`）→ `GET /fl/jobs/{id}/dp/budget`、`/dp/audit`（效果评估页）。
