# 发布插件

插件发布到自己的 GitHub 仓库后，用户可以通过目录或独立插件地址安装。

## 准备插件

在 `plugins/<名称>/` 放置 `package.json`、`src/worker.ts` 和可选的 UI 页面。清单声明版本、权限、最低主程序版本，以及提供和依赖的服务。可以参照仓库中的系统信息插件。

[SDK 源码](../sdk/)与内置插件可作为开发参考。依赖关系决定启动顺序，同一个服务应有唯一提供者。

## 配置发布密钥

运行 `vp run keys:generate` 生成 Ed25519 密钥。将私钥保存为仓库 Secret `PLUGIN_SIGNING_PRIVATE_KEY`，将公钥保存到 `config/plugin-public.pem`。已经发布的仓库继续使用现有密钥。

## 发布更新

更新插件版本并推送到 `main`。GitHub Actions 并行执行静态检查和插件构建，通过后发布归档并更新 `plugin-channel`。

分发地址为：

```text
https://github.com/<owner>/<repo>/releases/download/plugin-channel/catalog.json
```

用户在“设置”中填写目录地址和发布者公钥，在“插件”页面点击“检查更新”。单独发布的 `<插件ID>.json` 地址可以用于“添加插件”。

目录和清单经过签名校验，归档经过完整性校验。发布中断时可重跑原工作流；公开的归档持续保留，供已安装版本使用。

## 发布主程序

同步修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本，并填写对应版本说明。配置 `TAURI_SIGNING_PRIVATE_KEY` 后，推送 `app-v<版本>` 标签。

Windows 构建与静态检查并行执行，发布等待两者通过。正式版本包含安装程序、更新签名、独立运行时、更新元数据和校验文件。用户可在托盘菜单选择“检查并安装主程序更新”。
