# HANDOFF — mycc-brain D4 Session（2026-04-04）

## 已完成

### D4 Agent Loop（Phase 1-4 全部完成）
- **P1**: 手写 Agent Loop + ToolRegistry + 3 内置工具（search_memory/list_memories/run_diagnosis）
- **P2**: MCP Server（`src/mcp-entry.ts`），Claude Code 可通过 `claude mcp add` 连接
- **P3**: SSE 流式 Agent Loop（`/admin/api/agent/stream`），Admin UI 实时显示步骤
- **P4**: MCP Client 桥接（`src/services/mcp-client.ts` + `mcp-bridge.ts`），Agent 可调外部 MCP 工具

### Gemma 4 26B 接入
- 路由: `cc-gemma4` / `raw-gemma4`，Ollama localhost:11434
- reasoning fallback: content 空时用 reasoning 字段
- maxTokens: 32768
- Admin UI Think 开关控制 `enable_thinking`

### TTFT 优化（P0 + P1 完成）
- **P0**: FTS5 修复（better-sqlite3 加入 dependencies + Air 预编译 rsync）、thinking 默认关、Ollama warmup、deploy.sh 重构
- **P1**: 记忆缓存 LRU（60s TTL, 50 条）、FTS + Vector 并行检索
- **P2 待做**: 预计算记忆摘要 + 轻量路由跳过检索

### Admin UI 改进
- 下拉选模型不再跳回默认值（保持选择）
- 本地模型可在 A/B Compare 和 Agent Test 中选择
- TTFT + tok/s 速度指标显示
- loading 文案改为"请求中，等待模型响应"

### Bug 修复
- 进化 Tab hash 路由（validTabs Set）
- Node.js fetch error.cause 提取
- deploy.sh 内外网自动切换

## 关键文件
| 文件 | 职责 |
|------|------|
| `src/services/agent-loop.ts` | Agent Loop 核心 |
| `src/services/tool-registry.ts` | 工具注册中心 |
| `src/services/mcp-server.ts` | MCP Server |
| `src/services/mcp-client.ts` | MCP Client |
| `src/services/mcp-bridge.ts` | MCP→ToolRegistry 桥接 |
| `src/mcp-entry.ts` | MCP 独立入口 |
| `src/services/brain-context.ts` | 记忆检索 + LRU 缓存 |
| `src/adapters/openai-compat.ts` | LLM 适配器 |
| `src/config.ts` | 路由配置（含 Gemma4） |
| `deploy.sh` | 部署脚本（Air 预编译） |

## 待办
- [ ] TTFT P2: 预计算记忆摘要 + 轻量路由
- [ ] MCP Server 接入 Claude Code 实测
- [ ] mcp-servers.json 配置 feishu-mcp 实测
- [ ] P5 SFT（experience >= 1000 条触发）
- [ ] Studio Xcode CLI Tools 修复（sudo xcode-select --switch）

## 踩坑记录
- better-sqlite3 必须在 package.json dependencies 里，不能靠 try-catch 静默降级
- Studio Xcode 损坏，node-gyp 编译失败 → 用 Air 预编译 rsync 绕过
- Gemma 4 默认 thinking 模式，response 在 reasoning 字段不在 content
- Admin UI 下拉选项重建时要保存/恢复当前选中值
- 改完代码必须 deploy.sh 部署，不能只 push 到 git
