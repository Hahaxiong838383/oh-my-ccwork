## 2026-06-11 00:21 CST

- 健康状态：异常 / 检查不完整。
- 公网入口：`/` 返回 200 HTML；`/api/runtimes` 未鉴权返回 401；`/api/daemon/status` 未鉴权返回 401；`/settings` 返回 200；`/api/feishu/device/status` 返回 400 JSON，路由可达但请求参数不完整。`/healthz` 返回 404，未作为本次清单必需项。
- Mini：未完成。`ssh mini` 失败，当前执行环境无法解析 host alias `mini`。
- QNAP：未完成。`ssh prnas` 失败，当前执行环境无法解析 host alias `prnas`，因此无法确认 compose 容器、线上镜像 tag、backend 本地 401、frontend 本地首页。
- HK relay：未完成。`ssh aliyun-hk` 失败，当前执行环境无法解析 host alias `aliyun-hk`；尝试 `root@8.218.26.17` 只读检查也因 SSH 认证失败，未能确认 nginx、监听端口和 error log。
- 异常项：三台关键主机 SSH 不可达，无法完成 mini/QNAP/HK 健康检查；线上实际部署版本无法确认。
- 已执行动作：只读公网 HTTP 检查、上游 main/tags/release 查询、项目文档版本参考检查；未修改生产配置。
- 上游更新判断：GitHub main 当前为 `7d719cfbbebdef59b0ff25108c5312c721d63557`，最新 release/tag 为 `v0.3.19`（2026-06-10 10:00 UTC 发布）。项目文档参考 compose 镜像为 `v0.3.9`，但线上实际 tag 未能通过 QNAP 验证。
- 是否更新：已跳过。
- 跳过原因：自动更新安全门未通过。当前部署健康状态不完整；无法备份 QNAP compose/`.env` 和 mini daemon plist；release notes 包含 daemon、DB 外键、uploads 鉴权、realtime/WS 等敏感范围变更，需要人工审查后再决定。

## 2026-06-11 00:43 CST

- 更正：上一次报告把早期项目文档里的 `v0.3.9` 当作部署参考基线，容易误导。mini 上实际 `multica --version` / `multica daemon status` 显示当前 CLI/daemon 为 `0.3.16`（commit `5b69331a`，built `2026-06-04T10:02:09Z`）。
- QNAP backend/web 镜像 tag 仍未验证：当前从 MacBook 直连 `ssh prnas` 权限失败，从 mini 内部 `ssh prnas` 也无法解析 host alias，因此不能确认 compose 线上镜像 tag。
- 上游更新应按 `v0.3.16 -> v0.3.19` 重新评估：共 103 个提交、391 个文件名变更，涉及 server、packages、apps、CLI/daemon 文档、self-host compose/env、migrations、daemon、handler、protocol、agent runtime、autopilot、attachments、realtime/WS、Feishu/Lark。
- 更新判断：仍跳过自动更新。原因不是 `v0.3.9` 跨度，而是 `0.3.16 -> 0.3.19` 仍包含 DB migration、daemon/runtime、attachments/upload、realtime/WS、self-host env/compose 变更，且 QNAP 线上镜像 tag 和备份安全门未完成验证。

## 2026-06-11 01:21 CST

- 已配置 QNAP 凭据：密码仅保存到本机 Keychain 和 mini 本地 `~/.secrets/prnas_sshpass`（权限 `600`），维护命令通过 mini 上的 `~/bin/prnas-askpass` + `SSH_ASKPASS` 使用，不在报告、issue、git 中输出明文。
- 连接验证：Air 通过 `ssh prnas` 可登录 QNAP；mini 通过 `DISPLAY=none SSH_ASKPASS="$HOME/bin/prnas-askpass" SSH_ASKPASS_REQUIRE=force ssh -o NumberOfPasswordPrompts=1 -o PubkeyAuthentication=no prnas ... < /dev/null` 可登录 QNAP。
- QNAP 实际 server 镜像 tag：`ghcr.io/multica-ai/multica-backend:v0.3.13`、`ghcr.io/multica-ai/multica-web:v0.3.13`；容器 `multica-backend`、`multica-frontend`、`multica-postgres`、`multica-redis` 均为 Up。
- 版本基线更正：当前部署不是单一 `0.3.16`。mini CLI/daemon 为 `0.3.16`，QNAP backend/web 为 `v0.3.13`。后续更新评估需分别比较 `server v0.3.13 -> v0.3.19` 与 `daemon/CLI v0.3.16 -> v0.3.19`。

## 2026-06-11 01:38 CST

- 健康状态：正常。
- 备份：已在 QNAP 创建 `/share/CACHEDEV2_DATA/multica/backups/20260611-012855`，包含 `docker-compose.yml`、`.env`、`compose-ps.txt`、`image-tags.txt`、`postgres.sql.gz`、`SHA256SUMS`。
- 已执行动作：取消由维护 comment 触发的内部 Codex task；QNAP backend/web 从 `v0.3.13` 升级到 `v0.3.18`；mini `multica` CLI/daemon 从 `0.3.16` 升级到 `0.3.18`；重启 `com.multica.daemon`。
- 上游更新判断：GitHub 最新 release 是 `v0.3.19`，但 `ghcr.io/multica-ai/multica-backend:v0.3.19` 当前不存在（manifest unknown），`v0.3.18` backend/web 镜像成套可用，因此本次选择最高成套可用版本 `v0.3.18`，避免 backend/web 版本混用。
- 验证结果：QNAP `docker compose ps` 四容器均 Up；QNAP `/healthz` 返回 `db:ok`、`migrations:ok`；公网首页返回 200；`/settings` 返回 200；未鉴权 `/api/daemon/status` 返回 401 属于正常；mini daemon 状态为 `running`，`active_task_count=0`，两个 workspace 共 10 个 runtime 已注册。
- 自动更新：已执行到 `v0.3.18`；未升级到 `v0.3.19` 的原因是 backend 镜像缺失。

## 2026-06-11 16:59 CST

- 健康状态：正常。
- 备份：已在 QNAP 创建 `/share/CACHEDEV2_DATA/multica/backups/20260611-165422-skill-evolution`，包含 `docker-compose.yml`、`.env`、`compose-ps.txt`、`image-tags.txt`、`postgres.sql.gz`、`SHA256SUMS`。
- 已执行动作：基于 multica `v0.3.18` 后端镜像构建本地补丁镜像 `local/multica-backend:skill-evolution-20260611-2`；只替换 QNAP backend，web 仍为 `ghcr.io/multica-ai/multica-web:v0.3.18`；mini `~/bin/multica` 替换为 `v0.3.18-skill-evolution.1` 并重启 `com.multica.daemon`。
- 功能变更：新增 `skill_proposal` 表、`/api/skills/proposals` 创建/列表接口、`/api/skills/proposals/{proposalId}/publish` 发布接口，以及 CLI `multica skill proposals list/create/publish`。发布只进入 workspace skill 库，不自动绑定 agent。
- 部署插曲：第一版补丁镜像因 macOS tar 带入 `._*.sql` AppleDouble 文件导致 migration runner 误读，已立即回滚到 `v0.3.18` 恢复健康；随后重打 clean tar，并在 Dockerfile 中加入删除 `._*`/`.DS_Store` 防线后重新部署成功。
- 验证结果：QNAP `/healthz` 返回 `db:ok`、`migrations:ok`；Postgres `skill_proposal` 表存在；公网首页和 `/settings` 均返回 200；mini `multica skill proposals list --output json` 返回 `[]`；临时 smoke proposal 已成功 publish 成 skill，随后已删除临时 skill 和 proposal；daemon 重启后后端日志出现 `client_version=v0.3.18-skill-evolution.1`。

## 2026-06-11 18:13 CST

- 更正说明：上一轮只部署了 skill evolution 的底层 proposal/publish 通道，并未创建可见 agent；因此网页端智能体列表里看不到独立的技能进化维护员。
- 已执行动作：创建 workspace 可见 agent `Skill Evolution Agent（技能进化维护员）`，ID `d392bbf5-d1fa-4a76-8be3-669a2b58927f`，runtime 为 mini Codex `6e723acd-3693-4d23-8103-9b4dc13cc74d`，最大并发 1。
- 当前状态：agent 列表验证为 `idle`、`workspace` 可见；该 agent 只负责生成/验证/publish skill proposals，不会自动绑定 skill 到生产 agent。

## 2026-06-12 22:46 CST

- 健康状态：正常。
- 升级范围：前端升级到 `ghcr.io/multica-ai/multica-web:v0.3.21`；后端升级到本地整合镜像 `local/multica-backend:v0.3.21-skill-evolution.1`；mini CLI/daemon 升级到 `v0.3.21-skill-evolution.1`。
- 整合内容：以 upstream `v0.3.21` 为基线重新合入 skills 自进化补丁；保留 `/api/skills/proposals` 创建/列表、`/api/skills/proposals/{proposalId}/publish`、CLI `multica skill proposals list/create/publish`；迁移号从旧补丁 `119_skill_proposals` 调整为 `120_skill_proposals`，并做幂等处理以兼容线上已存在表。
- 构建方式：QNAP 直接拉取 upstream web 镜像；后端因 QNAP Go module 网络拉取不稳定，改为本机交叉编译 Linux/amd64 后用 runtime-only Dockerfile 打包。基础镜像使用 QNAP 可达镜像源。
- 备份：mini 备份在 `/Users/rayman.chen/multica-backups/20260612-224326`；QNAP 备份在 `/share/CACHEDEV2_DATA/multica/backups/20260612-224326-v0.3.21-upgrade`，包含 compose、脱敏运行配置备份和 Postgres custom dump。
- 验证结果：QNAP `docker compose ps` 四容器均 Up；`/healthz` 返回 `db:ok`、`migrations:ok`；公网首页返回 200，压缩后下载约 77.8KB，TTFB 约 0.325s，总耗时约 1.70s；`/api/config` 返回 200；mini daemon 为 running，2 个 workspace 共 10 个 runtime 注册成功；`multica skill proposals list --output json` 返回 `[]`。
- 测试结果：Go 定向测试通过 `server/internal/handler`、`server/cmd/multica`、`server/cmd/server`、`server/internal/daemon`；`server/pkg/agent` 在本机 fake runtime 场景出现 5s timeout，未发现与本次 patch 直接相关，保留为后续专项排查项。
- 注意事项：线上 schema 同时存在历史自定义迁移 `119_skill_proposals`、upstream `119_user_created_at_index` 和本次幂等 `120_skill_proposals`，这是兼容既有部署的预期结果。

## 2026-06-14 23:02 CST

- 健康状态：正常。
- 问题：飞书 OAuth sidecar 的 `expiry-watcher` 原逻辑只在 refresh token 剩余不足 24h 时直接发飞书提醒，没有先尝试静默刷新；同时 mapping 中遗留 5 条 `test-user-*` 测试授权记录，导致提醒噪声。
- 已执行动作：修改 `feishu-oauth-sidecar/expiry_watcher.go`，在 token `needs_refresh` 或临期时先通过 `lark-cli auth check --scope im:message` 触发无副作用自动刷新，再复查状态；刷新后仍临期才通知。新增过滤 `test-user-*` mapping，避免测试授权触发提醒。
- 清理动作：已备份并清理 mini `~/multica-user-homes/user_mapping.json` 中的 5 条 `test-user-*` 记录；备份为 `/Users/rayman.chen/multica-user-homes/backups/user_mapping.20260614-230146.json`。
- 部署：已重新编译并替换 mini `/Users/rayman.chen/feishu-oauth-sidecar/feishu-oauth-sidecar`，重启 `com.multica.feishu-oauth`；旧二进制和 plist 备份在 `/Users/rayman.chen/feishu-oauth-sidecar/backups/20260614-230044`。
- 验证结果：`go test ./...` 通过；sidecar `/healthz` 正常；公网 `/settings` 返回 200；真实用户 status 返回 `bound=true`、`token_status=valid`；重启后 watcher 首轮日志为 `scanned=2`、`notified=0`、`errors=0`。
