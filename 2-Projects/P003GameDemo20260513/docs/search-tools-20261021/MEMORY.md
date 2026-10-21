# P003 搜索候选与灰度接续记忆

更新时间：2026-10-21；本文件为可推送的项目事实摘录，不含凭据/原始用户正文。实时部署看执行会话最新回执，不以历史摘要覆盖现况。

## 接续位置

- Brain：`codex/p003-brain-search-tools-20261021`，工作树 `/Users/fu-121/.codex/worktrees/p003-brain-search-tools-20261021`，Codeg会话24；用户已发送启动灰度prompt，元数据确认in_progress。不要另起重复部署任务。
- Worker：`codex/p003-worker-tool-lifecycle-20261021`，工作树 `/Users/fu-121/.codex/worktrees/p003-worker-tool-lifecycle-20261021`，Codeg会话25。
- 17:47历史远端锚：Brain `1cdc1e99ed9df2f1c52716a2dd736bba65e035b4`，Worker `66b89ac2a7520ac43c58961a8de0426da2633679`；当前HEAD可能已经前进。
- 文档/技能归档：`codex/p003-search-retro-skills-20261021`，避免占用上面两个活跃工作树。
- [执行规划](../../../../docs/superpowers/plans/2026-10-21-p003-sn-search-canary.md)、[复盘](RETROSPECTIVE.md)、[协议](PROTOCOL.md)、[历史测试](TEST_RESULTS.json)。

## 授权与验收边界

目标完整SN `BJP00326070803800006`，末8位03800006；不能用ADB07000180或只按尾号授权。上线前重新核设备身份/APK和现役R1。用户授权独立候选测试通过后开启2小时单机窗口，先P1再P2；无自动全量/自动24小时延长授权。执行代码由codex亲写。

在此前候选冻结点，22项Node搜索测试、5组回归、类型检查、352项Rust、Linux ABI构建及真实Search/Tool Calls/受控Fetch通过。真机audio/transcription/metrics、前台聊天不阻塞、插话续讲、来源质量、单机长稳待验；本轮不重跑或宣称这些已通过。

R0生产归档路径、SHA与候选二进制在IMPLEMENTATION.md及构建清单，未来部署需重读R1而非整库回灌。空名单语义：搜索关闭；不能套用旧ASR/退出能力“空即全开”。不同源Brain/Worker不得整树互相覆盖。

开窗成功后执行会话生成 `P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_YYYYMMDD.md`，含真实窗口、SN后8位、已核APK、已开P1/P2、重连/话术/预期/反馈/恢复，放Air Downloads并核哈希；用户自己转发。未开窗和未实机项分别写明。

## Codeg 历史语义

原会话13保留。会话24/25通过原生fork与Codeg导入获得历史快照，初次回读各2152条展示记录；此后不实时同步。message_count因接口/压缩/新轮次口径会变化，查ID与实际历史边界。不要直接改Codeg DB或取消活跃原会话来迁移。

共享0-System记忆在仓外符号链接目标；本文件用于将本任务可公开于私有代码仓的事实实际入Git，二者不能混称均已push。

署名：codex（OpenAI）| 2026-10-21 北京时间
