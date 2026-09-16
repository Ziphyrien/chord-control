# Windows 维护与更新

默认安装目录为 `%LOCALAPPDATA%\Chord Control`，数据目录为 `%LOCALAPPDATA%\ChordControl`。安装器不创建卸载程序、系统卸载项或快捷方式。首次安装和覆盖安装完成后后台启动，首次安装默认启用登录启动。升级保留已设置的登录启动选项。

## 停止与移除

日常通过托盘“退出控制器”正常退出；相关验证由插件提供。维护人员可以在命令提示符中运行：

```bat
"%LOCALAPPDATA%\Chord Control\chord-control.exe" --maintenance-stop
```

该命令撤销守护会话，等待主程序、守护进程和插件执行器退出，并给插件机会恢复其持有的系统设置。命令退出码非 0 时不要删除程序文件；先检查 `%LOCALAPPDATA%\ChordControl\guard\guard.log` 与 `controller-stderr.log`，确认程序已正常退出。仅手动结束一个进程会触发守护恢复。

维护停止成功后，在命令提示符运行以下命令可移除默认位置的程序和登录启动登记：

```bat
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Chord Control" /f
reg delete "HKCU\Software\chord\Chord Control" /f
rmdir /s /q "%LOCALAPPDATA%\Chord Control"
del "%LOCALAPPDATA%\ChordControl\first-run-complete"
```

若修改过安装目录，将程序路径替换为实际位置。保留数据目录，便于恢复配置和插件数据；只有确认不再需要备份时才另行移除 `%LOCALAPPDATA%\ChordControl`。插件在正常停用时只恢复仍由自身持有的注册表值，避免覆盖之后的用户改动。

## 热更新边界

- 插件 JS、UI 和资源由插件 CI 编译并签名。符合 `minHostVersion` 和 Chord 版本的插件可直接替换，客户机无需编译或安装 Node.js。升级失败保留已安装的插件版本。
- Tauri Rust 原生能力、SDK 不兼容变化、内嵌 Node 和桌面 UI 更新，需要发布主程序安装包。主程序每 6 小时检查更新；解锁后可从托盘检查并安装。
- 主程序更新先验证嵌入公钥对应的 `.sig`，再停止守护和插件，运行安装器。安装器启动失败会恢复服务。0.1.x 需要手动覆盖安装一次，0.2.0 起具有更新入口。
- 发布 CI 用 `src-tauri/tauri.release.conf.json` 开启签名产物。`TAURI_SIGNING_PRIVATE_KEY` 为独立 Tauri 密钥，与插件 PEM 私钥分开；公钥在 `tauri.conf.json` 中。私钥只留在 `.local/signing/` 和 Actions Secret。
- `app-v*` 标签版本须与 `package.json`、`Cargo.toml`、`tauri.conf.json` 一致。先完成编译和产物准备，再上传安装包、`.sig`、执行器、`latest.json`、`SHA256SUMS.txt`，最后公开 Release。

主程序和插件执行器均以当前用户权限运行，后台插件是可信代码；声明权限不是操作系统沙箱。守护不提供对管理员、整棵进程树结束或系统关机的防护。连续快速失败会停止自动重启并记录日志。
