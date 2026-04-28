# 定时任务配置

> mycc 后端启动后自动生效

---

## 每日任务

| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 04:00 | Skill 双向同步 | - | 运行 python3 /home/hahaxiong83/mycc/2-Projects/cc-agent/bridges/skill_sync.py --direction both，同步 mycc↔hermes 技能库 |
| 23:40 | 清理一次性任务 | - | 删除已过期的一次性任务 |

## 间隔任务

| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|

## 每周任务

| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|

## 一次性任务

| 日期时间 | 任务 | Skill | 说明 |
|----------|------|-------|------|
| 2026-05-05 18:00 | BFO V0.1 一周校准 | - | 你是 cc，读取 `.claude/skills/scheduler/prompts/bfo-v0.1-week-calibration.md` 的完整内容并按其执行：扫一周 BFO 自检数据（no-guessing 违规案例 + task-log friction + memory 反馈 + git log），按 4 维度（推断扣 −0.3 / 转述扣 −0.2 / 短路滥用 / load-bearing 边界）给校准建议；输出三件套：飞书简报推 cc 群 + 写 feedback_bfo_v0.1_calibration.md memory + task-log 追加一行 + git push 到 mycc origin。数据不足时输出"延后 2 周再校准"并提示老板。约束：不准改规则文件，所有阈值建议必附数据依据。 |
