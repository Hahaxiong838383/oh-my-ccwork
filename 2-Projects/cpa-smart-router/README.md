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
- 长期 API Key、Management Key 或密码的轮换/撤销必须由用户明确授权；疑似泄露只触发停止扩散与告警，不得自动替换凭据。OAuth access token 的既有自动刷新不受此限制。
- `blocked_models` 用于拦截测试/玩具模型；正式流量不要调用 `fable-5`。
- `gpt-5.3-codex` 是 Codex app 可能发出的模型名，router 将其别名映射到已验证的 `gpt-5.5` 上游候选，避免 CPA mixed 返回 unknown provider。
- xAI 文本路由以 `grok-4.5` 为当前主模型；`grok-3-mini*`、`grok-4.3` 和 `grok-4.20-*` 旧别名统一重写到 `grok-4.5`，图像、视频、Build 与 Composer 专用模型保持原样。
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

## 主机资源保护（2026-08-12）

`aliyun-jp` 是 1 GB 内存的轻量实例。`scripts/cpa-resource-guard.sh` 每 30 秒限制 Aegis 安全扫描 cgroup 的 CPU、内存与磁盘调度优先级，并在 IO 压力或低内存时记录进程级证据。

- 部署单元：`deploy/cpa-resource-guard.service`、`deploy/cpa-resource-guard.timer`。
- 压力日志：`/var/log/cpa-resource-guard.log`，由 `deploy/cpa-resource-guard.logrotate` 控制大小。
- Cloud Assistant 与 CloudMonitor 不受限制，保证主机失联时仍可走控制面恢复和查看指标。
- K12 账号池已于 2026-08-12 退役；生产与代码仓不再保留账号源、历史账号、轮换脚本或定时器。

## Codex OAuth 自动刷新（2026-07-27）

生产 CLIProxyAPI 已开启核心 auth 自动刷新：`auth-auto-refresh-workers: 16`（配置位于 `aliyun-jp:/opt/cliproxy/config.yaml`）。

要点：

- 只有 auth 文件内存在 `refresh_token` 的 Codex OAuth 授权才可自动续期。
- 刷新线程日志应出现 `core auth auto-refresh started (interval=15m0s)`。
- 配置修改后需重启 `cliproxy.service`，并用低成本 `gpt-5.4-mini` / `gpt-5.5` 请求确认仍返回 200。
- 不要把 `access_token`、`refresh_token`、`id_token`、API key 或响应正文写入 git、记忆、通知或 Grok payload。

## Codex Fast 模式（2026-07-28）

- Codex 客户端配置使用 `service_tier = "fast"`，实际 `/v1/responses` 请求应发送 `service_tier: "priority"`。
- CLIProxyAPI 的 Codex 专用模型目录接口是 `GET /v1/models?client_version=<version>`；响应中的 `service_tiers` 与 `additional_speed_tiers` 是客户端是否发送 Fast 意图的能力真源。
- smart-router 转发模型目录和推理请求时必须保留 `r.URL.RawQuery`；丢失 `client_version` 会让 CPA 降级返回普通四字段模型列表，导致本地 catalog 看不到 Fast。
- 受 Git 管理的刷新器维护源是 `scripts/refresh-cc-switch-model-catalog.mjs`；本机 `~/.codex/refresh-cc-switch-model-catalog.mjs` 应指向该文件，由 LaunchAgent 每小时刷新。
- 验收必须分开记录：客户端请求是否携带 `priority`、CPA 是否返回 HTTP 200、上游响应回报的 service tier。当前真实请求已携带 `priority`，但上游流式响应仍回 `auto/default`，不得把“请求已发出”写成“后台加速已确认”。
- 现网 CLIProxyAPI 继续使用 `7.2.58`；Fast 链路不需要为了本次修复直接跨版本升级，升级应另做回归和时间窗。
