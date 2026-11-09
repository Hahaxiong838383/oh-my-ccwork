# Tailscale 无头安装配方（Ubuntu noble / 24.04）

## 源（已实测可达）

```
https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg            # keyring
https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list # 内容: deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main
https://pkgs.tailscale.com/stable/ubuntu/dists/noble/main/binary-amd64/Packages.gz  # 索引（grep '^Package: tailscale$' 看版本）
```

## 脚本骨架

```bash
set -euo pipefail
OPERATOR="${OPERATOR:-$SUDO_USER}"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
  chmod 0644 /usr/share/keyrings/tailscale-archive-keyring.gpg /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
fi
systemctl enable --now tailscaled && sleep 2 && systemctl is-active tailscaled
tailscale set --operator="$OPERATOR"   # 之后普通用户可 up/status/down，无需 sudo
```

## 上线与参数选择

- `tailscale up` 会打印 `https://login.tailscale.com/a/...` 授权链接，交给用户在自己的账号里点。无头机不需要屏幕，也不需要 auth key；只有用户提供 key 时才用 `--auth-key`。
- 服务器/组网主机建议 `--accept-dns=false`，避免 MagicDNS 改写 `/etc/resolv.conf` 干扰既有 easytier 等 overlay 的域名解析；要 MagicDNS 便利再显式开启。
- 主机名默认取系统 hostname，多机环境可加 `--hostname=<可读名>`，与既有设备命名保持一致。
- 核对网段：Tailscale `100.64.0.0/10` 与 easytier 常见 `10.x` 不冲突；若用户自定义了 `100.x` 段则先改。

## 装后自检

```bash
tailscale version | head -1
tailscale status            # 未登录时返回退出码 1 + "Logged out"，属正常
ip -4 addr show tailscale0  # 登录后才出现
systemctl is-enabled tailscaled
tailscale netcheck           # 出口类型/NAT/延迟，排查直连不通
```

`accept-routes` / `--advertise-routes` 只在需要子网路由时开，开了要让用户在管理后台批准；exit node 同理。

## 无头抓登录链接（agent 不阻塞）

`tailscale up` 未登录时会把 URL 打到 stderr 然后**一直阻塞**。用 `timeout 25 tailscale up --accept-dns=false --hostname=<名> 2>&1 | tee tsup.log` 抓链接；客户端被 timeout 杀掉不影响 daemon 的待认证状态，`tailscale status` 会继续显示 `Log in at: <同一链接>`，用户点完即自动完成登录。别把 `context canceled` 当成失败。

## Tailscale SSH（无头机远程登录的干净路径）

`tailscale set --ssh` 在 operator 已设的情况下**不需要 sudo**（返回 0，`tailscale debug prefs | grep RunSSH` 为 true；`tailscale debug netmap` 里出现 `SSHPolicy`/`sshUsers`/`cap/ssh` 即 daemon 侧已启用）。

- 验证只能在**另一台 tailnet 设备**上发起：本机 `ssh hahaxiong83@<自己的 100.x>` 走 loopback，不经过 tun，仍落到本机 sshd，会得到 `Permission denied (publickey,password)`，**不代表 Tailscale SSH 没开**。
- 成功的判据在服务端日志，不在客户端提示：`journalctl -u tailscaled | grep ssh-session` 应出现 `ssh-session(...): access granted ...` 与 `audit: SSH login: user=... from=<对端 100.x> ts_user=<tailnet 账号> node=<对端主机名>`，`who` 里登录来源也应是 `100.x`。客户端看到 `authenticity of host ... can't be established` 属正常（host key 与本机 sshd 同一个，故与局域网/组网地址指纹一致），**不要据此误判成走了普通 sshd**。
- ⚠️ `tailscale up` 会把未显式给出的 flag 重置回默认值，登录后用 `set` 调过的 `--ssh`/`--accept-dns` 会被抹掉。以后重跑 up 要带全参数：`tailscale up --ssh --accept-dns=false`，或改用 `tailscale set` 逐项改。

## 装了 xray/HTTP 代理的主机

`NO_PROXY` 常写成 `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`，**不含 `100.64.0.0/10`**：`curl http://100.x.x.x:<port>` 会被代理劫持失败。tailscaled 自身是 UDP 直连不受影响（`tailscale ping` 正常），SSH 也不读 `http_proxy`。只有要访问 tailnet 内 HTTP 服务时，才把 `100.64.0.0/10` 补进 `.bashrc` 与 `/etc/profile.d/*.sh` 两处 `NO_PROXY`（两处 `${VAR:-}` 谁先设谁赢，必须同步改）。

## 多机 tailnet 的既有边界（本机已在 4+ 台设备的 tailnet 里）

- IP 全表与 EasyTier 并行网段以 A 库 `user_hardware.md` 的「Tailscale tailnet 真值」节为准，**不要把 IP 抄进技能**（会漂移）。
- **不碰已经由用户手配好开机自启的节点**（公司两台 Mac 是他本人配的），也不要批量改别人节点的配置。
- 重新登录由 agent 用密码库账号操作，**遇验证码/设备确认才找人**，不猜凭据。
- DERP 保持**官方**，不要把自建 DERP 改回去（历史上自建已退回官方）。
- 已知不可达节点（如公司网内 dev198 因 NAT 直连不通）走「TS → 公司 Mac → 公司网」跳转，不要反复调本机参数硬直连。
- box 类云机重启后先跑它自己的 `ensure-up.sh`（`sudo -n`，免密）拉起 overlay，再判断连通性。
