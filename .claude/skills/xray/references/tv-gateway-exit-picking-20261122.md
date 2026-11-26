# 网关层出口优选与 IPv6 接入（2026-11-22）

网关上游可以使用 IPv6 出口。X96 有线口独立采用静态 IPv4；其开机策略和播放中测速约束以 [11 月 26 日实机记录](../../../../2-Projects/vps-proxy/tv-gateway/README.md) 为准。

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

## 十、电视「连不上」的头号原因：默认路由被 Android 抢回主路由（2026-11-25 复盘）

**现象**：电视重启后 SmartTube 打不开/播不动，网关侧 ping、adb 都正常；`dsh-tv-guard` 日志刷
`repaired drift` 与 `current=192.168.1.1` 交替出现；严重时 adb 报 `device offline`。

**根因两层**：
1. 电视重启后 DHCP 把默认网关设回 `192.168.1.1`（主路由），YouTube 走直连 → 不通。
   v1 守卫用 `ip route replace default via 192.168.1.19` 去改 **main / table eth0**，
   但 Android 的 netd 由 ConnectivityService 驱动，会周期性把这些表**重新装回** DHCP 版本，
   于是形成「守卫改回来 → netd 改回去」的拉锯，电视一半时间走直连。
2. 新上的 `dsh-tvlog` 每 7 秒重连一次 adb logcat，且每次都从缓冲区开头重放（几分钟就 3.7MB），
   把 adbd 拖到 `offline`，守卫的 adb 调用也跟着失败（日志里 `current=` 为空）。

**修法（v2，已上线）：
- **策略路由**：新建 `table 100`（`default via 192.168.1.19` + `192.168.1.0/24 dev eth0 scope link`），
  再插一条 `ip rule add priority 9000 from all lookup 100`。netd 只维护 10000 以上的规则与自己的表，
  **碰不到 9000**，所以种下即稳定。
- 判据改为「table 100 的 default 网关 == GW **且** 存在 9000 规则」；注意 `ip rule` 行尾有空格，
  匹配要用 `[[:space:]]` 而不是 `$`（这个坑让 v2 首版误判失败）。
- 守卫仍每 5 秒跑一次（`OnUnitActiveSec=5`），健康时静默退出（0.18s）。
- `dsh-tvlog` 改用 `logcat -T 1`（从当前开始，不回放历史）+ 秒退退避 20s；
  修完实测 75 秒内只有 1 次 `streaming`，文件 11–30KB，不再拖垮 adbd。

**复查命令**：
```bash
adb -s 192.168.1.144:5555 shell "ip route get 8.8.8.8"     # 必须 via 192.168.1.19 table 100
adb -s 192.168.1.144:5555 shell "ip rule | grep 9000"      # 必须有 9000: from all lookup 100
```
电视侧 `ip route` / `table eth0` 里仍是 `via 192.168.1.1` 也没关系——策略规则优先于它们。

**旁证**：日志后台在 2026-11-24 23:46 抓到一条真实播放错误
`ExoPlayerController: onPlayerError ... HttpDataSourceException: SocketTimeoutException`，
正是路由错误时段的产物；修好后 `events.log` 无新增。

## 十一、根治「默认网关被 Android 抢回」（2026-11-25 晚，codex 审核后重做）

### 11.1 结论：策略路由只是止血，根治点在 Android 的静态以太网配置

codex 用 AOSP 源码 + 实机 dump 审核后推翻了我两个判断：

| 我原来的说法 | 审核结论（附依据） |
|---|---|
| 「netd 管不到 9000 段规则」 | **只对日常增删成立**。`RouteController::Init()` 会 `flushRules()` 删掉 IPv4/IPv6 所有非 0 优先级的规则，9000 也删；netd 进程重启会再走一遍 |
| 「v1 被 netd 周期性覆盖」 | 确认是 **netd 重装 Ethernet 表**，但触发者不是 DHCP 续租，**是电视侧脚本每 10 秒的 `ip -6 addr flush dev eth0`**：AOSP `IpClient.compareProvisioning()` 把「IPv6 配置全丢」判为 `LOST_PROVISIONING` → Ethernet `stop()`/`start()` → 新 netId（现场 260→261）→ 用 Android 保存的静态配置（网关 .1）重建路由 |

**关键事实**：这台电视的 `eth0` 本来就是 **STATIC**，配置写在
`/data/misc/ethernet/ipconfig.txt`（v3 二进制，131B），里面 `gateway` 一直是 `192.168.1.1`。
所以任何「事后改路由」都会输——Android 每次重建都按这个文件装回 `.1`。

### 11.2 11 月 25 日的部署记录

1. **改 Android 的静态配置**：把 `ipconfig.txt` 里 `gateway` 的 `192.168.1.1` 换成 `192.168.1.19`
   （按字节模式 `00 0b "192.168.1.1"` → `00 0c "192.168.1.19"`，131B→132B；
   备份 `/data/local/tmp/ipconfig.bak2.txt` 与同目录 `ipconfig.txt.bak-20261125`）。
   重启后 `dumpsys ethernet` 显示 `Gateway 192.168.1.19`，Android 自己就把
   `default via 192.168.1.19 proto static` 装进 `table eth0` —— **无需任何外部改路由**。
   （codex 提示的 `IEthernetManager` Binder 方案可免重启，但需要自己编 DEX；改文件 + 重启更简单可靠。）
2. 当日尝试退役 `watch.sh`，并由晚期 `99-gateway.sh` 写 `disable_ipv6=1`。11 月 26 日查实，留在 `service.d` 的可执行备份仍会拉起旧进程。现役版本已将入口移出启动目录，早期过滤 eth0 路由通告，晚期在网络事件后复查规则。[现役盒端接线及回退](../../../../2-Projects/vps-proxy/tv-gateway/x96-install.md)
3. **网关侧守卫降级为「校验 + 应急兜底」**（`dsh-tv-guard.sh` v3，5s 一次）：
   读 `table eth0` 的默认网关，等于 .19 就静默退出；连续 2 次不对才装应急策略路由
   （table 100 + rule 9000），并在恢复正常后自动清掉应急规则。codex 指出旧版 `has_rule()`
   无论结果都 `echo yes` 导致误判，v3 改为直接判断实际网关，从根上避开该 bug。

### 11.3 11 月 25 日的重启读数

```
dumpsys ethernet → Static configuration: ... Gateway 192.168.1.19
ip route get 8.8.8.8 → via 192.168.1.19 dev eth0 table eth0    # Android 自己的表
ip -4 rule | grep 9000 → 无                                      # 没有任何补丁规则
disable_ipv6=1, eth0 无 IPv6 地址
nc www.youtube.com 443 → OK
```

### 11.4 仍需注意

- `ipconfig.txt` 是 v3 二进制，改错会让以太网配置整体失效（Android 会退回 DHCP，然后网关又变 .1）。
  改前必备份、改后必须 `dumpsys ethernet` 验证；解析不了就用「按字节模式替换」而不是重写。
- 电视重启后 `adb root` 会失效，写 `/data/adb/**` 前先 `adb root`。
- `dsh-tvlog` 若每 7 秒重连并回放整段 logcat，会把 adbd 拖到 `offline`（已用 `-T 1` + 退避修掉），
  排查 adb 不稳时先看它。
- 11 月 26 日起，验收看 eth0 全局 IPv6 地址数和 IPv6 默认路由数均为零，同时核对 Android 管理的 IPv4 网关与 DNS。链路本地 IPv6 可保留。

## 十二、如果要给电视开 IPv6 双栈：方案评审（2026-11-25，codex 分析，**未实施**）

> 结论：**为 YouTube 提速，现在不值得开**。IPv4 `hk-hy2` 已稳定 15–19MB/s（120–152Mbps），
> 而原生 v6 到 HK 是「13–15MB/s 峰值、随后 0.04–0.4MB/s」的突发型。
> 真要做，前提是先把「唯一 RA 来源」和「数据面闭合」两件事分开做，且只在无播放时切。

### 12.1 现场复核到的新事实

- 电视内核 `5.4.210-android12-9-…`，`eth0.disable_ipv6=1`、无 v6 地址、`accept_redirects=0`。
- **Armbian 除在用的 USB 网卡 `eth1`（r8152）外，还有板载 `eth0`（meson8b-dwmac，当前 NO-CARRIER）** ——
  独立下联在物理上可行。
- 80 秒被动抓包（AF_PACKET 非混杂）看到主路由 RA：源 `fe80::cacd:55ff:fe02:763c` / MAC `c8:cd:55:02:76:3c`，
  `preference=medium`，Router Lifetime 7200s，携带 `2409:8a00:8471:48c0::/64` 的 PIO（A=1,L=1）+ RDNSS。
- sing-box `tun-in` 只有 `172.19.0.1/30`（IPv4），IPv6 只有 link-local；走 `proxy` 的 14 条 IP 段**全是 v4**；
  `route.final=direct`。

### 12.2 RA 方案排序（「唯一默认路由来源」只有隔离能保证）

| 排名 | 方案 | 关键判断 |
|---|---|---|
| 1 | **板载 eth0 做电视专用下联**（独立子网） | 唯一能天然做到「只有 Armbian 发 RA」。代价：搬线 + 电视静态 IPv4/ADB/守卫都要重规划 |
| 2 | VLAN / 独立 AP 二层隔离 | 需 802.1Q 管理与端口划分；单臂 VLAN 共享 USB 链路带宽 |
| 3 | 交换机端口级压制上游 RA | 取决于设备是否支持按端口过滤 ICMPv6 type 134；组播 RA 发往 `ff02::1`，按目的 MAC 匹配无效 |
| 4 | 电视侧 `ip6tables` 只收 Armbian RA | 丢 RA 不会立刻清地址，但旧 RA 到期/切换留空窗会触发 `LOST_PROVISIONING`（同类风险我们已踩过）；只能在 v6 关闭态先装白名单再开 |
| 5 | Armbian 发 `pref=high`、主路由 `medium` | **能影响选路但不能保证唯一**：内核会同时保留两条 default（同 metric、`pref` 字段不同），主路由仍可能被选中 |

要点：Android 的 `RouteInfo` 没有 preference 字段，preference 只体现在内核路由属性与下一跳选择上，
所以「靠 preference 独占」不成立。

### 12.3 数据面必须同时堵两条漏

1. Linux 直接把电视的原始 v6 包从上联 `eth1` 转发出去（现在 `forwarding=1` + 默认路由走主路由 = 直连出境）。
2. 包进了 TUN 但命中 `route.final=direct`，由网关新建 v6 socket 直连。

做法要点（仅设计）：TUN 增加独立 v6 前缀（如 `fd7b:...:ffff::1/126`），`auto_route` 在 1.14 的 Linux 实现可覆盖转发流量；
再用 `inbound + source_ip_cidr + ip_version: 6` 的规则把电视 v6 准入流量固定到 `hk-hy2`，末尾对电视 v6 加 `reject`，
并在 `ip6tables` 侧拒绝电视原始 v6 走上联兜底。

### 12.4 地址来源三选一

| 方案 | 稳定性 | 备注 |
|---|---|---|
| ① ISP `/64` PIO | 差（前缀会从 `fcb0` 变 `48c0`） | 需持续跟踪上游前缀与寿命；`L=1` 还会让同前缀邻居直连 |
| **② 新 ULA `/64` + 代理（MVP 首选）** | 好（ISP 换前缀不影响） | 注意 Android `isGlobalPreferred()` **排除 ULA**，`isIpv6Provisioned()` 可能为 false，应用可能仍偏 IPv4；无需 NAT66 |
| ③ 只发默认路由、不发地址 | 无法公网通信 | 只有 `fe80::` 源地址，单独不可用 |

### 12.5 DNS 与 AAAA

只在「电视专用」的 DNS 策略里放开：对 YouTube 域名集合的 AAAA 查 `remote`（可继续走 IPv4 传输的 8.8.8.8），
其余 AAAA 及 `HTTPS/SVCB` 一律 `NOERROR` 空答案，避免 `ipv6hint` 成为第二条地址来源；
A 查询保持现有分流。前提是 DNS 规则能区分「来自电视」的请求（独立入口或实例）。

### 12.6 若将来做，MVP 五阶段（每步只读验收，切换只在无播放时）

0. 保持现状，记录基线（已完成）。
1. 用备用客户端验证 eth0/VLAN 独立下联 + ULA + 唯一 RA（搬线/改电视静态 IPv4 必须无播放）。
2. 先验数据面：测试客户端走 v6 TUN、准入流量固定 hk-hy2、未知 v6 拒绝；核对 RPDB/TUN/上联抓包
   （隔离环境可做；生产 sing-box 重载须无播放）。
3. 最后才开电视 IPv6 与 AAAA，验唯一网关、真实选源、DNS 正负样本、TCP/QUIC 路径。
4. 若将来开展双栈试验，先记录当时已通过冷启动的 IPv4 基线。退出试验按已核验的[盒端接线及回退](../../../../2-Projects/vps-proxy/tv-gateway/x96-install.md)恢复，并复核实际路由与播放。

### 12.7 结论

**先不做。** 现有单栈（v4 + hk-hy2）已经满足 4K；v6 的唯一潜在收益是绕开 v4 晚高峰限速，
而目前没有证据表明晚高峰 v4 会被压到 4K 门槛以下（`/var/lib/dsh/v6ab.csv` 仍在采样）。
等 `v6ab` 数据出现「晚高峰 v4 < 2.5MB/s 且 v6 明显更好」再启动上面的 MVP。
