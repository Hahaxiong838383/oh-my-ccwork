# Hermes Quicksilver → wechat-grok-bridge 加速笔记

> 源：[NousResearch/hermes-agent v0.19.0 Quicksilver](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20)  
> 日期：2026-07-22

## Hermes 水银版速度脊骨（可迁移原则）

1. **TTFT 优先**：冷启动探测/能力检查移出关键路径；阻塞探针做磁盘缓存或后台刷新  
2. **Gateway 级 agent cache**：复用会话内 AIAgent，避免每条消息重建客户端/工具表  
3. **Skill discovery 缓存**：按 scan signature 失效，不每次扫盘  
4. **Prompt 字节稳定**：系统提示固定前缀，保住 provider prompt cache  
5. **感知延迟**：首条反馈/流式 thinking 立刻可见，别让用户干等 spinner  
6. **工具批并发**：可并行工具分段，不串死  
7. **交付账本**：生成结果先落盘再投递，崩溃可重投

## 本机实测根因

`~/.grok/logs/unified.jsonl` 多条：

```
mcp_wait_ms ≈ 29890–29897
total_prep_ms ≈ 30s
tool_count = 28
```

每轮 headless `grok -p` 启动都会等 **wechat-bot MCP 超时 30s**，再进模型。  
微信收发已由 `bridge.mjs` 完成，该 MCP 对通道主路径无必要。

## 已落地改动

| 项 | 动作 | 是否需重启 bridge |
|----|------|-------------------|
| MCP wechat-bot | `~/.grok/config.toml` `enabled=false`，timeout 3s | **否**（下条 grok 即生效） |
| 进度首报 | `WX_STATUS_FIRST_SEC` 60→12，心跳 120→90 | 是（读 env） |
| 早期回执 | 附件先「下载中…」再下；文本即时「执行中…」 | 是 |
| 预热 | 桥启动 `GROK_PREWARM=1` 后台极轻 headless | 是 |
| **常驻 leader** | `GROK_LEADER=1` → `grok agent leader` + headless `--leader-socket` | **是** |
| **worker 池** | `GROK_WORKER_POOL_SIZE=2` 有界并发（替代全串行） | **是** |
| **流式气泡** | `WX_STREAM=1` → `streaming-json` 节流追加；定稿补后缀+附件 | **是** |
| 文档 | 本文件 | — |

## 预期收益

- **硬延迟**：去掉 ~30s MCP 空等 → 首轮工具准备从 ~30s 掉到亚秒～数秒级（其余仍取决于模型 TTFT）  
- **软延迟**：12s 内有【进度】；附件下载前已有回执  
- **预热**：进程/鉴权热路径更稳  
- **leader**：共享后端热路径；client 仍 `grok -p` 但挂 socket，auth/模型侧更稳  
- **worker 池**：多会话/连发可并行（默认 2），不再全局卡死  
- **流式气泡**：模型一吐字就节流推微信（【进行中】），结束只补未发后缀与 `[[send-file]]`

## 开关（.env）

```
GROK_LEADER=1
GROK_WORKER_POOL_SIZE=2
WX_STREAM=1
WX_STREAM_INTERVAL_MS=1800
WX_STREAM_MIN_CHARS=48
```

`ping` / `健康` 会回 `pool=` `leader=` `stream=` 便于验收。

## 未做 / 后续（Hermes 级，成本更高）

- 真·ACP 长连接 worker（`grok agent stdio` 多会话复用，无每轮 spawn client）  
- rules/system prompt 内容哈希稳定化 + 实验性 prompt_cache_key  
- skills 分层：设计类 skill 仅项目目录按需挂载，减冷启动扫盘  
- iLink 若将来支持改消息：可升级为单气泡原地增长

## 验证

```bash
# 应接近 0
grep mcp_wait_ms ~/.grok/logs/unified.jsonl | tail -5

# 冷启动
time grok -p 'Reply with exactly: pong' --max-turns 1 --always-approve \
  --permission-mode bypassPermissions --output-format plain --cwd /tmp --no-memory
```

改完 bridge 后：**需川哥 SSH `systemctl --user restart wechat-grok-bridge`**（Agent 禁止自重启通道）。  
`config.toml` MCP 关闭无需重启 bridge。
