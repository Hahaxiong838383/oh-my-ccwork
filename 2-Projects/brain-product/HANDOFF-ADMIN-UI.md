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

## 待做

暂无。Phase 1-3 全部完成并部署。

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

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/add-memory.ts` | Phase 2 新增：add_memory 工具 |
| `src/services/brain-context.ts` | Phase 2 改动：user-memories 检索 + prompt 指令 |
| `src/server.ts` | Phase 2+3：工具注册 + sessions CRUD 端点 |
| `src/admin/admin-ui.html` | Phase 3：双写逻辑 + 管理 UI modal |
| `data/user-memories.jsonl` | Phase 2 数据：用户记忆存储 |
| `data/admin-sessions.json` | Phase 3 数据：会话服务端存储 |

## Git 状态
- 最新 commit：`f5fe29b` feat(brain): Phase 1 多轮对话上下文
- Tag：`admin-ui-v1.0` = `a31b61f`
- 回滚：`git checkout pre-admin-ui-rewrite -- src/admin/admin-ui.html src/server.ts`
