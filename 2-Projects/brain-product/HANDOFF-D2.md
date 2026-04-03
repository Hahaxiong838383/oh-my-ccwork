# mycc-brain D2 交接文档

> 创建时间：2026-04-03 14:00 | 创建者：cc (Claude Opus 4.6)
> D2 完成状态：✅ 全部通过

---

## 一、D2 已完成

### 核心功能

| 功能 | 文件 | 说明 |
|------|------|------|
| 记忆注入（四路检索） | `brain-context.ts` | keyword + TF-IDF + FTS5 + 向量KNN |
| 向量语义检索 | `embedding.ts` + `memory-db.ts` | Ollama qwen3-embedding:0.6b → sqlite-vec KNN |
| hot-patch | `hot-patch.ts` | JSONL 读写，Admin 可视化管理 |
| 经验流 | `experience-stream.ts` | 异步 JSONL + 反哺 boost + insights 报告 |
| 多轮对话 | `conversation.ts` | 内存 Map，conversation_id，30min 过期 |
| A/B Compare | `server.ts` + `admin-ui.html` | raw vs brain 并排对比 |
| Admin 鉴权 | `server.ts` | Bearer token，默认 sk-brain-dev 免认证 |
| Admin UI | `admin-ui.html` | Tab 布局（对话/配置），完整模型名下拉 |
| MLX 27B 接入 | `config.ts` | cc-mlx/raw-mlx 路由，enable_thinking:false |

### 检索架构

```
query → keyword正则(17组) → TF-IDF cosine → FTS5全文 → 向量KNN(512d)
  → 经验boost(7天统计) → 合并去重 → 预算控制(2000字符) → 注入 system prompt
```

### 文件清单

```
src/
├── adapters/openai-compat.ts  (119行) — OpenAI 格式适配器
├── admin/admin-ui.html        (600行) — Admin UI（Tab 布局）
├── brain-api.ts               (220行) — 核心：记忆注入 + 多轮对话 + 经验流
├── config.ts                  (95行)  — 8 个模型路由配置
├── server.ts                  (300行) — HTTP 入口 + Admin API
└── services/
    ├── brain-context.ts       (260行) — 四路记忆检索
    ├── conversation.ts        (103行) — 多轮对话管理
    ├── embedding.ts           (60行)  — Ollama embedding 客户端
    ├── experience-stream.ts   (170行) — 经验流 + 反哺 + insights
    ├── hot-patch.ts           (80行)  — JSONL 热补丁
    └── memory-db.ts           (200行) — SQLite FTS5 + sqlite-vec
```

总计：~2200 行 TypeScript + ~600 行 HTML

---

## 二、部署信息

| 项目 | 详情 |
|------|------|
| Studio 地址 | 10.9.1.155:19080 |
| Admin UI | http://10.9.1.155:19080/admin |
| pm2 进程 | brain (pid 动态) |
| 部署命令 | `cd ~/mycc/2-Projects/brain-product/mycc-brain && bash deploy.sh` |
| Studio .env | `/Users/fu-121/mycc-brain/.env`（含 QWEN_API_KEY） |
| 记忆数据 | `/Users/fu-121/mycc-data/0-System/`（rsync 副本） |
| native deps | better-sqlite3 + sqlite-vec（已编译） |
| Ollama | localhost:11434，qwen3-embedding:0.6b 已加载 |
| MLX | localhost:8000，mlx-community/Qwen3.5-27B-4bit |

---

## 三、API 速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 核心对话（支持 conversation_id） |
| `/v1/models` | GET | 模型列表（8个） |
| `/admin` | GET | Admin UI |
| `/admin/api/status` | GET | 状态（含 experience/conversations） |
| `/admin/api/compare` | POST | A/B 对比（raw vs brain） |
| `/admin/api/memory-preview` | POST | 预览记忆注入 |
| `/admin/api/patches` | GET/POST | hot-patch CRUD |
| `/admin/api/test` | POST | Quick Test（走 brain 链路） |
| `/admin/api/insights` | GET | 经验流洞察报告 |
| `/admin/api/experiences/export` | GET | 导出今日经验流 JSONL |
| `/admin/api/restart` | POST | 重启服务 |
| `/health` | GET | 健康检查 |

---

## 四、D3 待做

### 工具调用（Agent Loop）

借鉴 Claude Code 源码（Hahaxiong838383/claude-code-source）的设计：

1. **Phase 1: Agent Loop + 内置工具**（2天）
   - brain-api handleChatCompletions 从单轮改为 while 循环
   - 3 个内置工具：search_memory / manage_patch / get_time
   - 最多 5 轮 tool_call，防死循环

2. **Phase 2: MCP Bridge**（3天）
   - brain 作为 MCP client 连接飞书 MCP server
   - 动态发现 tools → 注入 system prompt
   - 权限模型：safe / confirm / dangerous

3. **Phase 3: 生产加固**（1天）
   - 结果大小控制（>2000 字符截断+持久化）
   - token 预算监控
   - 错误恢复

### 评测

- eval.ts 自动化评测脚本（30 条高难度测试 + LLM-as-Judge）
- 评测方案已设计完成，待评审后实现

### 其他待办

- [ ] 14B 模型替代 27B（MLX 推理更快）
- [ ] 版本号更新 package.json

---

## 五、踩坑记录

| 问题 | 根因 | 解决 |
|------|------|------|
| MLX 404 超时 | 模型名必须完整 `mlx-community/Qwen3.5-27B-4bit` | config.ts 写完整名 |
| MLX 推理极慢 | Qwen3.5 默认开 thinking | 全局 `enable_thinking: false` |
| Quick Test 无记忆 | `/admin/api/test` 绕过 brain-api | 在 test 路由加记忆注入 |
| 注入过多垃圾 | always-inject user/topOfMind + MEMORY.md | 改为纯查询驱动 |
| pm2 找不到 | Studio PATH 不含 npm-global | 用完整路径调 pm2 |
| tsc 报错 better-sqlite3 | 动态 import 被 tsc 检查 | 用变量名绕过 |
| python3 JSON 解析失败 | Qwen reasoning_content 含控制字符 | `strict=False` |

---

## 六、可粘贴提示词（下个 Session）

```
读取 2-Projects/brain-product/HANDOFF-D2.md 了解 D2 完成状态。

下一步任务（按优先级）：
1. 实现 eval.ts 自动化评测脚本（30 条测试 + LLM-as-Judge），方案在 HANDOFF-D2.md 第四节
2. 根据评测结果优化记忆检索
3. D3 Agent Loop + 内置工具

关键信息：
- 源码：2-Projects/brain-product/mycc-brain/src/
- 部署：ssh studio → /Users/fu-121/mycc-brain/
- 测试：curl --noproxy '*' http://10.9.1.155:19080/health
```
