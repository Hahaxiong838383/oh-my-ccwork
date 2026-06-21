# docs/37 · 手机端 RTC 吐槽功能 + 首次连接进度倒计时

> 日期：2026-06-21。状态：✅ cc 后端 E2E 全过 + 川哥真机测通过 + 生产部署。
> 关联：吐槽链路源自端侧 app（pipeline captureMode='feedback'）/ onboarding docs/36 / 记忆 `feedback_p003_rtc_feedback_and_recency`。

## 1. 需求
手机端 RTC 小可界面加两件：①「我要吐槽」按钮（逻辑同端侧 app）②首次连接进度倒计时（首次连接 SDK 加载慢）。

## 2. 吐槽：架构矛盾 + 决策
- **端侧 app 吐槽** = 一个信号 `captureMode='feedback'`（WS sendSessionMeta 下发）触发两件事：落 `feedbackStore` + 小可切吐槽人格（`FEEDBACK_PERSONA_SUFFIX`：感谢+共情+不过度承诺）。
- **RTC 架构矛盾**：火山全双工管语音，custom-llm 只收文本回调——**没有 captureMode 下发通道**，也没有端侧「按住录音」的天然边界。
- **川哥决策**：点击进吐槽模式一轮。
- **方案 = arm 预置**：前端点吐槽 → `POST /api/rtc/feedback-arm`（token→accountId，内存 Map + TTL 60s）→ custom-llm 回调时 consume armed（一次性）→ 命中则落库 + 吐槽人格。

## 3. 吐槽实现
| 文件 | 改动 |
|---|---|
| `prompts.ts` | `FEEDBACK_PERSONA_SUFFIX` 从 pipeline 提到此处共享（WS + RTC 两端用）+ 强化措辞（见 §5） |
| `feedback-arm.ts`（新） | `armFeedback`/`consumeFeedbackArmed`：内存 Map(accountId→expireTs) + TTL 60s + 一次性消费 |
| `routes/rtc.ts` | `POST /feedback-arm`（token 鉴权，匿名拒；arm 该 accountId） |
| `routes/custom-llm.ts` | feedback 分支：consume armed → 吐槽优先(不 onboarding/不召回世界观) + 吐槽人格末尾追加 + `feedbackStore.add` 落库(source='rtc') |
| `pipeline.ts` | 同步把吐槽人格改成末尾追加(原在 base 前，近因隐患) |
| `mobile/useVolcRtc.ts` | `armFeedback`(POST arm) + `feedbackArmed` 态 |
| `mobile/MobileMain.tsx` | 「我要吐槽」按钮(点击) + 吐槽态 UI("小可在认真听你的吐槽…") |

落库 `source='rtc'`，复用 `feedback_items` 表，进**现有 admin/家长端反馈看板**（零运营改动，和端侧 app 同一条库）。session_id 用 accountId（RTC 无 WS sessionId），turn_id 用秒级时间戳。

## 4. 首次连接进度倒计时
- `useVolcRtc` 暴露 `connectPhase`：`starting`(起火山 task) → `loading`(动态 import 12MB SDK，**首次最慢**) → `joining`(joinRoom)。
- `MobileMain` connecting 时：阶段文字（叫醒小可→加载语音引擎→接入对话）+ 进度条（阶段映射百分比，framer-motion 平滑）+ 预估倒计时（20s→1s 停住，不归零防"0 秒还没好"尴尬）。
- 连上即止（connected → connecting=false → 倒计时清）。

## 5. 🔴 近因效应（第三次，提炼成规则）
小可这套 prompt 的 `ARK_WORLDVIEW_BASE` 开头是强人设（方舟/指挥官/探险），**所有「当前任务」类指令必须放 systemPrompt 最末尾**，否则被世界观开场盖过：
- **onboarding 引导**（docs/36）：第一次塞中间 → 小可不问名字、照喊指挥官探险 → 移末尾修复。
- **吐槽人格**（本次）：第一次塞 `base` 前 → 把"想多听恐龙故事"当请求**真讲了一大段恐龙故事** → 移末尾 + 措辞强化"无论像不像请求都只收集、不要真执行" → 修复后变成"感谢+收进金点子库+不讲故事"。

**规则：custom-llm / pipeline 里的吐槽人格、onboarding 引导这类「本轮任务」后缀，一律在 `assembleSystemPrompt` 返回后用 `+=` 追加到末尾，不要塞进 base 开头。** 这是同一个坑第三次（含知识库召回的 if 顺序），E2E 才暴露——光看代码以为注入了就生效。

## 6. 验证
- **cc 后端 E2E**（生产 curl + node:sqlite）：arm 200 → 吐槽"希望多讲恐龙故事" → 小可"感谢+郑重收进 KidsHub 金点子库+不讲故事+鼓励继续"✓ → 落库(source=rtc/status=已收到/nickname)✓ → arm 一次性消费后再说"你好"恢复正常探险对话✓。
- **连接进度**：纯前端 UI，川哥真机测通过。
- server tsc + web build 0 错。

## 7. 回滚
- server：`cp /opt/p003/_backup/20260621-174147-feedback-rtc/{prompts,pipeline}.ts .../src/` + `.../routes/{rtc,custom-llm}.ts` + 删 `feedback-arm.ts` + restart。
- web：`git revert` 前端改动 + 重 build + rsync。
