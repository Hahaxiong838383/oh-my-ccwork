# OK笔记 → Trilium 迁移审计脚本

2026-10-23 飞牛2迁移的脱敏代码。脚本是当次任务的审计记录，有固定路径、版本和前置收据要求，不是可直接重跑的通用安装器。私有内容、原始清单、恢复归档及实际凭据均留在 NAS；本目录不保存它们。

- NAS 私有迁移目录：`/vol1/1000/docker/trilium/migrations/20261023-oknote/`，权限 700。
- 凭据来源：密码库「飞牛nas登录信息」「飞牛2 TriliumNext 登录与维护」。仅通过进程内存和 SSH stdin 使用，不打印或入 Git。
- `backup.py`：停源服务、SQLite backup API 一致性数据库、完整应用数据/历史档案归档与成员哈希验证、镜像留档；进程退出恢复守护。
- `export.py`：在 NAS 解密正文、版本和附件，验证 GCM、长度和已有附件哈希。原始数据只写入 NAS 私有目录。
- `convert.py`、`importer.py`：严格富文本转换、稳定笔记 ID、可续跑清单、ETAPI 写入及立即回读。未知节点/丢失正文/缺失附件拒绝继续。
- `verify.py`：全量正文附件回读、内部链接闭合、源文件未变化、原 Trilium 笔记/属性/附件/配置未变化。
- `restore-source.py`、`restore-target.py`：从实际归档/数据库备份启动断网容器，验证应用及内容。
- `browser.cjs`：独立浏览器只读抽查，不保存截图、正文、凭据或浏览器会话；禁外部请求及笔记写操作。
- `retire.py`：所有迁移/恢复/浏览器收据通过，冻结源数据后再核对，使用 fnOS 原生应用管理器卸载，检查注册表、容器、端口、数据和其他容器。

Python 依赖：NAS 系统已有 `cryptography`；转换依赖 `markdown-it-py==4.0.0` 与 `mdurl==0.1.2`（任务目录安装，不改系统环境）。浏览器依赖已有 Playwright/Chromium。`test_convert.py` 的7项测试覆盖实际转换风险。

恢复时先保留当前 Trilium 数据，用 `backup-after-oknote-20261023.db` 和匹配 Trilium 镜像在隔离目录启动。若要恢复旧 OK笔记，加载 `oknote-image.tar`，从 `oknote-complete.tar.gz` 恢复 data/config 与保存的运行配置；`oknote-native-*.tar.gz` 另存应用中心生命周期资料。凭据/密钥归档是敏感文件，只在受限 NAS 目录解包；不要复制到 Git、聊天或共享记忆。

边界：导图转换为可编辑大纲并附原始 JSON；4张源外链图片保留原网址；版本是独立留档，不伪装为 Trilium 原生编辑历史。所有旧思源/飞书迁移恢复档案仍在独立备份中。无自动双向同步、无 mycc/MyAgent 文件导入。
