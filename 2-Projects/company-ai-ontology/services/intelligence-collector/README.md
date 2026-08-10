# Company Intelligence Collector

P1-SI-C 公司版前沿资讯雷达的独立 oneshot Collector。当前只形成可部署包，`productionDeploymentAllowed=false`、`publish=false`，不连接公司 QNAP、不发送飞书、不创建 P2、不写回 ERP/社媒。

## 设计边界

- 每次网络请求前必须通过 P1-SI-B Source Registry 判定；任一请求来源被拒绝时，本次运行在网络前失败。
- 只支持官方 RSS/API 的首期适配模式；登录态、Cookie、个人账号和反自动化绕过不受支持。
- 使用公司独立 account、credential、database、state、report 和 Feishu outlet namespace。
- 不读取个人站数据、报告、凭据或 Webhook；不依赖个人站运行时。
- 保存 raw snapshot、normalized items、source decisions、run summary 和 last-good；失败不覆盖 last-good。
- 外部正文按不可信输入保存为 Base64 raw snapshot，标准化层只保留受限字段；进入模型或 Ontology 前仍需 P1-SI-D 消毒与证据化。

## 目录

```text
contracts/   Collector Contract 与复用版本锁
schemas/     Config、Normalized Item、Run JSON Schema
src/         配置校验、准入、采集、标准化、去重和原子写入
test/        网络前拒绝、成功采集、去重、last-good 和资源负测
scripts/     镜像构建入口
```

## 本地验证

```bash
npm test
npm run validate
```

当前 Source Registry 的全部来源都是 paused 候选，因此 `validate` 只验证部署包和 Registry Snapshot，不发起真实采集。

## 镜像

Dockerfile 固定：

- `node:22.14.0-alpine3.21`；
- 多架构 manifest digest `sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944`；
- 非 root 用户 `intelligence`；
- 构建时写入 Source Commit OCI label。

具备 Docker 的独立构建环境执行：

```bash
IMAGE_TAG=company-intelligence-collector:0.1.0 scripts/build-image.sh
```

当前开发机没有 Docker/Podman/Buildah，因此本阶段只验证 Dockerfile、固定 Base Digest 和构建脚本；不得把“构建配方完成”描述为“镜像已经构建或部署”。

## 生产门禁

P1-SI-H 前不得：

- 把配置、Registry 或状态目录放进公司 QNAP 生产根；
- 把 `publish` 改为 true；
- 启用 Feishu outlet；
- 添加个人凭据；
- 启动常驻 Timer；
- 重启 Agent Core、H-Lite、Connector、Gateway 或数据库。
