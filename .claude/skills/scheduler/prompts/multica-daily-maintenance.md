# multica 每日维护任务

目标：每天检查 `2-Projects/multica-team-deploy` 对应的 multica 自托管部署是否正常运转；同时检查 `multica-ai/multica` 源仓库是否有更新。只有确认更新不影响当前部署时，才自动执行更新。

## 范围

- 项目目录：`/Users/rayman.chen/mycc/2-Projects/multica-team-deploy`
- 公网入口：`https://multica.cli4.hahaxiong.cc`
- Mini 主机：`ssh mini`
- QNAP 主机：`ssh prnas`
- HK relay：`ssh aliyun-hk`
- 上游仓库：`https://github.com/multica-ai/multica`

## QNAP 连接方式

在 mini 上已配置 `~/.ssh/config` 的 `prnas` alias，以及本地密码助手 `~/bin/prnas-askpass`。维护任务需要从 mini 访问 QNAP 时，使用以下形式，不要输出密码、不要读取或打印 `~/.secrets/prnas_sshpass`：

```bash
DISPLAY=none SSH_ASKPASS="$HOME/bin/prnas-askpass" SSH_ASKPASS_REQUIRE=force \
  ssh -o NumberOfPasswordPrompts=1 -o PubkeyAuthentication=no prnas '<只读或维护命令>' < /dev/null
```

QNAP docker binary 可能不在 PATH，优先使用 `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`。

## 每日健康检查

1. 检查公网入口：
   - 首页返回 200 或可用 HTML。
   - `/api/runtimes` 未带鉴权返回 401 属于正常。
   - `/api/daemon/status` 未带鉴权返回 401 属于正常。
   - `/settings` 或 `/api/feishu/device/status` 路由可到 sidecar。
2. 检查 mini：
   - `launchctl list` 中 `com.multica.daemon`、`com.multica.feishu-oauth`、frpc、xray 正常。
   - `multica daemon status` 正常。
   - `multica runtime list` 中 claude、codex、gemini、opencode、hermes 均 online。
   - `multica agent list` 无异常长期 running 或 queued。
   - `~/Library/Logs/multica-daemon.log` 最近 24 小时无连续 agent_error、WS 断连、heartbeat 异常。
   - `~/Library/Logs/feishu-oauth-sidecar.log` 最近 24 小时无连续 5xx 或 OAuth 脚本错误。
3. 检查 QNAP：
   - `docker compose ps` 中 multica backend、frontend、postgres、redis 均 Up。
   - backend 本地 `/api/runtimes` 未鉴权返回 401 属于正常。
   - frontend 本地首页可打开。
4. 检查 HK relay：
   - nginx active。
   - 18080、18443、18890、443 监听正常。
   - nginx error log 最近 24 小时无持续 upstream 错误。
5. 输出并记录维护报告：
   - 如目录不存在，先创建 `2-Projects/multica-team-deploy/auto-update/reports/`。
   - 增量追加写入 `2-Projects/multica-team-deploy/auto-update/reports/maintenance-log.md`，不要创建每日独立 md 文件。
   - 每次追加一个二级标题：`## YYYY-MM-DD HH:mm CST`。
   - 每段报告包含：健康状态、异常项、已执行动作、上游更新判断、是否更新、更新版本或跳过原因。

## 上游更新检查

1. 获取当前部署版本：
   - mini：`multica --version`。
   - QNAP compose：读取 `/share/CACHEDEV2_DATA/multica/docker-compose.yml` 中 multica backend/web 镜像 tag。
   - 项目文档中记录的 tag 仅作参考，以线上实际为准。
2. 获取上游状态：
   - `git ls-remote https://github.com/multica-ai/multica refs/heads/main`。
   - GitHub releases 或 tags。
   - 如能拉源码，检查当前部署版本到最新 tag/main 的 release notes、migrations、server API、daemon protocol、websocket、auth、env、docker compose、CLI/runtime 相关变更。

## 自动更新安全门

只有全部满足时才允许自动更新：

- 上游存在明确 release 或 tag，且镜像/CLI 构建可获得。
- 更新不包含数据库 schema migration、auth/JWT/session、workspace/permission、daemon protocol、WebSocket、runtime claim/heartbeat、environment variable、docker compose 结构、文件存储路径、反代路径变化。
- 当前部署健康，且最近没有未解决的 queued/running 积压。
- 能完成备份：
  - QNAP compose 和 `.env` 备份到 `/share/CACHEDEV2_DATA/multica/backups/`。
  - mini daemon plist 备份到 `~/Library/LaunchAgents/backups/` 或同级 `.bak.TIMESTAMP`。
- 更新命令可以完整执行并通过回滚验证。

只要任一条件不满足，禁止自动更新，只记录原因并通知。

## 允许的自动更新动作

1. 低风险 backend/web 镜像 patch 更新：
   - 备份 QNAP compose 和 `.env`。
   - 更新 compose image tag。
   - 执行 docker compose pull 和 docker compose up -d。
   - 等待 30 秒，重新跑健康检查。
   - 失败则回滚 compose tag 并 up -d。
2. 低风险 mini CLI/daemon patch 更新：
   - 确认 release notes 未涉及 daemon 协议或 runtime 配置破坏性变化。
   - 备份 plist。
   - 执行官方 CLI 更新命令或项目已验证命令。
   - 重启 `com.multica.daemon`。
   - 重新确认 5 个 runtime online。

## 禁止自动更新场景

- main 分支有更新但没有 release/tag。
- 涉及 migration 或 schema。
- 涉及 auth、权限、workspace、WebSocket、daemon API、runtime 调度协议。
- 需要改 nginx/frpc/公网路径。
- QNAP 或 mini 当前不健康。
- SSH 到关键主机失败。
- release notes 信息不足，无法判断影响。

## 收尾要求

任务完成后在当前 Multica issue 写 comment。正文控制在 10 行内：

- 今日状态：正常/异常。
- 上游更新：无/有。
- 自动更新：已执行/已跳过。
- 跳过或失败原因。
- 报告文件路径：`2-Projects/multica-team-deploy/auto-update/reports/maintenance-log.md`。

不要求调用 `/tell-me`。如需要飞书通知，后续由外层 scheduler 或人工处理。
