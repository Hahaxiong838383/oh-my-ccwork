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

## 安全规则

- 公网入口必须校验 `Authorization: Bearer <CPA_SMART_ROUTER_KEY>`。
- 后端 CPA key 只在服务端注入，不透传客户端 key。
- `blocked_models` 用于拦截测试/玩具模型；正式流量不要调用 `fable-5`。
- 流式响应开始输出后不做 failover。
- `/v1/responses` 强制 sticky，避免 `previous_response_id` 断链。

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
- `/debug/summary?hours=24`：JSON 聚合，字段包含总量、按 provider、按 model、最近错误。
- `sqlite_path` 为空时禁用 SQLite 聚合；生产建议写到 `/opt/cpa-smart-router/router.sqlite`。
- JSONL 指标仍保留，SQLite 写入走后台 channel，不阻塞流式转发路径。
