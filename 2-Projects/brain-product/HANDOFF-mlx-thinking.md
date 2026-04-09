# HANDOFF: MLX Qwen3.5 Thinking 模式修复

**日期**: 2026-04-09
**状态**: 服务端 no-thinking 已验证，brain 端调用仍慢（86-93s），需排查 brain→MLX 的请求差异

## 已完成

- [x] 根因确认：Qwen3.5 全系列默认开启 thinking（官方 chat_template 无默认关闭）
- [x] MLX 版 tokenizer_config.json 的 chat_template 为空（LENGTH: 0），模板内置在 mlx_lm 代码中
- [x] 找到 mlx_lm.server 原生参数：`--chat-template-args '{"enable_thinking":false}'`
- [x] 直接 curl MLX 验证成功：content="二"，reasoning=""，秒回
- [x] 27B 也验证成功：同样参数可关闭 thinking，热状态 TTFT ~3.5s
- [x] Studio Xcode CLT 已修复（`sudo xcode-select -switch /Library/Developer/CommandLineTools`）
- [x] python3 恢复可用
- [x] Studio 上 MLX 必须用模型全路径（HF 名称会卡在网络解析，Studio 有 WiFi 但无代理）
- [x] Admin UI 红点修复：杀掉 Air 残留 node 开发进程，用 ?logout 重登

## 核心阻塞

**直接 curl MLX 秒回，但通过 brain 调 86-93 秒。**

### 假设分析

1. **brain 的 system prompt 注入**：brain 模式会注入大量 system prompt（记忆、人格、上下文），导致 input token 数远超直接 curl 的 20 tokens → 9B 模型处理大 prompt 本身就慢
2. **`--chat-template-args` 可能被请求体覆盖**：mlx_lm.server 代码 `server.py:735-737` 显示请求体的 `chat_template_kwargs` 会 merge 到启动参数上。brain 没发这个字段，但可能发了其他字段干扰
3. **mlx_lm.server 单线程阻塞**：如果有排队请求（brain 的 intake/consolidation cron 也可能调 MLX），会串行等待

### 根因确认

brain-api.ts 第 316 行一次性注入所有内容到一个 system message：
```ts
messages = [{ role: "system", content: systemPrompt + soulSection + stateHint + environmentHint }, ...messages];
```

包含：记忆检索结果 + SOUL.md 身份内核 + 用户状态推断 + 视觉环境描述 + 活跃补丁。对云端大模型（Gemini Flash）没问题，但 9B 本地模型处理大 system prompt 极慢。

### 下一步：分层注入（不是裁剪）

**核心思路：不去掉任何 prompt，而是按模型能力分层注入。**

当前是"一锅炖"——所有上下文塞进一个 system message。应该改为：

1. **建立 prompt 层级**（按重要性排序）：
   - L0（必须）：用户消息本身
   - L1（核心）：SOUL.md 身份内核（定义"我是谁"）
   - L2（记忆）：loadBrainContext 检索到的相关记忆条目
   - L3（状态）：用户状态推断（意图/情绪/专业度）
   - L4（环境）：视觉环境描述、活跃补丁

2. **按模型 token 预算裁切**：
   - 云端模型（Gemini Flash 128K）：L0-L4 全注入
   - 本地 27B（~4K 有效上下文）：L0 + L1 + L2（限 top-3 条目）
   - 本地 9B（~2K 有效上下文）：L0 + L1 + L2（限 top-1 条目）

3. **实现方式**：在 config.ts 的路由配置里加 `promptBudget` 字段（如 `promptBudget: 'minimal' | 'standard' | 'full'`），brain-api.ts 根据 budget 决定注入哪些层级

4. **验证**：加日志打印实际 system prompt 的字符数/token 数，对比不同 budget 下的 TTFT

## 当前 Studio 进程状态

| 服务 | 端口 | PID | 状态 |
|------|------|-----|------|
| brain v0.9.0 | :19080 | 49621 | 在线 |
| MLX 9B (no-thinking) | :8000 | 55463 | 在线（nohup） |
| MLX 27B | :8001 | — | 已杀掉（内存竞争） |

### MLX 9B 启动命令（已验证可用）

```bash
# 通过 Mini 雷电跳板执行
ssh mini-pub 'ssh macstudio "nohup /opt/homebrew/Cellar/python@3.11/3.11.15/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -m mlx_lm.server --model /Users/fu-121/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-MLX-4bit/snapshots/938d8919941c6e7efd3c7150eff7fe9d12afa631 --port 8000 --chat-template-args '"'"'{\"enable_thinking\":false}'"'"' > /tmp/mlx-9b.log 2>&1 &"'
```

### 关键踩坑

- **模型路径必须用全路径**：HF 名称 `mlx-community/Qwen3.5-9B-MLX-4bit` 会卡在 HuggingFace API 解析（Studio 有 WiFi 但无代理，HF 被墙）
- **9B + 27B 不能同时跑**：32GB M2 Max 内存不够，会导致 swap → 响应从秒级退化到 90s+
- **launchd 不能启动 MLX**：Metal GPU 需要 GUI session，launchd daemon 上下文无法访问
- **SSH 路径**：Air → `ssh mini-pub`（公网 FRP）→ `ssh macstudio`（雷电网桥），不要直连 Studio

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/config.ts` | cc-mlx / cc-qwen 路由配置，supportsThinking: false |
| `src/adapters/openai-compat.ts` | 发请求的适配器，第 37 行控制 enable_thinking |
| `src/brain-api.ts` | brain 模式的请求构建，第 370-385 行 |
| `src/server.ts` | 路由分发，第 485-493 行 |
| mlx_lm server.py 第 1977 行 | `--chat-template-args` 参数定义 |
| mlx_lm server.py 第 1229 行 | `chat_template_kwargs` 请求体字段 |

## 可粘贴提示词

```
读 2-Projects/brain-product/HANDOFF-mlx-thinking.md。核心任务：实现 brain prompt 分层注入，让本地 MLX 9B 模型 TTFT < 3s。当前问题：brain-api.ts 第 316 行把所有上下文（记忆+SOUL+状态+环境）一锅炖进一个 system message，对 9B 模型太重（86-93s）。方案：1) 先在 openai-compat.ts 加日志确认实际 prompt token 数；2) 在 config.ts 路由配置加 promptBudget 字段（minimal/standard/full）；3) brain-api.ts 根据 budget 分层注入（L0 用户消息 → L1 SOUL → L2 记忆 top-N → L3 状态 → L4 环境）；4) 部署到 Studio 验证 TTFT。不要去掉任何 prompt 内容，只是按模型能力控制注入量。
```
