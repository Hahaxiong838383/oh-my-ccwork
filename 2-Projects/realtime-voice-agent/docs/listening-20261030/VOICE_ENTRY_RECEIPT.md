# P003 Worker 全程语音倾听：候选开发回执

本轮开发候选，未部署、未开总闸、未修改设备范围、Android包或搜索R26/窗口。实际Android自动控制、RTC声音/字幕与回滚演练仍待联调，不以HTTP模拟替代真机。

## 版本与回滚

- 工作树：`p003-listening-worker-20261030`；分支：`codex/p003-listening-worker-20261030`。
- 本轮起点/精确回滚点：`9156bf94847683964011073cb7f883abce2cbca6`。保留上一轮 pipeline Err/panic/正常结束→job有界统一收尾、STT Drop、关房/删房及重连新会话修复。
- 本轮代码提交：`9364f240f0530ac7bdbfb4984f384766751f6a8d`；本回执归档为后续仅文档提交，不代表部署。
- 如放弃此候选，针对本轮实现提交做revert；不整树覆盖、不重置其它工作树、不回退已发布后台。
- 联合Brain输入：`a784ad9b79a0da9b7b327f4ed17ea149be69f9cc`；32项Brain输入逐项与该提交git show校验。

## 已接入的行为

1. 复用现有STT和模式/输出许可，有限完整口令在普通对话、投机、filler、硬件/搜索之前处理；interim只抑制候选，不提交控制。ordered首句等完整性裁决后才提议，held-final不投机，使用独立`first_turn_listening_command`切换RTC。
2. Worker发可靠`control/listening.proposal`，不分配Android seq；Android自动echo enter/exit，seq/request_id仍由Android唯一分配。实际参与者、trace、session/房间绑定、epoch、三秒单调TTL、同seq全payload幂等均保留；State查询不消费提议。
3. 提议起立即撤销旧音频许可并清普通待播；提议→enter→租约期间即使内部phase仍Normal，也禁止普通输出。双确认完成前正文存最多12000字符临时缓冲；完成后才转入倾听buffer，避免Enter重置丢内容。溢出保持Paused并收尾，不宣称完整记忆。
4. 新能力协商的ordered首句保留最多8秒内存RTC桥，只有完整语音命令切换才回灌end之后的续讲帧；桥溢出或倾听STT队列失败保持Paused并有界关房。普通R18追补开关/自声门沿原逻辑。此处是实现和模拟证据，真实ASR切段/设备上行边界仍需验。
5. 无进入确认音，不用“好呀”冒充完成；completed仍要求Worker真实输出排空和Android local_ready。收到提议/received都不是成功。口令不入故事/history/长期画像；回声先过滤，消费口令以空final撤回并结束当前字幕段，清理旧pending字幕，防止之后补发。
6. 唱歌反馈用真实HTTP `trigger=voice_command`，不伪装button。要求本次协商新能力、冻结`voice_invitation_enabled=true`、有效租约及原一次反馈许可；先观察VAD SpeechEnd，再额外至少500ms静音后开始独立呼名口令，最后等口令SpeechEnd。现有VAD最小停声为0.3s；不新增歌声/音准模型。普通问句、连续歌词、静音、非呼名或单说“唱完了”均不申请反馈。
7. 一次反馈后回倾听；SpeechStart立即撤销后续帧与在途反馈，SpeechEnd不恢复旧输出。有效语音退出仅恢复普通聊天并关闭旧entry，下一新句才能进普通对话；提议/授权超时、缺local_ready或租约过期保持Paused，语音不能绕过撤权。
8. Worker-ready增加第六项可选能力；缺新voice_control的旧客户端不发提议、不自动进唱歌反馈，原按钮控制及story/sharing voice_invitation兼容。缺能力的明确新口令静默消费，不让普通LLM假称成功。

## 安卓需实现（尚未认定已完成）

- 真正完成自动控制后，session supports才同时声明`listening_mode_v1`与`listening_voice_control_v1`；核响应`listening_contract.voice_control={version:1,capability:"listening_voice_control_v1"}`，缺失不能显示全语音已可用。
- 收当前房间可靠有序control包。实际发布者须为受信AGENT，并以`lk.agent.name`核`expected_agent_name`后绑定本房实际identity/SID：实际identity是`agent-<job_id>`，不能直接与`rust-worker`调度名比较。仅src/name/payload自称worker不可信。
- proposal envelope为`trace_id,ts_ms,src=worker,type=listening.proposal`，**无Android seq**。payload为`version=1,proposal_id=<trace>:voice:<counter>,session_id,participant=dev-完整SN,mode_epoch,action=enter|exit,ttl_ms=3000`；enter另有`scene=story|sharing|singing`，exit无scene。不带原始口令。
- 核当前trace/session/target/epoch、实际sender和到期。重复提议不延时、不重新分配seq；重传原Android控制时用同seq和完全相同payload（包括proposal_id）。新seq重用已消费提议不成功。
- Enter：停止本地衔接音及所有待播，保持麦克风/RTC与idle策略；发送原`listening.enter`，payload只在旧字段上加`proposal_id`，复制原epoch/scene。收到received的新epoch后，确认本地队列确已清完才发原格式`local_ready`。两者都到且Worker排空后，原enter seq/request_id的completed才是成功。
- Exit：同样自动echo原exit加proposal_id；completed/normal后处理下一新句，不补故事/旧结果。超时用新seq查State，旧entry未可信完成前不自行恢复本地音频；Paused则关旧RTC、重新签会话，旧proposal不得带入新房。
- 首句可说“小可，先听我讲个故事。从前有只熊。”；sharing：“小可，先听我说一会儿。”；singing：“小可，听我唱首歌。”；反馈：“小可，我讲完了，请说说你的看法。”/“小可，我唱完了，请给我反馈。”；退出：“小可，结束倾听，恢复聊天。”
- 进入口令与同句正文需要可确认标点/空白分句边界；无界的长串或疑问/台词后缀保守不进入。ASR把引语/歌词独立切成完整口令、停唱/说话边界误判、回声窗外误识别仍是残余风险，不能承诺零误触。

## 冻结合同

来自38的rev3，文件与Brain按字节一致：

| 文件 | SHA256 |
|---|---|
| p003-listening-mode-v1.json | c055866fad0e9b69cdd75c526eeb2fee6ad97899641d792be63037a064bf2411 |
| p003-listening-http-v1.json | 86825d6281da13fdf17c32b04d5c9dcb4edf71ceb69257d839aacb9df0a99f1e |
| p003-listening-http-v1.fixtures.json | c58dd98ade3329d04e5c9b7622e7e4668c33483b38cd804f37257e5baa6d415b |

## 实测证据

- 本机纯Rust core29/runtime9/parser4已通过。解析/边界/过渡hold先有失败；Linux移除voice_text接线后的反向验证为8失败、6通过，非绿色证据。
- 匹配最终源码的Linux `cargo test --locked`：Worker **494通过/2 HTTP joint忽略**、core **29通过**、runtime **9通过**、parser **4通过**，共536通过，0失败，RC0。原job生命周期/P1、声学打断撤许可、真实VAD模型/原生队列、R18+style/ark及既有搜索单测均在此轮实际执行；未合R26。
- 单独 `cargo test --locked --bin voice-rust-worker listening_joint_real -- --ignored`：**2通过/0失败，RC0**。实际Brain Hono权限/租约/SQLite/HTTP：旧story进入/summary/反馈/撤权；新协商singing提议→双确认→`voice_command`反馈一次→normal退出，模型/身份/Android是替身。不同于真实RTC/终端声学验收。
- 完整Cargo与HTTP joint同一79项输入，manifest SHA256：`1da57c0cd3425bca2725e40eebd8b34eb1a66b3100be18ce26ab6735a89c4505`。逐项git show与上述Worker代码提交及Brain提交核同；三合同一致。未把上轮517累计为本轮通过。
- 日志及逐源SHA：[输入清单](evidence/voice-input-manifest.json)、[Linux完整Cargo](evidence/voice-linux-cargo.log)、[HTTP联合](evidence/voice-http-joint.log)、[本机纯Rust](evidence/voice-local-core-runtime-parser.log)、[移除接线反向失败](evidence/voice-negative.log)、[Brain bundle清单](evidence/voice-joint-bundle-manifest.json)。
- 构建隔离源位于`/data/p003-listening-worker-check-20261030-session39/voice`，target为本会话原独立target；未复制大缓存。原registry被清空后，在本会话隔离cargo-home恢复Cargo.lock锁定依赖，未安装/替换系统工具链。空间预检root38GB、/data161GB，rustc1.98。途中SSH握手超时，以及本任务Cargo磁盘I/O等待/重复包装任务等待本任务锁，均未当测试通过；仅取消本任务匹配锁路径的构建及后代，未动主机备份/服务/安全设置，再以冻结源码单独完成。最终Linux rustc1.98.0、Node22.14.0；VAD模型SHA已入输入清单。
- 只读审查修复：元话语“怎么说”误入、前置语音绕过TTS回声门、State查询误判proposal冲突、ASR更正口令后的字幕收尾。RTC发布和真机字幕仍待取证。核心代码锚：`pipeline.rs:1450/1623/2009/2410`、`listening_adapter.rs:201/301/736/749`、`listening_runtime.rs`的逐帧hold/permit、`caption_gate.rs:176`。ordered PCM→Adapter双确认是模拟接线证据，未声称已在真实Orchestrator/RTC回放首句。
- 下一步最小联调：主会话验收两端候选和合同→安卓按上述自动控制实现→隔离单机抓首句续讲/一次反馈/退出后普通问答，再唱歌、打断、迟到/重连及回滚。记录版本、trace/session、proposal、Android seq、两个确认顺序、上行续流和实听，不附Bearer或故事原文。

署名：codex（OpenAI）| 2026-10-30 14:41:31 CST
