---
name: lan-network
description: 局域网设备网络连接运维：查有线/WiFi 链路是否真的正常、配静态 IP、切默认路由优先走有线、排"连不上"。含 192.168.61.0/24 有线段与 10.9.1.x WiFi 段真值表。触发词："有线网络"、"网线"、"交换机"、"静态IP"、"固定IP"、"网段"、"默认路由"、"优先走有线"、"检查网络连接"、"设备连不上"
layer: 基建层
authorization: B区（改生产机网络配置需明确 scope，Mini/dev198 均跑生产服务）
output_levels: L1
---

# 局域网设备网络运维 Skill

管川哥这几台机器的链路层：**判有线到底通没通、配静态 IP、决定流量走哪条线**。

> ⚠️ 本 skill 的 IP 表是快照。**动手前一律现查真值**（`ifconfig` / `ip -br addr`），别照抄本文档——这是 no-guessing 红线。真值另一份在记忆 `user_hardware.md`。

---

## 网络真值（2026-07-31 实测）

三层网络，一台机器常同时挂在两层上：

| 网段 | 网关 | 谁在上面 |
|------|------|---------|
| **有线 192.168.61.0/24** | `192.168.61.254`（同时是 DHCP 服务器，管理界面 `http://192.168.61.254`） | Mini / dev198 / QNAP —— **三台的主用出口** |
| WiFi 10.9.1.0/24 | `10.9.1.254` | Air / Mini / Studio / dev198 |
| 雷电网桥 192.168.100.0/24 | — | Mini `.1` ↔ Studio `.2` 专用 |

### 有线段设备表

| 设备 | 接口 | 静态 IP | 速率 | 默认路由 | SSH |
|------|------|---------|------|---------|-----|
| Studio | `en0` 内置 | `192.168.61.177` | 1000baseT FD | ✅ 有线 | **`ssh studio` 走有线**；备用 `ssh studio-wifi`（.155） |
| Mini | `en0` 内置 | `192.168.61.66` | 1000baseT FD | ✅ 有线 | `ssh mini`（走 WiFi .54） |
| dev198 | `enp0s31f6` | `192.168.61.233` | 1000Mb/s FD | ✅ 有线（metric 100） | `ssh dev198-lan`（走 WiFi .198） |
| QNAP | — | `192.168.61.18` | 实测 382Mbps ⇒ 千兆 | 静态 | ⚠️ 密码不在记忆里，需向川哥要 |

- Air **无内置网口**，只走 WiFi，且 IP 是 DHCP 浮动 —— 用前 `ipconfig getifaddr en0` 现查
- QNAP 管理界面 `http://192.168.61.18:8080`（5000 亦开）
- 网关后有多条 WAN 分流：Mini 出口 `222.128.47.46` / dev198 `111.194.62.218`，**同网关不同出口是正常的**

---

## 一、检查链路（核心：ping 通证明不了什么）

**双上行的机器任意一条线活着 ping 就通**，所以"能 ping 通"不能作为"有线正常"的结论。必须拿接口级证据：

### macOS（Mini / Studio / Air）
```bash
ifconfig en0 | grep -E "status:|media:|inet "   # 要看到 1000baseT + active
networksetup -getinfo "Ethernet"                # DHCP Configuration / Manual Configuration
networksetup -listnetworkserviceorder | head -8 # 服务顺序 = 优先级，Ethernet 排第一才优先有线
route -n get 223.5.5.5 | grep -E "interface|gateway"   # 实际选路
```

### Ubuntu（dev198 / linux-lan）
```bash
ethtool enp0s31f6 | grep -E "Speed|Duplex|Link detected"
ip -br addr show enp0s31f6
ip -s -s link show enp0s31f6 | grep -A3 "RX:"   # CRC/frame/fifo/overrun 全 0 = 线和口干净
ip route get 223.5.5.5                          # 实际选路，看 dev/src
```

### 三条判据缺一不可
1. **协商速率** —— 跑成 `100baseTX` 说明网线或交换机口有问题（千兆口降速）
2. **错误计数** —— `RX errors` 里 CRC/frame/fifo/overrun 全 0 才算物理层干净。注意 `dropped` ≠ `errors`（dropped 多半是无监听端口的多播包，不是故障）
3. **实际选路** —— `ip route get` / `route -n get`，路由表好看只是配置

### 够不到内部的设备（如 QNAP）
用外部可观测量反证：从同网段拉它的 HTTP 资源测吞吐，**超过百兆物理上限 12.5 MB/s 就反证了千兆**：
```bash
curl -s -o /dev/null -w "%{size_download}B %{speed_download}B/s\n" http://192.168.61.18:18081/assets/<某个大js>
```

---

## 二、配静态 IP

### macOS
```bash
networksetup -setmanual "Ethernet" 192.168.61.66 255.255.255.0 192.168.61.254
networksetup -setdnsservers "Ethernet" 223.5.5.5
networksetup -getinfo "Ethernet"     # 验：应显示 Manual Configuration
```

### Ubuntu（NetworkManager）
```bash
sudo nmcli con mod <连接名> ipv4.method manual \
  ipv4.addresses 192.168.61.233/24 ipv4.gateway 192.168.61.254 ipv4.dns 223.5.5.5
sudo nmcli con up <连接名>
nmcli -t -f ipv4.method,ipv4.addresses con show <连接名>   # 验
```
连接名用 `nmcli -t -f NAME,DEVICE con show --active` 查（dev198 是 `netplan-enp0s31f6`）。

### ⚠️ 固化前必查：地址在不在 DHCP 池里
**DHCP 分来的地址直接固化成静态 = 埋雷** —— 路由器将来可能把同一地址再租给别的设备撞 IP。
- `networksetup -getinfo` 显示 `DHCP Configuration` ⇒ 这个地址**一定在池内**
- 够不到路由器（无凭据）就**如实标成待处理风险交给川哥**去做 DHCP 保留/排除，别默默固化然后报"完成"

---

## 三、切默认路由优先走有线

### macOS —— 靠服务顺序，不是 metric
```bash
networksetup -listnetworkserviceorder          # Ethernet 排在 Wi-Fi 前面即可
sudo networksetup -ordernetworkservices "Ethernet" "Wi-Fi" ...   # 需要调整时
```

### Ubuntu —— 靠 route-metric（数字小的赢）
```bash
sudo nmcli con mod netplan-enp0s31f6 ipv4.route-metric 100    # WiFi 通常 600
sudo nmcli con up netplan-enp0s31f6
ip route | grep default        # 有线那条 metric 要更小
ip route get 8.8.8.8           # 必须实测确认真走有线
```

---

## 四、改生产机网络的安全姿势

Mini（frpc 隧道 / kidsbench 转发）和 dev198（H 平台 feishu-grok-bridge）都跑生产。

1. **从另一条链路进去改** —— 走 WiFi SSH 进去改有线配置，改崩了也不会把自己踢下线，随时能回滚
2. **改完验生产面，不只验网络面**：
```bash
# 网络面
ping -c 3 <同网段设备>; curl -s --noproxy "*" -o /dev/null -w "%{http_code}\n" https://www.baidu.com
# 生产面
ssh dev198-lan 'curl -s http://127.0.0.1:18765/healthz'    # H 平台
ssh mini 'pgrep -l frpc; pgrep -l xray'                     # 隧道/代理
ssh dev198 'echo OK'; ssh mini-pub 'echo OK'                # 公网回路
```

---

## 五、坑清单

| 坑 | 表现 | 破法 |
|----|------|------|
| **ping 通 ≠ 走有线** | 三台全通 0% 丢包，其实走的 WiFi | 接口级证据 + `ip route get` |
| **改动后异常错误归因** | 切有线后 GitHub 超时，以为切坏了 | **先跑对照**：Air 走 WiFi 同样超时 ⇒ 环境常态，与改动无关。少这一步会回滚一个本来正确的改动 |
| **`pgrep -f <名字>` 自匹配** | 杀完进程 pgrep 仍返回 PID，以为没杀干净 | 那是执行命令的 shell 自己。用 `ss -lntp \| grep <port>` 判 |
| **DHCP 地址固化成静态** | 当下没事，将来撞 IP | 固化前查是否在池内，够不到路由器就交棒 |
| **WiFi 延迟抖动** | dev198 WiFi 实测 12–221ms，有线 0.5ms | 有线优先是实质改进，不只是洁癖 |

---

## 待办（需要川哥出手）

- [ ] 在 `http://192.168.61.254` 把 `.18 / .66 / .177 / .233` 做成 **DHCP 保留**或从池中排除（Mini 的 `.66` 原是池内地址）
- [ ] Studio 的 `en12` 接口 status active 但只有 link-local `169.254.x`（没拿到 IP），服务顺序里排第 2 的 "USB 10/100/1000 LAN"——空跑还是接了条不通的线，待确认
- [ ] Studio 的 Ollama 只监听 `127.0.0.1:11434`，外机连不上；MLX `:8000` 与 brain `:19080` 均未在跑（2026-08-03 实测，与旧记忆描述不符）

---

## 关联

- 记忆真值：`user_hardware.md`（设备清单 + SSH 别名 + 网络拓扑）
- 方法论：`feedback_dual_homed_wired_link_verification.md`
- 进程管理坑：`feedback_ssh_remote_process_mgmt_pitfalls.md`
- 相关 skill：`fnos-nas`（NAS 系统排障）、`ssh-tunnel`（公网隧道）、`xray`（代理）
