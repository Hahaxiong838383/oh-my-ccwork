---
name: chenchuan-site-content
description: 陈川个人站内容更新工艺：项目卡/文章的口径铁律、数字核实流程、渲染注意、部署与公网验收。用于用户提到"个人站加项目卡""更新个人站内容""写文章上站""writing 板块""个人站文案"时。视频线走 chenchuan-site-media。
---

# 个人站内容更新（项目卡 / 文章线）

## 边界

- 项目：`2-Projects/chenchuan-site/`。生产 = 韩国 `aliyun-kr:/var/www/chenchuan-site`（PM2 `chenchuan-site`）；旧香港机 `chenchuan-site` 别名已非生产。**部署前必跑 `dig +short my.chenchuan.cc A` 确认 A 记录**。
- 内容真源：项目卡 `src/data/projects.ts`、文章 `src/data/articles.ts`、经典回放 `src/data/classic-demos.ts`、AI 镜像 prompt `src/lib/chat/system-prompt.ts`。视频真源是生产 SQLite（`managed_videos`），不是 `videos.ts`。
- 不全量 `git add`；生产用精确文件 rsync + SHA-256 对账，改前建 `/var/www/chenchuan-site-backups/<批次>-<日期>/` 备份。

## 口径铁律（违反会被用户纠正，全部有过实案）

1. 受众 = HR / 投资人 / 非技术高管。白话优先，技术词必带括号解释；数字翻译成感受。
2. 独立项目一律「一个人 vibe coding 完成，没有团队，AI 是我的手脚」；绝不写「AI 工程团队」。真实公司人类团队战绩（AR HUD 产品市场团队等）保留不删。
3. 对外只用 EvoDesk，不出现内部工作台代号；不出现「川哥」「XX 钦定」等内部称呼与引擎口吻。
4. 负结果/研究止损 = 「阶段性结论 + 后续优化方向」，不写「暂停 / 关路 / 失败」。
5. **禁写 91.5%**（LnMem 准确率，存在合成/真人口径矛盾，已拍板全站去数字化）；同类口径争议数字一律「不体现具体数据，只做结论和逻辑性说明」。
6. 时间锚点：vibe coding 工作流起点 = 2025 年底（跨度按此推算，勿写 2024）。
7. 不出现：公司名细节、org 仓、协作者真名、服务器/域名/token、逆向厂商参数细节；灰色来源（如媒体取流方式）淡化。
8. 落稿流程：草稿 markdown 落 `docs/` → 发用户在原文修改标注 → 逐条落实（字面执行，禁扩展）→ 上线。

## 数字核实（公开载荷硬门槛）

写稿前把将出现的每个数字列清单，派只读 agent 回溯**原始结果文件**（leaderboard.json / 实验报告 / 生产实数清点）逐项核实。已知四类漂移：记忆 description 行的摘要值 ≠ 正文实测值；定语错（真人/合成）；单位错（分数 vs 题数）；现状过时（配置数、通道数）。核实清单随稿附上。详见记忆 `feedback_public_content_number_verification`。

## 渲染注意（实测过的坑）

- 项目卡 `fullDescription` / 详情页为**纯文本渲染**：`**加粗**` 星号会裸露显示——段首强调用「」中文引号。
- 文章正文走 `src/components/writing/ArticleBody.tsx`：支持 `####` 小标题、空行分段、`**加粗**`、URL 自动链接（arXiv 引用直接贴 `https://arxiv.org/abs/ID`，会渲染为可点链接）。列表条目之间必须空行（单换行会被并进同一段）。
- `brief.stack` 是无渲染死字段；访客可见技术点写 `highlights`（列表页渲染 `brief.problem/solution/result` + 详情页 `highlights/tags/fullDescription`）。
- 首页 ProjectGrid 只显示 `featured: true`。
- 学术引用的论文标题**必须从 arXiv API 取真值**（本地经 `socks5h://127.0.0.1:10808` 代理访问 `export.arxiv.org`；韩国机对 arXiv 限流挂起，勿从生产机调）。

## 上线流程

1. 本地改数据文件 → `npm run build` 过 → `preview_start`（launch.json `chenchuan-site-dev`，端口 3100）快验渲染。
2. 全文 grep 自查：`91.5`、`川哥`、`钦定`、裸 `**`（详情页文本内）应全为 0。
3. commit（格式 `feat(chenchuan-site): ...`，无 Co-Authored-By）。
4. `dig` 确认 A 记录 → 生产备份 → 精确文件 rsync → 本地/生产 SHA-256 逐文件对账。
5. 生产 `npm run build && pm2 restart chenchuan-site` → 确认 online。
6. **公网 E2E（必须自己验，不甩给用户）**：新页面 200 + 关键词在 HTML 里 + 下架页 404 + 占位文案消失 + 口径词零残留；文章附链接时数链接个数。
7. push origin + task-log + 重要决策写 `04-决策记录.md` + 记忆更新 `project_chenchuan_site`。

## 回滚

生产备份目录（步骤 4）+ git revert；只回滚目标文件，不全库恢复。
