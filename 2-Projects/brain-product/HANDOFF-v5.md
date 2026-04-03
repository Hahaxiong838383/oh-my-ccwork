# mycc-brain v0 实施交接 — OpenAI-compatible API 代理层

> 创建时间：2026-04-03 | 创建者：cc (Claude Opus 4.6)
> Session：v4 评审 → API 代理层方案讨论 → 延迟评估 → 评测工具选型
> 前序文档：HANDOFF-v4.md（原 WebUI 方案）、HANDOFF-v3.md（v3 完整架构）

---

## 一、方案定位

**mycc 后端对外暴露标准 OpenAI-compatible API（/v1/chat/completions），成为"带大脑的模型代理"。**

不自建 WebUI，让任何支持 OpenAI API 的工具直接接入。

```
v4（自建 WebUI + API 适配器）
  → v5（不建 UI，做 OpenAI-compatible 代理层，复用生态工具）
```

---

## 二、架构

```
任何 Agent 工具
  ├── Chatbox（桌面聊天）
  ├── ChatHub（浏览器多模型对比）
  ├── OpenClaw（微信/飞书）
  ├── Cursor / Continue（开发工具，需 tool_calls，v0 不做）
  └── 任何 OpenAI SDK 客户端
       │
       ▼
POST /v1/chat/completions
  Authorization: Bearer sk-brain-xxx
       │
       ▼
┌─────────────────────────────────────────────────┐
│  mycc 代理层（brain-api.ts ~300行，新建）         │
│                                                  │
│  ① 解析 OpenAI 格式请求                          │
│  ② context-loader 查记忆（TF-IDF 模式，<20ms）   │
│  ③ 读取 active hot-patches（最近纠正规则）        │
│  ④ 构造增强 system prompt（记忆 + patches）       │
│  ⑤ model 参数路由到上游 LLM                      │
│  ⑥ 流式转发 SSE（Claude 需格式转换）              │
│  ⑦ 异步写经验流 JSONL（不阻塞响应）              │
└─────────────────┬───────────────────────────────┘
                  │
     ┌────────────┼────────────────┐
     ▼            ▼                ▼
Claude API    DeepSeek API    Ollama 本地
(cc-claude)   (cc-deepseek)   (cc-local)
(raw-claude)  (raw-deepseek)  (raw-local)
```

### model 参数路由

| model 值 | 行为 |
|----------|------|
| `cc-claude` | 走大脑（记忆+hot-patch+经验流），上游 Claude API |
| `cc-deepseek` | 走大脑，上游 DeepSeek API |
| `cc-local` | 走大脑，上游 Ollama 本地 |
| `cc-auto` | 走大脑，自动选择上游 |
| `raw-claude` | 直通（不注入记忆，仍记录经验流用于对比） |
| `raw-deepseek` | 直通 DeepSeek |
| `raw-local` | 直通 Ollama |

### 公网访问

```
cli4.hahaxiong.cc/v1/*  → Caddy 反代 → localhost:18080/v1/*
认证：Bearer token（不走 nginx Basic Auth，OpenAI SDK 只支持 Bearer）
```

Caddyfile 新增：
```caddyfile
handle /v1/* {
    reverse_proxy localhost:18080 {
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }
}
```

---

## 三、与现有代码的关系

**核心原则：不碰现有 http-server.ts 的逻辑，只加 1 行路由分发。**

```
http-server.ts（现有 ~2500 行，不动）
    ├── /chat          → 现有逻辑（session + 飞书 + 多引擎路由）
    ├── /history/*     → 现有逻辑
    └── 新增 1 行：if (url.startsWith('/v1/')) return brainApi.handle(req, res)

brain-api.ts（新建 ~300 行）
    ├── POST /v1/chat/completions → 代理层核心
    ├── GET  /v1/models           → 返回可用模型列表
    ├── POST /correct             → 用户纠正（写 contrast + hot-patch）
    └── GET  /v1/stats            → 今日对话数/token/纠正数
```

不复用现有 CCAdapter 接口（那个绑定 session 生命周期，API 直调不需要）。

### 新建文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `brain-api.ts` | ~300 | OpenAI 兼容路由、认证、rate limiting |
| `adapters/claude-direct.ts` | ~150 | Claude Messages API 直调 + SSE 格式转换 |
| `adapters/openai-compat.ts` | ~100 | DeepSeek/Ollama 转发（天然兼容，改 baseURL） |
| `services/experience-stream.ts` | ~80 | 经验流 JSONL 按日写入 |
| `services/hotpatch.ts` | ~60 | hot-patch 读写 + 注入 |

### SSE 格式转换（Claude → OpenAI）

Claude SSE 和 OpenAI SSE 格式不同，需要转换：
- `message_start` → 生成 chatcmpl ID
- `content_block_delta` → `choices[0].delta.content`
- `message_stop` → `finish_reason: "stop"`
- `usage` → token 统计

DeepSeek/Ollama 天然 OpenAI 格式，直接管道转发不需要转换。

---

## 四、经验流 + hot-patch

### 经验流 Schema（同 v4）

```jsonc
// data/experiences/2026-04-03.jsonl
{
  "id": "exp_20260403_143021_a7f3",
  "ts": "2026-04-03T14:30:21+08:00",
  "mode": "brain",              // "brain" | "raw"（用于对比）
  "model": "cc-claude",
  "route": "claude_api",
  "latency_ms": 1200,
  "injected_memory": 8,         // 注入了几条记忆
  "injected_patches": 2,        // 注入了几条 hot-patch
  "user_corrected": false,      // 用户后来有没有纠正
  "user_input": "...",
  "model_output": "...",
  "contrast": null
}
```

### hot-patch（同 v4）

```jsonc
// data/hot-patches.jsonl
{
  "id": "hp_20260403_1502",
  "created_at": "2026-04-03T15:02:00+08:00",
  "rule": "...",
  "context": "...",
  "status": "active"          // active | merged | expired
}
```

---

## 五、认证 + 安全

- Bearer token：`.env` 中 `BRAIN_API_KEY=sk-brain-xxx`
- Rate limiting：滑动窗口，每分钟 30 请求（内存计数）
- Token 用量：日上限 100K tokens，超限自动切 DeepSeek
- /v1/* 不走 nginx Basic Auth（OpenAI SDK 不支持 Basic Auth）

---

## 六、评测方案

### 批量评测：Promptfoo

```bash
npx promptfoo@latest eval -c eval/promptfooconfig.yaml
npx promptfoo@latest view  # → http://localhost:15500
```

20 题标准 benchmark（推理、数学、代码、知识、创意、指令遵循），配置文件放 `eval/promptfooconfig.yaml`。

### 交互对比：ChatHub 浏览器插件

Chrome 插件，配置两个 Custom API（cc-claude + raw-claude），同一问题左右分屏对比。

### 深度评测（可选）：open-webui Arena

Docker 部署，盲评打分，自动统计胜率。

---

## 七、4 天执行计划

| 天 | 任务 | 验证标准 |
|----|------|---------|
| D1 | brain-api.ts + claude-direct.ts + openai-compat.ts + model 路由 | `curl /v1/chat/completions` 走 Claude API 返回 OpenAI 格式 SSE |
| D2 | context-loader 记忆注入（TF-IDF）+ hotpatch 读写注入 + 经验流 JSONL | 发消息后 system prompt 有记忆，JSONL 有记录 |
| D3 | Bearer token 认证 + rate limiting + Caddy /v1/* 路由 + 公网联调 | `curl https://cli4.hahaxiong.cc/v1/chat/completions` 可用 |
| D4 | Chatbox 接入 + ChatHub 对比验证 + Promptfoo 20 题评测 | 评测报告出炉 |

---

## 八、关键文件索引

| 文件 | 说明 |
|------|------|
| `2-Projects/brain-product/HANDOFF-v5.md` | **本文档** |
| `2-Projects/brain-product/HANDOFF-v4.md` | v4 原方案（WebUI 版，已放弃） |
| `.claude/skills/mycc/scripts/src/http-server.ts` | 现有后端（~2500 行，只改 1 行） |
| `.claude/skills/mycc/scripts/src/adapters/` | 适配器目录 |
| `.claude/skills/mycc/scripts/src/services/context-loader.ts` | 记忆注入（已有，1343 行） |
| `2-Projects/cc-remote-v4/Caddyfile` | Caddy 路由（加 /v1/* 反代） |

---

## 九、SSH / 环境信息

- **Mini M4**: `ssh rayman.chen@10.9.1.54`（密码 Hahaxiong83），Ollama :11434，mycc 后端 :18080
- **cc-remote V4 公网**：`https://cli4.hahaxiong.cc/`
- **API Keys**：`.env` 中配置 ANTHROPIC_API_KEY、DEEPSEEK_API_KEY、BRAIN_API_KEY
