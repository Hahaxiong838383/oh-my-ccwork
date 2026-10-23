# OK笔记迁移 Trilium 与退役

2026-10-23，用户授权在已手动配置的 Trilium 基础上迁移全部 OK笔记内容，验收后卸载和删除 OK笔记。已完成；目标入口为 `http://192.168.1.115:38081/`，树根下「OK笔记迁移（2026-10-23）」。

## 迁移结果

| 内容 | 结果 |
|---|---|
| 笔记 | 405 篇：404 篇未删除、1 篇进入「原回收站（保留）」 |
| 目录 | 4 个书架、88 个笔记本，层级保留 |
| 原附件 | 2,743 个，全部解密成功，字节长度及已有 SHA 校验通过 |
| 附加留档 | 每篇原始正文、完整迁移元数据、6 个历史版本；合计 3,155 个附件 |
| 标签 | 27 个标签、67 个关联；映射为可检索标签并保留原标签值 |
| 内部链接 | 321 处重写到 Trilium，引用闭合，无悬空源笔记 ID |
| 思维导图 | 1 篇转换为可编辑大纲，同时附完整原始 JSON |
| 原目标数据 | 原有 402 条笔记记录、原属性/附件、所有 options 和 config.ini 均未变更 |

395 篇 Tiptap 富文本递归转 HTML，另有9篇普通正文/Markdown。正文顺序文字检查通过；表格合并单元格、任务状态、公式、文本格式和图片引用保留。4张原有外链图片保留原网址，仍依赖原站。历史版本以独立留档呈现，不是 Trilium 原生编辑历史。没有导入 mycc/MyAgent 目录，也没有开启双向文件同步。

## 验收

- 全405篇迁移正文、6个历史版本及3,155个附件经 ETAPI 回读 SHA 一致；3154个源正文/导图/附件/版本文件重新校验，源业务表未变化。
- 浏览器正常密码登录，4篇覆盖最多图片、最多表格、任务列表、公式及最长正文的样本通过：169张本地图加载、56张表、35个勾选框、2处公式。只读测试阻止笔记/配置写入；放行经源码核对的只读 POST `tree/load` 和 `notes/metadata`。
- OK笔记完整归档恢复到断网容器，同镜像正常启动，3篇正文和3个附件与导出哈希一致。
- Trilium 迁移后原生备份恢复到断网容器，3566个正文/历史版本/附件载荷全部回读 SHA 一致，SQLite integrity_check 通过。
- 卸载后目标506个迁移树节点、3155个附件仍在；4篇正文和3个附件再次回读通过，数据库 quick_check 正常。
- 转换器7项针对性测试通过。详细脱敏收据在 `4-Assets/Code/oknote-to-trilium/receipt.json`。

## 卸载与清理

官方 trim-cli 当前 OAuth refresh 仍报 `client mismatch`，未重建 OAuth 或回退旧 Web 登录。按既有授权使用 SSH，最终通过 NAS 原生 `/usr/local/bin/appcenter-cli uninstall oknote` 完成应用中心卸载。

应用中心登记、容器、`/var/apps/oknote`、`/vol1/@appcenter/oknote`、`/vol1/@appdata/oknote` 均已移除；38080端口关闭，未使用的旧镜像已删除。原生应用残留的 `@appmeta/@apphome/@appconf` 专属目录也已备份后清理。其余21个容器的 ID、镜像和端口映射保持不变，Trilium healthy。两个临时恢复容器及恢复副本已清理。未撤销或删除密码库凭据。

## 独立恢复资料

全部位于 NAS 私有目录（700）：

`/vol1/1000/docker/trilium/migrations/20261023-oknote/`

- `oknote-complete.tar.gz`：完整应用数据与旧思源/飞书迁移档案；10,093个应用数据文件，归档4,103,246,546字节，所含全部应用数据文件成员哈希核验。SHA-256 `f9ef8e889f0caaa1f62a711fed7b9e1e48aa190025ca1cccd71c3a7c345a7a5d`。
- `oknote-appdata/migrations/`：旧迁移恢复档案的独立副本。旧 `/vol1/@appdata/oknote/migrations/` 已不存在，恢复时改用此处或完整归档。
- `oknote-image.tar`、`oknote-container-private.json`、`oknote-native-entry.tar.gz`、`oknote-native-extra.tar.gz`：原镜像、私有运行配置、应用中心生命周期资料。
- `backup-before-oknote-20261023.db`、`backup-after-oknote-20261023.db`：Trilium 迁移前后原生备份。迁移后备份281,047,040字节，SHA-256 `58290dc327f5a47f0b9f96f33e303a7ba7fca460e4728bd9c07c1fce6c97825f`。
- 私有导出、源→目标映射、源文件哈希、恢复收据留 NAS；未进入聊天、Git 或共享记忆。

首次逐字节比较遇到 SQLite WAL/SHM 运行差异，最终使用短暂停机配合 SQLite backup API 生成独立一致性数据库，再归档和真实恢复验证。没有将 WAL/SHM 相同当成业务一致性的唯一判据。

恢复脚本与边界见 `4-Assets/Code/oknote-to-trilium/README.md`。这些备份仍在同一台 NAS，不是异机灾备。
