# 部署进度真值表

> 最后更新：2026-08-26 01:15（实测时钟）· 每一行都是实跑验证过的，不是「应该」
> **9 节点全部上线**；`maxtkf-server` 已带 config-server 参数，Web 页面计数待下次目视核对

## 节点

| 节点 | 虚拟 IP | 状态 | NAT 类型 | 备注 |
|---|---|---|---|---|
| `hk-relay` | 10.10.10.1 | ✅ 运行中 | PortRestricted | systemd `easytier-mesh` + `easytier-web`；已开公钥登录，SSH 别名 `ycy-relay` |
| `mini` | 10.10.10.11 | ✅ 运行中 | Symmetric | launchd `cn.easytier.mesh`；公司侧子网网关（主） |
| `studio` | 10.10.10.12 | ✅ 运行中 | Symmetric | 同上；全程未干扰其上运行的任务 |
| `dev198` | 10.10.10.13 | ✅ 运行中 | Symmetric | systemd `easytier-mesh`；公司侧子网网关（备） |
| `linux-lan` | 10.10.10.21 | ✅ 运行中 | **PortRestricted** | 家侧子网网关 |
| `fnos2` | 10.10.10.22 | ✅ 运行中 | PortRestricted | **Docker** 部署（fnOS 升级会重置底层，原生二进制会静默失效）；家侧子网网关（备） |
| `home-studio` | 10.10.10.23 | ✅ 运行中 | PortRestricted | Ubuntu 24.04；家侧主力开发机，不导出子网 |
| `maxtkf-server` | 10.10.10.24 | ✅ 运行中 | PortRestricted | Windows 11；SYSTEM 开机任务 `EasyTier Mesh`；不导出子网；Mesh SSH 已验收 |
| `air` | 10.10.10.31 | ✅ 运行中 | PortRestricted | launchd；**已验证未被 Clash/Xray 劫持**（连接本地地址落在 en0 物理网卡，非 utun） |

上游通道（每节点 2 条，任一被中间网络掐掉仍能建链）：
`tcp://…:443` · `udp://…:22`。供应商防火墙不放行 `udp://…:11010`，不再配置。

---

## 核心结论：家↔公司 P2P 直连成功

| 路径 | 延迟 | 丢包 | 链路类型 |
|---|---|---|---|
| **家 ↔ 公司（linux-lan ↔ dev198）** | **12.69 ms** | **0%** | **p2p 直连** |
| 同一对节点若走香港中继 | ~96 ms | — | relay(2) |
| 公司三台互连 | 0.48–0.82 ms | 0% | p2p |
| 公司/家 ↔ 香港 | 48–52 ms | 见判读规则 | p2p |

**为什么打通了**：公司侧三台全是 **Symmetric NAT**（最难打洞），但家侧是 **PortRestricted**。
「对称 ↔ 端口受限」可以打通；只有「对称 ↔ 对称」才几乎无解。**家侧这台是整张网能直连的关键**，
若哪天家里换了路由器/运营商导致 NAT 变成对称，家↔公司会立刻退化成走香港中继（~96ms）。
`mesh-status.sh` 会把这种退化标黄。

这同时**证伪了一个之前标为待验的担心**：家是移动、公司是联通，跨网直连质量原本存疑，
实测 12.7ms、0% 丢包，直连明显优于绕香港，`latency_first` 的选路是对的。

## 子网代理：双向实测有效

原方案承诺「NAS、打印机可被任意设备访问」却没有任何配置，本项目补上并已验证：

| 方向 | 目标 | 延迟 | 丢包 |
|---|---|---|---|
| 家 → 公司 | `10.10.61.18` = **QNAP** (192.168.61.18) | 12.6 ms | 0% |
| 家 → 公司 | `10.10.61.254` 公司网关 | 11.7 ms | 0% |
| 家 → 公司 | `10.10.61.66` mini | 12.9 ms | 0% |
| 公司 → 家 | `10.10.1.1` 家里路由器 | 13.2 ms | 0% |
| 公司 → 家 | `10.10.1.119` linux-lan | 12.7 ms | 0% |
| 公司 → 家 | `10.10.1.219` Air（WiFi，抖动大属正常） | 103 ms | 0% |

**用法**：真实 IP 末位不变，只换前缀。`192.168.61.18` → `10.10.61.18`。

---

## Web 控制台（已部署；9 节点均带上报参数）

`http://10.10.10.1:11211` —— **只在组网内可达**，公网 11211/22020 实测均不通。
systemd `easytier-web.service`（`Requires=easytier-mesh.service`，否则早启动会因虚拟 IP 未就绪而 bind 失败）。

**登录页必须手工把 API Host 改成 `http://10.10.10.1:11211`**（注意是 http）。
前端默认填的是官方 `https://config-server.easytier.cn`，国内连不通（curl 返回 000），
症状是验证码图加载不出来、提交无反应。`--api-host` 参数**改不动这个默认值**（内嵌前端预编译）。

节点要出现在设备列表里，必须带 `--config-server udp://10.10.10.1:22020/<用户名>`
（已写进 `deploy-node.sh`，用户名在 `common.sh` 的 `ET_CONFIG_SERVER_USER`）。
⚠️ macOS 上该参数还需 plist 里的 `EnvironmentVariables: HOME=/var/root`，
否则报 `HOME is not set` 起不来 —— systemd 自动设 HOME，launchd 不设。

**核对方式（不要只看 Device Count）**：VPS 上 `tcpdump -ni easytier0 "udp port 22020"`
数不同源 IP，再另抓 `-ni lo`（中继自己的会话走回环，只抓 easytier0 会少数一台）。

## 家侧网关冗余：实测（2026-08-16）

停掉 linux-lan 的 EasyTier 28 秒，从公司侧 dev198 访问家里路由器 `10.10.1.1`：

| 阶段 | 丢包 | RTT | 提供该路由的节点 |
|---|---|---|---|
| 基线 | 0% | 10.8 ms | linux-lan(9.75) + fnos2(8.84) |
| linux-lan 停机 | **0%** | **9.9 ms** | 只剩 fnos2(8.92) |
| 恢复后 | — | — | 已重新入网（断言通过） |

⚠️ **这个测试证明的比看起来的少，别当成「双向冗余已验证」**：
基线里 fnos2 的延迟本来就更低（8.84 < 9.75），而全网开着 `latency_first`，
所以停机前流量**很可能已经走 fnos2**。我停掉的是备用路径，不是在承载流量的那条。
停机后 RTT 反而从 10.8ms 降到 9.9ms 也印证了这点。

- ✅ 已验证：linux-lan 挂掉 → 家庭段仍可达
- ⬜ **未验证**：fnos2 挂掉 → linux-lan 是否接管（需 NAS sudo，
  跑 `DOWN_NODE=fnos2 ./scripts/test-gateway-failover.sh`）

公司侧（mini + dev198 双导出 `10.10.61.0/24`）**两个方向都未做过故障切换测试**。

## 还没做到 / 还没验证的

| 事项 | 状态 |
|---|---|
| `enable_kcp_proxy` 该不该开 | 未测。当前全节点显式 `false`。家↔公司已 0% 丢包 12ms，**没有证据表明需要开** |
| 手机接入（WireGuard portal） | 未做，方案里留了口子 |
| ICMP 到中继虚拟 IP 丢 ~20% 的机制 | **未查明**。已证伪两个假设（见下） |

## 已被实测证伪的假设（记下来免得重复走）

1. ❌ **「UDP/22 被中间设备限速导致丢包」** —— 面板加了 `udp 11010` 规则后换端口复测：
   丢包 21.5%（11010）vs 18.5%（22），吞吐两边都是 ~86 Mbps。**没有差别**，假设不成立。
   该规则最终用于增加第三条冗余通道，是可用性收益不是性能收益。
2. ❌ **「用户态 ICMP 限速」** —— 发包率从 5/秒 降到 1/秒，丢包率一点没变。
3. ❌ **「移动↔联通跨网直连不如绕香港」** —— 实测直连 12.7ms vs 中继 ~96ms。

## 对野草云 VPS 做过的改动

| 改动 | 可逆性 |
|---|---|
| 装 `easytier-core` / `easytier-cli` / `easytier-web-embed` | `uninstall-node.sh hk-relay` |
| `/etc/easytier/node.toml`（600 root:root） | 同上 |
| systemd `easytier-mesh.service` + `easytier-web.service` | 同上 |
| 装了 `iperf3` | `apt remove iperf3` |
| `~/.ssh/authorized_keys` 加 Air 公钥 | 手工删除 |
| `/etc/ssh/sshd_config.d/99-pubkey.conf`（**由川哥本人执行**，保留密码登录） | 删该文件 + reload |

## 待办

1. **首次打开 Web 控制台注册账号**（`http://10.10.10.1:11211`，组网内任意机器），
   注册完可给 `easytier-web.service` 加 `--disable-registration` 关掉注册入口
2. 手机接入（WireGuard portal）—— 想要再做，方案里留了口子
3. ICMP 到中继虚拟 IP 丢 ~20% 的机制仍未查明。**不影响任何真实流量**，
   仅需记住不要拿它当健康判据（判读规则见 docs/02 §二）
