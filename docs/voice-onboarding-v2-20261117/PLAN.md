# 客户端编排教学v2实施

授权：用户2026-11-17明确按附件实施，延用373工作树；主13写代码，Grok独立合同/测试评审。v1语义保留，不原地替换。

回滚起点：81cbd0b10be15037f8f3fe0ea4846eb6bac6236b，rollback/p003-voice-onboarding-v2-pre-20261117。未部署，无生产配置/资料修改。新增表字段应可供旧代码忽略，回退仅代码，不回灌资料。

1. Brain增加独立v2 step合同和签发版本；客户端固定三个question_index，识别状态与memory_write分离，已知资料只skipped，拒绝/无效不关课，存储失败不伪saved。复用现鉴权和绑定身份。
2. Worker增加v2本地控制状态，完全不发问句/结束cue或TTS。客户端revision单调、request幂等、旧题/旧课/旧trace防护；同题回执重发保留VAD。
3. HTTP后台有界串行，不堵音频循环；skip/下一题/cancel撤销旧答案等待；服务失败保持教学隔离直到finish/cancel/180秒截止，截止不启动普通闲聊。
4. 增加实际HTTP/SQLite、Rust入口及Rust→Brain集成测试；覆盖全静默、存储失败、跳题中迟到结果、已知profile、重复audio_complete、v1退化。
5. 固定候选独立复验、commit/push，输出明确v2合同和Android联调回执；真实设备新包未到前不宣布真机通过、不自动部署。

客户端独自持久化教学完成：仅4A/4B实际播完，3C不算完成，GM simulation不写云资料。端侧必须按是否收到v2合同选择真实协作或本地有界教学，缺能力时不能发送教学音频去普通聊天。

待冻结的字段细节写入V2-CONTRACT.md；仅采用实现必要字段，不新增服务/每句话LLM调用。生日不由年龄推算。无需再次询问已确认的业务规则。

署名：codex（OpenAI）｜2026-11-17
