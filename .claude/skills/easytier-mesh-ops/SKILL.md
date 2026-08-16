---
name: easytier-mesh-ops
description: 家↔公司 EasyTier 异地组网（chuan-mesh）的部署、排障与扩容 SOP。触发词："组网"、"异地组网"、"EasyTier"、"easytier"、"野草云"、"mesh-status"、"虚拟内网"、"连不上公司/家里的机器"、"10.10.10."、"10.10.61."、"子网代理"、"NAS 访问不了"、"P2P 打洞"、"加一台机器进组网"。涵盖：6 节点拓扑真值、部署脚本用法、排障决策树（连不上/变中继/丢包/设备列表空）、判读规则（哪些读数不可信）、平台差异坑。
layer: 基建层
authorization: B区（改生产机网络配置需明确 scope；hk-relay 是唯一发现节点，改它会短暂断全网发现）
output_levels: L1
---

# EasyTier 异地组网运维

项目仓库：`~/mycc/2-Projects/vps-proxy/Cross-site mesh-EasyTier/`
记忆：`rg easytier ~/.claude/projects/-Users-rayman-chen-mycc/memory/`

---

## 一、拓扑真值（改动前先对照，不要凭记忆）

| 节点 | 虚拟 IP | 位置 | 角色 | NAT |
|---|---|---|---|---|
| hk-relay | `10.10.10.1` | 野草云 HK `207.57.124.191` | 发现 + 中继兜底 + 控制台 | PortRestricted |
| mini | `10.10.10.11` | 公司有线 `.66` | 公司子网网关（主） | **Symmetric** |
| studio | `10.10.10.12` | 公司有线 `.177` | 算力 | **Symmetric** |
| dev198 | `10.10.10.13` | 公司有线 `.233` | 公司子网网关（备） | **Symmetric** |
| linux-lan | `10.10.10.21` | 家有线 `.119` | 家侧子网网关 | **PortRestricted** |
| air | `10.10.10.31` | 移动 | 笔记本 | PortRestricted |

**子网映射**（末位不变只换前缀）：公司 `192.168.61.X`→`10.10.61.X`，家 `192.168.1.X`→`10.10.1.X`
**上游通道**（每节点 3 条冗余）：`tcp://207.57.124.191:443` · `udp://…:22` · `udp://…:11010`
**两个内网界面**：`10.10.10.1:11211` 控制台 · `10.10.10.1:8080` 速查页（均公网不可达）
**SSH 别名**：`hk-mesh` `mini-mesh` `studio-mesh` `dev198-mesh` `linux-lan-mesh`

> 🔑 **打洞能成的单点**：公司三台全是对称 NAT，家侧是端口受限锥形。
> 「对称↔端口受限」可通，「对称↔对称」几乎无解。**家里换路由器/运营商可能让 P2P 整体退化成走香港（10ms→96ms）。**

---

## 二、日常命令

```bash
cd ~/mycc/2-Projects/vps-proxy/Cross-site\ mesh-EasyTier
./scripts/mesh-status.sh                 # 全网巡检（逐节点取视角）
./scripts/deploy-node.sh <节点名>          # 部署/更新，幂等
./scripts/bench.sh dev198 hk-relay       # 某条链路的延迟/吞吐
./scripts/deploy-cheatsheet.sh           # 更新速查页
./scripts/uninstall-node.sh <节点名>       # 干净卸载（带三项断言）
```

需要 sudo 密码的节点（`linux-lan` / `air`），zsh 下用：

```bash
read -rs "SUDO_PASS?sudo 密码: " && echo && export SUDO_PASS && ./scripts/deploy-node.sh linux-lan; unset SUDO_PASS
```

⚠️ **`read -p` 是 bash 语法，zsh 里会报 `no coprocess`**，必须用 `变量?提示语` 形式。

`linux-lan` 上挂了 cron（每 10 分钟）跑 `~/easytier-watch.sh`，日志 `~/.easytier-watch.log`。

---

## 三、⚠️ 判读规则（不看这节必然误诊）

### 3.1 这些读数**不可信**，别拿来告警

| 读数 | 真相 |
|---|---|
| `ping 10.10.10.1` 丢包 10–30% | **假象**。同时刻 TCP 跑 86–88 Mbps。已证伪「ICMP 限速」「UDP 端口被限速」两个假设，机制未明，**不影响真实流量** |
| 刚重启后 `relay(N) / 1000.00ms / 548ms / loss 100%` | **未收敛的占位值**，几十秒后自动消失。别据此下结论 |
| 节点重启后 peer 表出现**重复条目** | 旧会话未过期，会自动清 |
| 控制台的 Device Count | 只反映连了 config server 的节点；核对要用抓包（见 3.3） |

**判健康的正确姿势**：看 `mesh-status.sh` 第二列是 `p2p` 还是 `relay`，加 iperf3 吞吐。
丢包率只在**两个客户端节点之间**才有参考价值。

### 3.2 `--check-config` 通过 ≠ 配置正确

它**只验 TOML 语法，不验键名**——未知键静默丢弃照样 PASS。所以：
- `rpc_portal` 写 TOML **无效**，必须 CLI `--rpc-portal 127.0.0.1:15888`，否则管理口裸奔 `0.0.0.0:15888`
- 启动日志的 TOML 回显**只显示非默认值**，`[flags]` 段短 ≠ 没生效
- 验配置是否真对：**看 peer 表有没有远端节点**，那是唯一「只有真入网才可能满足」的判据

### 3.3 核对「设备是否都上报控制台」

```bash
ssh ycy-relay 'timeout 20 tcpdump -ni easytier0 -c 200 "udp port 22020"' | grep -oE "^10\.10\.10\.[0-9]+" | sort -u
ssh ycy-relay 'timeout 12 tcpdump -ni lo -c 6 "udp port 22020"'   # 中继自己走回环，必须另抓
```

只抓 `easytier0` 会**稳定少数一台**（中继自身），看起来像有节点没上报。

---

## 四、排障决策树

### 4.1 「某台连不上」

1. `./scripts/mesh-status.sh` 看它是 **不可达** 还是 **探针无凭据**（脚本会分开报，别混为一谈）
2. 目标机上 `pgrep -x easytier-core`、`easytier-cli peer`
3. peer 表**只有自己** → 网络身份不一致。TCP 通道建得起来、connector 显示 `Connected`、
   进程 active、TUN 有 IP——**四项全绿但握手鉴权不过**。对撞两边配置的 `network_name`/`secret` 哈希

### 4.2 「本来直连，现在走中继了」

`cost` 从 `p2p` 变 `relay(2)`，延迟 10ms→96ms。查：
- 家侧 NAT 类型是否变了（`easytier-cli peer` 的 NAT 列）——**这是最常见根因**，换路由器/运营商会触发
- 三条上游通道是否还都在（`easytier-cli connector`）

### 4.3 「端口不通」——先查供应商面板，别只看机内

**野草云面板侧有客户不可关闭的防火墙**，白名单仅 `tcp22/udp22/tcp80/tcp443/tcp8888/icmp`。
机内 `iptables -S` 全 ACCEPT、`ufw` inactive，**拦你的那层在机器里看不见**。
非白名单端口被**静默丢弃**（timeout 而非 RST），症状与 NAT 打洞失败**完全同形**。

判别法：从外部 TCP 连该端口，**必须配一个期望成功的锚**（如 22 端口）证明探针可信。

> 通用化：换任何廉价 VPS，先查控制面板防火墙。

### 4.4 「NAS/内网设备访问不了」

先分清是**映射坏了**还是**端口找错了**——经映射地址与直连地址**逐端口对撞**：

```bash
for p in 5000 8080 443 80; do curl -s -o /dev/null -w "$p %{http_code}\n" http://10.10.61.18:$p/; done   # 映射
ssh dev198-mesh 'for p in 5000 8080 443 80; do curl -s -o /dev/null -w "$p %{http_code}\n" http://192.168.61.18:$p/; done'  # 直连
```

两条路径结果**一致** ⇒ 子网代理没坏，是端口找错了。

**已知真值：QNAP 管理口是 5000（HTTPS 5001），不是 8080。**
8080 上另有服务，返回 19 字节 Go 默认 `404 page not found`——极易被误判成组网故障。

### 4.5 「控制台设备列表是空的」

节点必须带 `--config-server udp://10.10.10.1:22020/<用户名>` 才会出现（控制台**没有 devices 表**，
设备是内存态）。已写进 `deploy-node.sh`，用户名在 `common.sh` 的 `ET_CONFIG_SERVER_USER`。

### 4.6 「登录页注册不了 / 验证码不显示」

登录页 **API Host 默认指向官方 `https://config-server.easytier.cn`**，国内连不通（curl 返回 000）。
**手工改成 `http://10.10.10.1:11211`**（注意 http）。`--api-host` 参数**改不动它**——内嵌前端预编译。

---

## 五、平台差异坑（macOS vs Linux）

| 坑 | 表现 | 修法 |
|---|---|---|
| **launchd 不设任何环境变量** | `--config-server` 在 Linux 正常，macOS 报 `HOME is not set, cannot resolve machine id state directory` 起不来 | plist 加 `EnvironmentVariables: HOME=/var/root` |
| `launchctl bootout` 是**异步**的 | 紧接着 bootstrap 报 `Bootstrap failed: 5`，失败后**新旧都没有** | 轮询确认消失再 bootstrap（脚本已处理） |
| macOS 不支持自定义 TUN 名 | 带 `dev_name` 会启动失败 | 部署脚本已自动剥离 |
| macOS `0.0.0.0` 与 `[::]` 同端口冲突 | 日志刷 `AddrInUse` WARN | 无害，v6 socket 已收双栈 |

> **教训**：`--config-server` 我在 systemd 三台一次通过就推给 macOS，直接把 mini 和 studio 搞挂。
> **跨平台推广前先问：这个参数依赖的运行时前提，在另一个载体上成立吗。**

---

## 六、扩容：加一台机器

1. `nodes/<名字>.toml` 照抄同类节点（**必须含 `[network_identity]` 段**，漏了会静默加入名为 `default` 的空密钥网）
2. `common.sh` 的 `ET_NODES` 加一行：`名字|ssh别名|虚拟IP|平台|sudo方式`
3. `./scripts/deploy-node.sh <名字>`，四项断言全过才算成功
4. `~/.ssh/config` 加 `<名字>-mesh` 别名
5. 更新 `web/index.html` + `./scripts/deploy-cheatsheet.sh`

虚拟 IP 别撞：`.1` 中继 / `.11-.19` 公司 / `.21-.29` 家 / `.31-.39` 移动。

---

## 七、写脚本时的两个反复踩的坑

**stdin 会被管道中间的命令吃掉**。犯过两次：
- `echo 密码 | sudo -S bash -c "cat > 文件"` → 密码占了 stdin，配置写成 **0 字节**
- `ssh ... true`（密钥探测）放在管道里 → 读走全部 stdin，同样写空

修法：密码型 sudo 走「先以普通用户写 `/tmp` 临时文件再 `sudo install`」；探测型 ssh 加 `-n`。
**保命的是断言**：「配置非空 + 含 network_identity + 至少看见 1 个远端 peer」——
否则节点会带空配置正常启动，进程 active、TUN 有 IP，只是安静地加入了 `default` 网。

**`pgrep -f <模式>` 会匹配到自己的命令行**。清理测试进程时踩过：kill 把执行命令的 shell 自己杀了，
循环没走到 `rm`。修法：用正则让模式本身不字面出现（`http[.]server`），并排除 `$$`/`$PPID`。

---

## 八、跨站大文件传输

强制边界见 `~/mycc/docs/rules/MULTI-DEVICE.md`，完整操作步骤见
`~/mycc/.claude/skills/cross-site-file-transfer/SKILL.md`。本 Skill 只保留组网侧结论：

- Air→公司的端到端 EasyTier 路径曾观测到 `2–6%` 丢包；Air Wi-Fi 是风险因素，但不是已证明的唯一根因。
- ⚠️ **「先落有线 Linux 再发送」2026-08-16 实测未成立，不要默认这么做**。同一时刻单流到 dev198：
  Air(WiFi) `0.28 MB/s` / linux-lan(有线+BBR) `0.19` / 飞牛(有线+BBR，i5-8500 六核 load 0.28，非 CPU 瓶颈) `0.15`
  —— 两台有线机**都比 Air 慢**；中转总耗时 `131.6s` vs 直传 `70.4s`，慢 1.9 倍。
  当时丢包 Air `15%` / linux-lan `30%`：丢包高到这个量级时，有线相对 Wi-Fi 的优势被跨网拥塞完全淹没。
  中转是否有利**必须当场实测两段**再决定，不能当默认策略。
- **丢包有强时段性**：同日 `3.3%`(下午) → `15~30%`(晚高峰)，两侧分属移动/联通，指向跨网互联点拥塞而非链路误码。
  ⇒ ①吞吐数字必须带同时刻丢包否则跨时间不可比 ②A/B 必须交替(A-B-A-B) ③**避开晚高峰的收益可能大于任何调参**
  ④拥塞型丢包下 KCP/Hysteria-Brutal 这类「无视丢包硬推」的方案未必有效，且对同一互联点上的其他人不友好。
- 批量文件并发从 4 路测起，再试 8 路；`rclone --transfers` 不会把单个大文件自动拆成多路。
- BBR 只影响 Linux 发送端的 TCP。2026-08-16 实测 `linux-lan` 使用 BBR、默认 qdisc 为 fq，但有线和 EasyTier 接口实际为 fq_codel，禁止笼统汇报“当前 bbr+fq”。
- SSH / RPC / Codex 等交互小流量不受大文件中转规则限制。

### `enable_kcp_proxy`：**air 已启用**（2026-08-16 改判）

早先「A/B 判否」的结论**已作废**——那次是单次顺序测量，被链路漂移毁了。
交替设计重测第 1 轮：单流 **0.26 → 3.84 MB/s（14.8×）**，且 KCP 组丢包**更高**
（12%→16%），混杂变量反向偏，结论比上次硬得多。第 2 轮未跑完。

**验它是否真生效，别读配置——比对 Mathis 上限**：
启用后在 `RTT 120ms / 丢包 8%` 下实测 `0.47 MB/s`，而纯 TCP 理论上限只有 `0.047`。
**超出 10 倍就只能是 ARQ 在接管重传**，这比 grep 配置文件硬。

⚠️ 未确认的部分：「10 并发反而降 17%」只有一轮。若复现，说明 **KCP 与多并发是互斥手段**，
不该叠加——那会改变传输建议。用之前先自己测一轮。
