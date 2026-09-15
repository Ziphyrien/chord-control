# 分发地址

主程序和插件构建时解析当前 GitHub 仓库：优先使用 `CHORD_CONTROL_REPOSITORY`、`GITHUB_REPOSITORY` 或 `GH_REPO`，否则读取 `origin`。`vite.config.ts` 和 `scripts/build-controller.mjs` 将 owner/repo 编译进前端和 sidecar，运行客户机不需要 Git。

默认插件目录：

```text
https://github.com/<owner>/<repo>/releases/download/plugin-channel/catalog.json
```

插件不可变包使用本次发布的 tag；插件目录只在包已经上传后更新。发布工作流会用同一个 `github.repository` 注入地址，因此不会出现构建仓库与下载仓库不一致。

本地更换目标仓库：

```powershell
$env:CHORD_CONTROL_REPOSITORY = "OWNER/REPO"
bun run build
bun run build:sidecar
```
