# 插件 API 与热更新

主程序 0.4.0 起允许普通插件直接控制窗口、托盘和主程序更新。SDK 随调用方插件打包，不需要额外安装桌面 API 插件。旧版主程序需要先升级一次。

## 直接调用宿主

在插件 `package.json` 的 `control` 中声明：

```json
{
  "minHostVersion": "0.4.0",
  "permissions": ["host-control"]
}
```

在 facet 中使用 SDK：

```ts
import { HostKernel } from "../../../sdk/kernel.ts";
import { createDesktop } from "../../../sdk/desktop.ts";

// setup(env) 内
const desktop = createDesktop(env.use(HostKernel));
// 在操作函数中传入收到的 context
await desktop.setTrayVisible(false, context);
await desktop.setTaskbarVisible(false, context);
await desktop.installUpdate(context);
```

`setTrayVisible` 控制通知区托盘图标；`setTaskbarVisible` 控制主窗口的任务栏按钮。`true` 撤销当前调用方的隐藏请求。多个插件同时要求隐藏时，最后一个请求释放后才显示。插件暂停、卸载、更新或控制器断开后，宿主自动释放对应会话，不需要在清理函数中再次调用桌面 SDK。

还可调用 `info`、`windowState`、`open`、`hide`、`minimize`、`quit`、`checkForUpdate` 和 `updateStatus`。打开和退出仍遵循原有验证流程。更新请求返回 `{ started: boolean }`；`false` 表示已有检查或安装正在进行，此时可用 `updateStatus` 查询 `busy`、`availableVersion` 和 `error`。安装更新异步完成，始终验证内置发布公钥，并由宿主处理插件清理和安装器交接。持有 `host-control` 的插件可发起无人值守更新；托盘手动安装仍要求解锁。

## 增加功能

文件、网络、进程和业务逻辑可以直接在普通插件中实现。SDK 中增加封装或组合现有操作后，重新发布调用方插件即可，宿主无需重新编译。每个插件使用归档内打包的 SDK，不受其他插件升级影响。

需要独立运行、供多个插件共享的功能，可以选择 Chord 服务插件：用 `defineService` 定义契约、`env.provide` 注册实现，并在清单的 `services.provides` 导出服务 ID。调用方在 `services.requires` 声明依赖。无需在主程序添加服务名或方法名白名单。

服务插件升级时按依赖顺序重载提供者和调用方，主程序和控制器进程保持运行，无关插件保持运行。候选插件无法启动时恢复旧版。不兼容的契约应使用新的服务 ID，例如 `example.capture.v2`，保留旧版直到调用方迁移完成。

跨服务调用应透传收到的 `context`。运行时保留最初调用方的权限和资源会话；使用宿主能力时，提供者和调用方都需声明 `host-control`。这是可信插件的能力管理，不是 Node.js 沙箱：已安装的代码仍可以使用 Node.js 内置模块。

## 基础内核与原生辅助程序

`HostKernel.call` 是版本化基础通道。`kernel.call("info", null, context)` 返回协议版本、宿主版本、平台、支持的操作、主程序路径、PID 和 Windows 主窗口句柄（十进制字符串）。先通过操作列表判断底层能力是否存在。

需要更多 Windows API 时，在 CI 编译独立 `.exe`，通过 `control.assets` 放入签名归档。用 `ControlHost.paths()` 取得 `bundleDir`，通过 Node.js 子进程或现有 `process.spawn` 原生能力启动辅助程序。在 `env.own` 中关闭 IPC、结束辅助程序并恢复外部资源。更新时只替换对应插件和辅助程序，不向主程序加载 DLL。

新增 SDK 方法、插件逻辑和原生辅助程序通常只需更新插件。必须修改 Tauri 内部实现或新增宿主基础操作时仍需整包升级；新的 SDK 无法执行旧宿主没有实现的 Rust 方法。
