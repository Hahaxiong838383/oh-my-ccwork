# Gemini 系列模型调用规则（brain 项目必读）

> **文档位置建议**：brain 项目的 `docs/gemini-calling-rules.md` 或类似位置
> **版本**：v5.3
> **最后更新**：2026-04-11 19:18 CST
> **维护者**：cc（基于 mycc-brain Gemini Proxy v5.3 的完整实测）

本文档是 brain 项目调用 Gemini 模型的**单一事实来源**。所有 Gemini 调用必须遵守本文档。

---

## 0. TL;DR（3 分钟速通）

- **Base URL**：`http://23.226.135.149:4000/v1`
- **API Key**：`fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4`
- **协议**：OpenAI Chat Completions 完全兼容，直接用 `openai` SDK
- **生产可用模型（仅 6 个）**：`gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite` / `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite-preview` / `gemini-3-flash-preview`
- **禁用**：任何 2.0 / 1.5 系列、`gemini-3-pro-preview`（已 discontinued）、任何带日期后缀的变体（`-002` / `-preview-09-2025` 等）
- **thinking 默认最小化**（brain 日常交互秒回），想要深度推理传 `reasoning_effort: "high"`
- **429 / rate limit 不用 brain 处理**：wrapper 已做 300s budget 自动重试 + cooldown，对下游透明
- **brain 代码无需加任何退避逻辑**

---

## 1. 快速接入

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://23.226.135.149:4000/v1",
    api_key="fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4",
)

# 最简调用
resp = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "写一段介绍"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Node.js / TypeScript

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://23.226.135.149:4000/v1",
  apiKey: "fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4",
});

const resp = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "你好" }],
});
console.log(resp.choices[0].message.content);
```

### curl

```bash
curl -sS http://23.226.135.149:4000/v1/chat/completions \
  -H "Authorization: Bearer fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

---

## 2. 可用模型完整清单（实测 2026-04-11）

### 2.1 生产可用 Text 模型（共 6 个）

| 模型 ID | Endpoint | 流式 TTFT | 流式 total | thinking 支持 | 用途 |
|---|---|---|---|---|---|
| `gemini-2.5-flash-lite` | us-central1 + global | **0.63s** | 0.95s | ❌ 无 | ⚡ 极速分类 / 路由 / 短答 |
| `gemini-2.5-flash` | us-central1 + global | **0.92s** | 0.95s | ✅ 0-32768 | ⭐ **brain 日常首选** |
| `gemini-2.5-pro` | us-central1 + global | **2.00s** | 2.04s | ✅ 128-32768 | 🧠 2.5 代深度推理（min=128） |
| `gemini-3-flash-preview` | **global only** | 1.43s | 1.43s | ✅ 0-32768 | 3.x 快速通道 |
| `gemini-3.1-flash-lite-preview` | **global only** | 1.57s | 1.57s | ✅ 0-32768 | 3.x 轻量首选 |
| `gemini-3.1-pro-preview` | **global only** | 2-15s ⚠️ | 波动大 | ✅ 128-32768 | 最强推理（延迟不稳，生产慎用）|

**关键说明**：
- **2.5 系列**：稳定、成本可控、延迟低，**brain 生产主力**
- **3.x preview**：wrapper 自动路由到 Vertex AI `global` endpoint（特殊 URL 结构，brain 无感）
- **`gemini-3.1-pro-preview`**：preview 模型 SLA 不保证，延迟波动大（2-40s），**不要用于关键路径**

### 2.2 禁用清单（调用会失败或行为不可预测）

| ❌ 不要用 | 原因 | ✅ 替代方案 |
|---|---|---|
| `gemini-2.0-flash` | Vertex AI 已下架，全 region 404 | `gemini-2.5-flash` |
| `gemini-2.0-flash-lite` | Vertex AI 已下架 | `gemini-2.5-flash-lite` |
| `gemini-2.0-flash-001` / `-exp` / `-thinking-exp` | 全部 404 | `gemini-2.5-flash` |
| `gemini-1.5-pro` / `gemini-1.5-flash` / `gemini-1.5-flash-8b` | Legacy 已下架 | `gemini-2.5-pro` / `gemini-2.5-flash` |
| `gemini-1.5-pro-002` / `gemini-1.5-flash-002` | 全部 404 | 2.5 系列 |
| `gemini-3-pro-preview` | **2026-03-26 discontinued** | `gemini-3.1-pro-preview` |
| `gemini-2.5-pro-002` / `gemini-2.5-flash-preview-09-2025` / 任何带日期/版本号后缀 | 全部 404 | 去掉后缀的主名 |
| `gemini-3.1-flash-image` (不带 preview) | 404 | `gemini-3.1-flash-image-preview`（如需 image） |

**规则**：只用主名，不用 `-XYZ` 日期版本号后缀。

### 2.3 Image Generation 模型（wrapper 当前未暴露）

这些模型存在但 wrapper 不处理（image 响应格式和 chat completions 不兼容）：

- `gemini-2.5-flash-image`（us-central1 + global）
- `gemini-3.1-flash-image-preview`（global only）
- `gemini-3-pro-image-preview`（global only）

**brain 需要 image generation 时**：告诉 cc，wrapper 加一条 `/v1/images/generations` 路由即可接入。

---

## 3. Thinking 控制（⭐ 关键参数）

Gemini 2.5 / 3.x 默认开启 extended thinking，简单问题也可能花 5-30s 推理。wrapper **默认最小化 thinking**（秒回），调用方按需开启。

### 3.1 使用 OpenAI 标准 `reasoning_effort`（推荐）

```python
# 快速响应（默认，不传也行）
client.chat.completions.create(
    model="gemini-2.5-flash",
    reasoning_effort="none",   # 关闭 thinking
    messages=[...]
)

# 中等推理
client.chat.completions.create(
    model="gemini-2.5-pro",
    reasoning_effort="medium",  # 1024 token thinking budget
    messages=[...]
)

# 深度推理
client.chat.completions.create(
    model="gemini-2.5-pro",
    reasoning_effort="high",    # 4096 token thinking budget
    messages=[...]
)
```

### 3.2 `reasoning_effort` 值映射

| reasoning_effort | thinking budget | flash 延迟 | pro 延迟 | 用途 |
|---|---|---|---|---|
| `"none"` / `"minimal"` | 0 | **0.9s** | 5.5s（pro 被 clamp 到 128） | Admin UI chat、秒回 |
| `"low"` | 256 | 1.7s | ~4s | 轻量推理 |
| `"medium"` | 1024 | 4.7s | ~8s | 平衡模式 |
| `"high"` | 4096 | 13.7s | 36.5s | 深度推理 |
| **(不传)** | wrapper 默认最小 | 0.9s | 5.5s | ⭐ 等价 "none" |

### 3.3 精确数值控制（如果 `reasoning_effort` 不够）

```python
client.chat.completions.create(
    model="gemini-2.5-pro",
    extra_body={"thinking_budget": 2048},   # 精确 token 数
    messages=[...]
)
```

### 3.4 wrapper 按模型自动 clamp 范围

| 模型 | thinking_budget 合法范围 | 不能传什么 |
|---|---|---|
| `gemini-2.5-pro` | `[128, 32768]` | ❌ 0（pro 最小 128） |
| `gemini-3.1-pro-preview` | `[128, 32768]` | ❌ 0 |
| `gemini-2.5-flash` | `[0, 32768]` | 任意整数 OK |
| `gemini-3-flash-preview` | `[0, 32768]` | 任意整数 OK |
| `gemini-3.1-flash-lite-preview` | `[0, 32768]` | 任意整数 OK |
| `gemini-2.5-flash-lite` | 字段无效 | 不支持 thinking |

wrapper 会自动 clamp 越界值，不会 400 给你。

---

## 4. 其他参数（OpenAI 完全兼容）

### 4.1 `max_tokens`（最大输出）

```python
# 不传：wrapper 自动填入模型上限 (65535, 不是 65536)
client.chat.completions.create(model="gemini-2.5-flash", messages=[...])

# 显式传：最大 65535（注意不是 65536，Vertex 上限是 exclusive）
client.chat.completions.create(model="gemini-2.5-flash", max_tokens=1000, messages=[...])
```

**陷阱**：所有 2.5 / 3.x 模型的 max_tokens 上限都是 **65535**（exclusive 65536）。传 65536 会 400。

### 4.2 其他参数

| 字段 | 类型 | 说明 |
|---|---|---|
| `temperature` | 0-2 | 随机性 |
| `top_p` | 0-1 | nucleus sampling |
| `top_k` | int | top-k sampling |
| `stop` | list[str] | 停止序列 |
| `stream` | bool | 原生 SSE 流式 |
| `extra_body` | dict | 透传通道（含 `thinking_budget`） |

---

## 5. 延迟基线（实测 2026-04-11）

**默认 thinking 最小化**（不传 `reasoning_effort`，brain 日常交互）：

| 模型 | 流式 TTFT | 流式 total |
|---|---|---|
| gemini-2.5-flash-lite | **0.63s** ⭐ | 0.95s |
| gemini-2.5-flash | **0.92s** ⭐ | 0.95s |
| gemini-2.5-pro | **2.00s** | 2.04s |
| gemini-3-flash-preview | 1.43s | 1.43s |
| gemini-3.1-flash-lite-preview | 1.57s | 1.57s |
| gemini-3.1-pro-preview | 2-15s ⚠️ | 波动大 |

**开启 `reasoning_effort="high"`**：

| 模型 | non-stream |
|---|---|
| gemini-2.5-flash | ~14s |
| gemini-2.5-pro | ~36s |
| gemini-3.1-pro-preview | 30-60s |

**注意**：
- **`gemini-3.1-pro-preview` 延迟波动极大**，同样 prompt 有时 2s 有时 15s。Preview 模型不保证 SLA，关键路径不要依赖
- **`gemini-2.5-pro` 相对稳定**，TTFT 基本 2-6s 区间

---

## 6. 错误处理

### 6.1 错误码语义

| HTTP | `error.type` | 含义 | brain 应对 |
|---|---|---|---|
| 200 | — | 成功 | — |
| 400 | `validation_error` | 参数错误（max_tokens 越界 / thinking_budget 越界 / 格式错） | 不可重试，检查代码 |
| 401 | `auth_error` | Bearer token 错误 | 检查 api_key 配置 |
| 404 | `upstream_error` | 模型不存在 | wrapper 已自动切 backend，**brain 不用重试** |
| 429 | `rate_limit_error` | wrapper 重试预算耗尽（极少发生） | 指数退避，或降级到 flash-lite |
| 500-503 | `upstream_error` | 上游异常 | wrapper 已自动重试+换 account |
| 504 | `timeout` | 超时 | 可重试，建议换模型 |

### 6.2 429 的正确理解

**wrapper 已经做了全局退避**：收到 Google 429 会自动 cooldown + retry（300s budget / 最多 5 次）。**brain 通常永远不会收到 429**，除非：
1. 单分钟内 **同一模型 +60 并发**（极端情况）
2. 使用了 `gemini-3.1-pro-preview` 且高频调用（preview 模型 quota 本来就紧）

**brain 收到 429 的处理**：
```python
try:
    resp = client.chat.completions.create(...)
except openai.RateLimitError as e:
    # 解析 "reset after Xs"
    import re
    m = re.search(r"reset after (\d+)s", str(e))
    wait = int(m.group(1)) + 2 if m else 30
    time.sleep(wait)
    # 或者降级到 flash-lite 重试
```

### 6.3 brain 不需要做的事

- ❌ 不需要加"wrapper 可能挂了"的 circuit breaker（wrapper 有 Restart=always）
- ❌ 不需要加"Vertex 可能挂了"的 fallback（wrapper 自动切 OAuth）
- ❌ 不需要加 per-model rate limit（wrapper 在 pool 层全局限流）
- ❌ 不需要加 429 指数退避（wrapper 内部已做）

---

## 7. 调试与运维工具

### 7.1 强制路由（调试用）

```python
# 强制走 Vertex AI
client.chat.completions.create(
    model="gemini-2.5-flash",
    extra_headers={"X-Gemini-Route": "vertex"},
    messages=[...]
)

# 强制走 OAuth Code Assist（测试 fallback）
client.chat.completions.create(
    model="gemini-2.5-flash",
    extra_headers={"X-Gemini-Route": "oauth"},
    messages=[...]
)
```

### 7.2 健康检查

```bash
curl http://23.226.135.149:4000/health | jq .pool
```

返回 pool 状态：
- `alive_accounts` / `total_accounts`（应该是 7/7）
- 每个 account 的 `total_requests` / `total_429` / `in_flight`
- `cooldowns_remaining_s`（每个 account 的 per-model 冷却）
- `unsupported_models`（wrapper 学到的"此 account 不支持此模型"）

### 7.3 可用模型列表

```bash
curl -H "Authorization: Bearer fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4" \
     http://23.226.135.149:4000/v1/models
```

---

## 8. Gotchas 速查（常见陷阱）

1. **⚠️ 不要用 2.0 / 1.5 系列模型**：Vertex 已全部下架，调用会 404
2. **⚠️ 不要用带日期后缀的变体**：`gemini-2.5-flash-002` / `gemini-2.5-pro-preview-09-2025` 等全 404
3. **⚠️ Gemini 2.5/3.x 默认 thinking 巨慢**：wrapper 已默认关闭，别手动传 `thinking_budget=32768`
4. **⚠️ pro 的 thinking_budget 最小 128**：传 0 会 400
5. **⚠️ max_tokens 最大 65535**：传 65536 会 400（Vertex 的上限是 exclusive）
6. **⚠️ 流式 TTFT = thinking 生成时间**：Gemini 在 thinking 完成前不会吐第一个 chunk
7. **⚠️ `gemini-3.1-pro-preview` 延迟波动大**：生产关键路径不要依赖
8. **✅ 3.x preview 可以放心用**：wrapper 自动路由到 Vertex global endpoint，延迟 1-2s（不是之前以为的 30s+）
9. **✅ brain 代码不用加 429 退避**：wrapper 已做 300s budget 重试
10. **✅ brain 代码不用加 Vertex/OAuth fallback**：wrapper pool 自动切

---

## 9. 成本参考（Vertex AI 按量计费）

| 模型 | Input ($/1M tokens) | Output ($/1M tokens) | brain 月成本估算（1000 次/天，500 in + 200 out）|
|---|---|---|---|
| gemini-2.5-flash-lite | $0.05 | $0.20 | ~$2 |
| gemini-2.5-flash | $0.30 | $2.50 | ~$20 |
| gemini-2.5-pro | $1.25 | $10.00 | ~$80 |
| gemini-3-flash-preview | preview 期低价 | — | 极低 |
| gemini-3.1-flash-lite-preview | preview 期低价 | — | 极低 |
| gemini-3.1-pro-preview | preview 期定价 | — | 预览期较低 |

**成本优化原则**：
- 高频调用首选 `gemini-2.5-flash-lite`（最便宜）
- 日常交互用 `gemini-2.5-flash`
- 只有真正需要推理时才用 `gemini-2.5-pro`
- preview 模型在 GA 前免费或低价，适合测试但生产依赖风险

---

## 10. 模型选型决策树

```
需要 Gemini 响应
    │
    ├─ ⚡ 极速交互（< 1s）
    │   ├─ gemini-2.5-flash-lite       (0.6s ⭐ 首选)
    │   └─ gemini-2.5-flash             (0.9s, 能力更强)
    │
    ├─ 📖 日常生成（Admin UI chat）
    │   ├─ gemini-2.5-flash             ⭐ brain 主力
    │   └─ gemini-3.1-flash-lite-preview (想体验 3.x 时)
    │
    ├─ 🧠 深度推理（reasoning_effort="high"）
    │   ├─ gemini-2.5-pro               (~36s, 稳定)
    │   └─ gemini-3.1-pro-preview       (30-60s, 最强但波动大)
    │
    ├─ ⚖️ eval judge / 打分
    │   └─ gemini-2.5-flash + reasoning_effort="medium" (~5s, 性价比最高)
    │
    ├─ 🛣️ skill 分类 / 路由
    │   └─ gemini-2.5-flash-lite + reasoning_effort="none" (<1s)
    │
    └─ 🔬 实验性 3.x 能力探索
        └─ gemini-3-flash-preview       (1.4s, 最快的 3.x)
```

---

## 11. brain 后端：thinking toggle 接入（Python）

### 11.1 统一的 Gemini 调用入口

```python
# brain/llm/gemini_client.py

from openai import OpenAI
from typing import Literal, Optional

client = OpenAI(
    base_url="http://23.226.135.149:4000/v1",
    api_key="fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4",
)

# thinking_mode → reasoning_effort 映射
THINKING_MODE_TO_EFFORT: dict[str, Optional[str]] = {
    "off":  "none",    # UI toggle OFF：关闭 thinking，秒回
    "auto": None,      # 不传，用 wrapper 默认（flash=0, pro=128 最小）
    "on":   "medium",  # UI toggle ON：中等推理 (1024 budget, flash ~5s, pro ~8s)
    # 如果 UI 未来加 "deep" 档，映射到 "high"
    "deep": "high",    # 深度推理 (4096 budget, flash ~14s, pro ~36s)
}

ThinkingMode = Literal["off", "auto", "on", "deep"]

def call_gemini(
    messages: list,
    *,
    model: str = "gemini-2.5-flash",
    thinking_mode: ThinkingMode = "auto",
    stream: bool = False,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    **extra,
):
    """Brain 的 Gemini 统一调用入口。

    Args:
        messages: OpenAI 格式 messages
        model: 必须是可用模型清单里的一个（见 Section 2.1）
        thinking_mode:
            - "off":  关闭 thinking（admin UI chat 默认，秒回）
            - "auto": wrapper 默认（flash=0, pro=128 最小）
            - "on":   启用中等推理（UI toggle ON 默认映射）
            - "deep": 深度推理（如果 UI 加了 Deep 档）
        stream: 流式输出
    """
    body = {
        "model": model,
        "messages": messages,
        "stream": stream,
        **extra,
    }
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens

    effort = THINKING_MODE_TO_EFFORT.get(thinking_mode)
    if effort is not None:
        body["reasoning_effort"] = effort

    return client.chat.completions.create(**body)
```

### 11.2 Chat API 路由接入

```python
# brain/api/chat.py

from brain.llm.gemini_client import call_gemini, ThinkingMode

class ChatRequest(BaseModel):
    messages: list
    model: str = "gemini-2.5-flash"
    stream: bool = False
    thinking_mode: ThinkingMode = "auto"  # 新增字段，从前端 toggle 来

@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    return call_gemini(
        messages=req.messages,
        model=req.model,
        thinking_mode=req.thinking_mode,
        stream=req.stream,
    )
```

### 11.3 非 chat 场景（代码层 hardcode thinking）

brain 内部的 LLM 调用（eval / agent / 分类）**不要受 UI toggle 影响**，应该在代码层固定：

```python
# Eval judge: 深度推理
judge_resp = call_gemini(
    messages=[...],
    model="gemini-2.5-pro",
    thinking_mode="on",      # hardcode
)

# Skill 分类 / 路由: 极速
route_resp = call_gemini(
    messages=[...],
    model="gemini-2.5-flash-lite",
    thinking_mode="off",     # hardcode
)

# 普通 agent 推理: 默认
agent_resp = call_gemini(
    messages=[...],
    model="gemini-2.5-flash",
    thinking_mode="auto",    # 或按任务复杂度动态选
)
```

---

## 12. brain 前端：thinking toggle UX 建议

### 12.1 前端组件伪代码（React）

```tsx
const [thinkingEnabled, setThinkingEnabled] = useState(false);
const [selectedModel, setSelectedModel] = useState("gemini-2.5-flash");

async function sendMessage(text: string) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [...history, { role: "user", content: text }],
      model: selectedModel,
      thinking_mode: thinkingEnabled ? "on" : "off",  // 核心映射
      stream: true,
    }),
  });
  // ...
}

return (
  <div>
    <Toggle
      checked={thinkingEnabled}
      onChange={setThinkingEnabled}
      label="Thinking 模式"
      description="开启后响应慢 5-20 倍，适合复杂推理"
      disabled={selectedModel === "gemini-2.5-flash-lite"}  // flash-lite 不支持
    />
    {thinkingEnabled && selectedModel === "gemini-2.5-pro" && (
      <div className="warning">⚠️ 深度推理模式，预计响应 20-40 秒</div>
    )}
    {/* ...chat UI... */}
  </div>
);
```

### 12.2 UX 优化清单

1. **延迟提示**：toggle 下方小字 "开启后响应延迟增加 5-20 倍"
2. **per-conversation 持久化**：toggle 状态存到 conversation 对象，刷新不丢
3. **模型组合约束**：
   - `flash-lite` 下 toggle **禁用或隐藏**（模型不支持 thinking）
   - `pro` 下 toggle OFF 时小提示 "pro 有最低 thinking，无法完全关闭"
4. **高延迟警告**：toggle ON 且 model 是 pro 时，输入框上方红字 "⚠️ 深度推理，预计 20-40s"
5. **模型选择器**：只列 Section 2.1 的 6 个生产可用模型，禁用的不要出现

---

## 13. brain 侧改动 Checklist

按顺序执行：

### 13.1 代码层面（后端）

- [ ] 新建 `brain/llm/gemini_client.py`，拷贝 Section 11.1 的代码
- [ ] 现有 Gemini 调用全部改为 `call_gemini()` 入口
- [ ] `ChatRequest` 数据模型加 `thinking_mode` 字段
- [ ] Chat API endpoint 透传 `thinking_mode`
- [ ] 非 chat 场景（eval / agent / skill）的 LLM 调用 hardcode 合适的 `thinking_mode`

### 13.2 代码层面（前端）

- [ ] admin UI 的 Thinking toggle 状态串到 `/api/chat` 请求的 `thinking_mode` 字段
- [ ] 模型选择器更新为 Section 2.1 的 6 个可用模型
- [ ] 加 UX 细节（Section 12.2）

### 13.3 清理遗留代码（关键！）

- [ ] 全局搜索 `gemini-2.0-flash` → 替换为 `gemini-2.5-flash`
- [ ] 全局搜索 `gemini-2.0-flash-lite` → 替换为 `gemini-2.5-flash-lite`
- [ ] 全局搜索 `gemini-1.5` → 替换为对应 2.5 版本
- [ ] 全局搜索 `gemini-3-pro-preview`（已 discontinued） → 替换为 `gemini-3.1-pro-preview`
- [ ] 全局搜索带日期后缀（如 `-002` / `-preview-09-`）→ 去掉后缀
- [ ] 检查配置文件、环境变量、`.env.example` 里的默认 model 值
- [ ] 检查测试用例里的 mock model 名

### 13.4 配置层面

- [ ] `brain/config/` 或环境变量里的 `GEMINI_BASE_URL` / `GEMINI_API_KEY` 指向 wrapper
- [ ] 如果有 model 白名单，同步更新为 Section 2.1

---

## 14. 验收测试

实施完成后跑这 4 个 curl 验证正确性：

```bash
BASE="http://<brain-backend>/api/chat"

# 1. thinking=off，预期 <1s
curl -X POST $BASE -H "Content-Type: application/json" -d '{
  "model":"gemini-2.5-flash",
  "thinking_mode":"off",
  "messages":[{"role":"user","content":"hi"}]
}'

# 2. thinking=auto，预期 <1s
curl -X POST $BASE -H "Content-Type: application/json" -d '{
  "model":"gemini-2.5-flash",
  "thinking_mode":"auto",
  "messages":[{"role":"user","content":"hi"}]
}'

# 3. thinking=on + flash，预期 5-15s
curl -X POST $BASE -H "Content-Type: application/json" -d '{
  "model":"gemini-2.5-flash",
  "thinking_mode":"on",
  "messages":[{"role":"user","content":"解释量子力学核心原理"}]
}'

# 4. thinking=on + pro，预期 15-40s
curl -X POST $BASE -H "Content-Type: application/json" -d '{
  "model":"gemini-2.5-pro",
  "thinking_mode":"on",
  "messages":[{"role":"user","content":"详细分析 AI 对就业的长期影响"}]
}'
```

**验收标准**：
- 所有请求 HTTP 200
- 1、2 的 wall time <2s
- 3 的 wall time 5-15s
- 4 的 wall time 15-40s

---

## 15. 基础设施背景

- **Wrapper 部署**：美国 VPS `23.226.135.149`（San Jose, RackNerd）
- **主路径**：Vertex AI 多 region pool
  - `us-central1`（首选，2.5 系列，延迟 0.4-2s）
  - `us-east4` / `us-west1` / `europe-west1` / `asia-northeast1`（溢出）
  - `global`（3.x preview 专用）
- **备份路径**：`hahaxiong83` Google One AI Pro → Code Assist OAuth
- **GCP Project**：`gen-lang-client-0932175592`
- **Billing Account**：`0189A1-D60B23-85327F`（绑定信用卡，后付费）
- **Wrapper 版本**：v5.3（2026-04-11）
- **容量实测**：30 并发 100% 成功（6 region × 20 slot ≈ 100 并发 slot）
- **systemd**：`gemini-proxy.service`，`Restart=always`，自动崩溃恢复
- **源码**：VPS `/opt/gemini-proxy/oauth_wrapper.py`
- **运维文档**：cc memory `reference_gemini_proxy.md`

---

## 16. 变更历史 & 维护

### 2026-04-11 v5.3（当前版本）

- 新增 Vertex AI `global` endpoint 支持 3.x preview 系列
- 多 region 并行（6 region spillover），30 并发 100% 成功
- Thinking 控制完整化（`reasoning_effort` / `thinking_budget`）
- 实测删除 2.0 / 1.5 系列模型（Vertex 已下架）
- max_tokens 边界修复（65535 不是 65536）
- Pool 自动剔除不可用 account，7/7 alive

### 如何报告问题

调用 Gemini 异常时：
1. 先 `curl http://23.226.135.149:4000/health | jq .pool` 看 pool 状态
2. 检查 wrapper 日志：`ssh root@23.226.135.149 journalctl -u gemini-proxy -n 50`
3. 把 request body + response + 时间戳发给 cc 排查

### wrapper 回滚（紧急）

```bash
ssh root@23.226.135.149 \
  "cp /opt/gemini-proxy/oauth_wrapper.v4.bak /opt/gemini-proxy/oauth_wrapper.py && systemctl restart gemini-proxy"
```

---

**文档结束**。brain 调用 Gemini 的所有规则都在这一份里，不需要参考其他文档。有问题直接找 cc。
