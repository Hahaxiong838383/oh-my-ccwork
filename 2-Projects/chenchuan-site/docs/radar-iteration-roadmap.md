# 雷达待迭代方案(2026-07-07 落盘,川哥确认排队)

> 三项均已具备启动条件,按下面方案可直接开工。背景与现状见 `04-决策记录.md` 2026-07-07 两条。

## ① github-radar 抓取质量优化(~1h)

**问题**:现有 `github-radar.py` 用「关键词 + `stars:>N` + `pushed:>7天`」搜索,近 7 天窗口内命中的多为小众 repo(如 loopers-oss/ponytail),缺少 autogen/crewai 级主线项目。

**方案(推荐 b,零新依赖)**:
- a. 纯调参:star 门槛按类提高(200→1000/2000),但 7 天窗口的根问题还在。
- **b. 双轨 query**:每类 = 「主线榜」(`stars:>5000 pushed:>30天内`,排序 stars,取 2)+「新锐榜」(`created:>90天内 stars:>300`,排序 stars,取 2)。主线保证"大牌在更新",新锐保证"趋势感"。改动集中在 `CATEGORIES` 结构与 `search_github` 调用,~15 行。
- c. 换数据源:ossinsight API / GitHub trending 爬取——功能更强但引入外部依赖,留作 b 不满意时的升级。

**验收**:跑一轮人工审 12 个 repo 的"认识度/相关度";板块渲染无回归。

## ② GithubRadarSection judgments(cc 判断)接入(~1.5h)

**现状**:webhook/组件/类型三层都已留位(`judgments: [{repo, reason}]`),推送不带该字段则板块隐藏该栏——**只差判断产出这一环**。

**方案**:`daily-github-radar-push.sh` 在 fetch 与 push 之间加一步 LLM 判断:
- 引擎:复用 theory-radar 同款 codex 网关(`~/.theory-radar-push.env` 已有 `CODEX_API_GATEWAY_KEY/BASE_URL`,gpt-5.5 分析在产线跑通)。
- 新脚本 `judge-github-repos.py`:输入 12 个 repo(name/description/stars/topics),prompt 按 SKILL.md 的 cc 自进化标准(记忆系统/工具框架/MCP/多智能体/skill 系统)挑 2-4 个,输出 `[{repo, reason}]` JSON,写回 `/tmp/github-radar-data.json` 的 `judgments` 字段。
- **兜底**:LLM 失败/超时(30s)→ 不带 judgments 照常推送(板块该栏隐藏,不阻断主链路)。

**验收**:公网板块出现「cc 的判断 · 值得跟进」栏,理由通顺;LLM 断供时推送仍成功。

## ③a 归档扩容前置:RSC 分页(~2-3h)

**问题**:`/radar` 页把全量归档嵌进 RSC(3000 条 ≈ 2.5MB),归档 cap 想提就会线性膨胀页面。

**方案**:
- 新 API `GET /api/radar/feed?offset=N&limit=200`:读盘归档(`data/radar-feed-cache.json`)切片返回,带 `total`。
- `page.tsx` 只嵌最新 600 条;`RadarFeed`「加载更多」超过 600 后改为调 API 追加(保留现有前端 slice 逻辑作首屏)。
- 完成后归档 cap 3000→10000(`feed-cache.ts` 一行),「资讯存服务器」容量×3.3。
- 注意:分类 tab 计数需用 API 返回的全量分类统计,或仅统计已加载部分并标注。

**验收**:页面 payload <1MB;滚到 600+ 条能继续加载;cap 提升后盘文件 ~5MB 读写正常。

## ③b 远期:FreshRSS 自建源池(半天,依赖 cockpit Phase 2)

- RackNerd cockpit 机 `compose.yaml` 加 FreshRSS(Dockge 管理,Kuma 监控,Basic Auth 后)。
- 源:draco-agent/tech-news-digest 的 `config/defaults/sources.json`(168 个带 topics/priority 的 RSS)转 OPML 导入。
- 出口:FreshRSS Google Reader API → 站点新适配器 `fetchFreshRSS()` 作第三上游(复用 allSettled 多源架构)。
- 置顶评分:移植 draco `merge-sources.py:110-146` 规则加分制(priority+3/24h内+2/互动分层),零 LLM 成本。
- 价值:源池完全自主(aihot/yuweiwan 全挂也有兜底),中文源可自由增删。
