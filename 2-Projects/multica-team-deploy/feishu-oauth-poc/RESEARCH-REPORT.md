# lark-cli Device Flow + token 持久化 + multica 集成调研

## Q1. lark-cli token 持久化机制

### 结论
1. 本机 `@larksuite/cli` 是二进制分发（无本地 TS/Go 源目录）；但可从上游源码确认：Device Flow 成功后会把 `access_token/refresh_token/expires_at/refresh_expires_at/scope` 写入 `StoredUAToken`，再经 `keychain.Set` 持久化。
2. token 主键是 `appId:userOpenId`，天然按「应用 + 用户」隔离；再叠加 profile/workspace，可做到多用户独立。
3. 刷新由 lark-cli 自动完成：`TokenStatus=needs_refresh` 时走 `GetValidAccessToken -> refreshWithLock -> doRefreshToken`；`refresh_token` 过期或刷新失败会清除本地 token，之后必须重新扫码登录。
4. 有效期不是写死值，来自 OAuth 响应：`expires_in` 与 `refresh_token_expires_in`（毫秒化后写入）。

### 证据
- 本地二进制形态：`/tmp/lark_pkg_shape.txt:1-15`
- 账号维度存储键与 token 结构：
  - `https://raw.githubusercontent.com/larksuite/cli/main/internal/auth/token_store.go`（L1-L5）
- Device Flow 返回 token 字段（含 refresh）：
  - `https://raw.githubusercontent.com/larksuite/cli/main/internal/auth/device_flow.go`（L1-L5）
- 自动 refresh + 失败清除 token：
  - `https://raw.githubusercontent.com/larksuite/cli/main/internal/auth/uat_client.go`（L5-L15）
- 本机实际持久化路径与隔离痕迹：
  - `~/.lark-cli/config.json`（app/user）见 `/tmp/lark_evidence_snapshot.txt:1-20`
  - `~/Library/Application Support/lark-cli/*.enc` 见 `/tmp/lark_evidence_snapshot.txt:61-67`
  - 刷新锁 `refresh_<app>_<user>.lock` 见 `/tmp/lark_evidence_snapshot.txt:54-60`
- 本机当前 token 状态为 `no_token`（需重新登录）：`/tmp/lark_evidence_snapshot.txt:139-158`

### 下一步建议
1. 服务端设计时不要自行实现 refresh，优先复用 lark-cli 自动刷新链路。
2. 多人场景固定使用「每个 multica 用户一个 profile（或独立 config dir）」；禁止共享同一 `appId:userOpenId`。
3. 在 daemon 健康检查加入 `lark-cli auth list`，发现 `no_token` 立即触发重新扫码流程。

---

## Q2. Device Flow 端到端流程实测脚本

### 结论
脚本已写好，未执行（避免阻塞扫码）：`/tmp/lark_device_flow_test.sh`。

### 证据
- 脚本路径：`/tmp/lark_device_flow_test.sh`
- 语法检查：`bash -n` 已通过
- `auth login` 支持 `--no-wait/--device-code/--json`：`/tmp/lark_evidence_snapshot.txt:68-85`

### 下一步建议
1. 先在 daemon 机器导出 `LARK_BIN=/Users/rayman.chen/local/node/bin/lark-cli` 后执行脚本。
2. 扫码完成后观察 `[4/5] auth status` 与 `[5/5] contact +me` 是否都成功。

---

## Q3. multica 集成方案（200字以内）

### 结论
方案大纲：前端调 start 获取 verification_url/device_code 并展示二维码；扫码后调 complete 轮询。后端仅存 profile_id、app_id、user_open_id、scopes、updated_at，不存明文 token。agent 运行时按 multica user 选 profile 调 lark-cli，读取与刷新都交给 lark-cli。

### 证据
- Device Flow 命令能力：`/tmp/lark_evidence_snapshot.txt:68-85`
- lark-cli 支持 workspace 绑定与 Agent 场景：`/tmp/lark_evidence_snapshot.txt:87-108`
- profile/workspace 字段存在：`/tmp/lark_evidence_snapshot.txt:128-137`

### 下一步建议
1. 先做最小可用：start/complete/status 三接口。
2. 第二阶段再加 QR 图片接口与扫码超时回收任务。

---

## Q4. multica daemon 多 runtime 部署方式

### 结论
1. 单 daemon 可同时暴露 codex + claude（以及更多）runtime，不是「1 daemon = 1 CLI」。
2. 多 daemon 共存通过 profile 隔离：每个 profile 独立 config 目录、daemon 状态、health 端口与 workspace 根目录。
3. 本环境无法直接跑 `multica daemon start --help`（本机无 multica，且到 mini 的 SSH 被沙箱阻断），以下命令基于 multica 官方文档与仓内部署记录。

### 证据
- 单 daemon 自动检测多 CLI 并注册 runtime：
  - `https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md`（L335-L352）
- profile 可并行运行多个 daemon：
  - `https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md`（L431-L443）
- profile 隔离到不同 config/pid 路径：
  - `https://github.com/multica-ai/multica/blob/main/CONTRIBUTING.md`（L619-L621）
- `--profile` 为全局持久参数：
  - `https://raw.githubusercontent.com/multica-ai/multica/main/server/cmd/multica/main.go`（L1-L2）
- 你仓内已记录「单次 `multica daemon start` 后 3 runtime online」：
  - `/Users/rayman.chen/mycc/2-Projects/multica-team-deploy/TODO.md:78-79`
- 本地/远端直查受限：`/tmp/multica_access_check.txt:1-9`

### mini 上双进程命令清单（daemon-codex + daemon-claude）
```bash
# 1) 各自登录（各 profile 一份 token）
multica login --profile daemon-codex --token "$MULTICA_TOKEN_CODEX"
multica login --profile daemon-claude --token "$MULTICA_TOKEN_CLAUDE"

# 2) 各自启动 daemon（前台示例；生产可配 launchd/systemd）
multica daemon start --profile daemon-codex --daemon-id daemon-codex --foreground
multica daemon start --profile daemon-claude --daemon-id daemon-claude --foreground

# 3) 分别查看状态
multica daemon status --profile daemon-codex
multica daemon status --profile daemon-claude
```

### 下一步建议
1. 若仅 10 人内测且无强隔离诉求，先用单 daemon（运维最省）。
2. 若按人隔离凭据/审计，改为每人一个 profile 或每人一个容器。

---

## Summary
lark-cli 已支持扫码授权、自动刷新和按应用+用户隔离，脚本已就绪。multica 先做 start/complete/status 三接口，先单 daemon，强隔离再拆 profile。
