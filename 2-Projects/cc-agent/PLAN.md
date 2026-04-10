# cc-agent 实施方案 v2（Phase 1 + Phase 2）

> 整合 Hermes Agent 自进化 + LLM Wiki 知识管理 + 多模型网关，为川哥打造专属 AI Agent。
> v1：2026-04-10 | v2：2026-04-10（整合 Codex 审查意见 + 新增模型网关层）

---

## 设计原则

1. **移植不 fork**：从 Hermes / LLM Wiki 提取核心模块，不搬运整体框架
2. **NAS 优先**：所有服务跑在 fnOS NAS（16GB RAM，Docker Compose）
3. **渐进增强**：不破坏现有 mycc 体系，在已有架构上叠加能力
4. **够用就行**：先跑通最小闭环，再迭代优化
5. **单一真相源**：memory-items.md 是短期事实权威，wiki 是深度知识补充，不做自动双写（v2 新增，采纳 Codex 审查）
6. **观测先于自动化**：先记录轨迹积累数据，再开自动 Skill 生成（v2 新增，采纳 Codex 审查）

---

## 资源约束（v2 修订）

| 资源 | 当前值 | 规划分配 |
|------|--------|---------|
| RAM | 16GB（8.6GB 可用） | PostgreSQL ~384MB + 模型网关 ~128MB |
| 磁盘 | 19GB 可用 | PostgreSQL ~3GB（含索引/WAL/vacuum 余量） |
| Docker | Compose v2.40 | 新增 1 个容器（仅 PG+PGroonga） |
| Python | 3.11.2 | MCP Server + 模型网关（原生进程，不容器化） |

**v2 变更**：删除 MinIO（文件存本地目录），PG 预算含索引/WAL/备份开销。

---

## 架构总览（v2）

```
┌───────────────────────────────────────────────────────────────┐
│                        cc-agent 系统                           │
│                                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐  │
│  │ Wiki MCP    │  │ Skill MCP   │  │  Model Gateway       │  │
│  │ (知识引擎)   │  │ (技能引擎)   │  │  (多模型路由)         │  │
│  │ search/read │  │ search/draft│  │  OpenAI-compatible   │  │
│  │ write/ingest│  │ stats       │  │  API endpoint        │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘  │
│         │                │                     │               │
│         └────────────────┴─────────────────────┘               │
│                          │                                     │
│                   ┌──────▼──────┐                              │
│                   │ PostgreSQL  │                              │
│                   │ + PGroonga  │                              │
│                   └─────────────┘                              │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  接入层                                                  │  │
│  │  Claude Code CLI ← 开发/疑难（直接用 Opus/Sonnet）       │  │
│  │  飞书/微信/Web  ← 日常交互（走 Model Gateway → 云端模型）│  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

---

## Phase 1A：模型网关 + 知识引擎基础设施（Day 1-4）

### 1A.1 模型网关（Model Gateway）

**目标**：提供统一的 OpenAI-compatible API，背后路由到不同云端模型。

#### 为什么需要

| 场景 | 现在 | 有了网关后 |
|------|------|-----------|
| 日常问答/闲聊 | 消耗 Claude Code 额度 | 走 DeepSeek/Qwen → 几乎免费 |
| 知识编译/摘要 | 依赖 Claude Code | 走 Gemini Flash/Haiku → 低成本 |
| 代码实现/调试 | Claude Code 或 Codex | 不变，保留给最强模型 |
| 多 Agent 子任务 | codex=OpenAI, gemini=Google，硬编码 | 配置化，可随时换模型 |

#### 配置文件设计

```yaml
# cc-agent/gateway/models.yml

# 模型定义
models:
  # --- 高端（开发/疑难） ---
  claude-opus:
    provider: anthropic
    model_id: claude-opus-4-6
    # api_key 从环境变量读取：ANTHROPIC_API_KEY
    max_tokens: 8192
    tags: [premium, coding, reasoning]

  gpt-5:
    provider: openai
    model_id: gpt-5.4-pro
    max_tokens: 8192
    tags: [premium, coding]

  # --- 中端（通用任务） ---
  claude-sonnet:
    provider: anthropic
    model_id: claude-sonnet-4-6
    max_tokens: 4096
    tags: [mid, general]

  gemini-pro:
    provider: google
    model_id: gemini-2.5-pro
    max_tokens: 4096
    tags: [mid, research, long-context]

  deepseek-r1:
    provider: openai-compatible
    model_id: deepseek-reasoner
    base_url: https://api.deepseek.com/v1
    # api_key: DEEPSEEK_API_KEY
    max_tokens: 8192
    tags: [mid, reasoning, cheap]

  # --- 低端（批量/编译） ---
  gemini-flash:
    provider: google
    model_id: gemini-2.5-flash
    max_tokens: 4096
    tags: [cheap, fast, compile]

  deepseek-chat:
    provider: openai-compatible
    model_id: deepseek-chat
    base_url: https://api.deepseek.com/v1
    max_tokens: 4096
    tags: [cheap, general]

  qwen-plus:
    provider: openai-compatible
    model_id: qwen-plus
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    # api_key: DASHSCOPE_API_KEY
    max_tokens: 4096
    tags: [cheap, chinese, general]

  # --- 本地（离线/隐私） ---
  qwen-local:
    provider: openai-compatible
    model_id: qwen2.5-3b
    base_url: http://127.0.0.1:11434/v1
    max_tokens: 2048
    tags: [local, free, fast]

# 任务路由规则
routing:
  # 默认模型（未匹配任何规则时）
  default: deepseek-chat

  # 按任务类型路由
  rules:
    - task: wiki_compile      # 知识编译
      model: gemini-flash
      fallback: deepseek-chat

    - task: wiki_query         # 知识库问答
      model: deepseek-chat
      fallback: qwen-plus

    - task: summarize          # 摘要
      model: gemini-flash
      fallback: qwen-plus

    - task: translate          # 翻译
      model: deepseek-chat

    - task: code_review        # 代码审查
      model: claude-sonnet
      fallback: deepseek-r1

    - task: research           # 调研
      model: gemini-pro
      fallback: deepseek-r1

    - task: planning           # 规划
      model: claude-opus
      fallback: deepseek-r1

    - task: casual             # 闲聊/简单问答
      model: qwen-plus
      fallback: qwen-local

# 多 Agent 模型分配
agents:
  cc:
    description: "规划、决策、编排"
    primary: claude-opus       # Claude Code 直接用，不走网关
    note: "cc 通过 Claude Code CLI 交互，不走网关"

  codex:
    description: "写代码、改仓库、跑测试"
    primary: gpt-5             # 通过 Codex plugin 调用
    note: "codex 通过 OpenAI Codex plugin 调用，不走网关"

  researcher:
    description: "调研、搜资料、对比分析"
    primary: gemini-pro
    fallback: deepseek-r1

  compiler:
    description: "知识编译、摘要、分块处理"
    primary: gemini-flash
    fallback: deepseek-chat

  assistant:
    description: "日常问答、飞书/微信交互、闲聊"
    primary: deepseek-chat
    fallback: qwen-plus

  reviewer:
    description: "代码审查、方案评审"
    primary: claude-sonnet
    fallback: deepseek-r1

# API 密钥（从环境变量读取，此处只做映射声明）
env_keys:
  anthropic: ANTHROPIC_API_KEY
  openai: OPENAI_API_KEY
  google: GOOGLE_API_KEY
  deepseek: DEEPSEEK_API_KEY
  dashscope: DASHSCOPE_API_KEY
```

#### 网关实现

```
cc-agent/gateway/
├── server.py          # FastAPI，暴露 /v1/chat/completions（OpenAI 兼容）
├── router.py          # 读取 models.yml，按 task type 路由到对应模型
├── providers/
│   ├── base.py        # Provider 抽象基类
│   ├── openai_compat.py  # OpenAI / DeepSeek / Qwen / 本地模型（统一）
│   ├── anthropic.py   # Anthropic API
│   └── google.py      # Google Gemini API
├── models.yml         # 模型 + 路由 + Agent 配置（上面那个文件）
└── .env               # API 密钥
```

**核心 API**：

```
# 标准 OpenAI-compatible 接口（所有客户端通用）
POST /v1/chat/completions
  body: { model: "auto" | "具体模型名", messages: [...], task_type?: "wiki_compile" }
  → 根据 task_type 或 model 路由到对应后端

# 管理接口
GET  /v1/models                    # 列出所有可用模型
GET  /v1/routing                   # 查看当前路由规则
PUT  /v1/routing/rules/{task}      # 热更新某个任务的路由
PUT  /v1/agents/{name}/model       # 热更新某个 Agent 的模型分配
GET  /v1/usage                     # 各模型用量统计
POST /v1/models/test               # 测试某个模型是否可用
```

**热更新**：修改 `models.yml` 后调用 `POST /v1/reload`，无需重启。

#### 与现有系统的集成

```
Claude Code CLI (cc)
  ├─ 开发/疑难 → 直接用 Claude API（不走网关）
  ├─ 需要调用其他模型时 → MCP 工具 `llm_call(task_type, prompt)`
  │    └─ 网关自动路由到配置的模型
  └─ 多 Agent 编排时 → 按 agents 配置分发

飞书/微信通道
  └─ 日常交互 → 走网关 → assistant agent → deepseek-chat/qwen-plus

自动化任务（采集/编译/摘要）
  └─ 走网关 → compiler agent → gemini-flash/deepseek-chat
```

#### MCP 工具（让 cc 在对话中调用其他模型）

```python
tools = {
    "llm_call": {
        "description": "调用云端模型执行任务（不消耗 Claude Code 额度）",
        "params": {
            "prompt": "要发送的 prompt",
            "task_type": "任务类型（wiki_compile/summarize/translate/casual/research/code_review）",
            "model": "可选，指定具体模型名（覆盖路由规则）",
            "system": "可选，system prompt",
            "max_tokens": "可选，最大输出 token"
        }
    },
    "llm_models": {
        "description": "列出所有可用模型和当前路由配置"
    },
    "llm_switch": {
        "description": "临时切换某个 Agent/任务的模型",
        "params": {
            "target": "agent 名或 task_type",
            "model": "新模型名"
        }
    },
}
```

### 1A.2 数据库部署（v2：仅 PG，无 MinIO）

```yaml
# docker-compose.yml
services:
  cc-postgres:
    image: groonga/pgroonga:latest
    container_name: cc-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: cc
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: cc_agent
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "127.0.0.1:5433:5432"
    deploy:
      resources:
        limits:
          memory: 384M
    command: >
      postgres
        -c shared_buffers=96MB
        -c work_mem=4MB
        -c maintenance_work_mem=32MB
        -c effective_cache_size=256MB
        -c max_wal_size=256MB
```

### 1A.3 数据库 Schema（v2：删除预建表，精简）

```sql
-- init.sql
CREATE EXTENSION IF NOT EXISTS pgroonga;

-- 文档表（wiki 页 + 导入素材共表）
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT NOT NULL UNIQUE,        -- "/wiki/concepts/xxx" 或 "/sources/xxx"
    title TEXT,
    content TEXT,                      -- Markdown 正文
    tags TEXT[] DEFAULT '{}',
    source_type TEXT DEFAULT 'manual', -- manual/import/auto-compile
    trust_level TEXT DEFAULT 'verified', -- verified/draft（v2：auto-compile 内容标记为 draft）
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 文本分块（全文搜索用）
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    header_breadcrumb TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- PGroonga 全文索引
CREATE INDEX idx_chunks_content ON document_chunks USING pgroonga (content);
CREATE INDEX idx_docs_content ON documents USING pgroonga (content);
CREATE INDEX idx_docs_title ON documents USING pgroonga (title);
CREATE INDEX idx_docs_path ON documents (path);
CREATE INDEX idx_docs_trust ON documents (trust_level);

-- 模型用量统计
CREATE TABLE model_usage (
    id BIGSERIAL PRIMARY KEY,
    model_name TEXT NOT NULL,
    task_type TEXT,
    agent_name TEXT,
    input_tokens INT,
    output_tokens INT,
    latency_ms INT,
    cost_usd NUMERIC(10,6),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_model ON model_usage (model_name, created_at);
CREATE INDEX idx_usage_agent ON model_usage (agent_name, created_at);
```

---

## Phase 1B：知识引擎 MCP + 存量迁移（Day 5-9）

### 1B.1 Wiki MCP Server（直连 PG，不经 FastAPI）

```
cc-agent/wiki_mcp/
├── server.py          # FastMCP 入口
├── db.py              # asyncpg 连接
├── chunker.py         # 文本分块（移植 LLM Wiki 的逻辑）
├── search.py          # PGroonga 搜索
└── tools.py           # 5 个 MCP 工具定义
```

**5 个工具**：

| 工具 | 功能 | 信任边界（v2 新增） |
|------|------|-------------------|
| `wiki_guide` | 知识库概览 + 写作规范 | 只读 |
| `wiki_search` | 全文搜索，返回 snippets | 只读，draft 内容降权展示 |
| `wiki_read` | 读取文档，支持 glob | 只读，路径限制在 /wiki/ 和 /sources/ |
| `wiki_write` | 创建/更新/追加 wiki 页 | 写入限制在 /wiki/ 下；自动标记 source_type |
| `wiki_ingest` | 导入本地文件到知识库 | **v2：仅接受白名单目录**（3-Thinking/、1-Inbox/、指定路径）；URL 导入先进 /sources/draft/ |

### 1B.2 存量迁移（一次性脚本，不做自动同步）

```python
# cc-agent/scripts/migrate_existing.py
# 一次性运行，把现有知识导入 wiki

migrations = [
    # memory-items.md 按命名空间拆成多个 wiki 页
    ("0-System/memory-items.md", parse_by_namespace, "/wiki/facts/{namespace}.md"),

    # 方法论文档直接导入
    ("3-Thinking/*.md", direct_import, "/wiki/concepts/methodology/{filename}"),

    # 个人画像
    ("0-System/about-me/*.md", direct_import, "/wiki/entities/chenchuan/{filename}"),
]
```

**导入后标记**：`source_type='import'`, `trust_level='verified'`（人工已有内容，可信）。

### 1B.3 与现有记忆系统的关系（v2 修订）

```
Source of Truth 层级：
  1. memory-items.md  — 短期事实权威（cc 直接读写）
  2. Wiki（PG）       — 深度知识补充（只在需要时查询）

规则：
  ✅ cc 可以主动 wiki_write（手动写入，trust=verified）
  ✅ 一次性迁移导入（import，trust=verified）
  ✅ 自动采集编译（Phase 2，trust=draft，search 降权）
  ❌ 不自动从 memory-items 同步到 wiki（避免双写一致性问题）
  ❌ wiki 不回写 memory-items
  ❌ 不删不改 memory-items 中的内容
```

---

## Phase 2A：模型驱动的多 Agent 升级（Day 10-13）

### 2A.1 多 Agent 路由升级

现有 `multi-agent/RULES.md` 的路由是概念性的（cc/codex/gemini 三角色）。v2 升级为**配置驱动 + 模型可切换**：

```
现有：
  cc (Claude) ──固定──► Anthropic
  codex (OpenAI) ──固定──► OpenAI
  gemini (Google) ──固定──► Google

升级后：
  cc ──固定──► Claude Code CLI（不变，开发/疑难专用）
  其他 Agent ──配置──► Model Gateway ──路由──► 最优模型
```

**新增 Agent 角色**（通过 gateway agents 配置）：

| Agent | 职责 | 默认模型 | 可切换为 |
|-------|------|---------|---------|
| `cc` | 规划/决策/编排 | Claude Opus（CLI 直接） | 不走网关 |
| `codex` | 写代码/跑测试 | GPT-5（Codex plugin） | 不走网关 |
| `researcher` | 调研/搜资料/对比 | Gemini Pro | DeepSeek-R1 |
| `compiler` | 知识编译/摘要 | Gemini Flash | DeepSeek-Chat |
| `assistant` | 日常问答/飞书交互 | DeepSeek-Chat | Qwen-Plus |
| `reviewer` | 代码审查/方案评审 | Claude Sonnet | DeepSeek-R1 |

**切换命令**（cc 对话中）：
```
cc: llm_switch(target="researcher", model="deepseek-r1")
→ "已将 researcher 的模型从 gemini-pro 切换为 deepseek-r1"
```

### 2A.2 Gateway 集成飞书/微信通道

```
飞书消息 → mycc 后端
  ├─ 判断：是否需要 Claude Code？
  │    ├─ 是（开发/疑难/复杂编排）→ 转发给 cc（Claude Code CLI）
  │    └─ 否（日常/问答/查询）→ 调用 Model Gateway
  │         ├─ 附带上下文：wiki_search 结果 + memory-items 相关条目
  │         └─ 模型响应 → 返回飞书
  └─ 成本：日常交互走 DeepSeek ≈ ¥0.001/次 vs Claude ≈ ¥0.1/次
```

---

## Phase 2B：自进化引擎 + 自动采集（Day 14-20）

### 2B.1 轨迹收集（观测优先，v2 修订）

```sql
-- Phase 2B 时再建表
CREATE TABLE trajectories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    task_description TEXT,
    steps JSONB,                  -- [{type, content, result, timestamp}]
    tool_count INT,               -- 工具调用次数
    outcome TEXT,                 -- success/failure/partial
    friction_points JSONB,        -- [{description, resolution}]
    model_used TEXT,              -- 哪个模型执行的
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**v2 关键变更**：
- 只记录，**不自动生成 Skill**
- 记录完整信息（含失败分支、人工修正、用了哪个模型）
- 积累 2 周数据后，人工评估是否开启 Skill 自动生成

### 2B.2 Skill 引擎（Draft 模式，v2 修订）

```
任务完成后的 Skill 流程（v2）：

复杂任务完成（≥5 步 或 有 friction）
  │
  ▼
自动分析轨迹 → 草拟 Skill draft
  │
  ▼
存入 /wiki/skill-drafts/{name}.md（trust=draft）
  │
  ▼
飞书通知用户：「发现可复用模式，已生成 Skill 草稿：{name}」
  │
  ▼
用户审核：
  ├─ 确认 → 移动到 .claude/skills/，trust=verified
  ├─ 修改 → 编辑后确认
  └─ 跳过 → 保留在 drafts，不启用
```

**v2 铁律**：
1. **自动生成的 Skill 永远先进 draft 区**，不直写 `.claude/skills/`
2. **Skill Patch 也先生成 diff 草稿**，用户确认后才应用
3. **安全扫描**依然保留（危险命令 + 硬编码密码 + prompt injection）

### 2B.3 知识库自动采集管线

#### 采集源（复用现有 skill 逻辑）

```yaml
# cc-agent/sources.yml
sources:
  - type: rss
    name: "技术博客"
    feeds: [...]            # 复用 /collect 的源列表
    schedule: "0 8 * * *"

  - type: github_releases
    repos: [anthropics/claude-code, nousresearch/hermes-agent, ...]
    schedule: "0 9 * * *"

  - type: arxiv
    topics: [cs.AI, cs.CL]
    schedule: "0 10 * * *"

  - type: web_clip          # 手动剪藏 API
```

#### 编译管线（v2 修订：draft 隔离）

```
采集新内容
  │
  ▼
解析为 Markdown → 存入 /sources/（trust=verified，原始素材）
  │
  ▼
分块 → document_chunks（可搜索）
  │
  ▼
LLM 编译（走 Model Gateway → compiler agent → gemini-flash）
  ├─ wiki_search 找相关已有页面
  ├─ 生成/更新 wiki 内容
  └─ 存入 /wiki/auto/（trust=draft）← v2 关键：不直接进入主 wiki
  │
  ▼
每日摘要 → 飞书通知
  「今日采集 12 条，生成 5 个 draft wiki 页，请审阅」
```

**v2 信任边界**：
- `/wiki/` 下手动写入的 = `verified`，搜索时正常返回
- `/wiki/auto/` 下自动编译的 = `draft`，搜索时标注 `[draft]` 并降权
- 用户确认后：从 `/wiki/auto/` 移动到 `/wiki/`，改为 `verified`

---

## 里程碑检查点（v2）

| 编号 | 里程碑 | 验收标准 | Phase | Day |
|------|--------|---------|-------|-----|
| M1 | PG+PGroonga 容器跑起来 | `docker compose up` + 建表成功 | 1A | 1 |
| M2 | Model Gateway 可用 | `curl /v1/chat/completions` 路由到 DeepSeek 返回 | 1A | 2-3 |
| M3 | Gateway MCP 接入 cc | cc 对话中 `llm_call("你好", task_type="casual")` 返回 | 1A | 4 |
| M4 | Wiki MCP 可用 | cc 对话中 `wiki_search("方法论")` 返回结果 | 1B | 6 |
| M5 | 存量迁移完成 | memory-items + 3-Thinking 已导入，50+ 文档 | 1B | 7 |
| M6 | 日常使用验证 | 用 3 天，wiki 查询好用，网关路由正确 | 1B | 8-9 |
| M7 | 飞书通道接入网关 | 飞书日常消息走 DeepSeek 响应 | 2A | 11 |
| M8 | Agent 模型可切换 | `llm_switch` 命令生效 | 2A | 12 |
| M9 | 轨迹收集上线 | 复杂任务自动记录到 PG | 2B | 15 |
| M10 | 自动采集跑通 | RSS → 解析 → draft wiki 页 | 2B | 17 |
| M11 | Skill draft 生成 | 复杂任务后自动生成 Skill 草稿 | 2B | 19 |
| M12 | 闭环验证 | 跑 1 周，知识库增长 + 模型成本下降 50% | 2B | 20-24 |

---

## 成本估算

| 场景 | 现在（全走 Claude） | 有网关后 | 节省 |
|------|-------------------|---------|------|
| 日常问答 ~50 次/天 | ~$5/天 | DeepSeek ~$0.05/天 | 99% |
| 知识编译 ~20 次/天 | ~$2/天 | Gemini Flash ~$0.02/天 | 99% |
| 代码开发 ~10 次/天 | ~$3/天（Claude Code） | 不变 | 0% |
| **合计** | **~$10/天** | **~$3.1/天** | **~70%** |

---

## 风险与缓解（v2）

| 风险 | 影响 | 缓解 |
|------|------|------|
| NAS 内存不够 | PG + Gateway OOM | PG 限 384MB，Gateway 纯 Python 轻量 ~128MB |
| PGroonga 中文分词差 | 搜索不准 | 备选：Jieba 预分词存入 |
| 云端模型 API 不稳定 | 请求失败 | 每个 task_type 配 fallback 模型 |
| 模型切换后质量下降 | 回答变差 | 记录每次调用的 model + 用户反馈，数据驱动调整 |
| 磁盘空间 | 19GB 不够 | PG 3GB 预算含 WAL，自动采集限量 30条/天 |
| draft 内容污染搜索 | 搜索结果混乱 | trust_level 字段 + 搜索时 draft 降权 |

---

## 技术决策记录（v2）

| 决策 | 选择 | 原因 |
|------|------|------|
| 搜索引擎 | PGroonga（非 ES） | NAS 内存有限，PG 内置 |
| 对象存储 | 本地目录（非 MinIO） | v2 精简，文件直接存磁盘，省一个容器 |
| 模型网关 | 自建 OpenAI-compatible（非 LiteLLM） | 轻量、可控、含路由+统计+Agent 配置 |
| Skill 写入 | Draft 模式（非直写） | Codex 审查建议：防止自动生成污染技能库 |
| 双写策略 | 不做自动双写 | Codex 审查建议：单一真相源，避免一致性问题 |
| 采集内容信任 | draft 隔离区 | Codex 审查建议：不可信内容不进入主 wiki |
| 网关协议 | OpenAI-compatible | 生态最广，所有客户端/SDK 直接对接 |

---

## 目录结构

```
cc-agent/
├── PLAN.md                    # 本文件
├── README.md
├── docker-compose.yml         # 仅 PG+PGroonga
├── init.sql                   # 数据库 Schema
├── .env                       # API 密钥（gitignore）
│
├── gateway/                   # 模型网关
│   ├── server.py              # FastAPI OpenAI-compatible API
│   ├── router.py              # 任务→模型路由
│   ├── usage.py               # 用量统计
│   ├── providers/
│   │   ├── base.py
│   │   ├── openai_compat.py   # OpenAI / DeepSeek / Qwen / 本地
│   │   ├── anthropic.py
│   │   └── google.py
│   └── models.yml             # 模型+路由+Agent 配置
│
├── wiki_mcp/                  # 知识引擎 MCP
│   ├── server.py
│   ├── db.py
│   ├── chunker.py
│   ├── search.py
│   └── tools.py
│
├── gateway_mcp/               # 模型网关 MCP（让 cc 调用其他模型）
│   ├── server.py
│   └── tools.py
│
├── scripts/
│   ├── migrate_existing.py    # 存量知识迁移
│   └── setup.sh               # 一键部署脚本
│
└── data/
    ├── postgres/              # PG 数据（gitignore）
    └── files/                 # 导入的文件（gitignore）
```
