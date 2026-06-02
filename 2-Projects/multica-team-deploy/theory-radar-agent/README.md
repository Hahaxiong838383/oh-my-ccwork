# multica theory-radar autopilot（自动化日报，agent 端到端自完成）

> 把 cc 的 theory-radar skill 能力同步到 multica agent，让 **multica autopilot 自己**抓取+分析+发飞书，不再依赖 cc 手动执行，也不再卡在多 agent 协调缺 O2。

## 问题（之前为什么卡）

原 autopilot「AI-Theory-Radar 每日报告自动化」设计成**多 agent 协调**：
- assignee = 爱马仕grok（4.3）主调度员 → 触发 FUT-49(grok)/FUT-50(Claude) → 评审 → 飞书代理发送
- 反复 blocked：mini 上的 agent 拿不到 O2 上下文（3-Thinking 文档/报告模板/飞书目标都在 Air mycc），agent 遵守 no-guessing → 集体 blocked

## 方案（单 agent 端到端 + 自包含 skill）

1. **arxiv 抓取脚本部署到 mini**：`~/theory-radar/arxiv-theory-radar.py`（纯 Python stdlib，无第三方依赖，走 xray proxy 抓 arXiv）
2. **自包含 multica skill `theory-radar`**（id `6b8ca900-ba60-4d68-aaa5-f7f161af2fac`）：SKILL.md 含完整三步 SOP（抓取→选8篇5段式分析→sidecar 取 open_id→05_agent_spawn.sh 发川哥飞书），把所有 O2 写进 skill 自身
   - **用 `multica skill update --content` 设主体**，不放 SKILL.md supporting file（避免双 SKILL.md 写碰撞，见 feedback_multica_skill_dual_skillmd_source_collision）
   - ASCII 名 `theory-radar`（slug 与「飞书代理操作-zh」的 zh 不同，避免同 slug 撞）
3. **挂到 agent**「Claude Code（理论雷达）」(`2876ba85`, claude-opus, 只挂此一个 skill)
4. **autopilot 改指向该 agent + 简化描述**（`multica autopilot update 93bef85d --agent 2876ba85 --description ...`），单 agent 一个 issue 端到端完成

## 文件

| 文件 | 说明 |
|------|------|
| `theory-radar-SKILL.md` | multica skill `theory-radar` 的内容（已 `skill update --content` 到 6b8ca900） |
| (mini) `~/theory-radar/arxiv-theory-radar.py` | arXiv 抓取脚本（源在 mycc `.claude/skills/theory-radar/scripts/`） |

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
