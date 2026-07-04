# chenchuan-site（川哥个人站 / my.chenchuan.cc）

> 状态：active（推断依据：最新文件修改在 2026-06-15，`data/`、`.next/` 构建产物 + `scripts/` 当天更新；COLLAB-RULES.md / SYNC-LOG.md 为 2026-06-14 新立，处于多 session 协作活跃期）
> 最后活跃日期：2026-06-15
> 一句话目标：用 Next.js 个人站对外展示川哥的作品 / 专利 / Lab Demo（AR-HUD、KidsHub-AI），承接招聘者与企业高管的「5 秒看懂这人做过什么」。

## 下一步
- [ ] 确认个人站如何「展示」KidsHub-AI：(a) iframe 嵌公司站 URL（COLLAB-RULES 强烈推荐）还是 (b) import / 复制 P003 build 产物（待川哥确认，见 COLLAB-RULES.md 末尾「开工前先确认 1 件事」）
- [ ] Talk-With-My-AI（`/ai-os/chat`）1.0 上线：DeepSeek + Gemini Proxy 凭据、每日预算、飞书预警 webhook 仍待配齐（依据 `.env.example`）
- [ ] 访问统计后台（`/admin`）生产环境密钥填充（ANALYTICS_* 一组，依据 `.env.example`）

## 归档条件
- 个人站停止迭代且 `my.chenchuan.cc` 不再维护 / 下线
- 或川哥明确将「对外展示」职能并入其他载体（公司站 / 新站）后

## 当前事实
- 技术栈：Next.js 15 + React 19 + TypeScript + TailwindCSS（`package.json` version 1.0.0）；交互 Demo 用 three.js + @mediapipe/tasks-vision + framer-motion。
- 站点分区（`src/app/`）：about / work / patents / lab（含 AR-HUD Demo）/ videos / ai-os（Talk-With-My-AI 聊天）/ radar / writing / contact / admin（访问统计后台）。
- 数据层：访问统计用 better-sqlite3（`data/analytics.db`）；鉴权用 jose（JWT）+ bcryptjs。
- AR-HUD Demo（`/lab/ar-hud-demo`）：100% 本地推理（MediaPipe 眼动 + 手势捏合），端到端延迟 ~60-90ms，已部署上线 `my.chenchuan.cc/lab/ar-hud-demo`（依据 `docs/AR-HUD-DEMO-STATUS.md`）。
- KidsHub-AI 展示：核心在另一目录 `2-Projects/P003GameDemo20260513/`（vite SPA，main 主线地盘），本站只做展示层；切场景卡 TTS 续播 bug 已由主线根治并两站部署生效（commit `c9278edf6`，依据 SYNC-LOG.md 2026-06-14）。
- Directus CMS（`docker-compose.yml` + `directus/`）：早期 CMS 方案，相关文件最后修改停在 2026-03-31，当前活跃栈已转向 Next.js + SQLite + 外部 LLM provider（Directus 是否仍在用，待川哥确认）。
- 仓库定位：mycc monorepo 子目录，无独立 GitHub repo；协作铁律见 COLLAB-RULES.md（目录墙 / 禁全量 add / 只 push 自己的 personal-site 分支）。

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| 协作铁律 | [COLLAB-RULES.md](./COLLAB-RULES.md) | 展示层 session 必读：目录墙、禁全量 add、单向数据流 |
| 主线同步日志 | [SYNC-LOG.md](./SYNC-LOG.md) | KidsHub 主线 → 个人站展示层的关键同步留档 |
| AR-HUD Demo 交接 | [docs/AR-HUD-DEMO-STATUS.md](./docs/AR-HUD-DEMO-STATUS.md) | `/lab/ar-hud-demo` 状态 + 技术方案 + TODO（新人只看这份） |
| 应用源码 | [src/app/](./src/app/) | Next.js App Router 各分区页面 |
| 环境变量样例 | [.env.example](./.env.example) | 站点 / Directus / 统计后台 / 聊天 provider 全量配置说明 |
| 容器编排 | [docker-compose.yml](./docker-compose.yml) | site + directus + postgres 三服务（早期 CMS 方案） |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无独立 repo（mycc monorepo 子目录 `2-Projects/chenchuan-site/`） |
| 服务地址 | 生产：https://my.chenchuan.cc （含 `/lab/ar-hud-demo`、`/kidshub-ai/`、`/contact`、`/admin`）；部署在 `chenchuan-site:/opt/kidshub-personal`（pm2 `kidshub-voice`，依据 SYNC-LOG.md） |
| 端口 | site 容器 `${SITE_PORT:-3100}→3000`；Directus CMS `${CMS_PORT:-8055}→8055`；postgres 内部 5432（依据 docker-compose.yml）。dev 注意避开 5173/5174/5175/4173（main 主线 P003 占用） |
| 负责人 | 川哥（开发执行 cc / 展示层 session；KidsHub 核心由 main 主线 cc 维护） |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
