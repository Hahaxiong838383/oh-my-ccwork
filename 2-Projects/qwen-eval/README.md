# qwen-eval（Qwen 模型评测）

> 状态：待川哥确认（目录仅有一份磁盘清理交接文档，无评测代码/数据/结论，无法判断 active/paused/done）
> 最后活跃日期：2025-04-02（HANDOFF-disk-cleanup.md 的修改日期；目录本身 2025-04-26 后无新增）
> 一句话目标：待川哥确认（推测为在 Studio 上跑 Qwen 系列模型的本地评测/对比，但当前目录无任何评测产物佐证）

## 下一步
- [ ] 川哥确认本项目的真实目标与状态（是否还在做、做到哪一步）
- [ ] 确认评测的实际产物（脚本/数据/结论）现在放在哪——当前目录里没有，可能在 Studio 本机或别处
- [ ] 若已完结，移至 5-Archive/；若暂停，状态改 paused 并补一句话上下文

## 归档条件
- 评测已出结论且无后续，或川哥确认放弃 → 移至 `5-Archive/`
- 当前无法判断，暂留 2-Projects/ 等川哥校准

## 当前事实
- 目录 `/Users/rayman.chen/mycc/2-Projects/qwen-eval/` 下仅 1 个文件：`HANDOFF-disk-cleanup.md`（2438 字节，2025-04-02）。【已验证】
- 该 HANDOFF 文件主题是 **Studio 机器磁盘清理交接**，不是评测本身的记录。【已验证】
- 文件中与「评测/模型」相关的线索：【已验证，均出自 HANDOFF 原文】
  - Studio（fu-121@10.9.1.155）上 `~/.ollama/models/` 有 5 个模型：qwen2.5、qwen3、minicpm-v、moondream、qwen3-embedding，共 34GB。
  - 「不能删」清单里有 `~/.cache/huggingface/`（15GB），标注为「当前在用的 Qwen3.5-27B-4bit 模型」，并提到 `/opt/homebrew` 里装了 Python 3.11 + MLX。
- 由上述线索**推断**（非已验证）：本项目可能涉及在 Studio（M2 Max）用 Ollama / MLX 跑 Qwen 系列模型做本地推理或评测。具体评测内容、指标、结论在本目录内**无任何记录**。
- 无独立 GitHub repo（mycc 单仓子目录）。【已验证：本任务前提】

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| 磁盘清理交接 | `/Users/rayman.chen/mycc/2-Projects/qwen-eval/HANDOFF-disk-cleanup.md` | 目录内唯一文件；含 Studio SSH + 可清理清单（与评测仅间接相关） |
| Studio 模型目录 | `fu-121@10.9.1.155:~/.ollama/models/` | Ollama 模型（含 qwen2.5/qwen3/qwen3-embedding 等），34GB |
| Studio HF 缓存 | `fu-121@10.9.1.155:~/.cache/huggingface/` | 在用的 Qwen3.5-27B-4bit 模型，15GB |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无（mycc 单仓子目录） |
| 服务地址 | Studio：`10.9.1.155`（SSH 用户 fu-121；密码见 HANDOFF 原文，建议改用密钥并从文档移除） |
| 端口 | 未知（目录内无服务/端口记录） |
| 负责人 | 川哥 |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
