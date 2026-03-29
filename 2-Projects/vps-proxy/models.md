# 可用模型列表与价格

> 截至 2026-03-29，通过代理可用的 49 个模型。

## 文本对话模型

| 模型 | 输入 $/1M tokens | 输出 $/1M tokens | 免费额度 | 推荐场景 |
|------|-----------------|-----------------|---------|---------|
| `gemini-2.5-flash` ⭐ | $0.30 | $2.50 | 有 | **默认推荐，性价比最高** |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | 有 | 极致省钱，简单任务 |
| `gemini-2.0-flash` | $0.10 | $0.40 | 有 | 快速响应，日常对话 |
| `gemini-2.0-flash-001` | $0.10 | $0.40 | 有 | 2.0 固定版本 |
| `gemini-2.0-flash-lite` | $0.10 | $0.40 | 有 | 最轻量 |
| `gemini-2.0-flash-lite-001` | $0.10 | $0.40 | 有 | lite 固定版本 |
| `gemini-3-flash-preview` | $0.50 | $3.00 | 有 | 新一代 Flash |
| `gemini-3.1-flash-lite-preview` | $0.25 | $1.50 | 有 | 3.1 轻量版 |
| `gemini-2.5-pro` | $1.25 / $2.50 | $10.00 / $15.00 | 有 | 复杂推理，长上下文 |
| `gemini-3-pro-preview` | ~$2.00 | ~$12.00 | 有限 | 旗舰预览 |
| `gemini-3.1-pro-preview` | $2.00 / $4.00 | $12.00 / $18.00 | 无 | 最强（纯付费） |

> Pro 系列分两档价格：`≤200K context` / `>200K context`
> Gemini 2.5 Pro 有内部思考 token，建议 `max_tokens` 设 2000+

## 开源模型（Gemma 系列，通过 API 调用免费）

| 模型 | 参数量 | 说明 |
|------|--------|------|
| `gemma-3-1b-it` | 1B | 超轻量 |
| `gemma-3-4b-it` | 4B | 轻量 |
| `gemma-3-12b-it` | 12B | 中等 |
| `gemma-3-27b-it` | 27B | 最大 |
| `gemma-3n-e2b-it` | 2B | 端侧优化 |
| `gemma-3n-e4b-it` | 4B | 端侧优化 |

## 多媒体模型

| 模型 | 用途 | 价格 |
|------|------|------|
| `gemini-2.5-flash-image` | 图片理解 + 生成 | 与 flash 同价 |
| `gemini-3-pro-image-preview` | 高质量图片理解 | 与 pro 同价 |
| `gemini-3.1-flash-image-preview` | 3.1 图片理解 | 预览中 |
| `imagen-4.0-generate-001` | 图片生成 | ~$0.04/张 |
| `imagen-4.0-fast-generate-001` | 快速图片生成 | ~$0.02/张 |
| `imagen-4.0-ultra-generate-001` | 高质量图片 | ~$0.06/张 |
| `veo-2.0-generate-001` | 视频生成 | ~$0.15-0.25/秒 |
| `veo-3.0-generate-001` | 视频生成 (新) | ~$0.25-0.40/秒 |
| `veo-3.0-fast-generate-001` | 快速视频生成 | ~$0.15-0.25/秒 |
| `veo-3.1-generate-preview` | 最新视频预览 | 预览中 |
| `veo-3.1-fast-generate-preview` | 快速视频预览 | 预览中 |

## 音频模型

| 模型 | 用途 |
|------|------|
| `gemini-2.5-flash-preview-tts` | 文字转语音 |
| `gemini-2.5-pro-preview-tts` | 高质量 TTS |
| `gemini-2.5-flash-native-audio-latest` | 原生音频理解 |
| `gemini-3.1-flash-live-preview` | 实时音频对话 |
| `lyria-3-clip-preview` | 音乐片段生成 |
| `lyria-3-pro-preview` | 专业音乐生成 |
| `lyria-realtime-exp` | 实时音乐 |

## 特殊模型

| 模型 | 用途 |
|------|------|
| `gemini-embedding-001` | 文本向量化（$0.15/1M tokens） |
| `gemini-embedding-2-preview` | 新一代 Embedding |
| `gemini-2.5-computer-use-preview` | 电脑操控 Agent |
| `deep-research-pro-preview` | 深度研究 |
| `gemini-robotics-er-1.5-preview` | 机器人控制 |
| `aqa` | 问答质量评估 |
| `nano-banana-pro-preview` | 实验模型 |

## 成本估算参考

| 场景 | 推荐模型 | 100 万 token ≈ |
|------|---------|----------------|
| Agent 日常对话 | gemini-2.5-flash | ¥20 |
| 批量跑数据 | gemini-2.5-flash-lite | ¥3.5 |
| 复杂推理/代码 | gemini-2.5-pro | ¥80 |
| 最强旗舰 | gemini-3.1-pro-preview | ¥100+ |

> 价格来源：[Google AI 官方定价](https://ai.google.dev/gemini-api/docs/pricing)（2026-03）
