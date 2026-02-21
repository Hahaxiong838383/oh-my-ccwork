# ARCH.md - 架构设计

## 系统架构

```
┌─────────────────────────────────────────────┐
│            Daily Tech Pulse                │
├─────────────────────────────────────────────┤
│  Scheduler (node-cron)                     │
│    └─> Fetcher → Parser → Ranker         │
│         └─> Pusher (Email/Feishu)         │
├─────────────────────────────────────────────┤
│  Config Store (JSON files)                │
│  Data Store (JSON files)                  │
└─────────────────────────────────────────────┘
```

## 核心模块

### SchedulerService
- 定时调度管理
- 任务注册与执行
- 支持 cron 表达式

### FetcherService
- RSS 订阅抓取
- HTTP API 调用
- 网页内容提取

### ParserService
- 内容解析
- 摘要生成
- 去重处理

### RankerService
- 热度计算
- 内容排序
- 关键词过滤

### PusherService
- 邮件推送 (nodemailer)
- 飞书推送 (lark-sdk)

### DataStore
- 信息源配置存储
- 采集数据存储
- 历史记录

## 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript | 类型安全 |
| 运行时 | Node.js | 生态丰富 |
| 调度 | node-cron | 简单可靠 |
| 存储 | JSON 文件 | 轻量无需数据库 |
| 邮件 | nodemailer | 成熟稳定 |
| 飞书 | @larksuiteoapi/node-sdk | 官方 SDK |
