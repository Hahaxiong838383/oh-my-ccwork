# mycc-brain D1 交接文档

> 创建时间：2026-04-03 09:55 | 创建者：cc (Claude Opus 4.6)
> D1 完成状态：✅ 全部通过

---

## 一、D1 已完成

### 代码（Air 本地 → Studio 部署）

| 文件 | 位置 | 说明 |
|------|------|------|
| `package.json` | `2-Projects/brain-product/mycc-brain/` | 依赖 dotenv/tsx/typescript |
| `tsconfig.json` | 同上 | ES2022 + ESM |
| `src/config.ts` | 同上 | .env 加载 + 6 个 model 路由配置 |
| `src/adapters/openai-compat.ts` | 同上 | 通用 OpenAI 格式适配器（Qwen/DeepSeek/Ollama） |
| `src/brain-api.ts` | 同上 | 核心：POST /v1/chat/completions + GET /v1/models |
| `src/server.ts` | 同上 | HTTP 入口 :19080 + Admin API（status/restart/test） |
| `src/admin/admin-ui.html` | 同上 | 管理面板（暗色主题） |
| `deploy.sh` | 同上 | 一键推送到 Studio |
| `.env.example` | 同上 | 配置模板 |

### 基础设施

| 项目 | 状态 | 详情 |
|------|------|------|
| **SSH 三机互联** | ✅ | Air↔Mini↔Studio，别名 `ssh mini` / `ssh studio` |
| **Studio 环境** | ✅ | Node v22.14.0 + npm 10.9.2 + pm2 6.0.14 |
| **brain 进程** | ✅ | pm2 托管，pid 83912，:19080 |
| **记忆数据同步** | ✅ | rsync 每 5min Mini→Studio（雷电网桥），数据在 `/Users/fu-121/mycc-data/0-System/` |
| **Admin UI** | ✅ | `http://10.9.1.155:19080/admin` |
| **代理绕过** | ✅ | Air macOS bypass 已加局域网；Studio 无代理，DashScope 直连 129ms |
| **Qwen API** | ✅ | qwen3.5-27b，DashScope compatible mode，流式 SSE 已验证 |

### 验证记录

```bash
# Health
curl --noproxy '*' http://10.9.1.155:19080/health
# → {"status":"ok","service":"mycc-brain"}

# Models
curl --noproxy '*' http://10.9.1.155:19080/v1/models
# → 6 个模型路由

# 流式对话（Qwen3.5-27B）
curl --noproxy '*' -X POST http://10.9.1.155:19080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cc-qwen","messages":[{"role":"user","content":"你好"}],"stream":true}'
# → 标准 OpenAI SSE 格式，带 reasoning_content
```

---

## 二、架构变更（vs HANDOFF-v5 原方案）

| 项目 | 原方案（v5） | 实际（D1） | 原因 |
|------|-------------|-----------|------|
| **部署位置** | Mini（嵌入 mycc 后端） | Studio（独立项目） | 不影响 Mini 生产服务，独立重启 |
| **主力模型** | Claude API | Qwen3.5-27B (DashScope) | 用户选择，国内直连快 |
| **适配器** | claude-direct.ts + openai-compat.ts | 只需 openai-compat.ts | Qwen/DeepSeek/Ollama 都是 OpenAI 格式 |
| **http-server.ts 改动** | 加 1 行路由 | 零改动 | 独立项目不碰 mycc 后端 |
| **记忆数据** | 本地读取 | rsync 同步（每 5min） | Studio 无本地 mycc 仓库 |

---

## 三、D2 待做

> context-loader 记忆注入 + hotpatch + 经验流

### 核心任务

1. **记忆注入**：brain=true 的模型路由，在 messages 前注入 system prompt（记忆 + hot-patch）
   - 复用 `context-loader.ts`（1343 行，standalone-ready，传 cwd 即可）
   - 需要 `memory-db.ts`（better-sqlite3 + sqlite-vec）
   - 需要 `embedding.ts`（Ollama HTTP client）
   - DATA_DIR 已指向 `/Users/fu-121/mycc-data/0-System/`
   - **注意**：SQLite 在 rsync 副本上用 `PRAGMA journal_mode=DELETE`（非 WAL）

2. **hot-patch 读写**：`data/hot-patches.jsonl`，active 状态的规则注入 system prompt

3. **经验流 JSONL**：每次请求异步写入 `data/experiences/YYYY-MM-DD.jsonl`

4. **Admin UI 增强**：显示今日注入记忆数/经验流条数

### 关键依赖

```
context-loader.ts → memory-db.ts → better-sqlite3, sqlite-vec
                  → embedding.ts → Ollama HTTP (Studio 本地或 Mini :11434)
```

需要在 Studio 安装 `better-sqlite3` + `sqlite-vec`（native addon，需编译）。

### brain-api.ts 改动点

```typescript
// D2: brain-api.ts handleChatCompletions 中
if (route.brain) {
  const context = await loadSharedContext(messages[messages.length-1].content, config.dataDir);
  const patches = await loadActivePatches(config.dataDir);
  messages = [{ role: "system", content: buildBrainPrompt(context, patches) }, ...messages];
}
```

---

## 四、关键文件索引

| 文件 | 位置 | 说明 |
|------|------|------|
| 本交接文档 | `2-Projects/brain-product/HANDOFF-D1.md` | **当前文档** |
| v5 总方案 | `2-Projects/brain-product/HANDOFF-v5.md` | 原始架构设计 |
| brain 源码 | `2-Projects/brain-product/mycc-brain/src/` | Air 本地开发 |
| Studio 部署 | `ssh studio` → `/Users/fu-121/mycc-brain/` | 运行时 |
| Studio .env | `ssh studio` → `/Users/fu-121/mycc-brain/.env` | Qwen API Key 在此 |
| 记忆数据 | `ssh studio` → `/Users/fu-121/mycc-data/0-System/` | rsync 副本 |
| 记忆源码 | `.claude/skills/mycc/scripts/src/services/` | context-loader 等 |
| Admin UI | `http://10.9.1.155:19080/admin` | 浏览器管理面板 |

---

## 五、部署命令速查

```bash
# 从 Air 一键部署到 Studio
cd ~/mycc/2-Projects/brain-product/mycc-brain
rsync -avz --exclude node_modules --exclude dist --exclude .env ./ studio:/Users/fu-121/mycc-brain/
ssh studio "cd /Users/fu-121/mycc-brain && PATH=/usr/local/bin:/Users/fu-121/.npm-global/bin:\$PATH npm install && npx tsc && mkdir -p dist/admin && cp src/admin/*.html dist/admin/ && pm2 restart brain"

# 查日志
ssh studio "PATH=/usr/local/bin:/Users/fu-121/.npm-global/bin:\$PATH pm2 logs brain --lines 30 --nostream"

# 测试
curl --noproxy '*' http://10.9.1.155:19080/health
```

---

## 六、SSH / 网络速查

| 设备 | WiFi IP | 雷电 IP | SSH 别名 | 用户 |
|------|---------|---------|----------|------|
| Air M5 | 10.9.1.144 | — | — | rayman.chen |
| Mini M4 | 10.9.1.54 | 192.168.100.1 | `mini` | rayman.chen |
| Studio M2 Max | 10.9.1.155 | 192.168.100.2 | `studio` | fu-121 |

Air 代理绕过：macOS bypass 已加 `10.0.0.0/8`、`192.168.0.0/16`。
Studio 无代理，国产 API 直连。
