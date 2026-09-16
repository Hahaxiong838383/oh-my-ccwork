# v0.9.2 基线补齐（2026-09-16）

当前 Studio 项目目录从独立仓库 `https://github.com/FUTURUS-ProductResearch/WarpDemo` 的 `main` 补齐。

- 固定来源提交：`ad557eee6e6c43eab494c09caef1828a903fa81d`。
- 基线版本：v0.9.2 (17)。未引入 `codex/nio-protopie-warp-skill` 分支。
- 来源 56 个文件中，55 个逐字节一致；README 保留本地“后续开发设备”章节。
- 保留本地开发设备、2026-09-08 部署回执、ProtoPie 安装记录及已有 `.rollback` 回滚资料。
- 仅同步源码、测试、默认配置和文档；未安装或启动 App，未写入运行中的用户标定配置，未同步远端设备。
- Git 差异格式及构建/安装/启动脚本语法检查通过。
- 本机 `swift build -c release --package-path native` 通过；日志：`/tmp/nio-baseline-build-20260916.log`。
- 本机只有 Command Line Tools；上一轮 Swift 测试因缺少 XCTest 失败，本次不重复执行。历史 v0.9.2 验收记录不等于本次实机验收。

后续应以此基线单独整合通用捕获修复；ProtoPie 自动启动及 MCP 的硬编码、超时问题另行处理。
