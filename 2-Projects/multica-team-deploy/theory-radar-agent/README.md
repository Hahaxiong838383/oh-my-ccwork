# multica theory-radar autopilot（正式报告飞书消费端）

> 韩国正式产线负责 RSS/OpenAlex 抓取、Grok 4.5 分析和个人站发布；Multica autopilot 只读取已发布报告并发送飞书，避免双生产者、arXiv Query API 429 和重复覆盖。

## 问题（之前为什么卡）

原 autopilot「AI-Theory-Radar 每日报告自动化」设计成**多 agent 协调**：
- assignee = 爱马仕grok（4.3）主调度员 → 触发 FUT-49(grok)/FUT-50(Claude) → 评审 → 飞书代理发送
- 反复 blocked：mini 上的 agent 拿不到 O2 上下文（3-Thinking 文档/报告模板/飞书目标都在 Air mycc），agent 遵守 no-guessing → 集体 blocked

## 方案（单 agent 端到端 + 自包含 skill）

1. **韩国正式产线是唯一生产者**：每日先完成 RSS/OpenAlex 抓取、Grok 4.5 分析和个人站发布。
2. **个人站提供只读报告接口**：`GET /api/radar/report?date=YYYY-MM-DD`，Multica 只消费已经发布的同日报告。
3. **自包含 multica skill `theory-radar`**（id `6b8ca900-ba60-4d68-aaa5-f7f161af2fac`）：等待正式报告→校验 4-8 篇→按原字段格式化→sidecar 取 open_id→飞书发送 3 条。
   - **用 `multica skill update --content` 设主体**，不放 SKILL.md supporting file（避免双 SKILL.md 写碰撞，见 feedback_multica_skill_dual_skillmd_source_collision）
   - ASCII 名 `theory-radar`（slug 与「飞书代理操作-zh」的 zh 不同，避免同 slug 撞）
4. **挂到 agent**「Claude Code（理论雷达）」(`2876ba85`, claude-opus, 只挂此一个 skill)。
5. **autopilot 09:10 触发**，给韩国 08:35 任务留出发布缓冲；Mini 不再访问 arXiv Query API，也不再调用个人站 webhook。

## 文件

| 文件 | 说明 |
|------|------|
| `theory-radar-SKILL.md` | multica skill `theory-radar` 的内容（已 `skill update --content` 到 6b8ca900） |
| 个人站 `/api/radar/report` | 韩国正式报告的公开只读 JSON 接口 |

## 关键 ID

| 资源 | ID |
|------|-----|
| autopilot | `93bef85d-c8a9-4667-a786-6baa8e040fc7` |
| theory-radar skill | `6b8ca900-ba60-4d68-aaa5-f7f161af2fac` |
| 执行 agent (Claude Code 理论雷达) | `2876ba85-2db9-4126-8e1b-21cd6a437508` |
| 收件人 (川哥 multica user id) | `<见 sidecar mapping>` |

## 验证

- FUT-82(派给 agent 测试): 端到端 ✅ 抓 32 篇 → 选 8 篇分析 → 飞书 3 条 message_id
- autopilot 手动 trigger: 创建 daily issue → agent 自完成 → 发飞书（**multica 自动化自发，非 cc 手动**）

## 飞书发送说明

- `tell-me/send.js`(自定义机器人 webhook) 当前禁用("Bot Not Enabled")→ skill 走 **multica 飞书 wrapper**(`05_agent_spawn.sh`)直发 open_id
- open_id 走 sidecar `/status` 权威源，禁手敲（防一字之差送错人）

## 后续

- 每日定时由 autopilot 的 schedule trigger 触发（早 9 点），自动创建 issue → agent 自完成
- 若要恢复双轨(grok+Claude 互评)：把 O2 写进 autopilot 描述后可重启多 agent 设计，但单 agent 端到端已满足"每日报告发飞书"
