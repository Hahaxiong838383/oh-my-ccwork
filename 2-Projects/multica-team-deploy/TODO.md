# TODO — multica-team-deploy

> **基线日期**：2026-05-27 13:40 完成 P0+P1+P2+P3+P5 公网部署
> **当前状态**：multica server 在 QNAP 公网 https://multica.cli4.hahaxiong.cc 可用，Mini 跑 3 个 runtime（Claude/Codex/Gemini）online
> **优先级标记**：🟥 P0 阻塞 / 🟧 P1 重要 / 🟦 P2 团队接入 / 🟪 P3 mycc 集成 / 🟫 P4 加固优化 / 🟢 P5 文档

---

## 🟥 P0 · 让 daemon 真能跑任务

- [ ] **Mini 上 `claude` CLI 登录** — daemon 检测到 `claude 2.1.114` 但实际跑 task 时需要登录态。运行 `~/.local/bin/claude login` 走 OAuth
- [ ] **修 codex `--version` 路径**（已用 symlink 修，PATH 持久化到 `~/.zshrc` 还没做） — 加 `export PATH=$HOME/bin:$PATH` 到 `~/.zshrc` 或 `~/.zprofile`
- [ ] **浏览器端到端实测**：打开 https://multica.cli4.hahaxiong.cc → 进 `futurus test` workspace → 创建 issue → 派 Claude/Codex/Gemini runtime → 验证产出代码

## 🟧 P1 · 生产稳定性（团队邀请前必做）

- [ ] **修 WS 400 根因** — `/api/daemon/ws` 走 nginx → backend 直反代后 backend 返 400 Bad Request。Polling 30s 工作中不阻塞，但实时推送需要这个。根因待 gemini 协助调试（Origin / WebSocket-Key / X-Forwarded-Proto 校验）
- [x] **Mini frpc launchd plist** ✅ 2026-05-27 已落地 `~/Library/LaunchAgents/dev.frpc.cc-remote.plist`
- [ ] **切回 production 模式 + Resend**：
  - `APP_ENV=production`
  - `ALLOW_SIGNUP=false`
  - `MULTICA_DEV_VERIFICATION_CODE=` 留空
  - 配 `RESEND_API_KEY=re_xxx`（你提供）
- [ ] **QNAP daily DB 备份 cron** — 脚本 `/share/CACHEDEV2_DATA/multica/scripts/backup-pgdata.sh` 已写好且实测产出 22KB gzip，crontab 用 admin 装
- [ ] **QNAP rollup_task_usage_hourly cron 5min** — 脚本就绪 `/share/CACHEDEV2_DATA/multica/scripts/rollup-usage.sh`

## 🟦 P2 · 团队 10 人接入

- [ ] **AI 订阅方案拍板**（DECISIONS D7 留空）：
  - Anthropic：Claude Code Team $30×10=$300/月 vs 沿用 Pro
  - OpenAI：ChatGPT Team vs 沿用 VPS:4001 Pro 代理
  - Google：Vertex AI API key（继续 VPS:4000 网关）
- [ ] **Mini 装 OrbStack**（M 系列 Mac 最快 Docker 替代）扩到 3-5 daemon 容器化，AI CLI 凭据独立隔离
- [ ] **收集 9 个同事邮箱** → 写进 `ALLOWED_EMAILS`，重启 backend
- [ ] **写 install-multica.sh 同事一键脚本**：
  - 检查 Apple Silicon
  - 下载 multica-desktop-0.3.9-mac-arm64.dmg
  - 装到 /Applications/
  - 写 `~/.multica/desktop.json` 三件套（apiUrl/wsUrl/appUrl）
- [ ] **Intel Mac 同事走浏览器**：Multica.app 仅 Apple Silicon，Intel 直接 https://multica.cli4.hahaxiong.cc

## 🟪 P3 · mycc 集成（差异化护城河）

- [ ] **QNAP 跑 mycc brain** — 独立容器，暴露 MCP + HTTP API（端口待定，建议 7800）
- [ ] **daemon 挂载 mycc 知识库只读** — 当前 Mini daemon 是裸 binary 跑，直接读 `~/mycc/` 没问题。未来 Docker 化后挂载 `~/mycc/0-System/` `~/mycc/2-Projects/` 到 `/mnt/mycc/`
- [ ] **multica skill 注入 brain 调用** — agent 任务前调 `brain.recall(workspace, task)`，任务结束后写 `brain.append(RECENT_EVENTS)`
- [ ] **agent persona 注入 mycc CLAUDE.md** — BRO-PDCA / ASMR / no-guessing 规则批量复制给团队
- [ ] **brain 跨设备同步** — QNAP brain ↔ Mini brain ↔ Air brain（沿用 project_brain_sync.md 机制）

## 🟫 P4 · 防御 + 优化（gemini 对抗审 backlog）

- [ ] **WS `proxy_read_timeout` 86400s → 1h** — 防僵死连接积累
- [ ] **FRP `proxyBindAddr=127.0.0.1`** — defense in depth（阿里云安全组已挡）
- [ ] **FRP `auth.token` 加固** — 现 `ccremote-v4-2026` 中等强度，改 hex 32 + `transport.tls.force=true`
- [ ] **QTS 自动更新关闭** — 避免 Container Station 重启踢容器
- [ ] **PATH 持久化到 ~/.zprofile** — 保证 Mini 重启后 daemon 仍能找到 node/codex
- [ ] **codex/gemini 的 nvm dependency 解耦** — 长期 daemon Docker 化时不该依赖 host nvm

## 🟢 P5 · 落盘 + 文档

- [x] **TODO.md** ✅（就是本文档）
- [ ] **更新 IMPLEMENTATION.md** — 把规划数据替换成实测真实命令
- [ ] **写 RUNBOOK.md** — 日常运维清单：启停 / 看日志 / 回滚 / 升级 / 看资源
- [ ] **更新 README.md 当前状态** — 从"待启动"改"P0-P3+P5 已部署 / 等同事接入"

---

## 完成历史（变更日志）

### 2026-05-27 13:00-13:40 一次性完成 P0+P1+P2+P3+P5

- **P0** Mini 停 Ollama + mycc backend，内存 Available 5→14GB，4 个同步 cron 保留
- **P1** QNAP `/share/CACHEDEV2_DATA/multica/` 工作目录 + docker-compose.yml + .env(chmod 600) + 4 镜像（GHCR + docker.1ms.run 国内镜像源）
- **P2** docker compose up → 4 容器 + 109 migration 全跑 + `/healthz` `db:ok,migrations:ok` + Redis relay 接入成功
- **P3-1** Mini `~/Library/LaunchAgents/dev.frpc.cc-remote.plist` 加 `multica-web` (3080→18080) + `multica-api` (8080→18443) proxy
- **P3-2** HK <hk-vps-ip> nginx server block + certbot 签 multica.cli4.hahaxiong.cc 证书
- **P3-3** 公网 HTTPS HTTP/2 200 + CORS allow_origin 正确 + WSS Upgrade 路径通
- **P5** Mini 直接装 multica CLI Linux→darwin-arm64 binary（**因为 Mini 没 Docker / 没 brew**），跑 `multica login --token mul_xxx` + `multica daemon start`，3 个 runtime（Claude/Codex/Gemini）online
- **codex CLI 修复** symlink `~/.nvm/.../node + codex → ~/bin/`，daemon 重启后 3 runtime 全注册
- **Gemini 对抗审** 2 轮 11 finding，修真 P0 4 个 / 误报否决 2 个 / backlog 4 个

### 沉淀的关键事实（写入 RECENT_EVENTS.md）

1. multica-web 自带 Next.js rewrites 把 `/api/* /auth/* /ws /uploads/* → backend:8080`，nginx 单 upstream 即可
2. QNAP TS-X65 (Intel Core 3 N355) Container Station docker 不在 PATH，路径 `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`
3. QNAP busybox base64 不支持 `-d` 参数，scp+ProxyJump+sshpass 三件组合也不工作 → 用 `ssh prnas 'cat > file' < local-file`
4. Mini 上 nvm 装的 node/codex/gemini SSH 非交互式 shell 拿不到 PATH，daemon detect 时 exit 127 → symlink 到 `~/bin/` 修复
5. Mini frpc reload 不工作（SIGUSR1 + `frpc reload` 都不行因为没启 webServer），必须 kill+重启
6. certbot 2.9.0 webroot 模式给子域签证书 < 1min 完成
7. gemini-3.5-flash high thinking 对抗审根因命中率高但数值（如 "QTS 默认 8080"）系统性偏乐观 2-4x，必须 cc 实测 sanity check

---

## WS 400 调试发现（2026-05-27 13:42）

通过对比测试定位 nginx 那一层问题：

| 测试路径 | 结果 |
|---------|------|
| HK 本机 `curl http://127.0.0.1:18443/api/daemon/ws?runtime_ids=...` （**直 backend，绕 nginx**）| ✅ **101 Switching Protocols** + Sec-WebSocket-Accept |
| 公网 `curl https://multica.cli4.hahaxiong.cc/api/daemon/ws?...` （**走 nginx**）| ❌ 400 Bad Request (12 字节 "Bad Request") |

**结论**：backend WS Upgrade 完全正常。问题在 nginx 反代 → backend 时，某些 Sec-WebSocket-* header 没透传到位。

**待试修复**（按命中概率排序）：
1. nginx `location /api/daemon/ws` 加显式 `proxy_set_header Sec-WebSocket-Key $http_sec_websocket_key;` 和 `Sec-WebSocket-Version` `Sec-WebSocket-Protocol` `Sec-WebSocket-Extensions`
2. 验证 nginx 是否把 client 的 HTTP/2 WS Upgrade 降级到 HTTP/1.1 时丢字段（虽然 daemon 用 HTTP/1.1 应该不该有这个问题）
3. nginx debug log（`error_log .. debug;`）抓实际转发的 headers

**当前影响**：daemon 每 8s polling fallback 工作（30s 之内任务推送）。10 人量级体感无感。**修了能升级到实时 push**。
