# 电视盒代理从设备迁到网关层：架构、七个坑与验收（2026-11-21）

## 现役盒端 IPv4 主备（2026-11-27）

Android 保持静态以太网配置，盒端 `x96-gateway-watch.sh` 通过 `x96-gateway-route.sh` 同时切换外网 IPv4 下一跳与 TCP/UDP DNS。首选 Armbian（.19），备用 TR3000（.254）。家庭直播源继续走局域网。11 月 25 日退役的旧 `watch.sh` 会反复清理 IPv6 地址，应留在启动目录外。11 月 26 日曾验证静态 IPv4 断电开机，11 月 27 日这次切换发生在同一次开机内。[盒端安装与状态检查](../../../../2-Projects/vps-proxy/tv-gateway/x96-install.md)

每个候选网关分别接受带独立标记的 DNS 查询和经该网关 SOCKS 发送的 HTTP 请求。主网关连续两轮失败且备用通过时切备用。主网关连续三轮成功后，已确认同一局域网直播连接持续收包，或解码器和媒体会话均空闲时，可回主。若备用健康且外网播放正在进行或状态不明，延后回切。日常排障先核对盒端当次启动的 `/data/misc/x96-boot-status/gateway` 和 `X96Gateway` 日志，再核对普通业务转发。网关内部媒体出口由另一套守护选择。

11 月 27 日的演练只阻断主网关的健康探针，采样覆盖同次开机内主、备、回主三个阶段。故障条件、实际下一跳与前台直播的实测数据见[项目验收记录](../../../../2-Projects/vps-proxy/tv-gateway/README.md#盒端双网关)。

## 11 月 21 日的迁移记录

本篇记录一次架构级改造：**电视盒不再自己跑代理**，改为把默认网关/DNS 指向局域网里的
Armbian 盒子（`192.168.1.19`），由它跑 sing-box TUN + 分流；TR3000（`192.168.1.254`）+ U 盘
做备用网关，电视盒侧做自动回退。

适用场景：电视盒算力/内存吃紧、要集中管理多条出口、或希望"电视盒子只管播片"。

## 0. 先给结论

| 项 | 结果 |
|---|---|
| 最终验收 | 4K60 连续播放 **5.5 分钟**，11/11 次采样 `state=3`、`3840×2160`、7.2–13.7 Mbps、0 异常 |
| 主网关 | Armbian `192.168.1.19`：sing-box 1.14.4，TUN `172.19.0.1/30` MTU 1400/system，7 条出口 + urltest |
| 备网关 | TR3000 `192.168.1.254`：U 盘上的 musl sing-box，TUN `172.20.0.1/30` MTU 1280，6 条出口 |
| 回退 | 电视盒侧功能健康度判定，主网关挂掉 **18 秒**切到备网关；恢复后自动切回 |

## 1. 架构

```
电视盒 192.168.1.144（本地代理进程 = 0）
   │ 默认路由 + DNS
   ├─ 正常 → 192.168.1.19 (Armbian)
   │           ├ dsh-gateway.service    sing-box TUN + 7 出口 + urltest
   │           ├ dsh-dns-relay.service  UDP53 → 8.8.8.8（走自身 TUN 被 sing-box 解析）
   │           └ dsh-tv-guard.timer     每 30s 用 adb 纠正电视盒路由/DNS/IPv6
   └─ 主挂 → 192.168.1.254 (TR3000)
               ├ /mnt/usb/proxy/sing-box (musl, 从 OpenWrt 包提取)
               ├ dnsmasq 监听 :53（上游 8.8.8.8 被本机 sing-box 劫持）
               └ 防火墙 zone tun(masq) + forwarding lan→tun
```

## 2. 七个必修的坑（按踩到的顺序）

### 坑 1｜`{"action":"sniff"}` 必须显式给 sniffer

sing-box 1.13+ 把 inbound 的 `sniff` 字段删了，改用路由动作。但只写 `{"action":"sniff"}`
**不会嗅探**，必须：

```json
{"action":"sniff","sniffer":["tls","http","quic"],"timeout":"500ms"}
```

判读：日志里出现 `inbound connection to <域名>:443` 才算嗅到；只出现 IP 就是没生效。

### 坑 2｜TUN 转发的流量即使嗅到了，也不按域名路由

实测：电视盒经 TUN 进来的连接，日志里始终是裸 IP，`domain_suffix` 规则不命中 → 落到 `final: direct`
→ YouTube 直连被墙，表现为"能解析、能握手、就是不出画面"。

**必须叠加 IP 段兜底**（Google 系 13 个 CIDR）：

```json
{"ip_cidr":["142.250.0.0/15","142.251.0.0/16","172.217.0.0/16","173.194.0.0/16",
            "74.125.0.0/16","209.85.128.0/17","216.58.192.0/19","108.177.0.0/17",
            "64.233.160.0/19","66.249.80.0/20","216.239.32.0/19","142.0.64.0/18",
            "34.64.0.0/10","35.190.0.0/17"],"outbound":"proxy"}
```

### 坑 3｜Android 用「按网卡分表」的路由，改 main 表等于没改

`ip route get 8.8.8.8` 显示的是 `table eth0`。必须**两张表都改**：

```sh
ip route replace default via $GW dev eth0
ip route replace default via $GW dev eth0 table eth0
```

### 坑 4｜旧栈残留的 `VIDEO_DNS` iptables 链会让全设备 DNS 静默挂掉

旧代理栈留下的：

```
-A OUTPUT -j VIDEO_DNS
-A VIDEO_DNS -p udp --dport 53 -j REDIRECT --to-ports 5354   # 5354 已无监听
-A OUTPUT -j VIDEO_DNS4_GUARD
-A VIDEO_DNS4_GUARD -p udp --dport 53 -j REJECT
```

表现：`nslookup` 对**任何**域名都失败（包括国内），`ping` 报 `unknown host`。
退役时先核实跳转和启动来源。若来源是 Magisk 通用启动目录里的可执行脚本，把入口移出启动目录，再核对实际进程及残留规则。

### 坑 5｜Magisk `service.d` 执行**任意扩展名**的文件

把 `video-proxy.sh` 改名成 `video-proxy.sh.disabled` 放回 `service.d`，开机**照样被执行**。
退役旧栈要把文件**移出目录**，不能只改后缀。

### 坑 6｜Android 会在开机后重写默认路由，且 boot 上下文改不动它

DHCP 续约/网络栈重建会把 `table eth0` 的 default 改回主路由。在 `service.d` 里起的守护
（即使 `setsid`）在该上下文里 `ip route replace` 不生效。

以下为 11 月 21 日网关侧定时纠正路由的历史实现。现役 X96 已采用 Android 静态以太网配置。前台排障时复用现有 ADB 会话，只读默认网络和路由。

```sh
# /usr/local/sbin/dsh-tv-guard.sh  +  dsh-tv-guard.timer (OnUnitActiveSec=30)
adb connect 192.168.1.144:5555; adb root
adb shell "ip route replace default via 192.168.1.19 dev eth0; \
           ip route replace default via 192.168.1.19 dev eth0 table eth0; ..."
```

实测重启后 30 秒内自动恢复，40 秒采样全绿。

### 坑 7｜DNS 必须 `ipv4_only`，否则解析出 IPv6 会绕开代理

`dns.strategy` 若为 `prefer_ipv4`/未设，Android 拿到 AAAA 后走本地 IPv6 直连出境 → 被墙，
表现为 `SSLHandshakeException: connection closed`（TLS 握手阶段断）。

```json
"dns": {"strategy":"ipv4_only",
        "servers":[{"tag":"cn","type":"udp","server":"223.5.5.5"},
                   {"tag":"remote","type":"udp","server":"8.8.8.8","detour":"proxy"}]}
```

## 3. 局域网 DNS 的可靠做法

`hijack-dns` 在本场景**对转发流量不生效**（本地查询能劫持，电视盒进来的不行，按 `port:53` 或
`protocol:dns` 都不行）。可行做法二选一：

1. **网关自建中继**：`dsh-dns-relay.py`（UDP 53 → 8.8.8.8），它自己的查询走 TUN 被 sing-box 解析。
   注意：如果中继改走 socks，会撞上 `hijack-dns` 规则形成自环。
2. **OpenWrt 上直接用 dnsmasq**：监听 LAN 地址 :53，`noresolv=1` + `server=8.8.8.8`。

## 4. 双网关冗余（TR3000 + U 盘）

### 4.1 extroot 在 TR3000 上是不可能的（重要教训）

`kmod-usb-storage` 装在 overlay 里；把 overlay 迁到 U 盘后形成死锁：
**挂载 U 盘 → 需要驱动 → 驱动在 U 盘上**。结果路由器直接起不来，只能拔 U 盘 + 断电恢复。

**结论：U 盘只做数据盘**（`/etc/config/fstab` 里挂 `/mnt/usb`，挂不上就跳过，不影响启动）。

### 4.2 二进制必须是 musl 版

- GitHub 官方 `sing-box-*-linux-arm64` 是 **glibc 动态链接**，OpenWrt 上 `not found`。
- 正确做法：拿 OpenWrt 的包再提取——

```sh
apk fetch sing-box            # 或直接下 sing-box-<ver>-r1.apk
mkdir x && cd x
apk extract --allow-untrusted ../sing-box-<ver>-r1.apk
./usr/bin/sing-box version    # 应显示 with_quic 等 tags
```

`sing-box-tiny` 无 `with_quic`（**不能跑 hy2**），要 hy2 必须用完整包（42.4M）。

### 4.3 配置要点

```json
"inbounds":[{"type":"tun","address":["172.20.0.1/30"],"mtu":1280,
  "route_exclude_address":["10.10.10.0/24","192.168.1.0/24","172.20.0.0/30"]}]
```

- `route_exclude_address` 必须排除**组网段和局域网**，否则 EasyTier 自己的流量会被卷进代理，隧道抖动。
- MTU 用 **1280**（1400 在 Reality/hy2 上会丢大包，表现同样是 TLS 握手失败）。
- TUN 名会自动避让（EasyTier 已占 `tun0` → sing-box 用 `tun1`）。

### 4.4 OpenWrt 必须建防火墙 zone，否则转发被丢

```sh
uci set firewall.tunzone=zone; uci set firewall.tunzone.name='tun'
uci set firewall.tunzone.input='ACCEPT'; uci set firewall.tunzone.output='ACCEPT'
uci set firewall.tunzone.forward='ACCEPT'; uci set firewall.tunzone.masq='1'
uci set firewall.tunzone.mtu_fix='1'; uci add_list firewall.tunzone.device='tun1'
uci set firewall.lan2tun=forwarding; uci set firewall.lan2tun.src='lan'; uci set firewall.lan2tun.dest='tun'
```

不加这条：局域网能 ping 通网关、TCP 也连得上（因为那是路由器本机），但**转发流量全被 fw4 丢掉**。

### 4.5 自启要等 U 盘

init 脚本直接 exec 二进制会撞上"U 盘还没挂载"的时序竞争。用包装脚本最多等 90 秒：

```sh
# /etc/dsh-backup-start.sh
while [ $i -lt 45 ]; do [ -x /mnt/usb/proxy/sing-box ] && break; sleep 2; i=$((i+1)); done
exec /mnt/usb/proxy/sing-box run -c /mnt/usb/proxy/config.json
```

## 5. 11 月 21 日的回退探针

主网关进程停了，主机照样 ping 得通 → 只按可达性判断永远不会切。

```sh
健康 = 当前网关 ping 通 && busybox nc -w 4 142.250.0.1 443 成功
连续 2 次不健康 → 切到另一条；每 10 秒一轮
```

用 Google IP 做探针的原因：国内直连该地址必然失败，能通就说明代理链真的在工作。

## 6. 验收方法（可复用）

```sh
# 每 30 秒采样一次，至少 10 次
state=$(adb shell 'dumpsys media_session | grep -oE "state=[0-9]+"')   # 3=playing 6=buffering 0=idle
res=$(adb shell 'cat /sys/class/video/frame_width')                     # 3840 = 4K
rx=$(adb shell 'cat /sys/class/net/eth0/statistics/rx_bytes')           # 差分 = 实际码率
```

判读：`state` 全程 3、分辨率全程 3840、码率稳定在 5 Mbps 以上（4K 通常 12–30 Mbps）即通过。
**注意**：4K 硬件解码时 `screencap` 拍到的是黑屏，**不能用截图判断是否在播**，必须看
`media_session` 的 state 与解码器分辨率。

## 7. 快速排障顺序

1. 电视盒 `ip route get 8.8.8.8` 是否指向网关（注意 `table eth0`）
2. `iptables -t nat -S OUTPUT` 有没有残留 `VIDEO_DNS`/`REDIRECT 5354`
3. 从盒端查询 `www.youtube.com` 的 A 记录，记录响应码和有效 IPv4 答案。同一域名可返回多个地址，地址段会变化。
4. 网关 `journalctl -u dsh-gateway` 看该连接走的哪个 outbound（`direct` 就是分流没命中）
5. 网关侧 `curl -x socks5h://127.0.0.1:1080 https://www.youtube.com` 是否 200
6. 仍不通 → 查 MTU（TUN 降到 1280 试）、查 `dns.strategy` 是否 `ipv4_only`

## 8. SmartTube 获取 PoToken 失败时的两种现场

症状：SmartTube 报播放错误（用户常转述为「403」），但**所有网络指标都正常**——各出口访问
`www.youtube.com` 200、`youtubei.googleapis.com` 405、DNS 干净、路由稳定、网关日志也没有异常。

真相在 logcat：

```
ExoPlayerController: onPlayerError: ExoPlaybackException:
  ...source.sabr.parser.exceptions.SabrPoTokenError: PoToken error: PENDING
```

YouTube 对 **SABR 流**要求 PoToken，SmartTube 用 `challenge-solver` 跑 YouTube 的 player JS 生成它。
**缓存里的 player 版本过期后，token 会一直 PENDING**，播放直接失败。

11 月 26 日同一组件 `TvPoTokenProvider` 也报获取失败，底层是 `UnknownHostException`。当时电视对网关的 DNS 请求连续超时，远程 DNS 和媒体出口同时失联。随后切到香港，原视频从 607.024 秒继续播放。[网关与实播记录](../../../../2-Projects/vps-proxy/tv-gateway/README.md#冷启动通过后的第二次播放错误)

### 11 月 22 日挑战缓存故障的处理记录

此操作会停止 SmartTube 并清除挑战缓存。仅在日志重现上述 PENDING 错误，且用户已同意中断播放和清理缓存时使用。若保护状态为 OK、缓冲耗尽且分片仍在传输，先看原视频的分片速度和解码进度。

```sh
adb shell am force-stop org.smarttube.beta
adb shell 'rm -rf /data/data/org.smarttube.beta/files/challenge-solver/*                   /data/data/org.smarttube.beta/files/tcl-challenge-solver/*'
adb shell 'rm -f "/data/data/org.smarttube.beta/shared_prefs/yt_cache_service2%KEY%challenge-solver.xml"                  "/data/data/org.smarttube.beta/shared_prefs/yt_cache_service2%KEY%tcl-challenge-solver.xml"'
adb shell 'am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=VIDEO_ID" org.smarttube.beta'
```

重启后 App 会重新拉当前 `tv-player-*.js` 生成 token，实测立刻恢复播放。

### 判读要点

| 现象 | 可能原因 | 判别 |
|---|---|---|
| 获取令牌时报域名解析失败 | DNS 或承载远程 DNS 的出口 | `UnknownHostException` 或 `EAI_NODATA`，对照同窗盒端解析结果与网关超时记录 |
| 播放失败且挑战持续未就绪 | PoToken 挑战 | 日志反复出现 `SabrPoTokenError` 且详情为 `PoToken error: PENDING`，同时确认相关域名解析和连接正常 |
| 播放卡顿 | 带宽不足 | `state=3` 但码率低、buffer 反复 |
| 打不开、转圈 | 路由/DNS | 网关日志里没有该连接，或 DNS 不干净 |
| 国内直连 YouTube 返回什么 | 超时(000)，**不是 403** | 所以「路由漂移→403」这个假设不成立 |

保留首次播放器错误、底层异常和时间戳，再与同一时段的网络日志对齐。自动重试时，后续日志可能只剩下获取令牌失败的提示。
