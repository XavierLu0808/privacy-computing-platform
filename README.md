# 隐私计算平台前端

连接 `sfl_backend` API v1.2 的静态控制台，包含联邦学习、同态加密、多方安全计算、隐私求交和差分隐私页面。运行源码在 `web/`，无需 npm 安装或构建；任务、数据、指标与导出均通过真实后端获取。

## 环境与目录

- 本地启动：Python 3.9+、现代浏览器。
- 自动化测试：Node.js 22+；代理测试使用 Python 标准库。
- 后端需单独部署，并提供有效的访问令牌。部署步骤见后端仓库 README。

推荐目录：

```text
rare_earth/
├── sfl_backend/
└── sfl_frontend/
```

本仓库是前端源码的维护入口。后端仓库的 `web/` 是用于独立部署的静态发布副本；前端修改后需同步发布副本，再构建后端镜像。

## 本地启动

```sh
git clone https://github.com/XavierLu0808/privacy-computing-platform.git sfl_frontend
cd sfl_frontend
```

先启动后端，再从本仓库根目录运行：

```sh
sh start.sh --backend-url https://localhost:18443 \
  --ca ../sfl_backend/deployment/.generated/tls.crt
```

打开 [http://127.0.0.1:8412/](http://127.0.0.1:8412/)。此示例假定后端 HTTPS 端口为 `18443`，应替换为实际部署端口；后端默认端口 `8443` 可这样连接：

```sh
sh start.sh --backend-url https://localhost:8443 \
  --ca ../sfl_backend/deployment/.generated/tls.crt
```

直接执行 `sh start.sh` 时，代理默认连接 `https://localhost:18443`，并读取上述同级后端证书。以下参数适用于其他环境：

```sh
# 后端使用受系统信任的 HTTPS 证书，无需 --ca
sh start.sh --backend-url https://backend.example.com --port 8412

# 仅用于本机 HTTP 开发服务
sh start.sh --backend-url http://127.0.0.1:8000

# 查看全部参数，或指定 Python 解释器
sh start.sh --help
SFL_FRONTEND_PYTHON=/path/to/python3 sh start.sh --help
```

`--backend-url` 必须是服务源地址，不含 `/api/v1`、凭证或查询参数。代理将 `/api/*`、`/health/*` 转发到固定后端并校验 TLS；Ctrl+C 停止前端，不会关闭后端。端口占用时使用 `--port` 更换端口。普通 `python -m http.server` 不提供 API 代理，不能替代这个本地入口。

## 访问令牌

连接页面会先请求 `/api/v1/me` 校验令牌，成功后加载项目。当前系统没有普通用户注册、密码登录或自助领取令牌入口；访问令牌由后端管理员签发。

后端演示初始化会生成私密文件 `deployment/.generated/demo-token.json`。管理员可用编辑器查看其中的 `access_token`，在前端连接页输入。演示令牌默认有效期为 8 小时，过期后由管理员重新签发。不要将文件或令牌写入前端配置、Git 或分享链接。

令牌只保存在当前标签页的 `sessionStorage` 中。JSON、上传、下载和 SSE 均通过 Bearer Header 鉴权；令牌失效后回到连接页。`web/js/config.js` 默认使用同源 `/api/v1`，无需写入令牌或修改后端地址。

## 服务器部署

将 `web/` 部署为静态站点根目录，通过 HTTPS 对外提供服务；同一个域名下将 `/api/` 和 `/health/` 反向代理到后端。页面使用 Hash 路由，无需额外的前端路由重写。本地 Python 代理只监听回环地址，服务器部署请使用 nginx 等反向代理。

部署代理时需要：

- 保留 `Authorization` 请求头和 API 原始路径。
- 关闭 SSE 响应缓冲与缓存，允许长连接，并设置适合计算任务的超时。
- 上传请求体上限至少覆盖后端允许的文件大小及 multipart 开销；本地代理上限为 257 MiB。
- HTTPS 上游校验证书；使用自签证书时配置可信 CA，不关闭校验。

后端 Compose 已包含 nginx 和静态控制台。只使用后端自带控制台时，按后端 README 构建、启动并访问后端 HTTPS 入口即可，无需再运行本仓库的 Python 代理。

## 测试

从仓库根目录执行：

```sh
node --test web/tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

测试覆盖请求与鉴权、文件传输、SSE 恢复、项目和任务切换、旧响应隔离、空数据状态，以及 HTTP/TLS/SSE 代理。请求桩只在测试中使用，不会被网页加载。真实算法、端到端业务与部署环境应在实际后端上另行验证。

可生成带当前源码摘要的前端证据汇总：

```sh
python3 tools/acceptance.py \
  --output output/acceptance \
  --unit-results output/acceptance/unit-results.json \
  --test-log output/acceptance/node.tap
```

Excel 导出可选安装 `openpyxl`；未安装时仍生成 HTML/JSON。浏览器证据可通过 `--e2e-results /path/to/e2e-results.json` 传入，必须包含 `scope: real-backend-browser` 和匹配的 `source_sha256`。未映射编号、旧 Mock 结果和截图不能自动计为当前验收通过。

## 目录与文档

| 路径 | 内容 |
| --- | --- |
| `web/` | 唯一运行前端：静态资源和客户端测试 |
| `scripts/serve.py`、`start.sh` | 本地同源静态服务及固定后端代理 |
| `tests/` | Python 代理与证据工具测试 |
| `tools/` | 证据汇总、Markdown/Word 文档生成与转换 |
| `API.md` | v1.2 接口字段与响应约定 |
| `docs/acceptance/` | 需求原始资料、固定功能编号和历史实现映射 |
| `docs/api/`、`docs/design/` | 历史接口设计片段与设计源稿，使用范围见文档索引 |
| `output/` | 本地报告、截图和文档输出，Git 忽略 |

- [前端源码说明](web/README.md)
- [当前开发约定](docs/DEV-CONVENTIONS.md)
- [文档索引与资料范围](docs/README.md)
- [API 契约](API.md)

已移除旧单页演示、Mock 验收截图、过期报告和重复 Word 输出；历史版本可从 Git 历史查看。业务能力以实际后端为准：动态机构拓扑、部分密码参数与 DP 框架仍有限制，技术指标评估当前明确标为原型公式模拟。
