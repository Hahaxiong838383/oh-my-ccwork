# SPEC.md - 每日热点信息收集推送系统

## 项目概述
- **项目名称**: Daily Tech Pulse (每日科技脉搏)
- **功能**: 每日自动收集全网热点科技/AI/AR-MR/游戏领域信息，推送到指定渠道
- **目标用户**: 科技爱好者、从业者

## 核心功能

### F1: 信息源配置
- 支持配置多个信息源（RSS、API、网页爬取）
- 预设分类：科技、AI、AR/MR、游戏
- 支持自定义关键词过滤

### F2: 信息采集
- 自动定时抓取（每日 8:00、14:00、20:00）
- 内容去重与摘要生成
- 热度排序

### F3: 内容推送
- 支持多渠道推送：邮件、飞书、微信
- 可配置推送模板
- 支持每日简报格式

### F4: 定时调度
- 内置定时任务调度器
- 支持 cron 表达式
- 支持手动触发

## 接口契约

### 1. 添加信息源
- **输入**: `{ source: { type: string, url: string, category: string } }`
- **输出**: `{ sourceId: string }`

### 2. 获取当日热点
- **输入**: `{ category?: string, limit?: number }`
- **输出**: `{ items: [{ title, url, summary, source, timestamp, hotScore }] }`

### 3. 推送简报
- **输入**: `{ channels: string[], content: string }`
- **输出**: `{ success: boolean, results: [] }`

### 4. 定时任务管理
- **输入**: `{ cron: string, action: string, enabled: boolean }`
- **输出**: `{ taskId: string }`

## 技术规格
- 语言: TypeScript
- 运行时: Node.js
- 存储: 文件 JSON
- 调度: node-cron
