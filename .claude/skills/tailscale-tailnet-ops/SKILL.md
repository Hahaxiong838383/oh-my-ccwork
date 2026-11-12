---
name: tailscale-tailnet-ops
description: 排查 Tailscale 连通性与 DERP/自建 derper 时用。
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [tailscale, derp, derper, peer-relay, tailnet, nat-traversal]
    related_skills: [headless-linux-privileged-install, easytier-mesh-ops]
---

# Tailscale tailnet 运维（连通性 / DERP / 自建 derper）

## When to Use

- 用户问“tailscale 稳不稳”“为什么走中继”“某台机器连不上”“自建 derper 有没有用”“早上弹了 Relay Server Unavailable”。
- 首次安装、登录授权不在这里：见另一个技能 `headless-linux-privileged-install`（其 tailscale 配方文件按该技能自己的 references 目录取）。
- 不适用：纯 EasyTier 组网问题（用 `easytier-mesh-ops`）。

## 1. 先取真值，再判断

```bash
tailscale status --json      # Self.Relay；每个 peer 的 Relay 与 CurAddr
tailscale ping -c 3 <peer>   # 路径常“前几包 DERP，随后 via <ip:port>”
tailscale netcheck           # UDP / MappingVariesByDestIP / PortMapping / 各区域延迟
```

判读规则：

- **`CurAddr` 为空 = 当前在走中转**；有值 = 已直连。别只看 `status` 的文本列，它不告诉你谁在中继。
- **一次 `tailscale ping` 全是 `via DERP(xxx)` + `direct connection not established` 只说明“此刻还没打通”，不是“打洞失败”的判决**。冷启动/重连后的几十秒到一两分钟内它先用 home DERP 兜着，随后自己转直连；同一对 peer 常在同一刻钟里从 `via DERP(nue) 392ms` 变成 `via <公网IP:port> 9ms`。判据：间隔 3-5 秒连续采样 4-5 次，或隔几分钟复采一轮，**只有跨分钟的多轮都拿不到 `via <ip:port>` 才判失败**。据单次采样给用户下“这台打不通”的结论是本类问题最容易犯的错。
- **分清 peer 的 `Relay` 与 `CurAddr`**：`Relay` 是它选的 home DERP（可能停在远端区域如 nue/sfo，长期不变），`CurAddr` 才是当前实际路径。`Relay: nue` + `CurAddr: <公网IP:port>` = 已在直连，把 `Relay` 当连接方式会得出相反结论。文本列看不出谁在中继，一律读 `status --json` 的这两个字段。
- **远端区域只在打洞窗口里伤人**：`Relay Server Unavailable` / `no-derp-connection` 多半就发生在这个窗口——还没打通、兜底中继又挂了，等于全断。所以修法有两条并行：缩短打洞窗口（§2）、把兜底中继挪近（§3）。
- **同一局域网 ≠ 同一公网出口**：宣称“同网”的多台机器常因多线出口 / VPN / 代理映射到不同 egress IP（两台 endpoint 的公网 IP 段可以完全不同）。逐台看 endpoint，别用“它们同网”推断同一种 NAT，也别据此套用同一套修法。
- **横向对比定责**：同一台本机与 A 能直连、与 B 不能，问题多半在 B 侧网络/防火墙，别在本机反复调参——前提是先按上面几条排除冷态与 `Relay`/`CurAddr` 误读。
- `MappingVariesByDestIP: false` + `PortMapping: UPnP/NAT-PMP/PCP` 说明本侧 NAT 不刁难，打不通基本在对方；**对端是否对称 NAT 只能在它本机跑 `netcheck` 才知道**，拿本机数据硬推对端 NAT 类型是猜。
- **`netcheck` 的 DERP 延迟表 ≠ 中继可用性**：它测的是探针 RTT，与中继实际走的 TCP/TLS 会话是两件事。表中某区域 200ms 级“可用”，实测 `curl https://<该区 derp 节点>/` 可能直接 `code 000`（TCP 443 根本建不起来）。判断“该区域能不能当中继”只认目标客户端上的 TCP+TLS 实测，别拿延迟排序下结论；反过来，延迟表把某区域排第一也不代表它是好中继。
- 平台差异与取数命令（macOS CLI 路径、无 `timeout`、系统代理污染 `curl` 计时、egress IP 对比）见 `references/platform-probes.md`。

### 够不到对端时：先解决访问，不要凭猜

- `nc -zv <tailnet-ip> 22` 通、`ssh` 却报 `Permission denied (publickey,password,keyboard-interactive)` = 链路没问题，只缺授权。做法是把本机公钥（`cat ~/.ssh/id_ed25519.pub`）连同一条可直接粘进对端终端的 `authorized_keys` 命令交给用户；**不索要密码、不让用户把密码贴进对话**（凭据走 vault，见 `secrets-vault-ops`）。
- 对端的 codeg / web 服务返回 200 只证明端口可达，不提供 shell；别把 HTTP 200 当成“能远程执行诊断”。
- 真拿不到对端数据时，明确列出只需要对端跑的三条（`tailscale netcheck`、`tailscale status | head -3`、对端平台的代理检查如 macOS `scutil --proxy`），并把“需要这组数据才能定性”说清楚，不要用本机数据硬推对端。

## 2. 中继的必要性：先修直连，再谈中继

频繁走 DERP 时按这个顺序处理，不要直接上自建 derper：

1. **查打洞为什么失败**（对方 UDP 出站被封？对称 NAT？代理/防火墙？）。
2. **Peer Relay**：tailnet 内已能与双方直连的节点当中继（`tailscale set --relay-server-port`、`--relay-server-static-endpoints`）。比跨洲 DERP 快得多，且不产生 VPS 出口成本。
3. **自建 DERP**：官方明确标 alpha，最后手段。

延迟账：DERP 是单条 TCP 中继，吞吐受 RTT 限制。跨洲区域（欧洲/美西 150-400ms）造成明显卡顿；同区区域（HK/Tokyo 50-80ms）能改善一个量级，但仍不等于直连。

## 3. 自建 derper：部署 ≠ 生效

**第一个问题永远是“客户端到底有没有用它”**：

```bash
tailscale debug derp-map | jq -r '.Regions[] | "\(.RegionID) \(.RegionName)"'
```

只列出官方区域 = tailnet 的 DERP map 仍是默认，你跑的 derper 完全没接入（此时客户端报的 DERP 故障与它无关）。接入靠 tailnet policy JSON 的 `derpMap`（region 900-999 保留给自定义），模板见 `templates/derpMap-region.json`。

接入时必须核对四件事：

| 项 | 要求 | 漏了会怎样 |
|---|---|---|
| `DERPPort` | 非 443 时**必须**写进 Nodes | 客户端连 443 打不通（该端口常被其它服务占，如 EasyTier） |
| 保留官方区域 | 不要设 `OmitDefaultRegions` | derper 单点故障时无 fallback |
| `verify-clients` | 想只服务自己 tailnet 就设 `true` | `false` = 开放中继，公网任意客户端可白嫖（日志会出现陌生 IP 扫 TLS） |
| STUN 端口 | 需 UDP 3478 真实可达 | 供应商面板防火墙常只放 tcp 白名单，UDP 被静默丢；netcheck 显示 STUN 不可用，只影响打洞辅助，relay 仍可用 |

另外：每个 region 只允许一台 DERP；derper 需随客户端升级重建（`go install tailscale.com/cmd/derper@latest`）；自定义区域不支持 regional routing。

### 公网 IP 变了：DNS 和 `derpMap` 的 `IPv4` 是两处

`tailscale debug derp-map` 里该 region 的 `IPv4` 有值时，客户端拨这个地址，不跟 `HostName` 的 A 记录走。只改 DNS，地图可以仍是旧 IP。改 tailnet policy 的 `IPv4`，或删掉该字段只留 `HostName`。

下发后在至少两台客户端核对，缺一不可：

1. `debug derp-map` 里该 region 的 `IPv4` 已是新地址，`DERPPort` 仍是非 443。
2. 新地址的 `DERPPort` 能建立 TCP；`curl --noproxy '*' --resolve <host>:<port>:<ip> https://<host>:<port>/` 返回 200。
3. `tailscale netcheck` 里该区域有延迟数字。成为 `Nearest DERP` 不是验收条件。

现场核查 derper 本身（在本机或 SSH 到那台 VPS）：`systemctl status derper`、`ss -tlnp | grep derper`、`openssl s_client -connect <host>:<port> -servername <host>` 看证书有效期、`curl -o /dev/null -w '%{http_code}' https://<host>:<port>/` 看 200。

### 接入后的生效验证（四步，缺一不可）

1. `tailscale debug derp-map | grep 901` —— policy 已下发。
2. `tailscale netcheck` 里该区出现且成为 `Nearest DERP`。
3. `tailscale status --json` 看 peer 的 `Relay` 字段从远端官方区变成自定义区代号。
4. 在 derper 机器上 `ss -tn state established '( sport = :<port> )'` —— 应能看到家和公司各自出口 IP 的保持连接。

实测对照（2026-11-09，香港 derper 8888）：家侧 901 `48.6ms` vs 官方 tok 57.1 / nue 138.5；公司 Studio 侧 901 `50.1ms` vs nue 189.4 / hkg 223（tok 探测失败）；公司 mini 冷态中继从 `374–885ms` 降到 `93–94ms`，随后照常转直连。

注意：客户端自己的 `Self.Relay` 可能仍停在官方区不换（本案家侧停在 tok），属正常——中继优先级由各 peer 各自协商，不影响实际转发。

## 5. 公司/受限网络实测坑（2026-11-09 钉死）

- **测 DERP 别猜主机名**：从 `tailscale debug derp-map` 取真实节点名（每区 3-7 个）。猜出来的（如 `derp20e`）可能根本不存在，`curl` 报 `code 000` 会让你误判“该区域不可达”。
- **macOS 系统代理会污染测速**：`curl` 默认走系统代理（常有 127.0.0.1:10808），`time_connect` 只有 0.0006s（那是连本地代理）。必须 `--noproxy '*'`。实测同一目标走代理 1.26s vs 直连 0.12s。
- **tailscaled 不走系统 HTTP 代理**（macOS Network Extension 自管）：`lsof -nP -iTCP:10808` 的客户端列表里没有 Tailscale。所以给 DERP 域名加 xray `direct` 规则对 tailscaled 无效，它只影响 shell 里的 curl/git。
- **MagicDNS 是故障放大器**：`CorpDNS=true` 时系统 DNS 指向 `100.100.100.100`，tailnet 一抖 DNS 一起断，体感“整机断网”。关闭只需 `tailscale set --accept-dns=false`（macOS 上无需 sudo，几秒生效），系统 DNS 自动回 DHCP/手动值。
  改前后必比对：`scutil --dns | grep nameserver`、`networksetup -listnetworkserviceorder`、以及特定网络服务（如雷电网桥 `networksetup -getinfo "TD to mini"`）——证明只改了 DNS，没动用户的桥接/服务顺序。代价是失去 `<host>.<tailnet>.ts.net` 与短主机名解析，SSH 改用 100.x IP。
- **同内网段多公网出口 = 打洞灾难**：判据是两端 `netcheck` 的 `MappingVariesByDestIP` 与 `IPv4` 出口地址对比。若两台各在不同的公网出口、又都是对称 NAT 且无端口映射，冷态打洞几十秒属正常，不要当成故障去调参。
- **延迟账（该网络实测）**：官方 DERP 全都 140-250ms（nue 143 / hkg 234 / tok 265），同机自建 HK derper 只要 58-86ms——自建 derper 在此类网络确有 3 倍优势，但仍只在 relay 阶段生效，直连打通后不参与。
- **macOS 上没有 `timeout`**：远程脚本里别用 `timeout` 包命令（zsh: command not found），改用 `ssh -o ConnectTimeout`。tailscale CLI 在 mini 这类机器可能不在 PATH，用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。

## 6. 常见坑

- **客户端报 `Relay Server Unavailable` / `no-derp-connection`**：它选定的 home DERP 不可达（常见是被分到远端区域）。先按 §1 判定这是**打洞窗口内的阶段性**（隔几分钟能转直连）还是**长期无直连**；前者修打洞速度、把兜底中继挪近，后者才谈换网络/peer relay。别把报错当成“Tailscale 服务端故障”，也别因为一次采样就断言某台机器不能直连。
- **在被测机器上量链路前先看它有没有系统代理**：桌面系统（尤其 macOS）的 `curl` 默认吃系统代理，`time_connect` 会变成“与本地代理握手”的 0.000x 秒，看起来极快、实际没测到目标；必须 `curl --noproxy '*'`。同理，`ProxyEnable=1` 的机器上任何 HTTP 计时类结论都要复核一遍。
- **MagicDNS 会把 tailnet 故障放大成整机断网**：`CorpDNS: true` 时系统 DNS 首个 nameserver 变成 `100.100.100.100`，tailnet 一断，域名解析全挂，用户体感是“整个网没了”而不只是 Tailscale 不通。排障时先分清“tailnet 断”还是“DNS 跟着断”，并把关掉 MagicDNS 作为可选缓解（改用户手配的机器前要授权）。
- **改别人机器的 Tailscale 配置前要一句明确授权**：用户手配过开机自启/登录方式的节点属“勿动”范围；加 peer relay、改 tailnet policy 都算改配置。
- **面板防火墙 ≠ 机内 iptables**：VPS 机内 `iptables -S` 全 ACCEPT 不代表端口能进；症状与 NAT 打洞失败同形（自建 DERP/中继端口被静默丢弃）。
- **IP/拓扑真值不抄进技能**：查 A 库 `user_hardware.md` 的 tailnet 节（随时间变化，技能里只留判据与流程）。
- 判断“有没有改善”必须给对照数据（改前后 `tailscale ping` 的路径与 RTT），不要用“应该更快了”收尾。

## 7. 把 derpMap 交给用户粘贴时

- **只给要插入的片段**（`"derpMap": {...}`），不要给带最外层 `{}` 的完整文档。用户会整段粘进已有的根对象里，结果是 `], { "derpMap": ... }` 或残留 `},`，Tailscale 报 `invalid character ']' at start of value`——这是纯语法问题，别去怀疑配置字段。
- 明确交代：它是**键**，与 `"grants"` 平级；前面保留逗号，后面若还有 `postures` 等键则写 `},`。
- 让对方先用编辑器的 **Preview changes** 校验再 Save。

## 本技能的维护位置

真身在 `~/mycc/.claude/skills/tailscale-tailnet-ops/`，`~/.hermes/skills/netops/` 下是软链（mycc 已在 `skills.trusted_project_dirs`）。**改本技能用文件编辑工具直接改仓内文件**：`skill_manage` 只编辑 profile 目录内的实体技能，对软链技能会报 `not found in active profile 'default'`。跨平台取数命令见 [references/platform-probes.md](references/platform-probes.md)。
