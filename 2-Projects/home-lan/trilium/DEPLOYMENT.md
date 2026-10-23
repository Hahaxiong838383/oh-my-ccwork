# TriliumNext 部署与上游跟踪

日期：2026-10-23。用户授权拉取源码、每周跟踪和维护 PR、飞牛2 Docker部署。

## 部署

- 主机：FNOS-2 / 192.168.1.115；入口 http://192.168.1.115:38081/ 。仅局域网地址绑定，无新增公网映射。
- 官方稳定版 v0.106.0，源码提交 c0fdceba3b59af8a4473c6944b4f176121bb9788。
- 固定镜像 `triliumnext/trilium:v0.106.0@sha256:be93e82699b12950ac4e2e7b565ce092fe215b8dd6ddfc47921e37b49e6a0e8b`，镜像标签、实际 API 版本/构建提交与源码标签一致。
- Compose：`/vol1/1000/docker/trilium/compose.yaml`；同目录 `data/` 与 `backups/` 分开持久化。SQLite内置，无额外数据库容器。
- restart unless-stopped、60秒停止宽限、日志10MiB×3；官方健康检查通过，界面简体中文。
- 登录密码与ETAPI维护token：密码库「飞牛2 TriliumNext 登录与维护」，写后逐字段回读验证；值未进入代码、命令参数或Git。

## 维护

本地源码：`~/home-lan/runtime/trilium-upstream/`，独立 Git 仓，当前检出稳定标签；每周 fetch 跟踪上游 refs。

配置与脚本真源：`~/home-lan/4-Assets/Code/trilium-maintenance/`。脱敏快照发布到私有 `Hahaxiong838383/oh-my-ccwork` 的 `2-Projects/home-lan/trilium/`，维护 PR 也提交到该目录，不给上游提交空 PR。

定时器 `trilium-upstream-check.timer`：home-studio 每周一09:20北京时间，Persistent=true。检查源码、稳定发布、官方镜像摘要及amd64支持；有变化才开草稿PR，已有未关闭PR不覆盖其分支；不自动合并/部署。检查状态在 `~/.local/state/trilium/update-status.json`。

## 验收与边界

- 未授权ETAPI返回401；授权版本API、Markdown正文读写和附件字节哈希验证通过。
- 中文桌面网页登录、真实正文编辑与刷新后持久化通过；手机尺寸浏览器登录/查看通过，未做真实手机测试。
- 新生成备份的SQLite完整性检查通过；独立临时容器从备份启动，正文和附件哈希均一致，恢复测试容器和目录已清理。
- 原生每日/每周/每月备份开关均已回读启用；备份仍在同一NAS，异机灾备尚未接入。
- 初次快速导航时捕获一条前端初始化异常；等应用就绪再正常打开后未复现。初次编辑探针误选快速搜索框，已改为正文编辑器后重新验收，以最后持久化结果为准。
- OK笔记保持原服务，未迁移私人笔记、未扫描mycc/MyAgent正文、未配置目录双向同步或云AI。

## 为什么本次用 Docker

用户本轮明确指定Docker，优先于本仓一般“应用中心优先”建议。trim-cli fnos2读取Compose再次报OAuth refresh client mismatch，未反复刷新或代办OAuth；通过已有授权SSH公钥和密码库sudo通道部署。首次初始化只绑定loopback，设置并入库密码后才绑定NAS局域网地址。

部署与恢复验证明细见维护目录的 validation.json 和 README.md。

## 实际接线验收

- systemd后台真实创建草稿PR https://github.com/Hahaxiong838383/oh-my-ccwork/pull/2 ；仅上游跟踪基线与评审说明两文件，生产版本未改。再次运行exit0、pr_pending_review，PR head保持。下次2026-10-26 09:20 CST。
- 后台不能使用本轮会话的Codeg credential helper；普通GitHub token缺PR权限（403）。最终读取密码库既有「GitHub token - 大权限」条目，仅内存使用，无新建/轮换GitHub凭据。
- 重启容器后欢迎文档哈希保持；临时验收笔记已删除；原有21容器名称、镜像和端口与部署前一致。
- 自动周期备份未到首个周期；已创建initial备份并验证，不能把开关启用写成已观察到定时备份。
