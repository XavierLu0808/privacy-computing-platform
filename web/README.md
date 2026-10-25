# 控制台运行目录

此目录只包含真实后端客户端与静态资源。已移除Mock服务、模拟数据与模拟定时器；所有数据通过 `js/api.js` 请求后端。

从仓库根目录运行：

```sh
sh start.sh
```

访问 [http://127.0.0.1:8412/](http://127.0.0.1:8412/)，在连接页输入有效访问令牌。默认通过同源代理连接 `https://localhost:18443`；参数、证书和后端启动见 [根README](../README.md)。不要使用普通静态服务器替代代理来联调 `/api/v1`。

| 路径 | 用途 |
| --- | --- |
| `index.html`、`styles.css`、`css/` | 控制台与连接页 |
| `js/config.js` | 同源API地址，空令牌 |
| `js/connection.js` | `/me`校验、标签页会话与失效重连 |
| `js/api.js`、`js/sse-client.mjs` | 真实JSON、multipart、Bearer Blob下载和可恢复事件流 |
| `js/app.js` | 项目上下文、导航、空项目及启动恢复 |
| `js/fl*.js`、`he*.js`、`mpc*.js`、`psi*.js`、`dp*.js` | 业务页面与后端结果展示 |
| `tests/` | 无生产模拟服务依赖的传输/DOM回归 |
| `vendor/echarts.min.js` | 本地图表库 |

新建项目不注入演示数据；上传的行数、字段和状态由后端实际解析。未知DP效用显示空态，未部署DP实现不能切换。后端能力不支持的组合会显示明确原因，不生成假的训练、解密或求交结果；评估页明确展示后端当前的原型公式模拟限制。

所有页面资源版本为 `1.2.9`；本地服务器设置重新验证缓存。现有浏览器原Mock数据库键会被一次性删除，其他存储和真实访问令牌不受影响。

```sh
# 从仓库根目录运行
node --test web/tests/*.test.mjs
python3 -m unittest discover -s tests -v
```
