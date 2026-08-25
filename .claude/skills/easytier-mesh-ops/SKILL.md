---
name: easytier-mesh-ops
description: 家↔公司 EasyTier 异地组网（chuan-mesh）的部署、排障与扩容 SOP。触发词："组网"、"异地组网"、"EasyTier"、"easytier"、"野草云"、"mesh-status"、"虚拟内网"、"连不上公司/家里的机器"、"10.10.10."、"10.10.61."、"子网代理"、"NAS 访问不了"、"P2P 打洞"、"加一台机器进组网"、"Windows 加入组网"、"组网速查表"。涵盖：9 节点拓扑真值、Windows 原生节点、速查表实时发布、僵死态识别、自愈与告警分级、部署脚本、排障决策树与判读规则。
---

# EasyTier 异地组网运维

项目仓库：`~/mycc/2-Projects/vps-proxy/Cross-site mesh-EasyTier/`
记忆：`rg easytier ~/.claude/projects/-Users-rayman-chen-mycc/memory/`

边界：改生产机网络配置必须有明确 scope；`hk-relay` 是唯一发现节点，改它会短暂中断全网发现。

---

## 一、拓扑真值（改动前先对照，不要凭记忆）

| 节点 | 虚拟 IP | 位置 | 角色 | NAT |
|---|---|---|---|---|
| hk-relay | `10.10.10.1` | 野草云 HK `207.57.124.191` | 发现 + 中继兜底 + 控制台 | PortRestricted |
| mini | `10.10.10.11` | 公司有线 `.66` | 公司子网网关（主） | **Symmetric** |
| studio | `10.10.10.12` | 公司有线 `.177` | 算力 | **Symmetric** |
| dev198 | `10.10.10.13` | 公司有线 `.233` | 公司子网网关（备） | **Symmetric** |
| linux-lan | `10.10.10.21` | 家有线 `.119` | 家侧子网网关（主）+ **探针宿主** | **PortRestricted** |
| fnos2 | `10.10.10.22` | 家有线 `.115` | 飞牛2号，家侧子网网关（备），Docker 部署 | PortRestricted |
| home-studio | `10.10.10.23` | 家有线 `.133` | **家侧主力开发机**（非网关，刻意不配 proxy_network） | PortRestricted |
| maxtkf-server | `10.10.10.24` | 家有线 `.77` | Windows 11 普通节点，SYSTEM 开机任务（非网关） | PortRestricted |
| air | `10.10.10.31` | 移动 | 笔记本 | PortRestricted |

**子网映射**（末位不变只换前缀）：公司 `192.168.61.X`→`10.10.61.X`，家 `192.168.1.X`→`10.10.1.X`
**上游通道**（每节点 2 条）：`tcp://207.57.124.191:443` · `udp://…:22`
⚠️ ~~第三条 `udp://…:11010`~~ **2026-08-20 已从所有节点删除**——野草云面板永久封该端口，
该 connector 永远停在 `Connecting`，四天在 linux-lan 上刷了 4121 行 WARN，
把真实故障信号淹没、排查僵死事故时带偏一轮。**别再加回来。**
**两个内网界面**：`10.10.10.1:11211` 控制台 · `10.10.10.1:8080` 速查页（均公网不可达）
**SSH 入口**：既有 Unix 节点用 `*-mesh` 别名；Windows 节点用 `ssh Administrator@10.10.10.24`

> 🔑 **打洞能成的单点**：公司三台全是对称 NAT，家侧是端口受限锥形。
> 「对称↔端口受限」可通，「对称↔对称」几乎无解。**家里换路由器/运营商可能让 P2P 整体退化成走香港（10ms→96ms）。**

---

## 二、日常命令

```bash
cd ~/mycc/2-Projects/vps-proxy/Cross-site\ mesh-EasyTier
./scripts/mesh-status.sh                 # 全网巡检（逐节点取视角）
./scripts/deploy-node.sh <节点名>          # 部署/更新，幂等
./scripts/bench.sh dev198 hk-relay       # 某条链路的延迟/吞吐
./scripts/deploy-cheatsheet.sh           # 立即把生成页发布到 10.10.10.1:8080
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
| **任意 mesh IP** 的 ping 丢包（10–40%） | **假象，且不限于中继**。同时刻 TCP 跑 86–88 Mbps。已证伪「ICMP 限速」「UDP 端口被限速」两个假设，机制未明，**不影响真实流量**。⚠️ 别代入 Mathis、别拿来论证优化收益 |
| 刚重启后 `relay(N) / 1000.00ms / 548ms / loss 100%` | **未收敛的占位值**，几十秒后自动消失。别据此下结论 |
| 节点重启后 peer 表出现**重复条目** | 旧会话未过期，会自动清 |
| 控制台的 Device Count | 只反映连了 config server 的节点；核对要用抓包（见 3.3） |

**判健康的正确姿势**：看 `mesh-status.sh` 第二列是 `p2p` 还是 `relay`，加 iperf3 吞吐。
🔴 **2026-08-20 加强：mesh 内 ping 丢包对 TCP 没有预测力，客户端之间也一样。**
同时刻实测：ping `10.10.10.13` 丢包 **10%**，而 TCP 跑 **88 Mbps** ——
比 Mathis 在 10% 丢包下的上限（0.5 MB/s）高 **22 倍**。
⇒ **绝不能把 mesh ping 丢包代入 Mathis，也不能拿它论证任何优化收益。**
我拿它推出过「单流锁死 2.6 Mbps」并据此建议买大陆 BGP 中继，实测后整个建议作废。
判吞吐只有一个办法：**按 §八 的正确测法真打一次流。**

🔴 **2026-08-21 再加强：peer 表自己的 `loss` 字段同样没有预测力，不只是 ping。**
Vaultwarden 前端打不开那次，我拿 peer 表「udp 隧道 27–42% 丢包 / tcp 隧道 0%」
推出「udp 隧道是元凶」，并准备加 `--default-protocol tcp`。两个证据把它否了：

| 证据 | 内容 |
|---|---|
| 对照实验 | 症状消失后立刻重采 peer 表，**丢包率几乎没变**（hk-relay 42%→39%、air 30%→27%、**mini 34%→39% 反而变差**），而症状确实没了 ⇒ loss 与症状无相关性 |
| 实测吞吐 | 同一条 air↔home-studio 链路，**两小时内 34.8 KB/s → 1.83 MB/s，波动 53 倍**（curl 拉 4.9MB 的真实文件，不吃浏览器缓存） |

⇒ **loss 读数不可信，但链路是真会烂**——两者不矛盾。唯一的终审仍是真打一次流。

⚠️ **间歇性故障不要在「好」的窗口里改**：那次链路自愈后我差点动
`--default-protocol tcp`。不该动的理由不是风险大，而是**改完没法验证**——
当下已经是 1.83 MB/s，改完还是 1.83 MB/s，分不清是改动生效还是它本来就好着；
而这个改动有真实下行风险（TCP 打洞失败会退化成经 hk-relay 中继，那条 42% 丢包）。
正确做法：**等下次发作时改**（有痛点驱动 + 能当场 A/B + 回滚判据明确），
平时挂定时测速留曲线。详见记忆 [[feedback_intermittent_fault_healthy_window]]。

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

### 3.4 可达性绿 ≠ 吞吐活（2026-08-25 控制台白屏一整圈教训）

网络故障分三类：**可达性**（握手/状态码）、**延迟**、**吞吐**。peer 表全 p2p、curl 全 200、
SSH 毫秒握手、小页面秒开——这些只覆盖前两类，对「吞吐塌到 1/1000」**零区分力**。
用户报「打不开/加载不出」时，判「链路正常」前必须**真打一次 ≥1MB 的流**：

```bash
curl -s -o /dev/null --max-time 15 --noproxy '*' \
  -w 'speed=%{speed_download}B/s bytes=%{size_download}\n' http://10.10.10.1:11211/assets/<主包>.js
```

- **SPA 白屏 + 标题已渲染** = 壳（几百字节）+缓存 CSS 到了、大 JS 吊死的典型形态；
  浏览器里 `performance.getEntriesByType('resource')` **缺席**的文件即卡点（计时表只记完成的加载）。
- 定位用**同目标多通道 + 同通道多源**三角：2026-08-25 实例——办公室→HK 22KB/s、
  办公室→家 59KB/s、办公室→美国优化线 1.3MB/s、家→HK 1.3MB/s、中继自身空闲(7KB/s)
  ⇒ 病灶=办公室出口晚高峰对普通流量的 QoS，EasyTier 无罪（隧道 41 还**快于**裸公网 22）。
- 晚高峰（约 21–23 点）办公室出口到 HK/到家同时塌是**常态画像**，先绕行（xray 优化线
  ssh -L 隧道）或开 KCP/QUIC 代理（见 §八），别急着改架构。

## 四、排障决策树

### 4.1 「某台连不上」

1. `./scripts/mesh-status.sh` 看它是 **不可达** 还是 **探针无凭据**（脚本会分开报，别混为一谈）
2. 目标机上 `pgrep -x easytier-core`、`easytier-cli peer`
3. peer 表**只有自己** → 网络身份不一致。TCP 通道建得起来、connector 显示 `Connected`、
   进程 active、TUN 有 IP——**四项全绿但握手鉴权不过**。对撞两边配置的 `network_name`/`secret` 哈希

### 4.2 「本来直连，现在走中继了」

`cost` 从 `p2p` 变 `relay(2)`，延迟 10ms→96ms。查：
- 家侧 NAT 类型是否变了（`easytier-cli peer` 的 NAT 列）——**这是最常见根因**，换路由器/运营商会触发
- 两条上游通道是否还都在（`easytier-cli connector`）

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

### 4.7 「网页打不开/白屏，但 curl 200、SSH 正常」

1. **别信可达性绿灯**，直接按 §3.4 打一次 ≥1MB 的流——大概率是吞吐塌陷不是服务挂了
2. 塌了 → §3.4 的多源三角定位病灶在哪一跳；办公室出口晚高峰 QoS 是第一嫌疑
3. 应急绕行（当晚就要用时）：`ssh -f -N -o ProxyCommand='nc -x 127.0.0.1:10808 %h %p' -L 21211:10.10.10.1:11211 ycy-relay`
   → 开 `http://127.0.0.1:21211/#/h/aHR0cDovLzEyNy4wLjAuMToyMTIxMQ==`（走 xray 美国优化线，实测 402KB/s）
4. 长效：确认 air/home-studio 的 KCP/QUIC 代理还开着（§八，`easytier-cli proxy` 验证）——
   2026-08-25 开启后控制台原地址 1.5s 直开，隧道不再需要

## 五、平台差异坑（macOS / Linux / Windows）

| 坑 | 表现 | 修法 |
|---|---|---|
| **launchd 不设任何环境变量** | `--config-server` 在 Linux 正常，macOS 报 `HOME is not set, cannot resolve machine id state directory` 起不来 | plist 加 `EnvironmentVariables: HOME=/var/root` |
| `launchctl bootout` 是**异步**的 | 紧接着 bootstrap 报 `Bootstrap failed: 5`，失败后**新旧都没有** | 轮询确认消失再 bootstrap（脚本已处理） |
| macOS 不支持自定义 TUN 名 | 带 `dev_name` 会启动失败 | 部署脚本已自动剥离 |
| macOS `0.0.0.0` 与 `[::]` 同端口冲突 | 日志刷 `AddrInUse` WARN | 无害，v6 socket 已收双栈 |
| Windows Update 被策略禁用 | `Add-WindowsCapability OpenSSH.Server` 报拒绝访问，`sshd` 不存在 | 不改受保护服务 ACL；从微软 Win32-OpenSSH Release 下载，校验 SHA256 后独立安装 |
| Windows 不能访问 GitHub | 安装包下载失败 | 同 LAN Linux 临时开 HTTP，只发布已校验包；目标下载后再验 SHA256，完成即关闭服务器 |
| Windows 常驻运行 | 把 console 程序硬注册成服务可能报 1053 | 用 `SYSTEM` + `AtStartup` 计划任务，设置失败重启；验收任务、进程、VIP、远端 peer、Mesh SSH |
| PowerShell stdin 编码 | 中文注释写入后 TOML 表头被吞，`--check-config` 报重复键 | 运行配置剥离注释写 ASCII，或显式设置输入/输出 UTF-8；模板仍保留中文说明 |

> **教训**：`--config-server` 我在 systemd 三台一次通过就推给 macOS，直接把 mini 和 studio 搞挂。
> **跨平台推广前先问：这个参数依赖的运行时前提，在另一个载体上成立吗。**

---

## 六、扩容：加一台机器

1. `nodes/<名字>.toml` 照抄同类节点（**必须含 `[network_identity]` 段**，漏了会静默加入名为 `default` 的空密钥网）
2. `common.sh` 的 `ET_NODES` 加一行：`名字|ssh别名|虚拟IP|平台|sudo方式`
3. Linux/macOS 跑 `./scripts/deploy-node.sh <名字>`；Windows 用原生二进制 + SYSTEM 开机任务
4. 必须断言：进程、VIP、网络身份非空、至少一个远端 peer；Windows 再从其他节点真实 SSH Mesh IP
5. Unix 节点给 `~/.ssh/config` 加 `<名字>-mesh` 别名
6. 速查页**生成 + 发布均已自动化，不用手改** —— `deploy-node.sh` 收尾会依次调用
   `gen-cheatsheet.sh` 与 `deploy-cheatsheet.sh`；发布失败只告警，不反转已成功的节点部署。
   ⚠️ 这条以前是「手动改 web/index.html」，**结果连漏两次**（fnos2 8-16、home-studio 8-20），
   页面停在 6 节点还显得完整。**同一步骤漏两次就该自动化，不是加强纪律。**
   生成器对没登记描述的节点会在页面上印「描述待补」、对没有 `-mesh` 别名的会标注——
   **宁可页面难看，不可页面撒谎**（它就当场抓出 fnos2 缺别名，补完发现 host key 也没收录）。

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

**凭据名称不能代替字段语义验证。** Vault 里叫“EasyTier”的条目可能存的是 VPS 登录凭据，不能直接当
`network_identity`。优先从已联网节点的运行配置中提取，但绝不打印整份 `node info`：其 `config` 字符串
内嵌 `network_secret`，对 JSON 做 `del(.network_secret)` 也删不掉。诊断启动失败时同样先脱敏，
因为 TOML parse error 会回显整份配置。只输出存在性、长度、哈希或脱敏后的错误行。

**无 `sshpass` 不等于要装依赖。** 项目内置 `ssh-askpass-env.sh`，密码只经进程环境交给
`SSH_ASKPASS`，不进文件和 argv。速查页发布验收必须同时满足：服务 active、只绑定
`10.10.10.1:8080`、未绑定公网、HTTP 载荷包含新节点、本地与线上 SHA256 一致。

---

## 八、跨站大文件传输

强制边界见 `~/mycc/docs/rules/MULTI-DEVICE.md`，完整操作步骤见
`~/mycc/.claude/skills/cross-site-file-transfer/SKILL.md`。本 Skill 只保留组网侧结论：

- Air→公司的端到端 EasyTier 路径曾观测到 `2–6%` 丢包；Air Wi-Fi 是风险因素，但不是已证明的唯一根因。
- 🟡 **以下 8-16 的绝对数值属待复核**（用的是 2026-08-20 才发现有问题的测法，量级可能整体偏低）；
  但「有线机不比 Air 快」这个**相对**结论仍成立，因为三者同法同刻对比。
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

### 🔴 测组网吞吐的正确姿势（不这么测必然错，2026-08-20 血泪）

**三条缺一不可**：

1. 发送端加 **`-N`**（EOF 后立即关 socket）。不加的话 nc 发完 stdin 会按 `-w` 挂着等对端，
   你量到的是**空转时间**——6MB 实际 0.5 秒传完，我量出 91 秒
2. **在接收端计时**。发送端计时还会被 socket 缓冲骗：1MB 塞进缓冲就"完成"，0.2 秒，同样假
3. **断言接收字节数 == 发送量**，没收全的读数一律作废

```bash
# 接收端（目标节点）
nohup sh -c 'S=$(date +%s%N); nc -l 5601 | wc -c > /tmp/rx.txt; E=$(date +%s%N); echo $(((E-S)/1000000)) > /tmp/ms.txt' &
# 发送端
dd if=/dev/zero bs=1M count=20 2>/dev/null | nc -N -w 100 <目标mesh IP> 5601
```

⚠️ **红旗信号：测量结果贴着某个你自己设的常数**（超时值、缓冲区大小）——
先假定你在测自己的工具，不是测被测对象。我那三轮"稳定的 0.07 MB/s"就是三次稳定地等满同一个超时；
**稳定可复现只排除了随机噪声，不排除系统性错误**。教训 → 记忆 `measured_the_wrong_quantity`

**家↔公司当前真值：8.4~13.3 MB/s（≈88 Mbps），晚高峰亦然。链路不慢，没有吞吐问题。**

### KCP/QUIC 代理：价值随路况反转——QoS 塌陷窗口 10–22×，健康窗口曾测亏 ~16%

> 🔴 2026-08-25 结论升级：**air 与 home-studio 两端已常开** `--enable-kcp-proxy --enable-quic-proxy`
> （两者同开时 **QUIC 优先**生效，v2.6+），其余节点保持关。部署已固化进 `deploy-node.sh`
> （只对这两个节点注入，重部署不丢）。回滚：air 恢复 `.bak-kcp` plist；home-studio 删
> `/etc/systemd/system/easytier-mesh.service.d/kcp-quic.conf` 后 daemon-reload+restart。

**两次实测不矛盾，是同一开关在不同路况下的两张脸：**

| 窗口 | 条件 | 结果 |
|---|---|---|
| **QoS 塌陷**（2026-08-25 晚高峰） | 办公室出口对普通流量整形，air↔home 基线 59–139 KB/s | 开 QUIC 后 **1302 KB/s（10–22×）**；控制台 1.78MB 主包 15s 拉不完 → 1.5s |
| **健康**（2026-08-20 家侧交替 A/B 三轮） | 基线 8–13 MB/s | KCP 开了**亏 ~16%**（10.97→9.16 MB/s 均值） |

⇒ 判断该不该开，问的不是「KCP 好不好」而是**这条路当前是不是 QoS 受害者**。
办公室↔家这条路晚高峰常态性受害 → 两端常开（QUIC 的健康窗口开销未测过，
若白天大文件传输明显变慢，先怀疑它，用交替 A/B 复测）。
旁证：2026-08-25 晚 loss 43% ≈ 健康日 46%，吞吐却差千倍——**loss 列依旧无预测力**。

**验它真生效，两个办法（配置对≠生效）：**
1. **首选：传输进行中跑 `easytier-cli proxy`**——表里出现 `transport_type=Quic/Kcp`
   的活跃条目即为铁证（2026-08-25 实测：14 条 Quic，含浏览器真实流量）。空表只说明
   此刻没有被代理的连接，不说明开关没生效。
2. 比对 Mathis 上限：`RTT 120ms/丢包 8%` 下实测 0.47 MB/s vs 纯 TCP 理论 0.047，
   超 10 倍只能是 ARQ 接管。

**部署形态真值（手工改时照抄）**：air = LaunchDaemon plist `ProgramArguments` 追加两个
flag（PlistBuddy `Add :ProgramArguments: string …`）；home-studio = systemd drop-in
`Environment=ET_ENABLE_KCP_PROXY=true` + `ET_ENABLE_QUIC_PROXY=true`（env 与 CLI 等效，
flag 名以 `easytier-core --help` 为准别猜）。控制台 UI **改不了**这些节点——它们是
「本地网络」（配置在各机 node.toml），控制台只能管通过控制台创建的网络实例。

⚠️ 未确认：「10 并发反而降 17%」只有一轮；KCP 与多并发若互斥，会改变传输建议，用前自测。

## 九、日常监控（2026-08-17 已交给 AI Ops Cockpit）

**形式：aiops 当告警总线，不当探针。** 探测留在组网内部（有真实视角的地方），
**中继 VPS 上零改动、ai-ops-cockpit 代码/Caddy/容器零改动**——只在 Kuma 里加了两个监控项。

- 探针：linux-lan `~/easytier-watch.sh`，cron `*/10`，只看本机 peer 表**不 SSH 别处**
  （监控不该为了看一眼就把凭据摊到每台机器上）
- 出口：push → Kuma → 「飞书运维告警」

| Kuma id | 名称 | 类型 |
|---|---|---|
| 17 | EasyTier 中继端口 野草云HK | port `207.57.124.191:443` |
| 18 | EasyTier 组网探针 家侧linux-lan | push，**interval 900s** / retries 2 |

### 判读表（单看一条会误判，必须两条一起看）

| 17 | 18 | 含义 |
|:--:|:--:|---|
| 🟢 | 🟢 | 正常 |
| 🔴 | 🔴 | 中继真没了（宕机 / 到期 / 被封） |
| 🟢 | 🔴 | 中继活着但组网有问题，**或探针那台机（linux-lan）自己坏了** |
| 🔴 | 🟢 | 供应商封了 443，但已建立的 p2p 还通 ← §三 那个面板防火墙形态的早期信号 |

### 判据里刻意不放的三样（改探针前先读这段）

1. **不放 `loss` 列** —— 17–28% 是本项目已证伪的假象（见 §三），拿它告警会天天误报
2. **不放 `air`** —— 笔记本，合盖即掉线。放进期望列表就是**定时炸弹式误报源**，
   误报几次之后告警没人看了，那才是真正的失效
3. **不用「N 个节点全在线」** —— 中继健康 ≠ 全员在线

期望列表只放**常驻开机**设备：`hk-relay mini studio dev198 fnos2 home-studio`。
改动时注意脚本第 0 步会强制 `MUST_P2P ⊆ EXPECT_PEERS`，否则某台掉线会静默。

### 三类故障如何被覆盖

| 情况 | 动作 | 谁发现 |
|---|---|---|
| 判据全过 | push `status=up` | — |
| 判据失败 | push `status=down` + 具体原因 | 立即告警且带原因 |
| 脚本 / cron / linux-lan 死 | **什么都不推** | Kuma 心跳超时兜底 |

第三行是关键：**「不推」本身就是信号**。所以别把失败写成"推一条 down 就完事"。

### 🔴 僵死态：自述全绿但实际离网（2026-08-20 实战，本 skill 最重要的一节）

两台家侧节点同时从全网消失，而**在它们自己看来一切正常**：进程 `active`、网卡带着虚拟 IP、
connector 报 `Connected`、peer 表**满员且全是 p2p**、自己日志一条不记。
`Restart=always` **完全无效——进程根本没崩**。重启即恢复。

**识别法：取两次样看数字变不变。** 隔 25 分钟两次 `easytier-cli peer`，
延迟数字一模一样到小数点后两位 ⇒ 表是冻结的。
活链路的延迟不可能两次采样完全相同。**「冻结」比「数值难看」是强得多的信号。**
佐证：`ss -tnp | grep <中继IP>` 会看到 `CLOSE-WAIT` 且 `Recv-Q` 积着几十上百 KB 没人读。

⚠️ **排查时别只读故障方自己的日志**——失联那一刻它可能完全空白。
去中继、去别的节点、去 socket 层找证据。

### 自动重启：做，但只对「本机离网」做

~~早先写过「不做自动重启，因为 Restart=always 已覆盖」~~ —— **2026-08-20 推翻**：
那个论证把「进程崩溃」当成了「需要重启的全部故障形态」，而僵死态里进程好好活着。
**论证「不需要 X」时要穷举 X 能覆盖的形态，别拿其中一种代替全部。**

现行自愈（在 `local-watch.sh` 里）的三个保险，改之前先理解为什么：

| 保险 | 值 | 为什么 |
|---|---|---|
| 连续 N 次才动手 | 3 次（30 分钟） | 单次网络抖动不该触发重启 |
| 冷却 | 1 小时 | 重启修不好的故障（中继真挂了）不能变成重启风暴 |
| **只对「本机离网」生效** | — | **别的节点掉线，重启本机毫无用处，只会变成无限重启** |

授权：linux-lan `/etc/sudoers.d/easytier-selfheal`，只放行
`/usr/bin/systemctl restart easytier-mesh.service` 一条。查权威清单用 `sudo -l`，
**别用不在白名单里的命令去探**（被拒是设计正确，会被误读成"授权没生效"）。

### 告警分级：退化不等于中断

「P2P 退化成 relay」实测 4 天触发 **26 次（每天 6~7 次），全部自行恢复**。
它是**性能降级不是中断**——流量照走，只是延迟 10ms→50ms+。
拿它天天发 DOWN 级飞书，几天后告警就没人看了，**那才是真正的失效**。
现行做法：连续 6 次（≈1 小时）仍未恢复才升级为告警，否则只记 INFO 日志，恢复即清零。

### 改探针后必须做的负向验证

**没红过的告警等于没有告警。** 全绿有二义性——可能一切正常，也可能判据恒真。
改完注入一个不存在的节点名跑一次，确认 Kuma 翻 `status=0` 且 `important=1`，再恢复确认回 UP：

```bash
ET_EXPECT_PEERS="hk-relay mini studio dev198 fnos2 home-studio ZZ_ALERT_DRILL_ZZ" ~/easytier-watch.sh
```

⚠️ **Kuma 不记录通知发送成败**（日志里 `Feishu` 出现 0 次），所以**逐次**「飞书是否送达」
服务端查不到，`important=1` 只代表 Kuma 判定了状态变更。别把单次 `important=1` 当"已送达"汇报。

✅ **但这条链路已整体实证**：2026-08-17 首次接入时跑完整演练，川哥人工确认手机收到 **3 条飞书**
（cc 直发的演练标记 + Kuma 的 DOWN + Kuma 的 recovery）。⇒ `push → Kuma → 飞书` 是活的，
**别因为"日志里查不到"就判它不可信、更别另起炉灶重造**。收口方式只有一个：重跑演练 + 人工确认。
