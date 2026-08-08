# Company Agent Core

QNAP 上的公司级 Agent 最小服务。当前版本提供内部签名协议、租户/人员 scope、Postgres 幂等与审计、H 引擎独立 HOME/Workspace 门禁。

## 接口

- `GET /healthz`：进程存活。
- `GET /readyz`：Postgres 与公司 H 引擎 Runtime 同时可用才返回 200；演示模式返回 `demo_ready` 和 `productionReady=false`。
- `POST /v1/turns`：仅接受 H-Lite 内部 HMAC 签名请求。

## 当前边界

- Runtime 未配置时明确返回 `runtime_not_ready`，不会用 echo 或假结果冒充 H 引擎成功。
- 不持有 ERP、飞书、Git 或社媒写权限。
- 不提供 Action Gateway；所有业务写回仍保持关闭。
- 公司 H 引擎使用独立 HOME、Workspace 和企业凭据，不复用员工私人 Bot Runtime。
- 具体模型 CLI 与 Provider 属于部署实现细节，不进入上层 Agent Core API 和业务架构。
- 无企业凭据时可使用 `H_ENGINE_MODE=demo` 跑通 P0 演示闭环；切换 `H_ENGINE_MODE=cli` 后使用官方 Provider CLI，并通过 `H_ENGINE_PROXY_URL` 走 Mac Mini Xray。

## 本地验证

```bash
npm ci
npm test
```
