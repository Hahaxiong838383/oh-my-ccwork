# Cross-site mesh · EasyTier 异地组网

把家里和公司的机器组成一张私有虚拟内网，优先 P2P 直连，香港节点只做发现与兜底中继。

**当前状态见 [`STATUS.md`](STATUS.md)。**

---

## 快速上手

```bash
# 前置：~/.mycc-secrets.env 里需有 EASYTIER_NETWORK_NAME / EASYTIER_NETWORK_SECRET / VPS_ROOT_PASS
./scripts/mesh-status.sh              # 看全网链路（每条是 p2p 还是走中继）
./scripts/deploy-node.sh <节点名>      # 部署/更新单个节点（幂等，可反复跑）
./scripts/bench.sh dev198 hk-relay    # 测某条链路的延迟/丢包/吞吐
./scripts/uninstall-node.sh <节点名>   # 干净卸载
```

需要 sudo 密码的节点（`linux-lan` / `air`）：

```bash
SUDO_PASS='xxx' ./scripts/deploy-node.sh linux-lan
```

---

## 目录

| 路径 | 内容 |
|---|---|
| [`docs/00-原方案评估与优化决策.md`](docs/00-原方案评估与优化决策.md) | 对原 HTML 方案的逐条评估：3 项 P0、2 项安全、2 项正确性问题，以及改法与理由 |
| [`docs/01-架构与网段规划.md`](docs/01-架构与网段规划.md) | 节点表、网段冲突核对、端口规划、代理共存 |
| [`docs/02-实测基线与判读规则.md`](docs/02-实测基线与判读规则.md) | 部署当天的实测数字 + **判读规则**（不看会误诊） |
| `nodes/*.toml` | 每节点配置模板（密钥用占位符，不含明文） |
| `scripts/` | 部署、巡检、基准、卸载 |
| `野草云-EasyTier-异地组网完整方案.html` | 原始方案，保留供对照 |

---

## 三条最容易踩的坑（都是本次实测踩出来的）

**1 · 端口 11010 连不上，不是 NAT 打洞失败**
野草云面板侧有**客户不可关闭**的供应商防火墙，入站白名单只有
`tcp22 / udp22 / tcp80 / tcp443 / tcp8888 / icmp / ipv6-icmp`。
打到 11010 的包被上游**静默丢弃**（timeout 而非 RST），症状与打洞失败完全同形。
本方案把服务落在 `443 / udp 22 / 80` 上，不需要动面板。

**2 · `ping 10.10.10.1` 丢包 30% 不代表链路坏了**
中继虚拟 IP 的 ICMP 稳定丢 10–30%，但同一时刻 TCP 吞吐 88 Mbps、106MB 只重传 45 次。
**判断健康看吞吐，或 ping 两个客户端节点之间**。详见 docs/02 §二。

**3 · 配置检查通过 ≠ 配置正确**
`--check-config` 只验 TOML 语法、**不验键名**，写错的键被静默丢弃且照样 PASS。
所以 `rpc_portal` 写进 TOML 是无效的，必须用 CLI 参数覆盖。

---

## 安全边界

- `network_secret` 只存在两处：`~/.mycc-secrets.env`（600，不进 git）和各节点
  `/etc/easytier/node.toml`（600 root:root）。**不进 systemd unit、不进命令行参数、不进本仓库。**
- 管理 RPC 绑 `127.0.0.1:15888`。
- `private_mode = true`：只有持同一 network_name + secret 的节点能握手或中继，
  不会变成公开中继。
- 未接入任何第三方公共节点，发现过程完全自建。
