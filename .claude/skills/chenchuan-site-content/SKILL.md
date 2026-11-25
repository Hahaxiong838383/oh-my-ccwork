---
name: chenchuan-site-content
description: 陈川个人站内容更新工艺：项目卡/文章的口径铁律、数字核实流程、渲染注意、部署与公网验收。用于用户提到"个人站加项目卡""更新个人站内容""首页媒体报道""完整首页预览""写文章上站""writing 板块""个人站文案"时。视频线走 chenchuan-site-media。
---

# 个人站内容更新（项目卡 / 文章线）

## 边界

- 项目：`2-Projects/chenchuan-site/`。生产 = 韩国 `aliyun-kr:/var/www/chenchuan-site`（PM2 `chenchuan-site`）；旧香港机 `chenchuan-site` 别名已非生产。**部署前必跑 `dig +short my.chenchuan.cc A` 确认 A 记录**。
- 内容真源：项目卡 `src/data/projects.ts`、文章 `src/data/articles.ts`、经典回放 `src/data/classic-demos.ts`、AI 镜像 prompt `src/lib/chat/system-prompt.ts`。视频真源是生产 SQLite（`managed_videos`），不是 `videos.ts`。
- 不全量 `git add`；生产用精确文件 rsync + SHA-256 对账，改前建 `/var/www/chenchuan-site-backups/<批次>-<日期>/` 备份。

## 韩国生产接入

- 韩国节点是阿里云轻量应用服务器 SWAS，不是标准 ECS。没有可用 SSH/GUI 时，从密码库读取阿里云 AccessKey，通过 `aliyun swas-open` 的 `ap-northeast-2` 地域查询实例并使用云助手；AccessKey 不是网页登录密码，绝不打印或放入 argv。
- 用户只授权韩国节点时，只查询 `ap-northeast-2` 并对 DNS 当前指向的精确实例执行命令；不得顺手枚举、登录或修改香港实例。
- 云助手命令返回的 `InvocationResult.Output` 是 Base64；只解码预先限定的非敏感输出。生产状态用 PM2 精确字段和 Nginx 本机 HTTPS 回环验证，不假设 Node 一定监听 3000/3100。

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
2. 全文 grep 自查：`91.5`、`川哥`、`钦定`、裸 `**`（详情页文本内）及本批次禁词/过时口径应全为 0；当前禁词包括 `Gemini`、`四引擎`、`ERP`、`GEO`，后续只有用户明确改口才移除。
3. commit（格式 `feat(chenchuan-site): ...`，无 Co-Authored-By）。
4. `dig` 确认 A 记录 → 生产备份目标文件、原 `.next`、PM2 状态和 before SHA → 精确上传文件并核对上传包 SHA。打包排除运行数据时必须用根路径锚定（如 `--exclude=/data`，兼容生产 data 为符号链接）；禁止 `--exclude=data`，它会误排除 `src/data/`。
5. 不在生产目录原地 build。复制到 `/var/tmp/chenchuan-site-build-<commit>` 隔离构建，复用生产依赖；用 SQLite 在线备份生成一致性副本，构建和 canary 均显式指定副本的 `ANALYTICS_DB_PATH`；用独立端口 canary 验证新文案、旧口径清零和资源可用后，再原子切换 `.next` 并重启 PM2。部署脚本设置失败自动恢复目标文件和原 `.next`。
6. 确认 PM2 `online`、`unstable_restarts=0`；本机链路用 `curl -skf --resolve my.chenchuan.cc:443:127.0.0.1 https://my.chenchuan.cc/<path>` 经过真实 Nginx 验证，不猜内部监听端口。
7. **公网 E2E（必须自己验，不甩给用户）**：桌面与 390×844 移动端真实点击导航、项目卡、关联项目、菜单和视频；检查控制台 0 error/warning、无横向溢出、关键页/图片 200、视频 Range 206、旧口径零残留。文章附链接时数链接个数。
8. 本地/生产目标文件 SHA-256 逐一一致后记录 after SHA、部署元数据和回滚路径；push origin + task-log + 重要决策写 `04-决策记录.md` + 记忆更新 `project_chenchuan_site`。

## 回滚

生产备份目录（步骤 4）+ git revert；只恢复本批次目标文件和 `next.before`，不全库恢复。回滚后重复 PM2、Nginx 回环和公网关键页验收。

## 首页报道的预览、验收与恢复演练

- **完整首页预览。** 先比对线上视频、项目和动态栏目。本地回退数据缺项时，用生产数据副本渲染；仅审阅布局也可用线上页面快照插入候选组件，交付时标明静态预览。桌面和手机都检查首屏、新区块前后顺序、滚动入场内容和页脚。长图末端空白时，逐屏滚动截图再拼接，核对最后一屏能读到页脚。
- **外链与封面。** 逐条比对用户提供的微信地址，确认手机布局、封面解码和点击目标。公众号环境验证页也会返回 200；分别记录本站入口、外站响应和正文可读性。用本地压缩封面及普通链接，检查进入首页时是否提前请求第三方播放器。
- **速度。** 发布前就留基线。用相同网络、浏览器、视口、缓存状态和采样次数比较前后 LCP、TTFB 中位数，同时记录压缩 HTML、JS 和封面实际传输字节。即使两次 LCP 接近，也要交代新增传输量。
- **回滚演练。** 保存旧 BUILD_ID、完整旧构建、目标文件指纹和新增路径清单。用旧构建和数据库副本在隔离端口启动，核对旧版独有内容及原有数据。切换后抽查旧标签页引用的静态资源；恢复脚本先核对当前构建与文件指纹，避免覆盖后续发布。记录隔离恢复和生产回退各自的实际执行情况。
