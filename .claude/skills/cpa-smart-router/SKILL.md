---
name: cpa-smart-router
description: CPA Smart Router 运维与迭代指南。用于检查、部署、验证阿里云日本服务器上的个人 CPA 调度 sidecar，排查 smart-api.hahaxiong.top、SQLite dashboard、provider 路由、Codex lane 灰度问题。
---

# CPA Smart Router

个人 CPA 的 Go sidecar 调度层，部署在阿里云日本服务器 `aliyun-jp`，负责给 CLIProxyAPI 增加鉴权、provider 候选调度、sticky、熔断、指标记录、SQLite 聚合和简易 dashboard。

## 触发场景

- 用户提到 `CPA`、`smart-router`、`smart-api.hahaxiong.top`、`fable-5`、`gpt-5.5` 调度。
- 用户要测试或部署个人中转 CPA。
- 用户要看 `/debug/state`、`/debug/summary`、`/dashboard`。
- 用户要调整 Codex lane 的 smart-router 灰度比例。

## 关键位置

- 本地代码：`/Users/rayman.chen/mycc/2-Projects/cpa-smart-router`
- 远端部署：`aliyun-jp:/opt/cpa-smart-router`
- systemd：`cpa-smart-router.service`
- 本地监听：`127.0.0.1:8327`
- 公网入口：`https://smart-api.hahaxiong.top/v1`
- CPA Direct：`https://api-direct.hahaxiong.top/v1`
- 远端 SQLite：`/opt/cpa-smart-router/router.sqlite`
- 远端 JSONL：`/opt/cpa-smart-router/router-metrics.jsonl`
- Codex lane：`/Users/rayman.chen/mycc/4-Assets/Prompt/omp-team-templates/_codex_lane.sh`
- CLIProxyAPI：`aliyun-jp:/opt/cliproxy`，auth-dir `/root/.cli-proxy-api`
- K12 池运维文档：`2-Projects/cpa-smart-router/docs/k12-auth-pool-ops.md`

## K12 账号池（2026-07-14）

- 源包 80500 个 sub2 k12 **全部无 refresh_token**，不能 OAuth 续期。
- 生产保活：`k12-health-rotate.py` = 验活 → 删死号 → 从 `/opt/cliproxy/k12-pool` 补到目标（默认 25）。
- 定时器：`cpa-k12-health.timer` 每 30 分钟；报告 `/opt/cliproxy/k12-state/last-report.json`。
- k12 文件前缀：`zz-test-k12-*.json`；正式 Team/xAI 不要删。
- 2026-07-14 筛后：约 **33 个活 k12** + Team + xAI。
- k12 可用模型：`gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini`；`gpt-5.3-codex`/`gpt-5.2` 在 CPA 未注册路由；`gpt-5.6-*` 走 Team。
- 手动：`ssh aliyun-jp 'python3 /opt/cliproxy/scripts/k12-health-rotate.py --target 25'`
- 禁止输出/提交 token 与账号文件。

## 安全边界

- 不输出 `CPA_SMART_ROUTER_KEY`、`CPA_API_KEY`、`CODEX_API_SMART_KEY` 的明文。
- 不提交 `~/.gateway.env`、`/etc/cpa-smart-router.env` 或任何 secret。
- 提交前避开无关运行态文件，例如 `.claude/skills/mycc/current.json`。
- 公网接口必须带鉴权；dashboard 支持 Bearer，也支持 Basic Auth，密码填同一个 key。
- 正式客户端可继续使用个人 `CPA_API_KEY`；smart-router 通过 `client_api_key_envs` 兼容该 key，同时可保留 `CPA_SMART_ROUTER_KEY` 作为管理备用 key。

## 常用验证

```bash
source ~/.gateway.env

curl -sS https://smart-api.hahaxiong.top/debug/state \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"

curl -sS https://smart-api.hahaxiong.top/debug/summary \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY" | python3 -m json.tool

curl -I https://smart-api.hahaxiong.top/dashboard \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
```

## Codex App 图片输入排障

如果 Codex app 使用 smart-router 的 `gpt-5.5` 时提示“不支持图片输入”，优先检查本地模型 catalog，而不是先怀疑 smart-router：

- Codex app 读取 `~/.codex/cc-switch-model-catalog.json` 判断模型输入模态。
- `gpt-5.5` 必须包含 `input_modalities: ["text", "image"]`。
- `~/.codex/refresh-cc-switch-model-catalog.mjs` 会通过 LaunchAgent 每小时刷新 catalog；持久修复要改刷新脚本，不能只手改 JSON。
- API 层验证可直接向 `https://smart-api.hahaxiong.top/v1/responses` 发送带 `input_image` 的 `gpt-5.5` 请求；若返回 200，说明 CPA/smart-router 实际支持图片，问题在 Codex app catalog。

## 构建部署

```bash
cd /Users/rayman.chen/mycc/2-Projects/cpa-smart-router
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /tmp/cpa-smart-router ./cmd/router

scp -q /tmp/cpa-smart-router aliyun-jp:/tmp/cpa-smart-router
ssh aliyun-jp 'install -m 755 /tmp/cpa-smart-router /opt/cpa-smart-router/cpa-smart-router && rm -f /tmp/cpa-smart-router && systemctl restart cpa-smart-router && sleep 2 && systemctl is-active cpa-smart-router'
```

## 当前实现状态

- 已验证 CPA `openai-compatibility.prefix` 能区分候选 provider：`ccsub2/...`、`gw1052/...`。
- 已支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`。
- 已支持鉴权、请求体上限、sticky、最多 2 次重试、被动 EWMA、熔断 cooldown。
- 已支持 JSONL 指标、SQLite 持久聚合、`/debug/summary`、`/dashboard` 和 provider 调度解释。
- 已支持 `/v1/responses` state probe 观测：`previous_response_id`、`store`、`stream`、response id 捕获率、parent/provider mismatch 和错误采样；当前只观测，不启用 strict response-chain sticky。
- 正式使用默认优先走 `gpt-5.5`；`fable-5` 只是测试玩具模型，生产配置应放入 `blocked_models`，不要调用。
- `/v1/chat/completions` 流式响应会注入 `stream_options.include_usage=true` 并解析 SSE usage；若上游不返回 usage，token 仍会是 0。

## 提交前检查

```bash
cd /Users/rayman.chen/mycc
git status --short
rg -n 'sk-[A-Za-z0-9_-]{12,}|CPA_SMART_ROUTER_KEY=.*[A-Za-z0-9_-]{12,}|CPA_API_KEY=.*[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9._-]{12,}' \
  2-Projects/cpa-smart-router 4-Assets/Prompt/omp-team-templates/_codex_lane.sh .claude/skills/cpa-smart-router || true
```
