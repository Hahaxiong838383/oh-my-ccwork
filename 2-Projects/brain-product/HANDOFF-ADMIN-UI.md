# HANDOFF — brain Admin UI Session（2026-04-04）

## 已完成

### V1.0 Chat-First UI 重构（tag: `admin-ui-v1.0`）
- 三 Tab 平铺 → 侧边栏 + 气泡聊天双栏布局
- Chat/Agent/Compare 三模式 pill 切换
- 会话持久化（localStorage，50 会话 / 100 消息上限）
- 四运维面板：数据面板/系统配置/进化中心/热补丁
- 响应式三档断点 + 移动端 overlay

### Bug 修复
- emptyState DOM 销毁 → `getEmpty()` 重建（`9fc8372`）
- Agent SSE emptyState null crash（`9fc8372`）
- Agent tok/s 改用服务端 durationMs，只计 LLM step 时间（`838c67b` + `a31b61f`）
- 默认 token `sk-brain-dev` 自动设置

### Phase 1：多轮对话上下文（`f5fe29b`）
- 前端 `getHistory(sess, 10)` 提取最近 10 轮历史
- Chat/Agent 模式发送 `messages[]` + `prompt`
- 后端 `/admin/api/test`、`/agent`、`/agent/stream` 接收 `body.messages[]`
- 消息拼接顺序：system prompt → history → current prompt
- max_tokens 从 200 改为 `route.maxTokens`（默认 4096）
- Compare 模式保持单轮

### 后端：session archive 端点
- `POST /admin/api/sessions/archive` — 清理的消息写入 `data/session-archives/{date}.jsonl`

### Phase 2：记忆写入工具
- 新增 Agent 工具 `add_memory`（`src/tools/add-memory.ts`）
- 工具参数：`{ category: string, content: string, keywords: string[] }`
- 写入 `{dataDir}/user-memories.jsonl`（JSONL 追加模式）
- Brain system prompt 含指令：「当用户要求记住某件事时，使用 add_memory 工具保存」
- `brain-context.ts` 检索流程加载 user-memories，关键词匹配后合并到 context
- 两处 ToolRegistry（stream + sync）均注册 `addMemoryTool`

### Phase 3：会话服务端持久化 + 管理 UI
- 后端 `GET/POST /admin/api/sessions` + `DELETE /admin/api/sessions/:id`
- 存储文件 `data/admin-sessions.json`（单文件 JSON）
- 前端启动异步从服务端加载会话，fallback localStorage
- `saveSess()` 双写：localStorage + 服务端 fire-and-forget
- `delSess()` 额外通知服务端删除
- 侧边栏「管理会话」按钮 + modal overlay
- 管理功能：搜索过滤、checkbox 批量删除、导出 JSON

### P0+P1：记忆系统规则驱动升级（2026-04-04）

**P0：memory-rules.md 规则文档**
- `docs/memory-rules.md` v1.0：从 memory-system.md 提取纯规则，7 章（六维度摄入/存储格式/矛盾检测/遗忘巩固/失真预算/因果关联/LLM输出Schema）
- 用途：brain post-hook 的 LLM prompt + Air CLAUDE.md include 源

**P1：post-response 记忆提取**
- `src/services/memory-intake.ts`：每轮对话后异步调 LLM 提取原子事实，fire-and-forget 不阻塞响应
- `src/services/memory-store.ts`：解析/追加 memory-items.md，支持命名空间 + 矛盾标记 `[?conflict]`
- `src/config.ts`：新增 `memoryLLM` 配置（intake/consolidation/fallbackIntake），复用 openai-compat 适配器
- `src/server.ts`：删除旧 `tryAutoSaveMemory` 正则匹配，test/compare 端点响应后加 `runMemoryIntake()` hook
- 降级链：本地 Ollama qwen2.5:7b → 云端 DashScope qwen2.5-7b-instruct → 静默跳过
- **前端零改动**，Admin UI HTML 未触及

## 待做（后续 Session）

| Phase | 内容 | 依赖 |
|-------|------|------|
| **部署验证** | deploy.sh 推到 Studio，Chat 模式验证 memory-items.md 自动写入 | P0+P1 代码 |
| **对齐 eval** | tests/memory-spec/ 用例集，验证 brain 摄入与 Air 六维度对齐度 | P0 rules + P1 intake |
| **P2** | 每日巩固 scheduler（矛盾检测三步法完整版 + Δ巩固 + 过期清理） | P1 |
| **P3** | Admin UI 记忆面板（可视化 items + 健康度） | P2 |
| **P4** | 多模态 adapter 接入 | 按需 |

## 部署方式

```bash
# 后端改动（server.ts / tools）
cd 2-Projects/brain-product/mycc-brain && bash deploy.sh

# 前端仅改 HTML（热更新，无需重启 pm2）
cat /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/admin/admin-ui.html | \
  ssh studio-pub "cat > /Users/fu-121/mycc-brain/dist/admin/admin-ui.html && \
  cp /Users/fu-121/mycc-brain/dist/admin/admin-ui.html /Users/fu-121/mycc-brain/src/admin/admin-ui.html"
```

## 踩坑记录
- deploy.sh 的 rsync 同步 `src/`，但 tsc 构建失败会导致 HTML 不复制到 `dist/`
- scp/cat 管道推送时**必须用绝对路径**，CWD 可能变
- Studio 服务从 `dist/admin/admin-ui.html` 读取（`import.meta.dirname + "/admin/admin-ui.html"`）
- Studio SSH 跳板：`studio-pub`（ProxyJump mini-pub），pm2 需要 `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH`
- memory-rules.md 有两份：mycc/docs/（真相源）和 brain/docs/（副本）。deploy.sh 会自动同步，手动修改只改真相源

## 关键文件

| 文件 | 说明 |
|------|------|
| `docs/memory-rules.md` | P0：记忆规则规范 v1.0（LLM prompt 源） |
| `src/services/memory-intake.ts` | P1：LLM 提取引擎（fire-and-forget） |
| `src/services/memory-store.ts` | P1：memory-items.md 读写 + 矛盾标记 |
| `src/config.ts` | P1：memoryLLM 配置（intake/consolidation/fallback） |
| `src/server.ts` | P1：删旧 tryAutoSaveMemory + 加 runMemoryIntake hook |
| `src/tools/add-memory.ts` | Phase 2 原有：add_memory 工具（Agent 模式仍用） |
| `src/services/brain-context.ts` | Phase 2 原有：记忆检索 + prompt 注入 |
| `src/admin/admin-ui.html` | Phase 3 原有：双写逻辑 + 管理 UI modal |
| `data/user-memories.jsonl` | Phase 2 数据：用户记忆（旧，保留读取） |
| `data/admin-sessions.json` | Phase 3 数据：会话服务端存储 |

## Git 状态
- 最新 commit：`f5fe29b` feat(brain): Phase 1 多轮对话上下文
- Tag：`admin-ui-v1.0` = `a31b61f`
- 回滚：`git checkout pre-admin-ui-rewrite -- src/admin/admin-ui.html src/server.ts`
