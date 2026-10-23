# 开发约定（v1.2 起，所有模块开发者必读）

项目：2026 年 AI+稀土追溯模型关键技术及应用研究（隐私计算）联合研发项目 · 隐私计算联邦学习软件原型 · 前端控制台。

验收依据两份文件，都在 `docs/acceptance/`：

- `附件1_成果形式及验收要求.docx`：合同功能清单 16 项（C-01 至 C-16）+ 技术参数指标 3 项（T-01 至 T-03）。
- `自研功能清单V5.xlsx`：甲方给的工程化拆解，60 个三级功能。

两者合并后的主表是 `docs/acceptance/items.json`（共 72 项，其中 V5 60 项、合同补充 12 项），每项有固定编号，例如 `FL-ORCH-01`。**编号不能改**，测试、文档、验收进度表都用这个编号。

## 1. 目录与文件归属

```
web/
  index.html            外壳（顶栏、侧边栏容器、每个二级页面一个空 <section>）——只由集成负责人改
  styles.css            全局样式与设计 token ——只由集成负责人改
  css/<mod>.css         各模块自己的样式（fed / he / mpc / psi / dp）
  js/app.js             路由 + 侧边二级下拉导航 ——只由集成负责人改
  js/api.js js/ui.js    请求层、通用 UI 工具 ——只读
  js/mock-server.js     mock 内核 ——只读；需要改内核行为用 extend 的 routeFirst 包一层
  js/mock/<name>.js     各模块的 mock 扩展路由（MockServer.extend）
  js/<page>.js          页面模块，一个二级页面一个文件
  tests/_boot.mjs       测试启动器（加载内核 + 全部 mock 扩展）
  tests/<name>.test.mjs 各模块测试
docs/api/<name>.md      各模块接口文档片段，集成时合入根目录 API.md
docs/acceptance/<name>.json  各模块验收映射（见 §6）
```

同一文件同一时间只允许一个人写。不属于你的文件只读。

## 2. 导航与页面模块

侧边栏 = V5 一级功能；点开下拉 = 二级功能。路由形如 `#/fed/orch`，每个二级页面对应 `<section class="screen" id="screen-{mod}-{sub}">`。

| 一级 | 二级（sub） | 页面模块（window 全局名） | 文件 |
|---|---|---|---|
| 联邦学习 fed | 任务编排 orch | `FLO` | js/fl-orch.js |
| | 过程管控 proc | `FL` | js/fl.js（已有） |
| | 聚合与安全 agg | `FLA` | js/fl-agg.js |
| | 技术指标验证 eval | `FLE` | js/fl-eval.js |
| 同态加密 he | 算法管理 algo | `HEA` | js/he-algo.js |
| | 应用集成 app | `HE` | js/he.js（已有） |
| 多方安全计算 mpc | 协议管理 proto | `MPCP` | js/mpc-proto.js |
| | 运维监控 ops | `MPC` | js/mpc.js（已有） |
| 隐私求交 psi | 数据接入 data | `PSI` | js/psi.js（已有，opts.sub = data） |
| | 算法配置 algo | `PSIA` | js/psi-algo.js |
| | 平台集成 pipe | `PSI` | js/psi.js（已有，opts.sub = pipe） |
| 差分隐私 dp | 隐私机制 mech | `DPM` | js/dp-mech.js |
| | 效果评估 eval | `DP` | js/dp.js（已有） |
| | 框架集成 fw | `DPF` | js/dp-fw.js |

页面模块接口：

```js
window.FLO = {
  mount(ctx, el, opts) {},   // ctx = { projectId }；el = 本页 <section>；opts = { sub, ... }
  unmount() {}               // 离开本页或切换项目时调用：清定时器、关 SSE
};
```

- 新页面的 DOM 全部由 JS 渲染进 `el`（第一次 mount 时建骨架，之后只刷新数据）。页面顶部统一用：
  `<div class="page-head"><div class="page-head-text"><span class="crumb">一级 / 二级</span><h1>标题</h1></div>…按钮</div>`
- 跳转别的页面：`App.go('fed', { sub: 'proc', focusJobId })`。新建项目后：`await App.reloadProjects(newProjectId)`。
- 每个可验收的功能块在 DOM 上加 `data-acc="FL-ORCH-01"`（可多个，空格分隔），测试和操作手册按它定位。
- 项目切换时 App 会对当前页调 `unmount()` 再 `mount()`，页面要能处理换项目。

## 3. 视觉与文案

- 复用 `styles.css` 已有类：`card` `card-lg` `card-xl` `card-title` `card-label` `hint` `hint-2` `btn` `btn-primary` `btn-sm` `btn-link` `btn-kill` `select` `select-sm` `select-lg` `input` `field` `field-label` `field-col` `table-head` `tag` `tag-ts` `tag-cls` `metric-grid` `metric` `metric-name` `metric-value` `metric-sub` `bar` `banner` `banner-ok` `banner-err` `banner-note` `chip-row` `divider-h` `divider-v` `tabs` `tab` `seg` `check-list` `preview-table` `modal*`。颜色用 `:root` 里的 token（`var(--primary)` 等），不要新造配色。
- 表格用 CSS grid：在 `css/<mod>.css` 里定义 `.xxx-grid { display:grid; grid-template-columns: … }`，表头 `table-head xxx-grid`，行 `table-row xxx-grid`（参考 styles.css 的 `.fl-job-grid`）。
- 图标只用内联 SVG（stroke 线框风格，同侧边栏），**不用 emoji 当图标**。
- 弹窗用 `UI.modal`，表单行用 `UI.formRow / UI.selectOf / UI.inputOf`，提示用 `UI.toast`，接口错误用 `UI.fail(e)`。
- 界面文字全中文；技术名词保留英文（ECDH-PSI、CKKS、FedAvg、DLG）。
- **每个数字都要写清楚是什么、什么单位、怎么算的**。例如写「攻击还原成功率 0.0%（0 / 200 个样本被还原，PSNR ≥ 20 dB 记为还原成功）」，不写「0.015 [0.006, 0.032]」这种裸数字；比率用百分比；置信区间要写「95% 置信区间」。
- 演示数据要贴合稀土业务：氧化钕 Nd₂O₃、氧化铈 CeO₂、氧化镧 La₂O₃ 价格（元/吨）；参与方用「参与方 A / B / C」、节点用现有 `node-*` ID。

## 4. mock 后端

- 前端只通过 `Api.get/post/patch/put/del/upload/download/subscribe`（见 js/api.js，subscribe 是 SSE）调接口，**不直接读 MockServer**。切 `useMock=false` 后应能直接打真实后端。
- mock 路由写在 `js/mock/<name>.js`：

```js
(function () {
  'use strict';
  window.MockServer.extend(function (k) {
    // k.route / k.routeFirst / k.download / k.ok / k.err / k.db / k.nextId / k.NOW / k.emit ...
    k.route('GET', '/projects/{project_id}/fl/algorithms', function (p, q, body) {
      return k.ok({ items: [] });
    });
  });
})();
```

- 响应包：`{ code, message, data, request_id }`，`code = 0` 成功。错误码沿用 API.md §9：`40000` 参数不合法、`40001` 方案不支持该操作、`40002` 值格式错误、`40003` 越界、`40400` 不存在、`40901` 当前状态不允许、`40902` 重名、`42201` 连通性检查失败、`50000` 内部错误。
- 自己的数据挂在 `k.db` 下自己的命名空间（例如 `k.db.flo = {}`），不要改别人的字段。读内核数据（项目、节点、任务）可以，写之前先在文档说明。
- 路径风格与现有一致：项目作用域资源 `/projects/{project_id}/xxx`，单个资源 `/xxx/{id}`，动作 `POST /xxx/{id}/actions`。
- 仿真数值要合理、稳定（同输入同输出，用 `k.hashHex` 做种子），并能解释来源。

## 5. 测试

- 每个三级功能至少一个测试，测试名以验收编号开头：`test('[FL-ORCH-01] 项目创建：必填校验 + 创建后出现在列表', …)`。一个测试可覆盖多个编号：`[FL-ORCH-01][FL-ORCH-04]`。
- 用 `import { boot } from './_boot.mjs'`，`const { okData, call, errCode, download, tick } = boot(t)`。正常路径 + 至少一个校验失败路径都要测。
- 跑：`cd web && node --test tests/*.test.mjs`，提交前必须全绿（包括别人的测试）。
- 浏览器自测：静态服务已开在 `http://127.0.0.1:18923/`（直接反映文件改动）。用 agent-browser 时**必须带自己的会话名**，避免和其他开发者抢同一个浏览器：

```bash
export AGENT_BROWSER_EXECUTABLE_PATH=/home/lmy/.agent-browser/browsers/chrome-148.0.7778.167/chrome
agent-browser --session <你的名字> open "http://127.0.0.1:18923/#/fed/orch"
agent-browser --session <你的名字> set viewport 1440 900
agent-browser --session <你的名字> screenshot <scratchpad>/x.png
agent-browser --session <你的名字> eval "..."
agent-browser --session <你的名字> errors
```

截图存到 scratchpad，不要放进仓库。自测要点：页面无报错 toast、无 console error、按钮都有反应、换项目后正常。

## 6. 接口文档与验收映射

- `docs/api/<name>.md`：按 API.md 的写法（方法 + 路径、对应界面、请求字段表、响应示例、错误码），每个接口标注它服务的验收编号。
- `docs/acceptance/<name>.json`：你负责的每个验收编号一条：

```json
{
  "FL-ORCH-01": {
    "page": "#/fed/orch",
    "ui": "任务编排 → 项目信息卡 → 「新建项目」按钮",
    "steps": ["点击「新建项目」", "填写项目名称、描述、模型版本、聚合轮数、训练目标", "提交后顶栏项目下拉出现新项目并自动切换"],
    "expected": "新项目出现在项目列表，详情字段与填写一致",
    "api": ["POST /projects", "GET /projects", "GET /projects/{project_id}"],
    "tests": ["tests/fed-orch.test.mjs: [FL-ORCH-01] …"],
    "impl": "工程实现说明（2–4 句，面向技术评审）：数据如何存、校验规则、与其他模块怎么衔接。",
    "status": "done"
  }
}
```

`status` 只有 `done`（实现 + 测试通过 + 浏览器自测通过）和 `partial`（说明缺什么）。`impl` 是写给甲方技术评审看的「工程实现解释」，要具体到字段、规则和算法名，不写空话。
