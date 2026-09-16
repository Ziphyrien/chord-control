# 发版任务

- [x] Windows API、注册表和浏览器监测改为 Rust 原生调用，移除运行时 PowerShell；策略留在插件内。
- [x] 安装器不生成卸载程序、不写入卸载项、不创建开始菜单或桌面快捷方式；记录维护移除方法。
- [x] 说明热更新边界并接入签名的主程序更新。
- [x] 使用指定 API 重新生成浅色壁纸；凭据仅保存在本地忽略目录。
- [x] 实现双进程互相监控和有界恢复；正常退出、维护和升级撤销守护会话。
- [x] 浏览器监测改用原生进程快照，移除 PowerShell / WMI 启动等待。
- [x] 修复窗口 label、显隐生命周期和桌面请求超时。
- [x] 从 workflow 移除运行测试及 Playwright 安装步骤。
- [x] 删除密保盘提示文案。
- [x] Oxfmt / Rustfmt 格式化、Oxlint、Knip 和静态边界检查。
- [x] GitHub Actions 编译成功，核验 CI 产物并发布可下载的 Windows 0.2.0 安装包。

按最新要求不在本机编译，编译和打包由 GitHub Actions 完成。双进程恢复及安装器运行行为待使用 CI 产物核验。维护与升级说明见 [docs/maintenance.md](docs/maintenance.md)。
