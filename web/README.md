# 控制台源码

`web/` 是前端的维护主源，也是静态部署根目录。后端仓库的 `web/` 是它的发布副本，用于后端独立部署；请在此维护页面，再同步到后端并重新构建镜像。

所有业务数据通过 `js/api.js` 请求真实后端，运行目录中不包含 Mock 服务。页面使用 Hash 路由，未登录连接状态下先显示令牌输入页。

从前端仓库根目录启动本地代理：

```sh
sh start.sh --backend-url https://localhost:8443 \
  --ca ../sfl_backend/deployment/.generated/tls.crt
```

访问 [http://127.0.0.1:8412/](http://127.0.0.1:8412/)，输入管理员签发的访问令牌。后端地址、端口、证书及部署说明见[前端 README](../README.md)。后端发布副本的访问方式与部署命令以该后端仓库根 README 为准。

| 路径 | 用途 |
| --- | --- |
| `index.html`、`styles.css`、`css/` | 页面外壳、样式和连接页 |
| `js/config.js` | 同源 `/api/v1` 配置；不保存令牌 |
| `js/connection.js` | `/me` 校验、标签页会话和失效重连 |
| `js/api.js`、`js/sse-client.mjs` | JSON、multipart、Bearer 下载和可恢复事件流 |
| `js/app.js` | 项目上下文、导航和空项目恢复 |
| `js/fl*.js`、`he*.js`、`mpc*.js`、`psi*.js`、`dp*.js` | 业务页面 |
| `tests/` | 客户端传输、DOM 与状态回归测试，不在生产页面加载 |
| `vendor/echarts.min.js` | 本地图表依赖 |

部署时保留同源 API 反向代理和 SSE 流式响应。切换空项目会清除旧详情；异步响应和流按当前上下文隔离。行数、字段与任务状态由后端返回；未知 DP 效用使用空态，不支持的功能显示后端原因。

从仓库根目录验证：

```sh
node --test web/tests/*.test.mjs
```
