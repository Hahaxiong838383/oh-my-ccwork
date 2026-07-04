# 同步日志 · 主线 → 个人站展示层

> 主线 cc（KidsHub 核心，mycc main 分支）→ 展示层 session（本仓 `chenchuan-site`）的关键同步留档。配合 [COLLAB-RULES.md](./COLLAB-RULES.md) 读。

---

## 2026-06-14 · 切场景卡 TTS 续播 bug 已根治 + 两站部署生效（✅ cc E2E 验证）

**结论**：展示层 session 之前提的「切场景卡 TTS 不打断」bug，已修复并两站部署生效。commit `c9278edf6` @ main。cc 已 E2E 验证生效（证据见末尾）。

**根因纠正**（展示层初诊方向不对，留档避免再误诊）：
不是「server provider(deepseek/gemini) 读流循环缺 `signal.aborted` 检查」——那确是代码事实，但被 pipeline 层的 turn 守卫（onDelta/onAudio 的 `turn !== activeTurn`）兜住了，server 侧旧轮续发根本发不出去。真根因在 **前端音频竞态**：`voice-client.ts` 的 `flushMp3Buffer` 在 `src.start()` 前不校验 turn + `tts.audio` 消息无 turn 标识 → 前端 `bargeIn` 到 server 的网络窗口内，server 在途发出的旧场景 `tts.audio` 到前端被照常 decode+播放。DeepSeek 慢(TTFT 2.4s)在途音频多→暴露；Gemini 快侥幸不露。不是 provider 本身问题。

**修复方案**：turn 标识根治——server 给 tts 消息打 turn + 每轮发 `tts.turn_start` + 前端按 turn 丢弃在途旧轮音频 + `barge.in` 回 `tts.turn_discard` ack 修正门槛。commit `c9278edf6` @ main。team：codex 5.5(xhigh) 实现两端，cc 4 道关验收（确定性复现脚本/tsc 双端/diff 审查/不退化），codex 对抗审查补 tts.end/sentence_break 门禁，cc 审出 edge case→codex 补 turn_discard ack。

**部署（✅ 已生效，cc E2E 验证）**：公司站 `aliyun-hk:/opt/p003`（pm2 `p003-voice`）+ 个人站 `chenchuan-site:/opt/kidshub-personal`（pm2 `kidshub-voice`，同机）。server `pipeline.ts`（md5 `d5be8174` 本地=两站三处一致）+ 前端 dist（含 turn 协议）都更新、pm2 两进程 19:23 restart。公网 `my.chenchuan.cc/kidshub-ai/` + `kidshub-ai.hahaxiong.cc` 均 200，前端 bundle 含 turn 协议字面量。

**展示层动作**（部署已生效）：
- 个人站若走 iframe 嵌 URL → bug 已透明修好，用户访问即修复版。
- 个人站若 import/复制了 P003 代码 → `merge main` 拿 `c9278edf6`。
- 记忆同步：「TTS bug 待修 / 根因=provider 循环」→「已根治(turn 标识 `c9278edf6`)+两站部署生效(cc E2E 验证)」。

— 主线 cc
