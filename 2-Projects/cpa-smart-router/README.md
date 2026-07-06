# CPA Smart Router

CPA Smart Router 是部署在 `aliyun-jp` 的 CLIProxyAPI 旁路调度层：客户端先打本服务，本服务按候选上游的健康度、延迟、错误率、用量与 sticky 状态选择 CPA 的 prefixed model 或混合入口。

## 当前状态

- M-1：已验证 CPA `openai-compatibility.prefix` 可固定命中候选上游。
- M0/M1：Go 单二进制 MVP，支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models` 转发、鉴权、sticky、熔断、异步 JSONL 指标。
- SQLite 与 dashboard 放到 M3/M4。

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
- 流式响应开始输出后不做 failover。
- `/v1/responses` 强制 sticky，避免 `previous_response_id` 断链。
