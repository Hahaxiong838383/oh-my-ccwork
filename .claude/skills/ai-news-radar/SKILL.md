---
name: ai-news-radar
description: 高质量 AI/科技新闻聚合项目，支持静态网页展示、24h 增量更新、WaytoAGI 更新日志、OPML RSS 批量接入
author: LearnPrompt
platform: github
source: https://github.com/LearnPrompt/ai-news-radar
tags: [ai-news, rss-aggregator, python, static-site, news-curation]
version: 1.0.0
generated: 2026-02-24T00:00:00Z
---

# AI News Radar - AI/科技新闻聚合器

高质量 AI/科技新闻聚合项目，支持静态网页展示、24h 增量更新、WaytoAGI 更新日志、OPML RSS 批量接入、失败源替换与告警。

## 快速开始

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/LearnPrompt/ai-news-radar.git
cd ai-news-radar

# 创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 复制 RSS 模板
cp feeds/follow.example.opml feeds/follow.opml

# 运行抓取（24h 窗口）
python scripts/update_news.py --output-dir data --window-hours 24 --rss-opml feeds/follow.opml

# 启动本地服务器
python -m http.server 8080
```

打开 http://localhost:8080 查看聚合新闻。

### GitHub Actions 自动更新

项目已配置定时任务（每 30 分钟自动更新）：

1. Fork 仓库
2. 如需私有 RSS：在仓库 Settings → Secrets 添加 `FOLLOW_OPML_B64`
   - macOS 生成：`base64 < feeds/follow.opml | pbcopy`
3. 工作流会自动运行并提交更新数据

## 核心功能

### 1. 多源聚合

- **10 个网页源**：TechURLs / Buzzing / Info Flow / BestBlogs / TopHub / Zeli / AI HubToday / AIbase / AI今日热榜 / NewsNow
- **OPML RSS 批量接入**：支持私有 RSS 订阅

### 2. 双视图模式

- **AI 强相关**：AI 相关新闻（默认去重）
- **全量模式**：所有新闻（可开关去重）

### 3. RSS 失败处理

- 自动替换官方源
- 跳过无 RSS 的源
- 输出告警数据：`failed_feeds`, `zero_item_feeds`, `skipped_feeds`, `replaced_feeds`

### 4. 中英双语

- 自动显示中英双语标题
- WaytoAGI 时间线：「当天」/「近7日」切换

## 输出文件

| 文件 | 说明 |
|------|------|
| `data/latest-24h.json` | 24h 最新新闻 |
| `data/archive.json` | 归档数据 |
| `data/source-status.json` | 源状态 |
| `data/waytoagi-7d.json` | WaytoAGI 7日数据 |
| `data/title-zh-cache.json` | 中文标题缓存 |

## 命令行参数

```bash
python scripts/update_news.py [OPTIONS]

选项：
  --output-dir TEXT      输出目录 [必需]
  --window-hours INT    时间窗口（小时）[默认: 24]
  --rss-opml TEXT        RSS OPML 文件路径
  --ai-mode              AI 强相关模式（默认去重）
  --no-dedup             禁用去重
```

## 配置说明

### 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `HTTP_PROXY` | HTTP 代理 |
| `HTTPS_PROXY` | HTTPS 代理 |

### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `FOLLOW_OPML_B64` | Base64 编码的私有 OPML |

**重要**：不要在代码中提交真实 API Key 或密码。

## 项目结构

```
ai-news-radar/
├── scripts/
│   └── update_news.py       # 主抓取脚本
├── assets/
│   ├── app.js               # 前端逻辑
│   ├── styles.css           # 样式
│   └── logo.svg             # Logo
├── feeds/
│   └── follow.example.opml  # RSS 模板
├── data/                    # 输出数据
├── tests/                   # 测试
├── index.html               # 主页面
├── requirements.txt         # Python 依赖
└── .github/workflows/
    └── update-news.yml     # 自动更新工作流
```

## 依赖

```
requests==2.32.3
beautifulsoup4==4.12.3
feedparser==6.0.11
python-dateutil==2.9.0.post0
```

## 测试

```bash
# 运行测试
pytest tests/

# 单独运行
pytest tests/test_topic_filter.py
pytest tests/test_utils.py
pytest tests/test_waytoagi_utils.py
```

## 部署建议

### Vercel/Netlify 静态部署

1. 推送仓库到 GitHub
2. 导入到 Vercel/Netlify
3. 设置构建命令：`python scripts/update_news.py --output-dir data --window-hours 24`
4. 设置输出目录：`data`
5. 添加定时任务（可选）

### 自定义 RSS 源

1. 编辑 `feeds/follow.opml`
2. 添加你的 RSS 订阅
3. （可选）设置 GitHub Secret 保护隐私

## 类似项目参考

- [waytoagi](https://github.com/kyoheiu/waytoagi) - WaytoAGI 官方展示
- [hacker-news-digest](https://github.com/nguyenvinhlinh/hacker-news-digest) - Hacker News 摘要

## 更新日志

- 2026-02-24: 转换为 OpenCode Skill
- 2026-02-21: 项目创建 (77 stars)
