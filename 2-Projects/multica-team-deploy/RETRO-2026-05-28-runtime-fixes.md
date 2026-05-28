# RETRO 2026-05-28 — multica runtime 三连修

> 上线前内测准备阶段，三个 multica runtime（hermes / codex / opencode-gemma）相继暴露环境问题，单 session 一气修通。

## 时间线

| 时刻 | 事件 | 状态 |
|------|------|------|
| ~05:13 UTC | FUT-31/32/33 fake adapter 飞书周报实测 11m → 20-32s（20-33x 提速）落定 | ✅ gemma-direct adapter v2.2 上线 |
| ~05:20 UTC | 川哥：hermes runtime 报错 | 🔍 排查 |
| ~05:28 UTC | hermes 修复（mini → api.x.ai 公网被墙，daemon plist 加 xray proxy） | ✅ FUT-34 26s 完成 |
| ~06:32 UTC | 川哥：codex runtime 报错 | 🔍 排查 |
| ~06:40 UTC | codex 修复（删 `~/.codex/config.toml` 末尾遗留 ollama provider block） | ✅ FUT-35 90s 完成 |

## 修复 1：hermes runtime — xAI 公网阻塞

**症状**:
```
hermes provider error: Codex stream produced no bytes within 12s (TTFB threshold: 12s)
base_url=https://api.x.ai/v1 model=grok-4.20-0309-non-reasoning
```
错误信息里 "Codex stream" 是 hermes 内部 stream 抽象命名，跟 OpenAI Codex 无关，**容易误导**。

**根因**: mini → `api.x.ai` 公网完全不通（`curl -m 30` 直接 timeout）。hermes-agent CLI 默认无 proxy 配置，3 次 retry 全死。

**修法**: `~/Library/LaunchAgents/com.multica.daemon.plist` 的 `EnvironmentVariables` 加 4 个 env，走 xray mixed inbound（127.0.0.1:10808 同端口兼 SOCKS5 + HTTP CONNECT）：

```xml
<key>HTTPS_PROXY</key><string>http://127.0.0.1:10808</string>
<key>HTTP_PROXY</key><string>http://127.0.0.1:10808</string>
<key>ALL_PROXY</key><string>http://127.0.0.1:10808</string>
<key>NO_PROXY</key><string>localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8</string>
```

NO_PROXY 兜住 127.0.0.1（Ollama tunnel + gemma-direct adapter）+ 内网网段，**不影响本地服务**。

`launchctl bootout` + `bootstrap` 重载，5 runtime 全 online。

**验证**:
- 直 curl xAI：proxy 前 30s timeout / proxy 后 786ms HTTP 401（鉴权预期）
- hermes chat -q 测试：proxy 前死 36s 3 retry / proxy 后 "你好！" 秒回
- multica FUT-34（爱马仕测试grok）：26s 完成，0 retry，comment+状态推进齐全

## 修复 2：codex runtime — wire_api="chat" 弃用

**症状**:
```
codex thread/start failed: thread/start: failed to load configuration:
...codex-home/config.toml:66:12: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

**根因**: 5-28 我配 Gemma 4 E4B 走 Studio Ollama 时，往 `~/.codex/config.toml` 末尾加了 `[model_providers.ollama]` block 用了 `wire_api = "chat"`。新版 codex CLI（multica 0.3.9 内嵌的版本）不再支持 chat。multica codex runtime 把**整个 `~/.codex/`** 复制到每个 task workdir 的 `codex-home/`，所以这一行坏 → 整个 config 解析失败 → 所有 codex task `thread/start failed` 拒启动（**不是只挂用到 ollama 的 task**，是 codex 进程整个起不来）。

**修法**:
- Ollama 服务端只支持 OpenAI Chat Completions API，**改 `wire_api = "responses"` 也跑不通**（Ollama 没有 Responses API）
- gemma-direct adapter 已经接管 Gemma 调用（走 opencode runtime），这个 ollama provider block **已弃用**
- 直接删整段（备份后 53 → 46 行），只保留 `[model_providers.custom]` 的 `wire_api = "responses"`

**验证**:
- `grep wire_api ~/.codex/config.toml` 只剩 `responses` 一处
- multica FUT-35（CodexBot 派 gpt-5.5）：90s 完成，0 error，正常读 issue + 回 comment + 改状态

## 经验沉淀（已落 cc memory）

1. **`feedback_multica_hermes_xai_proxy_required.md`** — multica hermes runtime 调境外 LLM provider 必须走 proxy，daemon plist 加 4 个 env 是固化点。`api.x.ai` 直连在墙内必挂。错误信息 "Codex stream" 跟 OpenAI Codex 无关，先 grep `base_url=` 锁定真正 provider。

2. **`feedback_codex_wire_api_chat_deprecated.md`** — 新版 codex 不再支持 `wire_api = "chat"`。Ollama 是 OpenAI Chat API 兼容（没有 Responses API），不能直接当 codex provider 用，要走 [feedback_multica_direct_ollama_adapter_pattern](https://...) 范式（opencode runtime + gemma-direct.py fake adapter）。multica codex runtime 把 `~/.codex/` 整套复制到 workdir，**主 config 一处错全 codex task 挂**。

3. **本次 session 范式**：所有 multica runtime 错误的排查顺序：
   - `multica agent tasks <agent-id> --output json` → 看 `error` 字段
   - `~/.<provider>/logs/errors.log`（hermes）/ stderr（codex）→ 锁定 endpoint 和真实根因
   - `curl -m 30 <endpoint>` 验证公网连通性
   - 修源（plist env / config.toml）→ `bootout`+`bootstrap` 重载 → 派测试 issue 验证

## 关联

- 前置成果：[gemma-direct-adapter](./gemma-direct-adapter/) — opencode runtime hijack 跑 Gemma 4 E4B（11m → 20-32s）
- 项目主线：[ONBOARDING.md](./ONBOARDING.md) / [ARCHITECTURE.md](./ARCHITECTURE.md)
- 上次 retro：[RETRO-2026-05-27.md](./RETRO-2026-05-27.md)
- 阻塞项：[ISSUES-TRIAGE-2026-05-27.md](./ISSUES-TRIAGE-2026-05-27.md)（邮件邀请 P0-A + issue 隔离 P0-B 仍未启动）
