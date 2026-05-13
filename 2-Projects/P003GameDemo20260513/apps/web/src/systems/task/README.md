# Task System（占位，V1.53）

来自 3.7 任务系统设计。

## 核心约束（产品文档明确）

1. **家长不能凭空发奖励** —— 必须和设备使用挂钩
2. **家长和孩子都不能手动点完成** —— 必须设备后台自动达标
3. **"小小愿望"机制** —— 家长+孩子共建愿望，花家族币达成（倒推使用时长预估）

## 架构

- **客户端**：仅上报设备传感器原始数据（focus_seconds, eco_part_unlocked, ...），不上报"已完成"标志
- **服务器**：根据任务规则 + 原始数据，单方面判定达成 + 发放奖励
- **小程序**：家长发布任务 + 接收完成通知

## V0.3 占位的目的

- mock server 接口预留：`/api/task/list` / `/api/task/accept` / `/api/wishes/*`
- store 字段预留：`activeTasks`、`wishes`
- demo 阶段不实现 UI，仅保证 V1.53 加入时不破坏架构

## V1.53 完整实现时

- `systems/task/heartbeat.ts` —— 心跳上报传感器原始数据
- `systems/task/wish.ts` —— 愿望进度展示
- `scenes/TaskList/`、`scenes/Wishes/`
- 配置表：`TaskConfig.json`（任务模板）
