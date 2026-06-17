# mycc-brain（brain-product）

> 状态：paused（推断依据：实质性开发与 HANDOFF 文档最后停在 2026-04-11 的 v0.13.3，此后两个月无新代码/交接产出，仅 `mycc-brain/.env.local` 于 2026-06-15 被改动；服务仍在 Studio 上 pm2 online 运行，故非 done/archived）
> 最后活跃日期：2026-06-15（目录内最新文件 `mycc-brain/.env.local`；最新实质性内容文件为 2026-04-11 的 HANDOFF-v0.13.3）
> 一句话目标：把 cc 的"大脑"做成"机制×模型"的活系统——经验流→记忆结晶→行为适应的自动闭环，对外以 OpenAI 兼容 API 暴露多模型（含 Gemini 6 模型），最终通过本地微调内化行为模式（来源：HANDOFF.md 架构共识 + HANDOFF-gemini-integration-v0.13.md）

## 下一步
- [ ] 确认项目是否继续推进，还是正式转 archived（已停滞约 2 个月，待川哥确认）
- [ ] HANDOFF.md 列的待决策仍未结：项目定位（自用升级 vs 产品化）、第一步优先级（经验流 / 多模型对比 / 热修复）、微调时机
- [ ] HANDOFF.md 引用的 `PROPOSAL.md` 在本目录已不存在，需确认是否已迁移/删除（待川哥确认）

## 归档条件
- 川哥确认大脑方向并入主线 mycc 后端、本目录仅留历史 → 转 archived
- 或明确放弃自进化大脑方向、Studio 上 brain 服务下线 → 转 archived

## 当前事实
- 本目录为 mycc 单仓子目录，无独立 GitHub repo（基于本地内容生成）。
- 子目录 `mycc-brain/` 是已编译的 Node/TS 服务（有 `dist/`、`node_modules/`、`package-lock.json`，但**根目录无 `package.json` 源文件**，本目录仅保留编译产物 + 锁文件 + handoff）。
- 截至 2026-04-11，brain 版本演进到 **v0.13.3**，已部署 Studio（M2 Max），pm2 online；v0.13.3 修复了 items_fts schema 漂移 bug，三门通过（来源：HANDOFF-v0.13.3-items-fts-fix.md）。
- 已接入 Gemini 6 个生产可用模型（cc/raw 双前缀），统一走 `src/llm/gemini-client.ts`（来源：HANDOFF-gemini-integration-v0.13.md）。
- 目录内约 30 份 HANDOFF-*.md，覆盖 phase1/2、vision、eval、admin UI、记忆面板等多条线，是该项目的主要交付记录。
- 架构共识（HANDOFF.md）：经验流(JSONL+惊讶度评分)、三循环时间架构、双模式大脑(Claude Sonnet API 完整模式 + 本地 Qwen3-14B 生存模式)、热修复机制、四层微调闭环。

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| 根交接文档 | `2-Projects/brain-product/HANDOFF.md` | 架构共识 + 待决策总览（2026-04-02） |
| 最新版本交接 | `2-Projects/brain-product/HANDOFF-v0.13.3-items-fts-fix.md` | v0.13.3 修复记录（2026-04-11，最新实质内容） |
| Gemini 接入交接 | `2-Projects/brain-product/HANDOFF-gemini-integration-v0.13.md` | 6 模型接入 + 调用统一 |
| 服务代码（编译产物） | `2-Projects/brain-product/mycc-brain/dist/` | server.js / brain-api.js / mcp-entry.js 等 |
| 运行日志 | `2-Projects/brain-product/mycc-brain/data/` | eval/sync-cron 日志 |
| Admin UI | `http://cli4.hahaxiong.cc:19080/admin` | 注意是 http 非 https（来源：HANDOFF-v0.13.3） |
| Chat API | `http://10.9.1.155:19080/v1/chat/completions` | OpenAI 兼容，Auth: `Bearer sk-brain-dev`（来源：HANDOFF-v0.13.3） |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无（mycc 单仓子目录） |
| 服务地址 | Admin UI `http://cli4.hahaxiong.cc:19080/admin`；API `http://10.9.1.155:19080/v1/chat/completions`；部署在 Studio（M2 Max），SSH 跳板 `studio-pub`（经 mini ProxyJump） |
| 端口 | 19080 |
| 负责人 | 川哥（cc 执行） |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
