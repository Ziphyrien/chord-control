# Windows 桌面外壳

`lib.rs` 装配 Tauri 插件、命令和窗口事件。`controller.rs` 管理 sidecar 与 IPC，`desktop.rs` 管理窗口、数据目录和登录启动，`tray.rs` 管理托盘菜单。

运行 `bun run tauri:dev` 或 `bun run build:windows` 时，Tauri hook 自动执行 `bun run build:sidecar`，把 Node SEA 生成到 `binaries/`。编译需要 MSVC C++ Build Tools 与 Windows SDK。

首次 NSIS 安装注册当前用户登录启动，升级保留用户设置；关闭主窗口隐藏到托盘，退出先通知控制器清理插件资源。卸载清理启动注册项并保留插件数据。
