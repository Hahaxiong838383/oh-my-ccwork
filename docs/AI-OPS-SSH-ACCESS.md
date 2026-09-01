# AI Ops 运维服务器 SSH 接入

> 适用：cc / codex / grok 三个引擎。此文件在仓库内，三者都可按路径读取：`~/mycc/docs/AI-OPS-SSH-ACCESS.md`。

## 接入真值

- 机器：`racknerd` = `23.226.135.149`（RackNerd 美西 1C/2G/39G，Ubuntu 24.04）。
- 用途：AI Ops 驾驶舱 9 个 Docker 容器：`ops-caddy` / `ops-inspector` / `ops-terminal`（ttyd）/ `ops-n8n` / `ops-auth` / `ops-netdata` / `ops-uptime-kuma` / `ops-dockge` / `ops-homepage`。
- 根目录：`/opt/ai-ops-cockpit`。
- 配套 skill：`ai-ops-cockpit`；但不要只依赖 skill，因为 codex / grok 不一定能读 cc 的 `~/.claude/skills/`。

## 本机身份与密钥

- 三个引擎都以本机用户 `Rayman.Chen` 运行，共享 `~/.ssh/config` 与 `~/.ssh/id_ed25519`，不需要各自配密钥。
- 私钥 `~/.ssh/id_ed25519` 已于 2026-07-25 实测无 passphrase，权限 `600`、属主 `Rayman.Chen`。
- 裸环境验证已通过：`env -i HOME=$HOME PATH=/usr/bin:/bin ssh racknerd`，不依赖 zshrc、环境变量或 ssh-agent。

## codex / grok 前提

- codex 做 aiops 运维时，调用方必须启动为：`codex exec --sandbox danger-full-access --skip-git-repo-check "<任务>"`。沙箱在进程启动时固定，codex 进程内无法自改。
- grok 无沙箱概念，`~/.grok/config.toml` 的 `permission_mode = "always-approve"`，可直接 `grok -p "ssh racknerd ..."`。

## 连接方式

```bash
ssh racknerd
ssh -o ProxyJump=none -i ~/.ssh/id_ed25519 root@23.226.135.149
```

- 默认 `ssh racknerd` 走 `ProxyJump mini-pub`：`cli4.hahaxiong.cc:22022` → aliyun-hk frps → Mac Mini，更稳。
- 默认链路依赖 aliyun-hk frps 与 Mac Mini 开机；不可用时走直连兜底。直连偶发 banner 超时，重试即可。
- 认证只有公钥一条路：2026-07-25 已关闭密码登录与 root 密码登录；近 60 天成功登录 100% publickey，密码 0 次。
- `/root/.ssh/authorized_keys` 只有一把 `id_ed25519`（`Rayman.Chen@RaymanMacBook-Air.local`）。

## 排障与安全边界

- fail2ban：`sshd` jail，5 次失败封 2 小时。连不上先查 `fail2ban-client status sshd`，解封用 `fail2ban-client set sshd unbanip <IP>`。
- 不要在这台机器上跑 `pkill -f <pattern>`：pattern 会匹配到当前 ssh 命令行导致自杀。改用 `pgrep` + `kill` 或 `fuser -k <PORT>/tcp`。
- 磁盘：2026-07-25 清理后 49%（曾 71%）。journald 已限 `SystemMaxUse=500M`；docker build cache 需定期手动清：`docker builder prune -af`（上次积 5.59GB）。
- 容器日志尚未设 `max-size` 上限；改 `daemon.json` 需要重启全部容器，必须等川哥给时间窗。
