# mycc-brain 项目规则

## 版本管理（强制）

**版本号唯一真相源：`package.json` 的 `version` 字段。**

以下三处版本号必须始终一致：
1. `package.json` → `"version": "x.y.z"`
2. `src/server.ts` → 启动横幅 `mycc-brain vX.Y.Z`
3. `src/server.ts` → `/admin/api/status` 响应的 `version` 字段

### 升版规则

| 变更类型 | 版本位 | 示例 |
|---------|--------|------|
| 新功能（feat） | minor +1 | 0.6.0 → 0.7.0 |
| bug 修复（fix） | patch +1 | 0.6.0 → 0.6.1 |
| 重大架构变更 | major +1 | 0.6.0 → 1.0.0 |
| 重构/文档/chore | 不升版 | — |

### 强制流程

每次 `feat` 或 `fix` 提交时，**必须同时更新三处版本号**。忘记升版 = 提交不完整。

```bash
# 快速检查版本一致性
grep '"version"' package.json
grep 'version:' src/server.ts
grep 'mycc-brain v' src/server.ts
```

### 版本历史

| 版本 | 日期 | 里程碑 |
|------|------|--------|
| 0.1.0 | 2026-04-03 | 初始版本，OpenAI 兼容代理 |
| 0.2.0 | 2026-04-04 | D2 记忆注入 + 四路检索 |
| 0.3.0 | 2026-04-05 | D4 Agent Loop + MCP |
| 0.4.0 | 2026-04-06 | 自进化系统 + Admin UI |
| 0.5.0 | 2026-04-07 | 在线模型接入 + 图谱 |
| 0.5.1 | 2026-04-07 | P0 TTFT 优化 |
| 0.6.0 | 2026-04-08 | Vision P0-P2（感知+自进化+prompt自调优） |
| 0.7.0 | 2026-04-09 | Phase 1 可观测面板（Admin UI observe Tab） |
| 0.8.0 | 2026-04-09 | Phase 2 可量化系统（TrustState+Guard+VetoSpiral） |
| 0.9.0 | 2026-04-09 | 算力重规划（Studio主力27B + Mini辅助intake/consolidation） |
| 0.9.1 | 2026-04-10 | eval 链路加固 + Studio SSOT 架构 |
| 0.9.2 | 2026-04-10 | retrieval cap=20 + tfidf topK=2 恢复生成质量 + eval generation_override |
| 0.9.3 | 2026-04-10 | eval 方差研究 (10 runs, EVAL_TEMPERATURE 支持) + claude-memory 阈值收紧（保护中文短 query） |
| 0.10.0 | 2026-04-11 | 外挂知识系统 P0.1-P0.6（crawler + extractor + 第五路 knowledgeSearch + scheduler sync）部署 Studio 落盘 |
| 0.11.0 | 2026-04-11 | 方舟 Coding Plan 接入 Admin UI + extraBody adapter（替换 Gemini Flash 解 429 blocker） |
| 0.12.0 | 2026-04-11 | Admin UI 知识库面板 + 5 个 `/admin/api/knowledge/*` 路由（steering_tax 盲区可视化） |
| 0.12.1 | 2026-04-11 | 第五路注入打通 + 白名单扩业务词（Futurus/公司/战略类） |
| 0.12.2 | 2026-04-11 | Codex 对抗审查 2 HIGH：itemCount 包含 knowledge hits + 知识库注入并入统一 MAX_BUDGET 预算器 |
| 0.12.3 | 2026-04-11 | 中文 FTS5 2-gram 预分词 + `maybeRebuildKnowledgeFts` 迁移（纯中文 query 召回打通） |
| 0.12.4 | 2026-04-11 | 中文停用词 + min_match 比例 + rank 阈值三门 + `markDocStale` tombstone + Admin UI 🔖knowledge label |
| 0.12.5 | 2026-04-11 | fix: 清理 judge-evaluator 2.0/1.5 遗留（Vertex 404）+ 新建 `src/llm/gemini-client.ts` 统一入口（白名单 + thinking 映射）|
| 0.13.0 | 2026-04-11 | feat: Gemini 6 模型全接入 Admin UI（+8 条路由：2.5-pro、2.5-flash-lite、3-flash-preview、3.1-pro-preview 各 cc/raw 双版本）+ config.ts baseURL 收敛到 gemini-client.ts 常量 |
| 0.13.1 | 2026-04-11 | fix: 命名漂移修复 `cc/raw-gemini-3.1-flash` → `cc/raw-gemini-3.1-flash-lite`（底层 model 本就是 `gemini-3.1-flash-lite-preview`，路由 key 现在忠实反映）+ 同步 docs/runtime-env.md & docs/vision-daemon.md |

## Admin UI 版本

**版本号位置：`src/admin/admin-ui.html` 的 `ADMIN_UI_VERSION` 常量。**

Admin UI 独立于后端版本，前端有改动时升版（minor +1）。当前 v2.6。

## Thinking 模式（强制）

**新增模型路由时，`supportsThinking` 默认设为 `false`。**

原则：thinking 由前端用户主动开启（Admin UI 的 Think 开关），后端不预开。`supportsThinking: true` 仅用于明确需要 thinking 且前端已适配 `<think>` 标签剥离的云端模型（如 Gemini、MiniMax）。本地 MLX 模型一律 `false`，避免生成大量隐藏 reasoning token 导致响应缓慢。

**踩坑**：Qwen3.5 默认开启 thinking，9B 模型一个简单问题要 2 分钟才返回，关闭后 10 秒内响应。

## Gemini 系列模型调用规则（强制）

**唯一事实来源：[`docs/gemini-calling-rules.md`](./docs/gemini-calling-rules.md)（v5.3，2026-04-11）**

所有 Gemini 系列模型（2.5-pro / 2.5-flash / 2.5-flash-lite / 3.1-pro-preview / 3.1-flash-lite-preview / 3-flash-preview）的调用必须遵守该文档：

- **Base URL**：`http://23.226.135.149:4000/v1`（cc 维护的 Gemini Proxy wrapper，OpenAI 兼容）
- **禁用**：2.0 / 1.5 系列（Vertex 已全下架）、`gemini-3-pro-preview`（2026-03-26 discontinued）、任何带日期/版本号后缀的变体（全部 404）
- **thinking 策略**：wrapper 默认最小化 thinking（秒回），需深度推理时传 `reasoning_effort`（none/low/medium/high），与本项目"前端主动开启"规则完全一致
- **不要自行加**：429 退避、Vertex/OAuth fallback、per-model rate limit —— wrapper 已做，重复实现只会引发冲突
- **max_tokens 上限**：65535（不是 65536，传 65536 会 400）

**接入 / 修改 Gemini 调用前必读该文档**。疑问直接找 cc。

### 已知待清理遗留

- [x] `src/eval/judge-evaluator.ts` 仍引用 `gemini-2.0` / `gemini-1.5` 系列，需替换为 2.5 对应版本（Vertex 已下架，当前调用必 404）（2026-04-11 v0.12.5 修复）

## 部署

- Studio SSH: `studio-pub`（经 Mini 跳板）
- 部署脚本: `bash deploy.sh` 或手动 rsync + tsc + pm2 restart
- 部署后必须验证: `pm2 logs brain --lines 5 --nostream`
