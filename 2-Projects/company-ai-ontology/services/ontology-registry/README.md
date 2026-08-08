# Ontology Registry

P0-S 的 Ontology Compiler、Registry 和运行时对账服务。生产部署只编译镜像内的 Git 定义；远程请求可以 dry-run 编译候选定义，但不能把任意请求正文直接部署到生产 Registry。

## 接口

- `GET /healthz`：进程健康。
- `GET /readyz`：数据库、定义编译和 active Registry hash 全部一致才返回 200。
- `POST /v1/compile`：编译候选定义或本地定义，只读。
- `POST /v1/deploy`：部署镜像内定义；要求 proposal、批准人和 Git commit。
- `GET /v1/registry/active`：读取 active 版本摘要。
- `GET /v1/reconcile`：比较 Git 定义与运行时 Registry，不写入。
- `GET /v1/contracts`：返回当前 Data/Logic/Action 和 Event Envelope 契约。

所有 `/v1/*` 接口必须提供 `x-ontology-registry-token`。迁移级变更必须显式提供 `allowMigration=true` 和非空 migration plan；Agent 不能自行批准或部署本体。

## 本地验证

```bash
npm install
npm test
```
