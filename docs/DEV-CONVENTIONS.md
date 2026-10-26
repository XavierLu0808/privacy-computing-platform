# 前端开发约定

本仓库维护连接真实 API v1.2 的静态控制台。生产页面只通过 `web/js/api.js` 访问后端；接口字段、错误码与分页以根目录 [API.md](../API.md) 及后端实际契约为准。不要恢复浏览器 Mock 服务、假令牌或自动生成的业务数据。

## 文件与页面

- `web/index.html`、`styles.css`：页面外壳、共享样式与设计 token。
- `web/js/app.js`：路由、项目切换与导航；`connection.js`：认证与会话。
- `web/js/api.js`、`sse-client.mjs`：公共请求、文件传输与事件流。
- `web/js/<page>.js`、`web/css/<module>.css`：业务模块。
- `web/tests/*.test.mjs`：Node 客户端回归；`tests/`：Python 代理及资料工具测试。

页面模块提供 `mount(ctx, el, opts)` 和 `unmount()`。切换项目、任务或离开页面时，清理订阅和定时器；异步操作按请求发起时的上下文校验，避免旧响应、文件与弹窗提交覆盖新上下文。空项目必须显示空态，不能沿用上一个项目的详情。

| 路由 | 页面模块 | 文件 |
| --- | --- | --- |
| `#/fed/orch` | `FLO` 任务编排 | `web/js/fl-orch.js` |
| `#/fed/proc` | `FL` 过程管控 | `web/js/fl.js` |
| `#/fed/agg` | `FLA` 聚合与安全 | `web/js/fl-agg.js` |
| `#/fed/eval` | `FLE` 技术指标评估 | `web/js/fl-eval.js` |
| `#/he/algo`、`#/he/app` | `HEA`、`HE` | `web/js/he-algo.js`、`he.js` |
| `#/mpc/proto`、`#/mpc/ops` | `MPCP`、`MPC` | `web/js/mpc-proto.js`、`mpc.js` |
| `#/psi/data`、`#/psi/algo`、`#/psi/pipe` | `PSI`、`PSIA` | `web/js/psi.js`、`psi-algo.js` |
| `#/dp/mech`、`#/dp/eval`、`#/dp/fw` | `DPM`、`DP`、`DPF` | `web/js/dp-mech.js`、`dp.js`、`dp-fw.js` |

## 请求、认证与展示

统一使用 `Api.get/post/patch/put/del/upload/download/subscribe`。Bearer 令牌仅由连接页验证后存入标签页会话；不要放入 URL、源码、日志或截图。下载通过带鉴权的请求获取 Blob，SSE 使用带请求头的 fetch 流。

复用 `UI` 的表单、弹窗、提示和错误处理，以及共享 CSS token。界面使用中文，技术名称可保留英文；图标使用 SVG。所有数字说明来源与单位。没有测量或后端明确未知的指标应显示空态和原因；计算预估、原型公式模拟与真实测量应清楚区分。

## 测试与验收资料

从仓库根目录运行：

```sh
node --test web/tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

新增测试优先验证错误路径、边界和异步上下文隔离。需要浏览器验证时，按根 README 启动真实后端代理，使用独立浏览器会话，截图和请求证据写入 `output/`。

验收编号由 `docs/acceptance/items.json` 定义，应保持稳定；页面可通过 `data-acc` 标注关联项。需要映射的测试名显式包含 `[FL-ORCH-01]` 等编号。旧模块映射不是当前测试结果，缺少映射或浏览器证据的项目保留缺口。证据工具要求源码摘要一致，禁止将测试请求桩或旧 Mock 截图视为真实算法验收。

## 发布与产物

运行源码统一维护在本仓库 `web/`，后端 `web/` 只作静态发布副本。同步后运行双方客户端测试，并重新构建后端 API/控制镜像。测试结果、截图、文档导出与临时文件放 `output/` 或其他已忽略的输出目录，不将令牌、缓存或运行产物提交 Git。
