---
name: voice-agent-ops
description: realtime-voice-agent(自建 LiveKit cascade 中文语音)部署 + 排障 SOP。触发词:"/voice-ops"、"voice 部署"、"voice-agent 排障"、"voice-hk 连不上/无声/没反应"、"语音 agent 无声"、"部署 voice worker"、"热词增减/改热词"、"说单个字没反应"、"没有字幕"、"rust 灰度线/voice-worker-rust"、"小可暗夜剧场表情/搜索/响应慢"。涵盖:HK ECS 部署链(rsync editable+systemd)、排障决策树(通话中无声/重连无反应/局部无声/5G 直连不通/单字被上游丢弃)、rtc_probe 验收姿势(三通道:音频/字幕/metrics)、延迟分解四锚点、TURN relay、承接音与 bench 工具、热词增减 SOP、Rust 灰度线运维。
---

# voice-agent-ops（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/voice-agent-ops/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
