# 隐私计算平台前端

本仓库提供连接真实 `sfl_backend` 的静态控制台。运行目录为 `web/`，无需 npm 安装或构建。已移除浏览器 Mock 服务、模拟状态流转、演示重置入口和假令牌；数据、任务、指标和导出均来自后端 API。

## 本地启动

目录建议保持同级：

```text
rare_earth/
  sfl_backend/
  sfl_frontend/
```

当前本机后端已运行于 `https://localhost:18443`。前端执行：

```sh
cd sfl_frontend
sh start.sh
```

打开 **http://127.0.0.1:8412/**，输入运维签发的 Bearer 令牌。当前本地实例的令牌保存在 `../sfl_backend/deployment/.generated/demo-token.json`，用编辑器查看 `access_token` 后输入连接页面，不要把令牌写进源码。

启动器需要 Python 3.9+，会在同一个源提供静态文件并把 `/api/v1`、`/health` 转发给真实后端。默认信任后端生成的 `tls.crt`，保持 TLS 校验；后端未启动时显示连接失败，不会回退到演示数据。不能继续用普通 `python -m http.server` 作为真实联调入口，因为它不会代理 API。

首次部署后端时，可在后端目录执行（会构建实际计算镜像）：

```sh
sh start.sh --project sfl-local --http-port 18080 --tls-port 18443 \
  --subnet 172.29.220.0/24
```

后端已有本目录部署配置时使用 `sh start.sh --resume`，复用已有端口和持久数据。状态与停止操作使用后端的 `scripts/deploy.py`。前端通过 Ctrl+C 停止，后端不随前端静态进程关闭。

其他后端地址通过启动参数设置：

```sh
sh start.sh --backend-url http://127.0.0.1:8000
sh start.sh --backend-url https://backend.example.com --ca /safe/backend-ca.crt
# 当前环境默认 python3；也可显式指定，不修改用户级配置
SFL_FRONTEND_PYTHON=/path/to/python3 sh start.sh
```

`--backend-url` 是服务源地址，不含 `/api/v1`、凭证或查询参数。前端 `web/js/config.js` 默认 `apiBase: '/api/v1'`，`accessToken` 为空；无需将令牌或后端私密配置写入该文件。

## 真实连接行为

- 连接页先验证 `/me`，成功后才加载项目；令牌只存当前标签页的 `sessionStorage`，失效后回到连接页。
- JSON、上传、下载与 SSE 均携带 Bearer Header；导出错误会显示错误，不会保存成伪文件；SSE支持游标、重连、410快照恢复和关闭隔离。
- 切到空项目会清空上一项目详情、指标、图表、节点和历史；快速切任务时，旧响应和事件不能覆盖新选择。失效的上传或弹窗不能把旧文件提交给新项目。
- 新项目不会自动导入节点、数据集或任务。文件接入由服务端实际解析，不用浏览器猜测行数或合成样例。
- MPC 性能预估的假设行数不会冒充实际执行输入；PSI 对齐后的训练配置由后端按登记拓扑绑定。
- DP未知效用显示 `—` 及原因；未部署实现不能切换。训练和其他操作以实际后端状态及能力错误为准。

当前本地后端初始化提供持久化示例项目和公开数据资产；它们来自真实 API，并非浏览器生成的数据。实际业务使用自己的项目、节点和数据源。前端不扩大后端能力：动态机构拓扑、部分密码参数和DP框架尚有限制；技术指标评估当前后端明确标识为原型公式模拟，不是实际攻击实验或合同验收。

## 测试

Node.js 22+，无需第三方依赖：

```sh
node --test web/tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

现有测试覆盖真实传输契约、认证/失效重连、下载/上传、SSE恢复、DP空值/参数、项目与任务乱序响应、上传上下文，以及本地HTTP/TLS/SSE代理。测试请求桩仅用于隔离单元场景，不会被网页加载。

旧106条只针对已删除Mock实现的测试不再作为真实后端验收；原始内容可从Git历史 `6578ca3` 查看。本轮浏览器与请求证据保存在本机 `output/playwright/real-backend-20261025/`，运行产物由Git忽略。

## 验收资料工具

```sh
python3 tools/acceptance.py \
  --output output/acceptance \
  --unit-results output/acceptance/unit-results.json \
  --test-log output/acceptance/node.tap
```

该工具只汇总当前源码摘要绑定的客户端隔离测试；未带验收编号的用例保留为“未映射”，不会自动视为功能覆盖。浏览器记录需明确 `scope: real-backend-browser` 且 `source_sha256` 匹配；仓库内旧 Mock 浏览器记录仅作历史资料。`--no-test` 拒绝旧 scope 或源码已变化的缓存，Node 失败会返回非零状态。报告不能证明原生算法、129 个接口或合同指标全部通过。Excel 导出可选依赖 `openpyxl`，未安装时仍生成 HTML/JSON。

历史 `tools/gen_docs.py` / `tools/md2docx.py` 用于资料转换，可选依赖 `python-docx`；旧需求映射与截图不能直接作为当前操作或验收结论。本仓库未新增 CI workflow，以上本地测试和浏览器证据应独立核对。

## 部署资料

- [前端文件说明](web/README.md)
- [API契约](API.md)

生产部署将 `web/` 作为静态根目录，并同源反代 API；SSE关闭代理缓冲。原设计HTML与需求文档仅保留为设计资料，不参与当前站点运行。
