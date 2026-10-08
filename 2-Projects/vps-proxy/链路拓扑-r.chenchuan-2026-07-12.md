# 代理链路拓扑 · r.chenchuan.cc 永活 dest（2026-07-12）

> 无密钥/无 UUID。客户端参数在服务器 `/root/*-params.json` 与会话交付链接，**禁止**写入 git 或 `0-System` 明文密钥。  
> 三引擎共享记忆：`0-System/RECENT_EVENTS.md`、`0-System/memory-items.md` → `[project/代理-vps-proxy]`。

## 目标

把 Reality 的 **dest/SNI** 从会 502 的业务站 `my.chenchuan.cc` 解耦到 **CF 永活静态域** `r.chenchuan.cc`，并在丽萨 / ZGO 上**只新增**链路，不改旧 inbound。

## CF 永活静态域

| 项 | 值 |
|----|-----|
| 域名 | `r.chenchuan.cc` |
| 托管 | Cloudflare Pages 项目 `reality-static-ok` |
| DNS | CNAME `r` → `reality-static-ok.pages.dev`，**小橙云** |
| 内容 | 静态页 `ok`（HTTPS 200） |
| 证书 | 区级 `*.chenchuan.cc` |

业务站 `my.chenchuan.cc` 继续独立发版；其 502 **alone 通常不杀 Reality**（TLS 握手层仍可成功），但 dest 绑业务站会带来误判与偶发风险，故不再作 dest。

## 中转 DMIT（`lax-relay` / `64.186.235.107` / fqzz）

既有 gost（勿删）：`gost` 8443、`gost-lisa2` 7443、`gost-lisa3` 5443、`gost-usvps2` 6443、`gost-us-vps` 等。

| 新增 unit | 监听 | 目标 |
|-----------|------|------|
| `gost-lisa-r` | `:8446` | 丽萨 `154.44.3.170:8446` |
| `gost-zgo-r` | `:8447` | ZGO `38.49.38.237:8447` |
| `gost-ph-r` | `:8448` | 菲律宾 Makati `61.245.11.252:443` |

## 落地丽萨（`lisa` / `154.44.3.170`，SSH 端口见本地 RTF）

| 端口 | dest / SNI | 状态 |
|------|------------|------|
| 8443 | microsoft | 旧，保留 |
| 8444 | my.chenchuan.cc | 旧，保留 |
| 8445 | api.hahaxiong.top | 旧，保留 |
| **8446** | **r.chenchuan.cc** | **2026-07-12 新增** |

参数指针：`/root/r-chenchuan-link-params.json`（服务器本地）。

## 落地 ZGO / us-vps2（`38.49.38.237`，hostname `gemini-special`，x-ui）

| 端口 | 说明 | 状态 |
|------|------|------|
| 443 | VLESS Reality（旧 dest 可能仍为 my.chenchuan.cc） | 旧，保留 |
| 10086 | VMess WS | 旧，保留 |
| **8447** | VLESS Reality **r.chenchuan.cc** | **2026-07-12 新增** |

- SSH：本机 `Host us-vps2` / `~/.ssh/us_vps2_rsa`（`zgo 服务器私钥.rtf` 可能与 authorized_keys 不一致）。
- 参数指针：`/root/zgo-r-chenchuan-params.json`。
- 性能：BBR+fq 已开；`/etc/sysctl.d/99-tcp-buffers.conf` 将 TCP 缓冲上限调至 **16MB**，`tcp_fastopen=3`。2G 内存不建议再上 64MB+。

## 客户端怎么走

```
手机/电脑
  → DMIT 64.186.235.107:<8446|8447|8448>
  → 丽萨:8446、ZGO:8447 或菲律宾:443
  → Reality dest TLS: r.chenchuan.cc
  → 出口：住宅(丽萨) / 美国机房(ZGO) / 菲律宾机房(Makati)
```

| 场景 | 建议 |
|------|------|
| ChatGPT / Claude / 需住宅 | DMIT **:8446** → 丽萨 |
| 速度 / Gemini / 机房即可 | DMIT **:8447** → ZGO |
| 菲律宾出口 / 独立测试 | DMIT **:8448** → 菲律宾 Makati |

导入链接以会话交付为准；重建时从对应服务器 params 生成。

## 排障要点

1. 多条订阅节点若都指向同一 DMIT IP，入口抖动会表现为「所有链接都挂」。
2. Reality 客户端**不需要**浏览器能打开 SNI 域名。
3. dest 应用永活静态域；业务站 502 ≠ 必然代理挂。
4. DMIT 面板强制重启日志像硬切（无优雅 shutdown 序列），属正常。

## 落地菲律宾（`ph-makati` / `61.245.11.252`，Makati AS19970）

> 2026-07-24 补完：xray bare core（非 3x-ui）+ systemd + healthcheck。

| 端口 | 协议 | dest / SNI | 状态 |
|------|------|------------|------|
| **443** | VLESS Reality Vision | **r.chenchuan.cc** | 已验收 E2E |
| **10086** | VMess WS | path 见服务器 params | 已验收 E2E |

- 参数指针：服务器 `/root/ph-vps-proxy-params.json`；本机密钥目录 `Documents/陈川个人站/自建 vps 密钥/菲律宾-vps-proxy-params.env`（不进 git）。
- DMIT 中转：`gost-ph-r.service`，监听 `64.186.235.107:8448`，转发到菲律宾 `:443`；`Restart=always`，随系统启动。
- 客户端导入：DMIT 中转 VLESS 链接保存在本机密钥 env 的 `VLESS_DMIT_LINK`，不写入 `~/xray/config.json`，不新增本地监听端口。
- 性能：BBR+fq、`tcp_fastopen=3`、16MB buffer、1G swap、healthcheck 每 2min、`Restart=always`。
- 2026-08-04 优化：修正网卡实际 qdisc 从 `pfifo_fast` 为 `fq`，由 `proxy-fq-qdisc.service` 开机持久化；TCP keepalive 调为 `120/30/4`；healthcheck 增加配置校验、dest TLS 与本地 Reality TLS 闭环。
- 2026-08-04 验收：使用临时 Xray 客户端验证 `VLESS_DMIT_LINK`，出口确认为菲律宾公网，OpenAI 返回预期 401；此前压力测试 Cloudflare 20/20 成功，5MB 下载约 1.37–1.42 MB/s（约 11 Mbps）。
- 备注：Reality **不要**对 inbound 开 `sockopt.tcpFastOpen`（曾导致握手 incomplete）；dest 优先用永活静态域 `r.chenchuan.cc`，勿绑业务站。

## 相关路径

- 项目：`2-Projects/vps-proxy/`
- 本机 xray 配置（分流规则）：`~/xray/config.json`（本地，非本仓）
- 共享记忆：`0-System/memory-items.md` → `[project/代理-vps-proxy]`

## 2026-10-03 · 国内 IPv4 回程异常后的恢复路径

国内多个出口连 DMIT `64.186.235.107` 和丽萨 `154.44.3.170` 的 IPv4 TCP 超时。DMIT 收到 SYN 并发出 SYN-ACK，但收不到最终 ACK；外部出口可完整连接，原 VLESS 参数经其他可达入口仍能得到 OpenAI 401 与正确丽萨出口。不能只凭此判定是哪家运营商或哪条过滤规则丢包，也不要通过重启节点、轮换密钥掩盖路径问题。

| 客户端 | 当前入口 | 丽萨出口链路 |
|--------|----------|--------------|
| Air Xray 的 `admin-dmit-LISA-不限速` | DMIT IPv6 `2605:52c0:2:c1a:e896:25ff:fe53:fea7:11443` | DMIT → 丽萨 `:11443` |
| Air v2rayN 的 `admin-LISA-ZGO-12443` | ZGO IPv4 `38.49.38.237:12443`，兼容无 IPv6 网络 | ZGO → 丽萨 `:11443` |
| Air Xray 的 `新美宅-Claude-GPT` | DMIT IPv6 `:7443` | DMIT → 丽萨 `:8444` |
| home-studio 的 `lisa-direct-then-dmit`（历史标签名沿用） | 主用 DMIT IPv6 `:7443`，备用 ZGO IPv4 `38.49.38.237:12444`，两者探测均失败才直连 ZGO `:443` | 前两路到丽萨 `:8444`，最后一路出口是 ZGO |
| Mini 的 `admin-dmit-LISA-不限速` | ZGO IPv4 `:12443` | ZGO → 丽萨 `:11443` |
| Mini 的 `新美宅-Claude-GPT` | ZGO IPv4 `:12444` | ZGO → 丽萨 `:8444` |

ZGO 上两个持久 systemd 服务 `zgo-lisa-admin-relay.service`、`zgo-lisa-legacy-relay.service` 使用 `socat` 裸 TCP 转发，分别监听 `:12443→154.44.3.170:11443`、`:12444→154.44.3.170:8444`；Reality 鉴权仍在丽萨端完成，转发端不保存节点密钥。服务以 `DynamicUser` 运行，已 enabled、active。**不经过 RackNerd**。Mini 和 dev198 的 DMIT→ZGO 旧 IPv4 出站也改为已有直连 ZGO 的 `:443`/`:11447`（保留原 VLESS 凭据与规则标签）；dev198 不配置丽萨出站。

home-studio 的旧 `lisa-direct-then-dmit` 标签保留，以免改动三条现有业务规则。Xray 本机 `127.0.0.1:14990` 开启 RoutingService；三个仅监听 `127.0.0.1` 的 SOCKS 探针口 `:14881/:14882/:14883` 分别直测 DMIT IPv6→丽萨、ZGO→丽萨、直连 ZGO。`lisa-failover-controller.timer` 每 30 秒调用 `lisa-failover-controller.service`，对 `http://cp.cloudflare.com/generate_204` 做 HTTP 204 探测：主链**连续两次失败**才选次链，两条丽萨链均连续两次失败才选直连 ZGO；恢复时需连续两次成功，优先回主链。切换通过 Xray API `bo` 覆盖选择，无需重启 Xray；状态保存在 `/var/lib/xray-lisa-failover/state.json`（root 600，只有健康状态与标签，无密钥）。Xray 刚启动时默认主链，不会因探测结果尚未生成而提前落入 ZGO。已有 TCP 连接不会迁移。

控制器源文件：本目录 `lisa-failover-controller.py`、`lisa-failover-controller.service`、`lisa-failover-controller.timer`；home-studio 分别部署在 `/usr/local/sbin/xray-lisa-failover`、`/etc/systemd/system/`。`burstObservatory` 原有的 30 秒/双样本探测继续服务其它均衡器，**不决定丽萨三级路由**。隔离 API 实测默认/主断/双断/主恢复，实际出站依次为 `新美宅-Claude-GPT`/丽萨、`美宅-Claude-GPT_mychenchuan`/丽萨、`Gemini专用-US2-VLESS-Reality-IP`/ZGO、再回主链；每步 OpenAI 无凭据请求均为 401。

验收：Air、Mini、home-studio 的 OpenAI 无凭据请求均为预期 401，Air/home-studio 出口验证为丽萨；ZGO IPv4 `:12443` 已用原 VLESS 凭据验出 401 和丽萨出口。dev198 两条 ZGO 出站用隔离 SOCKS 分别验出 401。v2rayN 仅验数据库完整性与同凭据临时 Xray 闭环，未同时启动其 GUI/TUN，以免和常驻 Xray 抢系统代理。Air `typesafe.ai` 为 200、Gemini 模型列表为预期 403、个人 CPA 未认证模型列表为预期 401。`console.typesafe.ai` 当次返回 403，是站点层响应，**不能**据此声称注册流程已成功。

回滚须**先恢复客户端配置，再停 ZGO 转发服务**，否则 Mini/home-studio 会立刻断线：

- Air：`~/xray/config.json.bak-dmit-ipv6-20261003-003557`；v2rayN 变更前备份 `~/Library/Application Support/v2rayN/guiConfigs/guiNDB.db.bak-dmit-ipv6-20261003-003712`，改用 ZGO 前备份 `guiNDB.db.bak-lisa-zgo-20261003-005947`。
- Mini：`~/xray/config.json.bak-zgo-lisa-20261003-004539`（丽萨出站改动前）及 `config.json.bak-zgo-direct-20261003-005450`（ZGO 出站改动前）。
- home-studio：回退前先 `systemctl disable --now lisa-failover-controller.timer`，再恢复 `/usr/local/etc/xray/config.json.bak-three-tier-20261003-011300`（两层，ZGO→丽萨主用、DMIT IPv6 备用）并重启 xray。`config.json.bak-lisa-api-controller-20261003-012702` 仅供对照，它保留的旧 loopback 方案在刚启动时会过早直连 ZGO，不建议作为运行回滚点。若要完全拆除 ZGO 新入口，须恢复更早的 `config.json.bak-lisa-v6-zgo-20261003-005020` 或另行改路由。dev198：`~/.config/xray/config.json.bak-zgo-direct-20261003-005525`。
- ZGO：客户端回退后执行 `systemctl disable --now zgo-lisa-admin-relay.service zgo-lisa-legacy-relay.service` 关闭两个新公网监听口。旧 DMIT `:8443` 已停用，不应作为回滚目标。

## 2026-10-08 · Air 分流更新

上节的 Air Xray `admin-dmit-LISA-不限速` 行仅记录 10-03 当时入口；10-08 起，原引用该标签的 4 条业务规则改走新出站 `admin-LISA-DMIT-11443`，入口 `131.143.181.60:11443`，仍由丽萨出网。旧出站保留但路由引用为 0。涉及 Proton、OpenAI/ChatGPT/Anthropic、后序 Google 规则及 TypeSafe；前序 Google 大规则优先于后序丽萨规则。回滚备份为 `~/xray/config.json.bak-admin-lisa-switch-20261008-075307`。

同日当前 Wi-Fi 无全局 IPv6，原 `admin-dmit-ZGO-不限速` 的 DMIT IPv6 入口不可达。只把该出站的入口地址换为 ZGO IPv4 `38.49.38.237:11447`，端口、Reality 参数和路由规则均未改；标签沿用旧名，但物理路径已不经过 DMIT。Google、Accounts、Gemini、Notion 经此入口恢复 200，Google API 无凭据返回预期 403；OpenAI 经新丽萨出站无凭据 401，TypeSafe 200，个人 CPA 仍 Xray `direct`、无凭据 401。回滚备份为 `~/xray/config.json.bak-google-zgo-direct-20261008-080057`。两次修改均已通过 `xray run -test` 并重载 `com.xray.proxy`；原始配置和凭据不入 Git。
