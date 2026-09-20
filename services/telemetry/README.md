# 遥测接收服务

[状态页面](https://chord.zipawa.top)展示客户端、历史报告和诊断结果。使用部署时设置的管理密钥登录，核对计算机名、用户名和客户端 ID 后确认设备。

确认的设备保留7天历史；未确认设备保存最新报告，24小时未上报后清理。详情页显示最近12份样本。超过15分钟未上报时显示最后收到数据的时间。客户端采集与签名实现见[遥测插件](../../plugins/telemetry/README.md)。

## 结构

- Worker 验证 Ed25519 签名、报告结构与序号，提供查询和管理 API。
- D1 保存设备和历史报告。
- Durable Object 管理可休眠的 WebSocket 连接和待采集请求。
- `ui/src/routes/` 使用 SvelteKit：`/devices` 是设备列表，`/devices/[id]` 是设备详情，支持深链接与前进后退。
- `ui/src/lib/session.js` 管理内存凭据、请求取消和采集轮询；`client.js` 连接路由与会话；诊断和报告整理为独立 helper。请求函数与计时器可注入测试。
- 筛选、确认弹窗和完整报告使用 `@chord-control/ui` 的 Bits UI 组件。
- `ui/` 是独立 workspace `@chord-control/telemetry-dashboard`，拥有前端依赖和 `tsconfig.json`；`ui/vite.config.ts` 通过 `@chord-control/kit/static` 配置静态 SPA，使用 Kit 默认的 `src/routes`、`src/lib` 和 `src/app.html`，无需 `svelte.config` 或 `kit.files`。
- `ui/dist/` 是生成资源，由现有 Worker 的 `ASSETS` 提供。无需 Kit SSR 服务，构建目录不作为源码提交。`ui/build-static.mjs` 在构建后将 Kit 启动脚本提取为同源文件，以兼容 Worker 现有的严格 CSP。
- 父包 `chord-telemetry-server` 只保留 Wrangler 依赖，`tsconfig.json` 独立检查 Worker 并排除 `ui/`。

报告外层使用 `format: 1`；`host.native` 保存执行事实，`host.windows` 保存插件采集结果。未知或失败的读取保留其状态。后台原始报告可查看完整 API、代码、权限与进程身份。

## 本地开发与检查

在 `services/telemetry` 执行 `bun run build` 生成首份静态资源，然后在两个终端分别执行：

```sh
bun run dev:worker
bun run --cwd ui dev
```

Kit 开发服务器把 `/api` 请求转发到 `127.0.0.1:8787`。Worker 仍负责所有 API 和鉴权；页面刷新后需重新输入管理密钥。

`bun run --cwd ui check:svelte` 同步 UI 的 Kit 类型并检查组件。Worker 类型检查使用父目录的 `tsconfig.json`，不依赖 Kit 同步。从仓库根目录执行 `bunx vp test tests/telemetry-session.test.mjs tests/telemetry-view.test.mjs`，覆盖注入传输的竞态与轮询，以及实际 Kit 路由和 Bits UI 的浏览器交互。测试服务器以 `services/telemetry/ui` 为工作目录。

首次开发或新增 workspace 后，先在仓库根目录运行 `bun install`。父包的 `build` 委托 `ui` 执行构建；也可直接在 `ui/` 运行 `bun run build`。

## 部署

在 `services/telemetry` 执行：

```sh
vp exec wrangler d1 migrations apply chord-telemetry --remote
vp exec wrangler secret put ADMIN_TOKEN
bun run deploy
```

服务使用 `chord.zipawa.top/*` Worker Route，对应 DNS 记录开启 Cloudflare 代理。管理密钥存入 Cloudflare Secret；本地开发放在未提交的 `.dev.vars`。更改绑定后运行 `vp exec wrangler types`。

## 管理 API

通过 `Authorization: Bearer <管理密钥>` 访问：

| 请求                                   | 用途                   |
| -------------------------------------- | ---------------------- |
| `GET /api/devices`                     | 查询设备               |
| `GET /api/devices/:id`                 | 查询最新报告和历史     |
| `POST /api/devices/:id/trust`          | 确认设备、设置显示名称 |
| `POST /api/devices/:id/request-report` | 请求重新采集状态       |
| `GET /api/devices/:id/live`            | 查询连接和待采集状态   |

点击立即采集后，页面先等待1.5秒，再每2秒查看结果，最多15次。切换页面或退出会取消本页轮询；设备端待处理请求继续由连接服务管理。
