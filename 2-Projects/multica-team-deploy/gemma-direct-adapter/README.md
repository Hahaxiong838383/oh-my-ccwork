# gemma-direct — multica direct-Ollama 加速 adapter

> 把 multica + opencode 跑 Gemma 4 E4B 从 **11 分钟 → 20-32 秒**（20-33x 提速），通过跳过 agent multi-turn loop 直接调 Ollama。

## 问题

multica 派 task 给 Gemma 4 E4B (Studio) agent 时，走 `opencode build` 真 agent：
- system prompt ~4000+ tokens（含 tools 定义 + 编程人设）
- Gemma 4 E4B prefill rate 43 tok/s → 单次 LLM call prefill 90+ 秒
- agent multi-turn loop 3-4 次 LLM call → **总 11 分 5 秒**（FUT-20 实测）
- 输出还被 "AI 编程助手" 人设污染

## 方案

**跳过 opencode agent loop**，用一个轻量 Python adapter 模拟 opencode CLI 接口，内部直接调 Ollama 一次拿结果：

```
multica daemon
  └─ spawn /Users/rayman.chen/bin/opencode-gemma-direct (shell wrapper)
       └─ python3 gemma-direct.py [opencode args] <PROMPT>
            ├─ 从 PROMPT 提取 issue UUID
            ├─ multica issue get → 拿真实 description (跳过 multica 长系统 prompt)
            ├─ 构造简洁 user prompt: "请完成任务,直接给结果...\n标题: X\n详情: Y"
            ├─ 流式调 Ollama (stream=true, TTFB 快)
            └─ stream-json 输出 opencode 协议格式 (step_start + 单一 text event)
```

**关键设计**：multica daemon 通过环境变量 `MULTICA_OPENCODE_PATH` 把 opencode runtime 重定向到本 adapter，**不动 npm 装的真 opencode**（保留可回退）。

## 实测对比

| 任务 | 旧 (opencode + 真 build agent) | **新 (gemma-direct)** | 提速 |
|------|------|------|------|
| 300 字飞书周报 (FUT-20 vs FUT-32/33) | 11m 5s | **20-32s** | **20-33x** |
| 200 字技术介绍 (FUT-29) | — | 26s | — |
| 一句中文自我介绍 | 100s (opencode) | <2s (直调 Ollama) | 50x |

输出**质量更好**（不再被编程人设污染，3 段结构完整 + emoji + markdown 占位符）。

## 文件清单

| 文件 | 部署到 mini | 作用 |
|------|------------|------|
| `gemma-direct.py` | `~/bin/gemma-direct.py` | 主 adapter Python 脚本 (172 行) |
| `opencode-gemma-direct.sh` | `~/bin/opencode-gemma-direct` | shell wrapper，让 multica daemon 调 |
| `com.multica.daemon.plist` | `~/Library/LaunchAgents/com.multica.daemon.plist` | multica daemon launchd 自启 (含 `MULTICA_OPENCODE_PATH` 环境变量) |

## 部署

```bash
# 1. 装 fake adapter
scp gemma-direct.py mini:~/bin/
scp opencode-gemma-direct.sh mini:~/bin/opencode-gemma-direct
ssh mini 'chmod +x ~/bin/gemma-direct.py ~/bin/opencode-gemma-direct'

# 2. 装 multica daemon launchd plist
scp com.multica.daemon.plist mini:~/Library/LaunchAgents/

# 3. 停手动 daemon + load launchd
ssh mini 'multica daemon stop 2>/dev/null; \
  launchctl bootout gui/$(id -u)/com.multica.daemon 2>/dev/null; \
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.multica.daemon.plist'

# 4. 验证 daemon 跑起来 + runtime online
ssh mini 'launchctl list | grep multica.daemon; multica runtime list | head'
```

## 依赖（已在 mini 上）

- Python 3.9+（系统自带）
- multica CLI in `~/bin/multica`（multica daemon 同款）
- Ollama 通过 `127.0.0.1:11434` 可达（mini → studio SSH tunnel `com.cc.studio-ollama-tunnel`）
- Studio 上 Ollama 跑 `gemma4:e4b-it-q4_K_M`，建议 keep_alive 1h 防 model swap

## 回退（如果出问题）

把 `MULTICA_OPENCODE_PATH` env var 从 plist 移除 → multica daemon spawn 真 opencode (`~/.nvm/.../bin/opencode`)。

```bash
# 直接编辑 plist 删 MULTICA_OPENCODE_PATH key + bootout/bootstrap 重启 daemon
```

## 已知坑

| 坑 | 修法 |
|----|------|
| argparse 把 prompt 内 `--output/--recent/--before-id` 子串当成 flag 吃掉 | `sys.argv[-1]` 直接拿 prompt (skip argparse) |
| streaming 中间多次 emit text event 累积 full_text → comment 巨大 (624KB)  | 只在 stream 完成后 emit 一次最终 text event (multica daemon 把每个 event 当独立 message) |
| fake adapter 自己 `multica issue comment add` + multica daemon 自动从 stream 提取写 → comment 重复 | fake adapter 不写 comment，让 daemon 自动处理 |
| multica daemon detect agent version 时把 stream-json 全部输出当成 version string | 无害，daemon 仍正确注册 runtime |

## 适用边界

**适合**:
- 简单中文生成（周报 / 摘要 / 翻译 / 邮件）
- 任务描述清晰、无需 multi-step 推理
- 不需要 agent tool 调用（grep/bash/edit）

**不适合**:
- 需要 multi-tool agent loop 的复杂 coding 任务（用 claude/codex 真 agent）
- 任务 description 含 placeholder 需要扩展 / 探索的（agent 比 single-shot 强）
- 用户在 web 上需要看 streaming 体感（当前实现是 batch 收完再 emit）

## 后续优化（未做）

- [ ] 真 streaming 体感（fake adapter emit delta 而非累积 full_text，但 multica daemon 似乎不支持 — 待调研协议）
- [ ] 失败重试（当前 Ollama 一次失败就报错）
- [ ] 多模型路由（issue.metadata 指定不同 model）
