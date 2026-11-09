---
name: headless-linux-privileged-install
description: 无头 Linux 装系统包/服务时用；sudo 需密码不代输，交用户执行。
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [linux, apt, sudo, headless, tailscale, overlay-network]
    related_skills: [home-studio-boot-maintenance, home-studio-reboot-preservation]
---

# 无头主机系统级安装（sudo 需密码）

## When to Use

- 用户要求在一台无显示器/远程 Linux 机上安装系统包、加 overlay 网络（Tailscale/easytier 等）或起 root 级服务，而 `sudo -n true` 失败、必须输密码。
- 装有完成但需要用户点账号授权链接（无头登录）的场合。
- 不适用：已有免密 sudo 的普通装包、纯用户级（pip/npm --user）安装、重启验收（用 `home-studio-boot-maintenance`）。

适用主机形态：远程 SSH/ACP 接入的 Linux 服务器或工作站，用户 `hahaxiong83` 类普通账号在 sudo 组但需密码。目标是“一次 install、后续全部由 agent 免 sudo 操作”。

## 1. 一次批量探明环境（不要逐个命令试）

同一条命令里取全：`hostname`、`/etc/os-release`、目标二进制是否已装、`systemctl is-system-running`、`sudo -n true`（判断免密）、`id`（是否在 docker/sudo 组）、`ip -4 addr`（**既有 overlay/容器网段**）、`/etc/resolv.conf` 是否走 systemd-resolved、出站可达性（`curl -o /dev/null -w '%{http_code}'` 目标源）。

- 先看既有 overlay 网段再选新网络：本机常有 easytier 之类占着 `10.x`，新装的 mesh（如 Tailscale `100.64/10`）不得与它重叠。
- 服务器类主机上会改 DNS 的组件（MagicDNS 等）默认关掉或先与用户确认，`/etc/resolv.conf` 被改会连带打断既有组网域名解析。

## 2. 提权边界（硬规则）

- **不代输密码，也不接收聊天里给的密码**，包括从凭据文件里翻 sudo 密码。密码 stdin 方案（`echo pw | sudo -S`）同样不做。
- **不擅自用 docker 组 / `--privileged` + 宿主根挂载绕过 sudo**：这等效 root，属于越过用户密码控制，必须先得到用户一句明确授权；未授权时只作为“选项 B”提出。
- 首选“选项 A”：把幂等脚本写到 scratch 目录，给用户**一条**命令 `sudo bash <路径>`，他跑完我再接管。用 A/B 两选项让用户一句话选，不要长篇解释。
- 新增 apt 源、装包、enable 服务属于用户已授权的动作；除脚本外不改 `sources.list.d` 里的既有条目。

## 3. 脚本约定

写到 scratch / 工作区的 `install-<pkg>.sh`，`set -euo pipefail`，`bash -n` 校验后交付。必须具备：

1. 幂等：目标二进制已存在就跳过源配置与安装，直接进入服务启用。
2. 官方源：keyring + `sources.list.d` 条目，权限 `0644`；不要用第三方镜像或 `curl | sh` 安装脚本。
3. `systemctl enable --now <svc>` + `sleep 2` + `systemctl is-active` 实地确认，不用“命令退出 0”当成功。
4. **把当前用户设为 operator**（如 `tailscale set --operator=$USER`），这是“后续免 sudo 管理”的关键一步；漏了这步每次 `up/status` 都要 sudo。
5. 结尾打印版本、服务状态和 daemon 摘要，便于用户贴回。

## 4. 装完的核验与授权

- 用户执行后先 `systemctl is-active` + 版本 + `status` 复核，再进业务配置。
- 需要账号授权（登录 URL）时，由 agent 跑 `up` 拿到 URL 交给用户点，**不代替用户授权、不猜凭据**；vault 为空时不要编造凭据来源。
- 结论先行汇报：已装/未装、卡在哪一层、下一步谁做什么。安装尚未完成时不得写成“已安装”。

## 5. 常见坑

- 判断软件源是否可用时别猜索引路径：Ubuntu 官方源索引是 `.../dists/<suite>/main/binary-amd64/Packages.gz`，直接请求 `.../<suite>/Packages.gz` 会 404，容易被误判成源挂掉。验证用 `curl -sS ... | gunzip -c | grep -A6 '^Package: <name>$'`。
- 内存里的主机 IP/别名不可信，装机前用 `hostname` + `ip addr` 取真值。
- `apt-get update` 全量较慢属正常，别用管道截断输出导致看不到失败。

Tailscale 具体配方（源 URL、operator、参数选择、装后自检）见 [references/tailscale-headless.md](references/tailscale-headless.md)；多机 tailnet 的既有边界（不改他人自启、DERP 保持官方、NAT 节点走跳转）见该文件末节。

## 本技能的维护位置

真身在 `~/mycc/.claude/skills/headless-linux-privileged-install/`，`~/.hermes/skills/agent-infra/` 下是软链（mycc 已列入 `skills.trusted_project_dirs`）。**改本技能要用文件编辑工具（patch/write_file）直接改仓内文件**：`skill_manage` 只编辑 profile 目录内的实体技能，对软链技能会报 `not found in active profile 'default'`，不要误以为技能丢了。
