# fnmedia-ext 加固部署快照

真源：`~/home-lan/`。2026-10-31飞牛1已升级并启用独立Lite加固版 **0.2.19.3**：完整分片选线、播放会话固定、普通TS一段预取。**160项回归通过**；真实片源下一段命中预取缓存、正文一致、结束后资源归零。官方程序/manifest/nginx未改，用户数据保留，匿名管理/播放401。

维护器可信树和last-good已同步；上游0.2.35含源码变动，仍按needs_review保留，未覆盖本地加固。递增版本0.2.19.4旧代码恢复包已准备并校验，未安装。用户随后确认实播更流畅、加载更快；终端类型未明确，手机/电视自然播放A/B未完成，不宣称卡顿减少50%或起播P95达标。

- [播放优化复盘、技能与下一阶段待办](19-fnmedia-ext播放优化复盘与后续计划.md)
- [本次共享记忆增量](MEMORY-20261031-RETRO.md)
- [fnmedia-ext维护技能](../../../.claude/skills/fnmedia-ext-maintenance/SKILL.md)
- [实施结果与验收边界](18-fnmedia-ext播放稳定性实施与验收.md)
- [Codex/Grok播放稳定性原方案](17-fnmedia-ext播放稳定性方案.md)
- [播放卡顿诊断与自动选线限制](16-fnmedia-ext播放卡顿诊断.md)
- [播放修复与当时验收边界](15-fnmedia-ext播放超时修复.md)
- [自动更新机制与历史验收](14-fnmedia-ext自动更新与复连.md)
- [上一版加固部署](13-fnmedia-ext加固部署与升级保护.md)
- [原版安装前评估](12-fnmedia-ext安装前评估.md)
- [补丁、构建与维护器](hardening/README.md)
- [来源与哈希](SOURCE-MANIFEST.json)

安装包、运行配置、用户数据、凭据不入仓；CLI授权留在维护主机。不是上游官方发布。
