# 技能更新验证

2026-11-16。本次是reference技能检索与应用检查，不重跑业务或生产验证。

更新入口：`.claude/skills/p003-deploy-ops/SKILL.md`及其`references/miniapp-realdata-reconciliation.md`；Launcher入口将旧v193声明改为带日期的历史快照，指向精确分支/构建源。

## RED：原技能检索基线

独立无上下文代理只读原技能及直接相关引用，不读本次报告/源码、不连服务器，回答5个固定场景：新流水0与旧历史、无epoch旧对话授权、同路径mini009合同、400/410→刷新503、源码到真人证据分层。

实际结果：第1—4题没有专门步骤；第5题部分覆盖，但缺Release Kotlin与完整APK的明确边界。代理明确缺少能力矩阵/null、完整历史授权与ABA/WAL、原context/retryable ACK、失效游标连续失败状态机。不是以主模型推测代替基线。

## GREEN：加入最小引用后复验

同一代理仍仅从技能入口及链接检索，不借本次报告补答案：5题均能定位明确步骤，3个相对链接存在。已逐项核：

- 新Ark流水0不否定旧对话；缺测null不改0。
- 固定完整授权元组/唯一账户、单调代际；COMMIT后复核权威状态，真实第二连接测ABA/WAL。
- 最新回执与精确构建源；实际wire/ACK/持久消费者对撞；缺原context旧事实保留unattributed，禁止补当前owner。
- retryable=true保pending和原ID，不错误转死信；400/410清cursor后首屏503仍保持needsRefresh，只有成功才恢复。
- Release Kotlin不等于签名APK；自报版本不等于活动包回读；H5传输夹具不等于微信发布/手机登录；旧v193不是当前设备真值。

结论：检索与应用指引通过，未发现剩余阻断性缺口。它证明本次技能可找到正确步骤，不证明设备或生产再次完成验收。

署名：codex（OpenAI）| 2026-11-16
