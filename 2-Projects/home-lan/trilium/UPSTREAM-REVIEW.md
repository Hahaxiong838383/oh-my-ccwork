跟踪 TriliumNext 上游：稳定版 `v0.106.0` → `v0.106.0`。

[上游提交差异](https://github.com/TriliumNext/Trilium/compare/c0fdceba3b59af8a4473c6944b4f176121bb9788...cceea8eb019d18d89585a52af4eb4b5b0754ce6c) · [版本说明](https://github.com/TriliumNext/Trilium/releases/tag/v0.106.0)

稳定版未变，此 PR 仅更新上游跟踪基线；生产镜像保持。

已验证：源码 fetch、稳定标签、官方镜像摘要及 Linux amd64 清单。尚未验证：候选版本网页读写、附件、导入、备份恢复和 NAS 兼容性。合并不会自动部署；实际升级前需备份，在隔离实例验收，再更新生产与 deployed.json。

生产数据、凭据和私人笔记不在本 PR 中。
