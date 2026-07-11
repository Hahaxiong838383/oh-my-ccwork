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
  → DMIT 64.186.235.107:<8446|8447>
  → 丽萨:8446 或 ZGO:8447
  → Reality dest TLS: r.chenchuan.cc
  → 出口：住宅(丽萨) / 机房(ZGO)
```

| 场景 | 建议 |
|------|------|
| ChatGPT / Claude / 需住宅 | DMIT **:8446** → 丽萨 |
| 速度 / Gemini / 机房即可 | DMIT **:8447** → ZGO |

导入链接以会话交付为准；重建时从对应服务器 params 生成。

## 排障要点

1. 多条订阅节点若都指向同一 DMIT IP，入口抖动会表现为「所有链接都挂」。
2. Reality 客户端**不需要**浏览器能打开 SNI 域名。
3. dest 应用永活静态域；业务站 502 ≠ 必然代理挂。
4. DMIT 面板强制重启日志像硬切（无优雅 shutdown 序列），属正常。

## 相关路径

- 项目：`2-Projects/vps-proxy/`
- 本机 xray 配置（分流规则）：`~/xray/config.json`（本地，非本仓）
- 共享记忆：`0-System/memory-items.md` → `[project/代理-vps-proxy]`
