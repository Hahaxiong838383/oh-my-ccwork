# HANDOFF: Gemini 在线模型配置

> 创建时间：2026-04-06 02:30 | 上一个 session 由 cc (Claude opus-4-6) 完成

## 已完成

1. **config.ts 路由已配好**（已 deploy 到 Studio，已 push GitHub）
   - `cc-gemini-flash` / `raw-gemini-flash` → `gemini-2.5-flash`
   - `cc-gemini-3.1-flash` / `raw-gemini-3.1-flash` → `gemini-3.1-flash-lite-preview`
   - baseURL: `http://23.226.135.149:4000/v1`（你自建的 litellm 中转，OpenAI 兼容格式）
   - 模型名不带 `models/` 前缀（从 Air 直接 curl 验证通过）

2. **Studio .env 已写入 `GEMINI_PROXY_KEY`**

3. **brain 已部署 3 次**，最新 pid 23609 online

## ✅ 已修复：Upstream 500 问题（2026-04-06 10:40）

### 根因
`openai-compat.ts` 的 `streamOpenAICompat` 和 `chatCompletion` 函数无条件发送 `enable_thinking: false` 和 `max_tokens: 8192`。这两个非标准字段被 litellm 透传给 Gemini API，导致 500。

### 修复
改为条件性包含：`enable_thinking` 仅在 `true` 时发送，`max_tokens` 仅在显式传值时发送。

### 验证结果
| 路由 | brain | 状态 |
|------|-------|------|
| raw-gemini-flash | false | ✅ 200 |
| cc-gemini-flash | true | ✅ 200 |
| raw-gemini-3.1-flash | false | ✅ 200 |
| cc-gemini-3.1-flash | true | ✅（同配置） |

## 关键文件

| 文件 | 用途 |
|------|------|
| `src/config.ts` | Gemini 路由定义（已完成） |
| `src/adapters/openai-compat.ts` | 实际发 HTTP 请求的适配器（重点排查） |
| `src/brain-api.ts` | 调用链：handleChatCompletions → 记忆注入 → openai-compat |
| Studio `.env` | `GEMINI_PROXY_KEY` 已写入 |

## 中转服务信息

| 项目 | 值 |
|------|-----|
| 地址 | `http://23.226.135.149:4000/v1` |
| Token | `fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4` |
| 可用模型 | `gemini-2.5-flash`、`gemini-3.1-flash-lite-preview` 等 49 个 |
| 不需要代理 | Studio WiFi 可直连 |
