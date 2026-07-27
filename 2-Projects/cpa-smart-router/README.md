# CPA Smart Router

CPA Smart Router 是部署在 `aliyun-jp` 的 CLIProxyAPI 旁路调度层：客户端先打本服务，本服务按候选上游的健康度、延迟、错误率、用量与 sticky 状态选择 CPA 的 prefixed model 或混合入口。

## 当前状态

- M-1：已验证 CPA `openai-compatibility.prefix` 可固定命中候选上游。
- M0/M1：Go 单二进制 MVP，支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models` 转发、鉴权、sticky、熔断、异步 JSONL 指标。
- M2：支持 CST 日用量重置与鉴权状态查看 `/debug/state`。
- M3：支持 SQLite 持久聚合、`/debug/summary` 与简易 `/dashboard`。

## 运行

```bash
go run ./cmd/router -config config/router.example.json
```

配置里的 secret 推荐用环境变量：

- `CPA_SMART_ROUTER_KEY`：客户端访问 smart-router 的 key
- `CPA_API_KEY`：smart-router 访问本机 CPA 的 key
- `client_api_key_envs` 可加入 `CPA_API_KEY`，让客户端继续用个人 CPA key 访问 smart-router。

## 安全规则

- 公网入口必须校验 `Authorization: Bearer <CPA_SMART_ROUTER_KEY>`。
- 后端 CPA key 只在服务端注入，不透传客户端 key。
- `blocked_models` 用于拦截测试/玩具模型；正式流量不要调用 `fable-5`。
- `gpt-5.3-codex` 是 Codex app 可能发出的模型名，router 将其别名映射到已验证的 `gpt-5.5` 上游候选，避免 CPA mixed 返回 unknown provider。
- 流式响应开始输出后不做 failover。
- `/v1/chat/completions` 流式请求会自动注入 `stream_options.include_usage=true` 并解析 SSE usage，用于 dashboard 和调度用量统计。
- `/v1/responses` 强制 sticky，避免 `previous_response_id` 断链。
- `/v1/responses` 当前先启用 state probe 观测，不改变路由；M1 门控看 `previous_response_id` 占比和 response id 捕获率。

## 灰度接入

`4-Assets/Prompt/omp-team-templates/_codex_lane.sh` 支持以下开关：

- `CODEX_API_SMART_BASE_URL`：smart-router base URL。
- `CODEX_API_SMART_KEY`：smart-router 客户端 key。
- `CODEX_SMART_CANARY_PERCENT`：0-100，命中时先试 smart-router，失败自动回原网关链。

## 观察

```bash
curl https://smart-api.hahaxiong.top/debug/state \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
curl https://smart-api.hahaxiong.top/debug/summary \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
ssh aliyun-jp 'tail -n 20 /opt/cpa-smart-router/router-metrics.jsonl'
```

## Dashboard

- `/dashboard`：简易 HTML 聚合页，支持 `Authorization: Bearer <key>`；浏览器可用 Basic Auth，密码填同一个 key。
- `/debug/summary?hours=24`：JSON 聚合，字段包含总量、调度解释、按 provider、按 model、最近错误。
- `Responses State Probe`：观测 `previous_response_id`、`store`、`stream`、response id 捕获率、provider mismatch 和错误样本；只观测不强制 sticky。
- `sqlite_path` 为空时禁用 SQLite 聚合；生产建议写到 `/opt/cpa-smart-router/router.sqlite`。
- JSONL 指标仍保留，SQLite 写入走后台 channel，不阻塞流式转发路径。

## K12 账号池（2026-07-14）

CLIProxyAPI 侧可混入 k12 codex auth 文件作为补充算力。完整运维见 [`docs/k12-auth-pool-ops.md`](./docs/k12-auth-pool-ops.md)；踩坑见 [`docs/k12-lessons-learned-2026-07-14.md`](./docs/k12-lessons-learned-2026-07-14.md)。

要点：

- 源包 **无 refresh_token**，保活 = 验活剔除 + 备用池补号。
- 脚本：`scripts/k12-health-rotate.py`（生产：`aliyun-jp:/opt/cliproxy/scripts/`）。
- 定时：`deploy/cpa-k12-health.timer` 每 30 分钟。
- k12 实际好用模型：`gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini`。
- **禁止**把账号 token 提交进 git。

## Codex OAuth 自动刷新（2026-07-27）

生产 CLIProxyAPI 已开启核心 auth 自动刷新：`auth-auto-refresh-workers: 16`（配置位于 `aliyun-jp:/opt/cliproxy/config.yaml`）。

要点：

- 只有 auth 文件内存在 `refresh_token` 的 Codex OAuth 授权才可自动续期；无 `refresh_token` 的 K12 源包不能靠此机制续期。
- 刷新线程日志应出现 `core auth auto-refresh started (interval=15m0s)`。
- 配置修改后需重启 `cliproxy.service`，并用低成本 `gpt-5.4-mini` / `gpt-5.5` 请求确认仍返回 200。
- 不要把 `access_token`、`refresh_token`、`id_token`、API key 或响应正文写入 git、记忆、通知或 Grok payload。
