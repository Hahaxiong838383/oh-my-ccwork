# 网关层出口优选与 IPv6 接入（2026-11-22）

> 场景：电视盒 YouTube 4K 由 Armbian 网关（`192.168.1.19` / 组网 `10.10.10.25`）跑 sing-box 分流，
> 多出口（hy2/REALITY）择优。本文是「怎么选出口、怎么测、哪些坑」的现行真值。
> 配套文档：`2-Projects/vps-proxy/2026-11-22-测速源调研与出口实测.md`、
> `2026-11-22-出口优选与IPv6接入经验教训.md`。

## 一、现行架构（2026-11-22 上线）

| 组件 | 作用 | 要点 |
|---|---|---|
| `dsh-gateway.service` | 生产 sing-box（TUN + 分流 + DNS） | 配置 `/etc/dsh-gateway/config.json`；`proxy` 选择器 `"default": "hk-hy2"` |
| `dsh-probe.service` | 探针侧车：每条出口一个 SOCKS 口（19201+） | 配置由 `dsh-gen-probe.py` 从生产 config 生成；**测速不碰生产选择器** |
| `dsh-pick-exit.timer`（10min） | 带宽择优 | 轻量体检当前出口；不合格/卡顿/满 6h 才全量扫描 |
| `dsh-watch-exit.timer`（1min） | 存活看门狗 | 当前出口打 `youtube.com/generate_204`，连续 2 次失败触发择优 |
| `dsh-log-guard.timer`（5min） | `/var/log`(zram 47M) 兜底 | 占用 >85% 自动截断 + 重启 rsyslog |

出口清单**单一真源**：`/etc/dsh-gateway/probe-exits`（每行一个 tag）。选择器与看门狗都从这里读；
加/删出口只改这一处 + 重新生成探针。

## 二、测速方法（踩过坑后定稿）

- 主指标 `https://dl.google.com/go/go1.23.0.linux-amd64.tar.gz`（73.6MB，版本路径永不变，与 YouTube 同网）
- 副指标 `https://sin-speed.hetzner.com/1GB.bin`（Range 206，中立新加坡源站）
- 快检 `https://speed.cloudflare.com/__down?bytes=50000000`（**≥1e8 返回 403**；Range 被忽略；Anycast 只代表最近 PoP）
- **必须**：文件 ≥50MB、`Accept-Encoding: identity`、`--max-redirs 0`、8s 窗口
- **有效速率 = size / (time_total − time_starttransfer)**。裸 `speed_download` 把 TCP+TLS+首字节算进分母，
  1MB 文件实测低估 **4.6 倍**（5.28 vs 真实 24.4 MB/s）
- 判据：4K 门槛 2.5 MB/s（YouTube 官方 20 Mbps），健康线 4 MB/s

## 三、扫描与判决算法（v4.1）

```
轻量体检（每 10min）：当前出口 Google 12MiB/5s；低于底线再复测一次（防冷启动误判）
需要全量时（当前<2.5 / 电视卡顿 / 满 6h）：
  1) 并行探路：6 条出口各 8MiB×3 轮（同一时刻，互不干扰 WAN）→ 取中位排序
  2) 串行复测前二：25MiB×3 采 → 取中位（**不要用最大值**）
  3) 新出口须 ≥ 当前×1.25 且 ≥2.5 MB/s 才切；切后复验，验不过自动回滚
```

**为什么串行三采取中位**：`hk-v6` 这类通道会出现「一采 15MB/s、后两采 0.1MB/s」的突发型表现；
用最大值会把突发通道判成好通道，切过去电视立刻卡死。中位/最小才代表可持续带宽。

## 四、REALITY 兼容性坑（重要）

**sing-box 1.14.4 与 Xray 26.11.9 的 REALITY 握手不兼容**：客户端报 `reality verification failed`。
判据三步：①同参数换 xray 客户端（服务端本机 loopback）能通 → 服务端配置无罪；
②降 MTU 仍失败 → 不是黑洞；③改标准 VLESS+TLS 立刻通。

因此新增 v6 出口走 **VLESS + TLS**（LE `derp.hahaxiong.cc`，uTLS chrome，alpn `h2,http/1.1`）。
老的 8445 REALITY inbound 保留给手机等客户端。历史上 `hk-reality-test` 一直 000 也是同一处不兼容。

## 五、野草云（HK）的供应商防火墙

面板侧防火墙**客户不可关闭**，入站白名单：`tcp 22 / udp 22 / tcp 80 / tcp 443 / tcp 8888`
（另有事后人工放行的 `8443/8444`，以及 2026-11-22 放行的 `19443`）。
其余端口（实测 2053/2083/2087/2096/8447/8880/9443/8445/8446）从家里打 **v6 全是静默丢弃**。
所以：**新开 v6 入口必须在野草云面板放行端口**，网关侧配得再对也没用。

## 六、原生 IPv6 到 HK 的真实质量（2026-11-22 实测）

- 打 HK `ping6` 82ms 0% 丢包；`v6 443/80/22` 可建连
- 但**大流量不稳**：首采 13–15 MB/s，随后跌到 0.04–0.4 MB/s（重复 4 次同型）
- 用 **xray 客户端**在另一台机（home-studio）复测同样坍缩 → **网络层问题，不是 sing-box**
- 结论：`hk-v6` 作为**备路**保留在出口池，别当主路；选择器用中位判据会把它自动压到低位

## 七、DNS 与 IPv6 的正确姿势

`dns.strategy=ipv4_only` 是**刻意保留的保护**：安卓拿到 AAAA 会直连出境被墙（`SSLHandshakeException`）。
要加 v6 出口时，outbound 直接写**字面 v6 地址**，不要为了它放宽全局 AAAA。
排查 v6 也要注意：`curl -6 域名` 失败可能只是解析不到 AAAA，用 `--resolve 域名:443:[v6]` 才能验真实传输。

## 八、证书（xray 以 `xray` 用户运行）

xray 读不到 `/etc/letsencrypt`（700 root）。做法：
- 证书复制到 `/etc/xray/tls/{fullchain,privkey}.pem`（`xray:xray`，640）
- `/etc/letsencrypt/renewal-hooks/deploy/sync-xray-cert.sh`：比对 sha256，变了才复制并 `systemctl restart xray`
  （未变则跳过，避免续期钩子把 xray 白重启一次）

## 九、电视盒日志后台（2026-11-23 起）

`dsh-tvlog.service`（网关常驻，`Restart=always`）负责把电视 logcat 收成可控的三层结构：

| 文件 | 内容 | 保留 |
|---|---|---|
| `/var/lib/dsh/tvlog/tv-YYYYmmdd-HH.log` | 只收 `*:W`（警告及以上），剔除 adbd/hwc_nn/ActivityThread 等刷屏 tag | **24 小时**（`find -mmin +1440 -delete`），按小时切分 |
| `tail.log` | 每 2 分钟覆盖写最近 4000 行**完整**日志（含 D/I），用于事后还原现场 | 固定 ~400KB，只留最新 |
| `events.log` | 命中 `PlaybackException/ERROR_CODE/Response code: 4xx/5xx/LOGIN_REQUIRED/not a bot/SabrPoToken/FATAL/ANR` 的汇总行 | 到 50MB 滚动一次 |

- 实测量：W 流 206 行/分 ≈ **25MB/天**；目录总量兜底 400MB（超了先删最旧）。
- adb 掉线（电视关机）→ 每 60 秒重试 `adb connect`，不刷日志。
- 排查入口：`grep -nE "ERROR_CODE|PlaybackException|503|403" /var/lib/dsh/tvlog/events.log | tail`；
  需要完整上下文看 `tail.log`（近 5–10 分钟全量）。
- 注意：电视 4K 硬解时 `screencap` 是黑屏，**不要用截图判断是否在播**；用
  `dumpsys media_session` 的 `state` + `PlaybackState.error` + `rx_bytes` 差分。
