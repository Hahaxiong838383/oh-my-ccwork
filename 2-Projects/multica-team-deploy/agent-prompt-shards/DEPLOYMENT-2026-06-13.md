# Prompt Shards Live Deployment · 2026-06-13

## 范围

- 更新 live agent instructions:
  - 爱马仕grok 接待员（快速）`a56c3666-8f04-4204-8697-d8b928807a7a`
  - 爱马仕grok（4.3）主调度员 `f7b19bfb-e53a-4ea1-a415-127c593287e8`
  - Gemma 4 E4B (Studio) `9c78bbda-0cb3-4a24-bfea-d02268728680`
- 更新 live skill content:
  - 飞书代理操作-zh `54d94775-5dda-4024-afd7-9c950ebb2f91`
  - theory-radar `6b8ca900-ba60-4d68-aaa5-f7f161af2fac`

## 备份

- mini 备份目录：`~/multica-agent-backups/20260613-150051`

## 验收

| 验收项 | 结果 |
|---|---|
| live marker 校验 | ✅ 5/5 均包含 `Prompt Shard Kernel` |
| Claude 专属残留 | ✅ 未发现 `{antml:`, `The assistant is Claude`, `/mnt/user-data` |
| Gemma smoke issue | ✅ `FUT-115` 已完成，无 Claude 身份污染、无工具幻觉 |
| Grok 快速 smoke issue | ✅ `FUT-116` 已完成，判别简洁档、自己直答、未派子 issue |

## 已知小瑕疵

- Gemma 对“20字以内”的长度约束略松，但遵守了轻量内核的核心边界。后续如要更硬，可在 Gemma shard 加“硬长度优先级高于自然表达”。

## 复验命令

```bash
./agent-prompt-shards/validate-shards.sh
./agent-prompt-shards/validate-live-shards.sh
```

