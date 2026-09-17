# 开发

安装 [Vite+](https://viteplus.dev/guide/)，在仓库根目录运行 `vp install`。
Vite+ 使用项目固定的 Node 版本和 Bun 1.4.2；独立运行时打包需要 Node 26。

| 命令                   | 用途                          |
| ---------------------- | ----------------------------- |
| `vp dev`               | 启动前端开发服务器            |
| `vp check`             | 格式、lint 和 TypeScript 检查 |
| `vp run check`         | 上述检查加 Svelte 组件检查    |
| `vp fmt`               | 格式化项目                    |
| `vp test`              | 运行行为测试                  |
| `vp run test:ui`       | 运行浏览器交互检查            |
| `vp build`             | 构建前端                      |
| `vp run build:windows` | 构建 Windows 安装包           |

发布构建在 GitHub Actions 执行。格式、类型和源码行为测试与构建并行，发布等待两者通过。

`vp` 的内置命令与 `package.json` 脚本分开：运行自定义脚本时使用 `vp run <名称>`。
格式、lint、测试和前端配置集中在 `vite.config.ts`。

测试独立运行时和已打包插件时，分别通过 `CHORD_TEST_SEA` 和 `CHORD_TEST_PLUGINS` 指定下载产物。
缺少产物时，这些检查会显示为跳过。

更新 Vite+ 时运行 `vp upgrade`、`vp migrate`、`vp install`，一起提交工具链版本与锁文件。
