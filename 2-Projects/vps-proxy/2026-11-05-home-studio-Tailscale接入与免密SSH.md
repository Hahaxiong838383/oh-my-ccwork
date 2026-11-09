# home-studio 接入 Tailscale 与免密 SSH（2026-11-05）

## 结论

`hahaxiong-home-studio`（Ubuntu 24.04.4，无头）已接入 Tailscale，并作为**第二套 overlay** 与既有 EasyTier 并存，不冲突、不互相改写 DNS。

| 项 | 值 |
|---|---|
| 版本 | Tailscale 1.104.5（官方 apt 源） |
| 设备名 | `hahaxiong-home-studio` |
| Tailscale IPv4 / IPv6 | `100.101.2.86` / `fd7a:115c:a1e0::632b:257` |
| 账号 | hahaxiong83@gmail.com |
| operator | `hahaxiong83` → `tailscale up/status/down` 免 sudo |
| DNS | `--accept-dns=false`（MagicDNS 关闭） |
| SSH | `RunSSH=true`，`ssh hahaxiong83@100.101.2.86` 走 tailscaled SSO，不需要密钥 |
| 服务 | `tailscaled` active + enabled（开机自启） |

网段：

- EasyTier `10.10.10.0/24`（本机 `10.10.10.23`）
- Tailscale `100.64.0.0/10`（本机 `100.101.2.86`）、IPv6 `fd7a:115c:a1e0::/48`
- 两者不重叠，可以并存；Tailscale 不做 exit node，也不 advertise routes

## 安装与上线

`sudo` 需要密码，本机不代输密码（红线），所以系统级动作写成幂等脚本交本人执行：

```bash
# 1) 装包 + 起服务 + 设 operator（一次性）
sudo bash ~/.hermes/cache/scratch/install-tailscale.sh

# 2) 生成登录链接（operator 生效后普通用户即可，无需 sudo）
tailscale up --accept-dns=false --hostname=hahaxiong-home-studio
```

脚本做的事与要点：

```bash
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
chmod 0644 /usr/share/keyrings/tailscale-archive-keyring.gpg /etc/apt/sources.list.d/tailscale.list
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
systemctl enable --now tailscaled
tailscale set --operator=hahaxiong83     # 关键一步，漏了每次 up/status 都要 sudo
```

`tailscale ssh` 侧独立开启（operator 下不需要 sudo）：

```bash
tailscale set --ssh
```

## 无头抓登录链接的正确姿势

`tailscale up` 未登录时会把 URL 打到 stderr 然后**一直阻塞**，用 timeout 截断的话容易误判成失败：

```bash
timeout 25 tailscale up --accept-dns=false --hostname=hahaxiong-home-studio 2>&1 | tee /tmp/tsup.log
# 输出: To authenticate, visit: https://login.tailscale.com/a/<code>
# 末尾 context canceled 是 timeout 杀客户端，不是失败
```

客户端被杀不影响 daemon 的待认证状态，`tailscale status` 会继续显示 `Log in at: <同一链接>`，用户在浏览器点完即自动完成登录。无头机不需要屏幕，也不需要预先准备 auth key。

## 验证（要可复现的判据，不看“状态页好看”）

```bash
tailscale status                     # 已登录时列出全网设备
tailscale ip -4                      # 100.101.2.86
ip -4 addr show tailscale0           # inet 100.101.2.86/32
tailscale ping <peer>                # 首包可能 via DERP，随后转直连
tailscale netcheck                   # UDP: true / Nearest DERP
```

实测：`tailscale ping mac-mini` 先 `via DERP(nue) 1.35s`，100ms 内转 `via 222.128.47.46:2135 9ms`；`ping 100.79.113.66` 2/2 收，avg 17ms。

## 教训

1. **无头机本地验证不了 Tailscale SSH**：`ssh hahaxiong83@100.101.2.86` 从本机发起走 loopback，不经过 tun，仍然落到本机 sshd，会得到 `Permission denied (publickey,password)`——**这不代表 SSH 没开**。必须从另一台 tailnet 设备发起。
2. **成功判据在服务端日志，不在客户端提示**：`journalctl -u tailscaled | grep ssh-session` 出现 `access granted`、`audit: SSH login: ... from=100.x ts_user=... node=...` 即通；`who` 的登录来源也应是 `100.x`。客户端那条 `authenticity of host ... can't be established` 是正常提示（host key 与本机 sshd 同一个，所以指纹和 `192.168.1.133`、`10.10.10.23` 一致），别据此判断“走了普通 sshd”。
3. **`tailscale up` 会重置没显式给出的 flag**：先用 `tailscale set --ssh` 开的 SSH，日后重跑 `tailscale up` 会被关掉。重跑必须写全：`tailscale up --ssh --accept-dns=false`，或用 `tailscale set` 逐项改。
4. **xray 的 `geoip:private` 会掩盖 NO_PROXY 缺失**：不加 Tailscale 网段时 `curl http://100.x:port` 也返回 200（代理按私有地址直连兜底），所以“能通”不能证明 NO_PROXY 配对了。用 `curl -sv ... | grep -E 'Trying|Connected to'` 看真实路径：有 NO_PROXY 时 `Trying 100.101.2.86`，没有时 `Trying 127.0.0.1:10808`。
5. **两处 `NO_PROXY` 必须同步改**：`~/.bashrc`（覆盖 `ssh host 'cmd'` 这类非交互 shell，且在“非交互 return”之前）与 `/etc/profile.d/xray-proxy.sh`（覆盖登录 shell / 桌面会话 / `su -`）。两边都是 `${VAR:-}`，**先设的那份赢**，改一处不改另一处会出现“换了个 shell 就不生效”。

## 本次改动的落点

| 位置 | 改动 |
|---|---|
| `/usr/share/keyrings/tailscale-archive-keyring.gpg`、`/etc/apt/sources.list.d/tailscale.list` | 新增官方源 |
| `tailscaled` | 安装、enable、operator=hahaxiong83、RunSSH=true |
| `~/.bashrc` | `NO_PROXY`/`no_proxy` 增加 `100.64.0.0/10,fd7a:115c:a1e0::/48` |
| `/etc/profile.d/xray-proxy.sh` | 同上（已备份 `xray-proxy.sh.bak-20261105-223639`） |
| A 库 `user_hardware.md` | 记录 Tailscale IP、SSH、两处 NO_PROXY |
| 技能 `headless-linux-privileged-install` | 沉淀本流程与 5 条坑 |

## 待办（未做，需川哥决定）

- **系统待重启**：内核已更新但未重启，另有 141 个待更新包（6 个标准安全更新）。重启要走 `home-studio-reboot-preservation` 保全流程，不擅自执行。
- **26.04.1 LTS 可升级**：未动。
- **Tailscale ACL**：当前用默认策略（`autogroup:member` 可访问全部设备）才让 SSH 直接通；日后若收紧 ACL，要保留 `ssh` action 规则，否则 SSH 会被拒。
- **Tailscale SSH 的 `check` 模式**：当前是默认放行（同账号自访），若要二次确认/定期重验，需在 ACL 里改 `action: check`。

## 2026-11-09 复核（并入幕僚长 Tailscale 记忆导出件后）

导入导出件（幕僚长 RecallMemory，`tailscale-memory-2026-11-09.md`）时按实测校对，三处不符，以实测为准：

| 导出件说法 | 实测 | 处理 |
|---|---|---|
| 四机组网（box / Mac Studio / Mac mini / home-studio） | `tailscale status` 共 **9 台**（本机 + 8 peer），在线 4 台：Mac Studio `100.111.199.5`、Mac mini `100.79.113.66`、MacBook Air `100.127.123.50`、maxtkf-server `100.115.63.120`；离线：box `100.96.198.7`、`100.116.67.54`、muse `100.68.172.102`、CC S24 Ultra `100.94.37.118` | 记 9 台清单 |
| box 已纳入 ensure-up / ensure-watchdog 保活 | box（`grok-bot-vm-478370779`）离线 2 天，`:3080` 无响应 | 川哥 11-09 告知：**云机额度用尽，过几天恢复**，属预期停机，不排查保活/网络 |
| 家用 Mac Studio EasyTier `10.10.10.23` | 该 IP 是本机 home-studio 的 `easytier0` 实测值 | 归属纠正为 home-studio |

合并进长期记忆的位置：A 库 `user_hardware.md` 的「Tailscale tailnet 真值」节（设备表 + EasyTier 旁路 + DERP 策略 + 自启/保活授权边界 + 连通边界）；技能 `headless-linux-privileged-install` 的 references 记 6 条操作边界（不含 IP 清单，避免漂移）。

实测确认仍然成立的点：Tailscale 段与 EasyTier 不冲突；`accept-dns=false` 未改动本机 DNS；公司两台 Mac 的 Tailscale 自启仍按川哥手配（勿改）；DERP 走官方（自建已退回）；dev198 在公司网 NAT 直连不通，仍是「TS → 公司 Mac → 公司网 10.10.10.13」。

## 2026-11-09 Mac Studio 直连不稳的根因诊断

症状：早上 Mac 弹 `Relay Server Unavailable / no-derp-connection`（Nuremberg），体感像断网。

**结论：不是故障，是「对称 NAT + 公司多出口」导致冷态打洞慢，期间只能靠远端 DERP 兜底；而 Studio 开着 MagicDNS，tailnet 一抖连 DNS 一起断。**

实测定量（SSH 进 `fu-121@100.111.199.5`，本机公钥已授权）：

| 项 | Mac Studio | Mac mini |
|---|---|---|
| 公网出口 | `111.194.62.218` | `222.128.47.46`（**同 192.168.61.x 网段，出口不同**） |
| `MappingVariesByDestIP` | true（对称 NAT） | true（对称 NAT） |
| PortMapping（UPnP/PMP/PCP） | 空 | 空 |
| 系统代理 | 全开 → `127.0.0.1:10808` | 全关 |
| MagicDNS (`CorpDNS`) | **true**（DNS 指向 100.100.100.100） | 未查 |

直连表现：打通后 Studio↔家 **9–10ms**、mini↔家 **7–8ms**，稳定；但冷态要几十秒，期间 nue 中继 391–398ms（mini 头两包 885ms/374ms 才转直连）。

Studio 侧 DERP 真实延迟（`curl --noproxy '*'`）：

| 目标 | connect | TLS |
|---|---|---|
| 野草云自建 derper `:8888` | **58–86ms** | 126–147ms |
| 官方 nue `derp26d` | 143ms | 286ms |
| 官方 hkg `derp20d/b/c` | 234ms | 480ms |
| 官方 tok `derp7e` | 265ms | 527ms |

**两处误判已纠正**

1. 早前说「官方香港 DERP 不可达」是错的：我用了不存在的主机名 `derp20e`（该节点已下线，DNS 无解析），`curl` 返回 code 000 被当成封锁。真实 hkg 节点 `derp20d/b/c` 可达，234ms。
2. 早前怀疑「系统代理导致连不上」也是错的：`lsof -nP -iTCP:10808` 的客户端里没有 Tailscale——macOS 的 tailscaled 走 Network Extension，不读系统 HTTP 代理。给 DERP 域名加 xray direct 规则**对 tailscaled 无效**，只影响 shell 的 curl/git（同一目标走代理 1.26s vs 直连 0.12s）。

**处置**

- 接自建 HK derper 进 tailnet：region 901 / `DERPPort: 8888`（443 被 EasyTier 占），保留官方兜底。接入后冷态中继从 nue 392ms 降到 ~100–150ms。
- 给 Studio 关 MagicDNS（`accept-dns=false`）：避免 tailnet 抖动变成整机 DNS 断网；代价是失去 `<host>.<tailnet>.ts.net` 解析，SSH 改用 100.x IP。
- 直连不必再修：对称 NAT + 多出口环境下的冷态慢是结构性的，靠 peer relay 优于靠调参。
