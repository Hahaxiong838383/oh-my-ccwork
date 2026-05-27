# multica-team-deploy

> 把 [multica-ai/multica](https://github.com/multica-ai/multica)（开源 managed agents 平台）部署给 iBRO 团队 10 人小范围使用，AI CLI 订阅在小团队内共享，并集成 mycc 的记忆 + 认知架构。

## 当前状态

**Phase 0：方案落盘 ✅**（2026-05-27）

- ✅ multica 源码分析（架构 + 多用户隔离机制 + Mac 客户端能力）
- ✅ QNAP TS-X65 (192.168.61.18) SSH 实测：8C N355 / 16GB / 615GB SSD / Container Station 已装
- ✅ Mini M4 (10.9.1.54) 资源盘点：停 Ollama+mycc 后可腾 7-12GB 跑 daemon
- ✅ 部署架构定稿：**QNAP server + Mini daemon + cli4 Caddy TLS 反代 + 同事装 Multica.app**
- ✅ 落盘 4 份文档：本 README / ARCHITECTURE / IMPLEMENTATION / DECISIONS

**下一步**：等川哥拍板 Phase 1 启动节奏

## 项目根本目标

1. **能用**：10 人团队（含 Apple Silicon 同事）能通过 Multica.app 客户端跑 issue 派单 + agent 自动执行
2. **共享 AI 订阅**：claude/codex/gemini 不让 10 人各自买（沿用现有 VPS 23.226.135.149 网关路径）
3. **集成 mycc 记忆**：每个 agent 任务读 mycc brain → 任务输出回写 RECENT_EVENTS / memory_items
4. **零额外硬件成本**：QNAP + Mini 已有，公网走现成 FRP（cli4.hahaxiong.cc）

## 文件索引

| 文件 | 内容 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 五层架构图 + 资源账（QNAP/Mini/网关/AI 上游）+ multica 多用户隔离实现细节 |
| [IMPLEMENTATION.md](./IMPLEMENTATION.md) | 7 个 Phase 的具体命令 + docker-compose + Caddyfile + install.sh |
| [DECISIONS.md](./DECISIONS.md) | 关键决策记录（为什么不上云 / 为什么 QNAP 跑 server / 客户端 self-host 配置 / WSS 必需）|

## 关键事实索引

- **multica 镜像架构**：ghcr.io/multica-ai/multica-backend 多架构（arm64 + amd64），QNAP/Mini/云服务器都能跑
- **客户端版本**：v0.3.9（2025-09）Electron + 注册 `multica://` 协议 + macOS notarized
- **客户端 macOS 限制**：**只支持 Apple Silicon**，Intel Mac 同事用浏览器
- **客户端自托管配置**：`~/.multica/desktop.json` 写 `{apiUrl, wsUrl, appUrl}` 三件套
- **公网入口必需 HTTPS + WSS**：因为 WebSocket 走 `wss://`，FRP 裸 TCP 转发不够，必须 Caddy/nginx 做 TLS 终端
- **多租户隔离合格**：workspace + member + role 三元组在 schema 层（migrations/001）、middleware 层（middleware/workspace.go）、WebSocket scope 层（scope_authorizer.go）三处强制，注释提到 MUL-2600 修过越权 CVE
- **Daemon 不能多用户共享 OS**：每个 daemon 进程读自己 $HOME 的 AI CLI 凭据，所以方案是 Mini 上每个 daemon 用独立容器 + 独立 HOME

## 相关 memory（不在此项目内的全局上下文）

- [project_evodesk.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/project_evodesk.md) — EvoDesk 独立产品，**不与本项目耦合**（feedback_evodesk_mycc_independent 纪律）
- [user_hardware.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/user_hardware.md) — Mini/QNAP/Studio 硬件
- [reference_prnas_ssh.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/reference_prnas_ssh.md) — QNAP 登录方式
- [reference_gemini_proxy.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/reference_gemini_proxy.md) — VPS Gemini 网关
- [reference_vps_codex_proxy.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/reference_vps_codex_proxy.md) — VPS Codex 网关
