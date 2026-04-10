# HANDOFF: Ollama Qwen3 Thinking 关闭 + 本地推理优化

**日期**: 2026-04-10
**状态**: 框架切换完成，thinking 关闭待实现（最后一步）

## 已完成

- [x] 根因分析：MLX prefill 效率远低于 Ollama (llama.cpp)，同模型差 20x
- [x] MoE 30B-A3B 实测：75s TTFT，Apple Silicon 上 MoE 不省时间（已记录 memory）
- [x] 三机 benchmark 对比实测（Mini M4 / Studio M2 Max / 云端）
- [x] 框架切换：cc-local 从 MLX → Ollama qwen3:4b（config.ts）
- [x] 路由重命名：cc-mlx → cc-local / raw-local
- [x] memoryLLM intake/consolidation 全量本地化（localhost:11434，不依赖雷电）
- [x] prompt 分层注入代码（brain-api.ts promptBudgetTokens 逻辑）
- [x] openai-compat.ts prompt 大小诊断日志
- [x] Admin UI 红点修复（aFetch 401 清 token + 弹登录）
- [x] Studio 30B-A3B 模型下载（/Users/fu-121/models/Qwen3-30B-A3B-4bit/，可删）
- [x] Studio swap 爆满排查与恢复
- [x] 决策记录写入 04-决策记录.md

## 核心阻塞

**Ollama Qwen3 的 thinking 模式无法通过 OpenAI 兼容 API 关闭。**

### 已验证无效的方式
1. `enable_thinking: false` — Ollama `/v1/chat/completions` 静默忽略此参数
2. `/no_think` system prompt 标签 — 在 streaming 模式下不可靠，实测仍 41s
3. `supportsThinking: true` + brain 发 `enable_thinking: false` — 导致请求卡死

### 正确方式（来自掘金文章实测验证）

**必须使用 Ollama 原生 API** (`/api/chat`)，不能用 OpenAI 兼容 API：

```
POST http://localhost:11434/api/chat
{
    "model": "qwen3:4b",
    "messages": [...],
    "stream": true,
    "think": false    // ← 只在原生 API 生效
}
```

参考文章：https://juejin.cn/post/7613658584812568576

## 下一步：实现 Ollama 原生适配器

### 方案

在 `src/adapters/` 新增 `ollama-native.ts`，专门处理 Ollama 路由：
- 使用 `/api/chat` 而非 `/v1/chat/completions`
- 请求体加 `"think": false`
- SSE 流式响应格式不同（Ollama 原生是 NDJSON，不是 SSE `data:` 前缀）
- 需要转换为 brain 前端期望的 SSE 格式

### 关键差异

| 特性 | OpenAI 兼容 (`/v1/`) | Ollama 原生 (`/api/`) |
|------|---------------------|---------------------|
| 路径 | `/v1/chat/completions` | `/api/chat` |
| thinking 控制 | 不支持 | `"think": true/false` |
| 流式格式 | SSE (`data: {...}\n\n`) | NDJSON (每行一个 JSON) |
| 响应结构 | `choices[0].delta.content` | `message.content` |
| 结束标记 | `data: [DONE]` | `"done": true` |

### 改动范围

1. **新文件** `src/adapters/ollama-native.ts` — Ollama 原生流式适配器
2. **config.ts** — ModelRoute 加 `adapter: "ollama-native"` 类型
3. **brain-api.ts** — 路由分发时根据 adapter 类型选择适配器
4. **brain-api.ts** — 删除 `/no_think` 注入逻辑（不再需要）

### 预期效果

非流式 benchmark 已验证 cc-local TTFT 3.4s。关闭 thinking 后流式模式应该也能达到同样水平。

## 当前 Studio 状态

| 服务 | 端口 | 状态 |
|------|------|------|
| brain v0.9.0 | :19080 | 在线（pm2） |
| Ollama (qwen3:4b) | :11434 | 在线 |
| MLX 30B-A3B | :8000 | 已停（可删模型释放 16GB 磁盘） |

## 其他待处理

- Admin UI 部署后 token 失效需 `?logout`（init 启动时预验证未实现）
- 测试前应先盘点 Studio 模型/内存状态（防 swap 爆满）
- prompt 分层注入代码已写但未实际验证效果（因 thinking 问题遮蔽了）

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/config.ts` | cc-local 路由定义，promptBudgetTokens |
| `src/adapters/openai-compat.ts` | 当前适配器（需保留给非 Ollama 路由） |
| `src/brain-api.ts` | 分层注入 + /no_think 注入（待改为原生 API） |
| `src/admin/admin-ui.html` | 红点修复已应用 |
| `04-决策记录.md` | 本次决策已记录 |

## 可粘贴提示词

```
读 2-Projects/brain-product/HANDOFF-ollama-thinking.md。核心任务：实现 Ollama 原生 API 适配器，让 cc-local 路由使用 /api/chat + think:false 关闭 Qwen3 thinking。当前问题：OpenAI 兼容 API 无法关闭 thinking（实测 41s），必须用 Ollama 原生 /api/chat 的 think 参数。方案：1) 新建 src/adapters/ollama-native.ts 处理 /api/chat 流式 NDJSON → SSE 转换；2) config.ts ModelRoute 加 adapter:"ollama-native" 类型；3) brain-api.ts 根据 adapter 类型分发；4) 删除 /no_think 标签注入。部署到 Studio 验证 TTFT < 5s。
```
