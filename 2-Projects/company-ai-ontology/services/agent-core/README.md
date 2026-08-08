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
- 当前远程 H Worker 使用独立 Workspace 和 HMAC 边界；临时读取既有 H 平台 OAuth，但不复制凭据、不共享会话或记忆。
- 正式模式使用独立公司 HOME/Grok HOME，并报告 `credentialMode=company-dedicated-oauth`。
- 具体模型 CLI 与 Provider 属于部署实现细节，不进入上层 Agent Core API 和业务架构。
- `H_ENGINE_MODE=remote` 通过签名请求调用受控 H Worker；`demo` 只用于离线演示，`cli` 保留为 QNAP 本机执行候选。
- 正式凭据切换流程见 `../../docs/h-engine-credential-cutover.md`。

## 本地验证

```bash
npm ci
npm test
```
