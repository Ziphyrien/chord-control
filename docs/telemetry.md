# 运行遥测

访问 https://chord.zipawa.top ，使用部署时设置的管理密钥进入。首次收到客户端报告后，在列表核对计算机名、用户名和客户端ID，点击“确认此客户端”开始保留7天历史。未确认设备仅保留最新报告，24小时未上报后清理。页面显示最近12份历史样本。

客户端默认每5分钟上报一次；点击“立即采集”会通过客户端主动建立的WebSocket连接请求一份新报告，通常数秒内完成，单次采集和上传最多等待30秒。连接断开时保留一个待处理请求，重连后执行。失败会退避重试，周期上报最长退避至30分钟。超过15分钟未上报只表示未收到近期数据，不能据此确定机器关机。

## 架构边界

主程序通过 Chord 的 `HostDiagnostics` 服务提供通用只读快照，使用者必须声明 `diagnostics` 权限。主程序不引用遥测插件ID、上传地址、Cloudflare或周期上传逻辑。其他插件可提供可选的 `PluginDiagnostics` 服务，指标结构位于 `sdk/diagnostics.ts`。

`plugins/telemetry` 独立负责采集、客户端身份、签名、上传、重连；`services/telemetry` 独立负责存储和查询。遥测插件需要主程序0.4.4提供通用观测接口。暂停或忽略遥测插件即可停止上报，其余功能继续运行。

客户端唯一ID为本机生成的Ed25519公钥的SHA-256，身份保存在该插件的数据目录。用户名和计算机名是可搜索的显示信息。重命名保留身份，清空身份文件会生成新客户端；克隆机器前不要复制该身份文件。签名证明报告来自同一身份，不等同于管理员已确认该设备。

## 指标与远程排查

| 数据                                     | 含义                                            |
| ---------------------------------------- | ----------------------------------------------- |
| version / latestVersion                  | 当前安装版本和已发现的可用版本                  |
| running / status / sourceStatus          | 实际插件运行状态、本地选择及来源状态            |
| attempts / succeeded / failed / inFlight | 统计起点以来的调用与完成次数                    |
| successRatio                             | 成功调用数除以已完成调用数；没有样本时为空      |
| meanMs / maxMs / lastMs                  | 调用平均、最大和最近耗时，单位毫秒              |
| since / lastSuccessAt / lastFailureAt    | 统计起点和最近成功、失败时间                    |
| process                                  | 控制器进程的运行时长、内存字节数和累计CPU微秒数 |
| 插件自报指标                             | 各插件通过同一契约提供的计数器与瞬时值          |

调用指标保存在主程序内存中，重启后重新计数；每份报告带有统计起点，历史样本不会伪装成跨重启累计值。插件自报值未实现或读取失败时显示未知或明确错误。诊断时先请求新报告，再检查状态、最近错误、调用成功比例和耗时，最后查看业务插件自报的效果指标。API调用成功不等于业务效果已通过验证。

例如学习权限插件的 `policy.passed / policy.checks` 衡量当前系统设置通过核验的数量，`policy.complianceRatio` 为通过比例，`policy.owned` 表示当前插件代是否拥有策略。其检查实现完全位于学习权限插件中，主程序和遥测页面不包含特例逻辑。

遥测投影不读取密保盘密码、便笺、原始配置公钥或任意文件。报告包含计算机名、用户名、错误和最近20条活动；管理员应仅在受管理设备上启用。

## Cloudflare部署

无需VPS。Worker接收报告，D1保存最新状态和历史，SQLite Durable Object按客户端管理可休眠的WebSocket连接和待采集请求。小规模可从Cloudflare免费额度开始，实际配额和超额行为以账户方案为准。

此项目使用 Worker Route `chord.zipawa.top/*`，`custom_domain: false`，不绑定Custom Domain。对应DNS记录必须启用Cloudflare代理；Worker直接处理请求，无需自建源站。

在 `services/telemetry` 执行：

```sh
vp exec wrangler d1 migrations apply chord-telemetry --remote
vp exec wrangler secret put ADMIN_TOKEN
vp exec wrangler deploy
```

管理密钥只存Cloudflare Secret，客户端用各自私钥签名，不包含管理密钥。本地开发使用未提交的 `.dev.vars`。每次更改绑定后执行 `vp exec wrangler types`。

管理API使用 `Authorization: Bearer <管理密钥>`：`GET /api/devices`、`GET /api/devices/:id`、`POST /api/devices/:id/request-report`、`GET /api/devices/:id/live`。主动采集仅允许重新读取状态，不接收脚本或任意控制命令。
