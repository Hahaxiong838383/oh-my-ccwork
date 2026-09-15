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

## 2026-09-11 变更（限速 + admin + home-studio 直连）

- 非 admin 通道（`443/10086/5443/6443/7443/8446/8447/9443`）共享 **5Mbps** HTB（脚本仍由 `dmit-limited-4mbit.service` 开机执行，2026-09-14 由 1Mbps 上调）：回国 **sport** + 中转去 ZGO `38.49.38.237:{8447,443}` + 中转去丽萨 `154.44.3.170:{8446,8444,8445}`。**不限**：SSH 22、admin 丽萨 `:11443`、admin ZGO `:11447`、菲律宾 `:8448`。u32 只匹配 IPv4 包；`ss` 里的 `[::ffff:x.x.x.x]` 是 IPv4 客户在双栈套接字上的显示，网上仍走 IPv4。真 IPv6 客户才会绕过（现网 0 条）。
- 2026-09-11：DMIT `gost.service` `:8443 → 丽萨:8443` 已停用下线（备份 `/root/backup-gost-8443/`）。落地丽萨 `:8443` inbound 未动。
- admin ZGO 新 inbound `:11447` dest `r.chenchuan.cc`（新 UUID/密钥）；DMIT `gost-admin-zgo` `:11447 → 38.49.38.237:11447`。参数 `/root/zgo-admin-r-chenchuan-params.json`。
- admin 丽萨新 inbound `:11443` dest `r.chenchuan.cc`（新 UUID/密钥）；DMIT `gost-admin-lisa` `:11443 → 154.44.3.170:11443`。参数 `/root/lisa-admin-r-chenchuan-params.json`。
- home-studio Xray：原 DMIT→丽萨规则改 balancer `lisa-direct-then-dmit`（直连 `美宅-Claude-GPT_mychenchuan`，fallback `新美宅-Claude-GPT`）；原 DMIT→ZGO 改 `zgo-direct-then-dmit`（直连 `Gemini专用-US2-VLESS-Reality-IP`，fallback `DMIT-Gemini-vps-chenchuan`）。备份 `config.json.bak-direct-fallback-20260911-101229`。

## 中转 DMIT（`lax-relay` / `64.186.235.107` / fqzz）

既有 gost（勿删）：`gost-lisa2` 7443、`gost-lisa3` 5443、`gost-usvps2` 6443、`gost-us-vps` 等。`gost.service` `:8443` 已下线。

| 新增 unit | 监听 | 目标 |
|-----------|------|------|
| `gost-lisa-r` | `:8446` | 丽萨 `154.44.3.170:8446` |
| `gost-zgo-r` | `:8447` | ZGO `38.49.38.237:8447` |
| `gost-ph-r` | `:8448` | 菲律宾 Makati `61.245.11.252:443` |
| `gost-admin-lisa` | `:11443` | 丽萨 `154.44.3.170:11443`（admin，不限速） |
| `gost-admin-zgo` | `:11447` | ZGO `38.49.38.237:11447`（admin，不限速） |

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
