# Kit 构建配置

控制中心、四个插件 UI 和遥测后台都是独立的 SvelteKit 应用。每个应用使用标准 `src/routes`、`src/app.html`、`src/hooks.ts` 和自己的 `vite.config.ts`；没有 `svelte.config.js` 或已弃用的 `files` 目录覆盖。

| 位置                     | 用途                                                         |
| ------------------------ | ------------------------------------------------------------ |
| 仓库根目录               | Tauri 控制中心；根布局持有连接会话，页面负责插件、活动和设置 |
| `plugins/<name>/ui/`     | 单个插件的 UI 工作区，服务代码留在父目录 `src/`              |
| `services/telemetry/ui/` | 遥测设备列表与详情；通过 HTTP 客户端调用父目录的 Worker      |
| `packages/ui/`           | Bits UI 交互封装、通用组件与主题                             |
| `packages/contracts/`    | Chord 插件间服务契约                                         |

`createStaticConfig` 生成传给 `sveltekit(...)` 的内联配置，使用静态适配器。`createPluginConfig` 在此基础上开启单文件内嵌输出。Vite+ 的 `lazyPlugins` 延迟插件实例化，使任务发现阶段不写入其他应用的 Kit 生成目录。

插件清单的 `control.uiProject` 指向 `ui/vite.config.ts`。发布脚本在 UI 工作区内构建，并将单个 `ui.html` 写入签名归档。构建使用 production 模式和稳定的 Kit 标记；更新身份由归档摘要与宿主页面地址管理。`sdk/PluginPage.svelte` 注入 RPC，并在页面退出或切换呈现方式时取消请求。

在仓库根目录运行 `vp run sync:svelte` 同步所有路由类型，运行 `vp run check:svelte` 分别检查每个应用。插件仍可独立发布和更新，用户机不需要 Kit 服务端、Node.js 或开发依赖。
