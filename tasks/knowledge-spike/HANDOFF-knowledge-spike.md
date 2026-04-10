# HANDOFF — mycc-brain 外挂知识系统 · Spike 阶段

> 任务：为 brain 加一条「飞书 Wiki → Gemini Flash 提取 → 独立 knowledge.db」的外挂学习管线
> 方案：Plan D（Spike + P0 并行）
> 阶段：Day 0 Spike 进行中
> 创建时间：2026-04-10 18:30
> 分支：`feat/knowledge-system`（尚未创建）

---

## 一、战略定稿

**核心原则（不可违反）**：

1. **不污染对话记忆** — feishu 知识走**独立 knowledge.db**，**严禁**写入 memory.db 或 memory-items.md。brain 的 v0.9.2 刚修复 retrieval precision 回归，再灌文档数据会再炸一次。
2. **SSOT 合规** — 运行时数据只允许本地进程写入；P0 实装时 crawler 最终宿主从三个候选里选：Air（开发机）、Mini（事件上报架构）、Studio（all-in-one）
3. **砍掉原方案的雄心** — 不做 LLM 生成 Wiki、不做实体归一化、不做 knowledge-gap 自动闭环。只做「原子事实抽取 + 独立库存储 + 显式触发检索」
4. **默认 off 检索** — brain-context.ts 增加第五路 `knowledgeSearch()`，**只在 query 匹配"文档/wiki/手册/SOP/怎么部署"关键词或主检索兜底时激活**，其余对话查询零感知

## 二、已完成工作（Day 0 T0 阶段）

### ✅ T0 Mini 预检 — 已完成（关键发现：简化架构）

**尝试过的路径**：
1. ssh mini（10.9.1.54）→ 内网超时（当前不在 iBRO WiFi）
2. ssh mini-pub（公网 FRP）→ 通了，但 lark-cli 在 `~/.nvm/versions/node/v22.12.0/bin/` 非交互 shell 找不到

**最终发现**：**Air 本地就有完整 lark-cli**，完全不需要 SSH。

```
lark-cli 路径: /Users/rayman.chen/local/node/bin/lark-cli
实际位置: ~/mycc/node_modules/@larksuite/cli/bin/lark-cli
版本: @larksuite/cli v1.0.0
```

### ✅ Auth 状态 — 已验证

```json
{
  "appId": "cli_a9f1cd1366751bc7",
  "brand": "feishu",
  "identity": "user",
  "userName": "陈川Rayman",
  "userOpenId": "ou_6bde3a204c8499a3b6c26677c7c9a070",
  "tokenStatus": "valid",
  "expiresAt": "2026-04-10T19:15:31+08:00",      // 注意：session 进行时可能已过期
  "refreshExpiresAt": "2026-04-17T17:15:31+08:00" // refresh 一周内有效，会自动续
}
```

**关键 scope（覆盖所有需求）**：
- `wiki:wiki wiki:space:retrieve wiki:node:read wiki:wiki:readonly`
- `docs:document.content:read space:document:retrieve`
- `search:docs:read`
- `bitable:app bitable:app:readonly`

### ✅ 命令探索 — 初步

```
lark-cli wiki --help
  → 顶层子命令只有 `spaces`
lark-cli wiki spaces --help
  → 只有 `get_node`（没有 list！）

lark-cli docs --help
  → 有 `+create / +fetch / +media-download / +media-insert / +search / +update / +whiteboard-update`
```

**卡点**：lark-cli 官方命令没有"列所有 wiki space"。列 space 的正确姿势在 **lark-wiki skill 封装的 shortcut** 或 **lark-openapi-explorer 直接调 OpenAPI**。

**下一步**：
1. 先加载 `lark-wiki` skill 读文档，找列 space 的 shortcut
2. 如果 skill 里没有，用 `lark-openapi-explorer` 调 `/open-apis/wiki/v2/spaces` 列表接口

### ✅ 架构决策简化

- **Day 0 全在 Air 本地跑**，不碰 Mini/Studio
- **P0 实装阶段**再决定 crawler 长期宿主（三选一）：
  - α: Air 开发机跑（最简单但不符合长期架构，当 dev 用）
  - β: Mini 跑 → rsync 到 Studio 的 `~/mycc-data/feishu-raw/`（符合 SSOT 铁律 2）
  - γ: Studio 跑（需要同步 lark-cli + token，Studio 目前没装）
- 当前倾向 **β**（最符合 SSOT，Mini 已有 lark-cli 基础）

## 三、任务看板（tasks #1-#4）

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 1 | T0 Mini 预检 lark-cli 可用性 | ✅ completed | 实际在 Air 本地验证 |
| 2 | Track A Mini Wiki 空间侦察 | pending | blocked by #1 → 实际上 #1 完成后即可启动，在 Air 本地跑 |
| 3 | Track B P0 脚手架（subagent） | in_progress | 还未真正启动 subagent，待下 session |
| 4 | Track C 深度 Spike Gemini 提取 | pending | blocked by #2（需先选 space） |

## 四、下一步执行清单（给下个 session 的 cc）

### 立即执行（按顺序）

#### 1. 加载 lark-wiki skill，找列 space 命令

```bash
# 用 Skill 工具或直接 read skill 文件
Read /Users/rayman.chen/mycc/.claude/skills/lark-wiki/ 下的 SKILL.md 或相应文件
# 或者
cat /Users/rayman.chen/.claude/skills/lark-wiki/* 2>/dev/null
```

找到"列所有 wiki space"的命令（可能是 `docs +search` 某种模式，或需要走 `lark-openapi-explorer` 直接调 OpenAPI `GET /open-apis/wiki/v2/spaces`）。

#### 2. 生成 wiki-inventory.md

```bash
lark-cli <列 space 的命令> > /Users/rayman.chen/mycc/tasks/knowledge-spike/wiki-spaces-raw.json
# 对每个 space 调 wiki spaces get_node 拿 root nodes
# 生成人类可读的 /Users/rayman.chen/mycc/tasks/knowledge-spike/wiki-inventory.md
```

**wiki-inventory.md 格式**：
```markdown
| # | space 名 | space_id | 顶级节点 | 总文档估算 | 最近更新 | 样例 title |
|---|----------|----------|---------|-----------|----------|-----------|
| 1 | ... | ... | N | ~M | YYYY-MM-DD | ..., ..., ... |
```

**👉 确认点 #1**：把清单发给川哥，问他选哪个 space 做深度 spike。

#### 3. 并行启动 Track B subagent（可以在等川哥选 space 时跑）

用 general-purpose Agent（**不要用 codex-rescue**，那是 codex 专用路径）。在后台跑，prompt 参考：

```
Task: 在 feat/knowledge-system 分支上搭建 mycc-brain 外挂知识系统的 P0 脚手架。
纯本地代码，不调外部 API，不 merge 到 main。

约束：
- 独立 knowledge.db（不碰 memory.db）
- 独立 knowledge-items.md（不碰 memory-items.md）
- readonly immutable 数据结构
- 单文件 < 400 行
- 单元测试 ≥ 80% coverage

目录结构：
2-Projects/brain-product/mycc-brain/
├── src/knowledge/
│   ├── crawler.ts        (stub: DocSyncState 类型 + 接口定义)
│   ├── extractor.ts      (stub: ExtractedFact 类型 + Gemini Flash 调用签名)
│   ├── store.ts          (实装: 独立 knowledge.db schema 初始化 + FTS5 + 写入 append)
│   ├── allowlist.ts      (实装: 从 knowledge-allowlist.yaml 加载 + 校验)
│   └── types.ts          (所有 readonly interface)
├── data/
│   ├── knowledge-allowlist.yaml.template (空模板 + 注释说明)
│   └── knowledge.db (初始化后为空，include gitignore)
└── tests/knowledge/
    ├── store.test.ts
    └── allowlist.test.ts

Schema:
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY,
  doc_token TEXT NOT NULL,
  doc_title TEXT,
  space_id TEXT,
  namespace TEXT NOT NULL,       -- 分类路径
  content TEXT NOT NULL,         -- 原子事实
  keywords TEXT NOT NULL,        -- JSON array
  confidence REAL NOT NULL,      -- 0..1
  source_url TEXT,
  extracted_by TEXT NOT NULL,    -- "gemini-flash" / "manual"
  created_at INTEGER NOT NULL,   -- unix ms
  tombstone INTEGER DEFAULT 0    -- soft delete
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  namespace, content, keywords, content='knowledge_items', content_rowid='id'
);

步骤：
1. git checkout -b feat/knowledge-system
2. 创建所有文件
3. npm test 验证单元测试通过
4. tsc --noEmit 验证类型
5. git add + commit（不 push）

完成后 report：文件清单 + 测试结果 + 任何意外。
```

#### 4. 川哥选定 space 后，跑 Track C 深度 Spike

- 拉 3-5 篇文档（不同类型：长文/短文/含表格嵌入/纯文本）
- 算 content-hash 稳定性（跑 3 次）
- 调 Gemini Flash 真实提取（复用 `.env.local` 的 `GEMINI_PROXY_KEY` + `http://23.226.135.149:4000/v1`）
- Gemini Flash 预算硬上限 **$0.50**
- 生成 `spike-report.md`

Gemini Flash 调用示例（用 openai-compat 格式）：
```bash
curl -s http://23.226.135.149:4000/v1/chat/completions \
  -H "Authorization: Bearer $GEMINI_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [...],
    "max_tokens": 4096
  }'
```

**👉 确认点 #2**：spike-report 发给川哥，GO/GO-with-tweaks/ABORT。

### P0 实装（Day 1+，Spike GO 后）

详见 `2-Projects/brain-product/HANDOFF-v5.md` 的 P0 章节（需创建，可以参考这份 HANDOFF 重写）。

## 五、关键约束清单（每次改动前必读）

1. ❌ **不写 memory.db / memory-items.md / memory-items-intake.md**
2. ❌ **不改 brain-context.ts 的默认检索路径**
3. ❌ **不调用 Gemini 超过日预算上限 $0.50（spike 阶段）**
4. ❌ **不 merge feat/knowledge-system 到 main 直到 Spike GO**
5. ❌ **不碰 Studio 运行时数据**（符合 SSOT 铁律）
6. ✅ **所有数据结构 readonly immutable**
7. ✅ **单文件 < 400 行**
8. ✅ **双门验证（verify + guard）每次提交前必跑**

## 六、关键引用

- 纲领：`2-Projects/brain-product/MANIFESTO.md`
- SSOT 铁律：`2-Projects/brain-product/mycc-brain/docs/architecture-ssot.md`
- 现有 memory 系统：`2-Projects/brain-product/mycc-brain/src/services/memory-{intake,store,db}.ts`
- 检索层：`2-Projects/brain-product/mycc-brain/src/services/brain-context.ts`
- 飞书原始方案：飞书 doc `ZIB3d6ig6odIWSxUo2GcbLgPnfb`（Mycc-brain 外挂知识库）
- Gemini Flash 路由：`src/config.ts` 的 `memoryLLM.intake`（已在用）
- env 位置：`2-Projects/brain-product/mycc-brain/.env.local`

## 七、预算和时间追踪

- Gemini Flash 已消耗：$0.00（spike 未开始）
- 预算硬上限：$0.50（spike 阶段）
- Day 0 已用时：~40 分钟（T0 预检 + 架构简化）
- 预计 Day 0 剩余：3-4 小时（Track A 侦察 + Track B 骨架 + Track C Spike + 两个确认点）

---

**下个 session 的第一条指令**：
```
读 tasks/knowledge-spike/HANDOFF-knowledge-spike.md，
继续执行"下一步执行清单"的第 1 步（加载 lark-wiki skill 找列 space 命令）。
```
