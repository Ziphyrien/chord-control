# 主程序更新诊断

发现程序自动退出后没有回来，先采集，再重试安装。记录看到问题的时间，保留 `%LOCALAPPDATA%\ChordControl\updates` 中的安装包。不要先删除更新目录或反复重启；后续事件可能覆盖最有价值的时间段。

## 一次采集

0.4.7 起，安装目录包含 `collect-update-diagnostics.ps1`。打开 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Chord Control\collect-update-diagnostics.ps1"
```

使用自定义安装目录时替换脚本路径。在源码工作区可执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-update-diagnostics.ps1
```

脚本会在桌面生成 `Chord-update-日期-时间.zip`，并打印完整路径。它只读应用和系统状态，写入诊断包，不启动安装器、不结束进程、不修改更新设置。默认检查最近 24 小时，每个事件通道最多读取 1000 条；可用 `-Since "2026-09-21 00:10:00"` 指定更准确的时间，`-Destination "D:\Diagnostics"` 指定导出目录。

诊断包包括：

- `collection.json`：采集时间、时区和读取失败的项目。日志不可读会标记 `unavailable`，不会被当作没有错误。
- `processes.json`：主程序、守护进程、控制器、更新安装器的 PID、父 PID、路径和创建时间；不导出完整命令行。
- `installed.json`、`installers.json`：已安装版本与最近 10 个更新包的时间、大小和 SHA-256；不复制安装器。
- `host.log`、`installer.log` 及其前一段：存在时复制更新日志。
- `settings-summary.json`：更新开关、检查间隔和插件版本摘要；不复制完整配置、插件数据或守护令牌。
- `events.json`：与 Chord 相关的应用错误、Windows Defender、Code Integrity 和 AppLocker 记录。

## 如何判断停在哪里

0.4.7 起，主程序把 JSON 行日志写入 `%LOCALAPPDATA%\ChordControl\updates\host.log`。每次检查有独立的 `attempt`，并记录进程 ID、主程序版本和毫秒时间戳。安装器把自己的阶段日志写入同目录的 `installer.log`；通过 PID、安装包路径和时间对照两份日志。主程序日志达到约 1 MiB、安装器日志达到约 512 KiB 时轮换，各保留前一段。

| 最后留下的证据                                  | 排查方向                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `download_started` 后失败                       | 网络或签名校验，原程序仍在运行                                                                        |
| `download_verified`、`installer_staged`         | 下载与写盘已完成，检查后续交接                                                                        |
| `prepare_started`，没有 `prepare_finished`      | 守护进程或控制器退出阶段                                                                              |
| `installer_spawn_requested` 后 `handoff_failed` | Windows 创建安装器进程失败，错误在同一 attempt 中                                                     |
| `installer_spawned`，没有安装器初始化记录       | 安装器在脚本执行前退出、被阻止或无法写日志；结合系统事件，不能仅凭日志缺失断定拦截                    |
| 安装器维护检查、运行时检查或文件替换失败        | 按 installer.log 中的阶段与状态定位                                                                   |
| 安装器启动应用成功，没有 `startup_ready`        | 新程序初始化未完成，继续看 `startup_started`、`startup_failed` 与应用错误事件                         |
| `startup_ready`                                 | 主窗口、托盘和初始化流程已完成；`controller_started` 只表示控制器启动调用成功，不等于全部插件已经激活 |

`installer_spawned` 仅表示创建进程成功，安装器的“应用已创建”也不是启动完成回执。以新版本 `startup_ready` 和当前实际进程为准。被强制结束的进程可能来不及写最后一条；日志缺失本身不是成功或失败的证明。

## 采集之后

确认安装器已经不在运行，再用已校验的安装包重试一次。记录重试时间与退出结果，将重试前后的两个诊断包分开保留。当前设计的这些日志用于定位问题，不会自动重跑安装或改变更新失败恢复策略。

从旧版升级到 0.4.7 时，旧主程序没有新的 host.log，但 0.4.7 安装器能够记录安装阶段，新程序启动后也会留下回执。完整的下载和交接日志从运行 0.4.7 后的更新开始提供。
