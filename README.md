# Chord Control

面向 Windows 的插件控制程序。首次安装后默认登录启动，关闭窗口后在托盘中继续运行。控制器定期检查 GitHub 上的签名插件目录，下载有变化的插件并运行；断网重启时恢复本地版本。

## 开发与构建

开发依赖：Bun 1.4.2、Node.js 26、Rust stable，以及 Visual Studio C++ Build Tools / Windows SDK。Bun 负责包管理和脚本调度，Node 用于 Chord 运行时及 SEA 打包。安装包内嵌运行时，使用者无需安装 Bun 或 Node.js。

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run tauri:dev
```

`bun run dev` 启动前端开发服务器；`bun run controller:dev` 单独启动控制器。完整桌面操作使用 `tauri:dev`。

```sh
bun run build:windows
```

Tauri 的构建 hook 自动生成前端与独立 sidecar：

- 安装包：`src-tauri/target/release/bundle/nsis/*.exe`
- 独立控制器：`src-tauri/binaries/plugin-controller-x86_64-pc-windows-msvc.exe`

默认构建 Windows x64。ARM64 需要匹配架构的 Node、Rust 目标和 `TAURI_TARGET_TRIPLE=aarch64-pc-windows-msvc`。Windows 图形界面使用 WebView2。

依赖由 `bun.lock` 锁定。Svelte 编译配置集中在 `vite.config.ts`。TypeScript 7 通过 `@typescript/native` 别名用于检查；最新版 svelte-check 仍要求 TypeScript 6 作为兼容依赖，因此两者同时安装，`check` 使用其支持的 `--tsgo` 模式。

## 插件自动发布

仓库中的 [plugins 工作流]（会执行 Knip）(.github/workflows/plugins.yml) 在 `main` 上相关文件变更后自动发现 `plugins/*`、编译、签名并发布。先发布带版本的插件文件，再更新固定地址的签名目录。控制器通过目录发现新插件和移除项，通过内容哈希决定是否下载更新。

1. 运行 `bun run keys:generate`，生成 `.local/signing/private.pem` 和 `public.pem`。
2. 把私钥完整内容写入仓库 Actions Secret `PLUGIN_SIGNING_PRIVATE_KEY`。私钥目录已从 Git 排除。
3. 将仓库推送到 GitHub 的 `main` 分支，运行 `Publish plugins` 工作流。
4. 程序默认在编译时从当前 GitHub 仓库解析分发地址，目录为 `https://github.com/OWNER/REPO/releases/download/plugin-channel/catalog.json`；也可在设置中覆盖，并填写发布者公钥。GitHub Actions 通过 `github.repository` 注入同一个地址。

公钥由发布者单独提供，控制器将其固定到插件源。签名覆盖插件身份、版本、下载地址和哈希。当前下载器支持公开 HTTPS 发布源；私有 GitHub 仓库的认证尚未接入。

Windows 工作流运行 Oxlint、格式检查、类型检查、集成测试、真实定时测试、浏览器交互、安装包构建和 SEA 测试，产物保存在 Actions Artifacts 中。

## 编写插件

参考 [系统信息与便笺](plugins/system-info)：

```text
plugins/my-plugin/
  package.json
  src/worker.ts
  ui/index.html
  ui/main.ts
```

`package.json` 的 `name` 是稳定插件 ID，`version` 使用 `x.y.z`。`control.name` 是显示名称，`control.ui` 和 `control.uiScript` 指定可选界面。UI 模板通过 `<!--PLUGIN_SCRIPT-->` 插入编译后的浏览器脚本。`control.assets` 可以声明需要打包的文件。

后台默认导出 Chord facet。通过 [sdk/index.ts](sdk/index.ts) 的 `ControlHost` 获取数据目录、记录日志和打开插件窗口，通过 `PluginUi` 提供界面调用的方法。插件可以在 `control.services` 中声明 Chord 服务的 `provides` / `requires`，在自己的包里定义服务契约；控制器使用 Chord 的 `RemoteServiceSource` 动态连接它们。`control.hooks` 声明通用宿主操作钩子，策略由插件自己实现。激活时申请资源，使用 `env.own()` 注册清理。界面使用 [sdk/ui.ts](sdk/ui.ts) 的 `callHost()` 调用后台。

仓库内置的 `com.chord.password-pad` 用当天“月份 + 日期 + 星期英文首字母”生成一次性滑动密码，`com.chord.app-guard` 通过 Chord 服务保护打开控制中心、退出和设置操作，`com.chord.study-guard` 管理浏览器限制与学习壁纸。壁纸使用 Windows 当前用户策略注册表固定，数据和原值由插件保存并在停用时有条件恢复。插件资源和依赖由 CI 编译进签名包，客户机不需要安装 Node.js。

```sh
bun run plugins:build --unsigned
```

此命令生成本地开发包。正式工作流使用 Ed25519 私钥签名。控制器默认拒绝未签名包；本地测试可显式使用 `CHORD_CONTROL_ALLOW_UNSIGNED=1`，回环 HTTP 测试需 `CHORD_CONTROL_ALLOW_LOCAL_HTTP=1`。

构建脚本把 JS 依赖编入每个插件，只保留 Node 内置模块作为外部依赖。插件无需在使用者机器上安装依赖。带原生二进制的插件需要自行提供匹配 Windows 架构与运行时的文件。

后台插件以当前用户权限执行，可以访问文件、网络或启动子进程。它们共享控制器进程，适合可信插件；插件 UI 在带访问令牌的本地页面中运行，通过受限 iframe 调用自己的后台。`permissions` 是能力声明，不是操作系统权限隔离。

新增版本激活成功后替换旧版本；激活失败时保留旧版本。暂停状态跨重启保留；目录移除项会被停用并移出列表，手动移除项不会被下一轮目录检查重新添加。用户数据保存在 `%LOCALAPPDATA%/ChordControl/data/<plugin-id>`，移除插件及卸载程序时保留。

## 检查与格式化

```sh
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

Oxlint 检查 JavaScript、TypeScript 及 Svelte 的脚本部分，警告也会使检查失败。Oxfmt 统一格式化 JS/TS、Svelte、CSS、HTML、JSON、YAML、TOML 和 Markdown；Rust 文件由同一格式化命令调用 `cargo fmt` 处理。配置位于 `.oxlintrc.json` 和 `.oxfmtrc.json`，Svelte 格式化已显式启用。

两项工具遵循 `.gitignore` 排除生成物，锁文件保留包管理器生成的格式。`format:check` 检查格式但不写入文件。两个 CI 工作流都会运行 lint 和格式检查，Svelte 模板与类型检查仍由 `bun run check` 负责。

## 验证

```sh
bun run test:architecture
bun run test
bun run test:periodic
bunx --no-install playwright install chromium
bun run test:ui
bun run build:sidecar
bun run test:sea
```

集成测试使用真实 Chord 插件、临时签名密钥和发布服务器。覆盖签名拒绝、安装、更新失败保留旧版、离线恢复、UI 调用、暂停清理、目录增删、路径保护和可复现打包。定时测试等待真实一分钟周期；SEA 测试把可执行文件复制到临时目录，在无项目依赖、PATH 不含 Node 的环境中启动。

模块职责和依赖方向见 [架构说明](docs/architecture.md)。
