---
name: daily-tech-pulse
description: 每日热点信息收集推送 - 自动收集全网科技/AI/AR-MR/游戏领域热点，推送到邮件/飞书
trigger: 每日热点|科技简报|tech pulse|热点推送
---

# Daily Tech Pulse

每日自动收集全网热点科技/AI/AR-MR/游戏领域信息，推送到指定渠道。

## 使用方式

```bash
cd .claude/skills/daily-tech-pulse
npm start
```

## 功能

- **定时抓取**: 每日 8:00、14:00、20:00 自动抓取
- **多源聚合**: 支持 RSS、API 自定义来源
- **热度排序**: 自动按热度排序
- **多渠道推送**: 支持邮件、飞书

## 信息源配置

默认配置在 `config/sources.json`：
- 科技: TechCrunch RSS
- AI: NYTimes AI RSS
- AR/MR: UploadVR RSS
- 游戏: GameSpot RSS

## 推送配置

环境变量：
- `EMAIL_USER` - 邮箱账号
- `EMAIL_PASS` - 邮箱密码
- `FEISHU_WEBHOOK` - 飞书 Webhook

## 目录结构

```
daily-tech-pulse/
├── src/
│   ├── index.ts          # 入口
│   ├── services/
│   │   ├── scheduler.ts  # 调度
│   │   ├── fetcher.ts   # 抓取
│   │   ├── pusher.ts    # 推送
│   │   └── store.ts      # 存储
│   └── types.ts         # 类型
├── config/
│   └── sources.json      # 信息源配置
└── package.json
```
