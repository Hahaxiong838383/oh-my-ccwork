# 电视盒播放与网关 DNS

2026-11-26 在 X96 和 Armbian 网关验证。电视以太网使用静态 IPv4，网关和 DNS 均为 `192.168.1.19`。DIYP 的家庭直播源由同一局域网的 `192.168.1.211:4022` 提供。

## 开机修复与验收（11 月 26 日晚）

旧脚本负责主备网关切换，并在循环里清除 eth0 的 IPv6 地址，以免电视经主路由直接出网。静态 IPv4 配置仍在，但 Android 11 的 IpClient 记录了 9 次已配通后再次配置失败，直播连接随默认网络重建而断开。Magisk 按执行权限运行通用启动脚本，文件名加 `.disabled` 后仍可能被运行。[Magisk 启动脚本说明](https://topjohnwu.github.io/Magisk/guides.html#boot-scripts)

开机现由早期入口拦截 eth0 的 IPv6 路由通告，晚期入口在网络变化后检查防火墙，保留 Android 安装的地址和路由。前五分钟按开机时钟在 30、60、120、240、300 秒补查，之后监听网络事件。SmartTube 的传输规则按实际 UID 安装。启动回执写在盒上 `/data/misc/x96-boot-status/`。原有的空 DNS 启动入口也已移出启动目录。[盒端接线与回退](x96-install.md)

网关的 `dsh-tv-guard.sh` 在同一次已完成启动且有线链路就绪后，连续两次查到相同的路由偏离才启用应急路由。择优测速和 IPv6 对照测速遇到播放器前台会跳过。独立的出口看门狗仍用小请求检测真实失联，切换前复核播放进度、备用可达性及当前出口。PoToken 守护只记诊断信息。网关运行文件映射如下。

| 仓库文件 | 网关位置 |
|---|---|
| `dsh-media-pick-exit.sh` | `/usr/local/sbin/dsh-pick-exit.sh` |
| `dsh-media-state.sh`、`dsh-watch-exit.sh`、`dsh-st-guard.sh`、`dsh-tv-guard.sh`、`dsh-tv-boot-audit.py` | `/usr/local/sbin/`，同名 |
| `dsh-media-v6ab.conf` | `/etc/systemd/system/dsh-v6ab.service.d/90-tv-idle.conf` |
| `dsh-tv-boot-audit.service`、`dsh-tv-boot-audit.timer` | `/etc/systemd/system/`，同名 |

网关已启用 `dsh-tv-boot-audit.timer`。每次观察到新的 boot ID，前四分钟分时记录 Android 配网失败次数、网卡和 DNS、规则、YouTube 可达性、两条家庭直播源的 TS 数据，并在播放器恰好处于前台时采样硬解帧。最近 12 次结果在 `/var/lib/dsh-tv-boot-audit/<boot-id>.json`。结果 `observed_checks_pass` 需要覆盖自然启动并收到本次启动的早期、晚期、SmartTube 三种回执。`late_join_checks_pass` 表示盒已运行后才开始观察。

2026-11-26 20:08 用户断电重启，启动编号 `1b0969ef-60c4-484d-b0e2-d9d2842e5ae8`，20:13 验收结果为 `observed_checks_pass`。开机第 45 至 295 秒共五次采样，默认网络编号始终为 101，IPv4 网关和唯一 DNS 均为 `192.168.1.19`，以太网无全局 IPv6 地址和 IPv6 默认路由。Android 配网失败 0 次，旧脚本进程 0 个。盒端两路家庭直播均读到有效 MPEG-TS。前台 DIYP 的 1080p 直播在 30 秒内从 275 增至 1936 帧。随后 SmartTube 同一条 1080p 视频在 65 秒内从 282 增至 4353 帧。两段的掉帧、帧错误和硬件错误均为 0，全程只读采样。

系统网络稳定期间还观察到独立的应用故障。1440p 视频在 262.168 秒缓冲见底并自动重载。短时把新请求换到 Rack 后仍报 SABR 重载和音轨选择数组越界，已恢复原 ZGO 出口。随后另一条 1080p 视频恢复硬解。此段无法证明原 1440p 视频已恢复，也不能用 YouTube 的 204 响应推定所有视频都可连续播放。[官方 32.80 音轨选择源码](https://github.com/yuliskov/SmartTube/blob/32.80/common/src/main/java/com/liskovsoft/smartyoutubetv2/common/exoplayer/selector/TrackSelectorManager.java#L319)

本次网关四份旧脚本保存在 `/var/backups/dsh-tv-boot-20261126.7XedRr/before/`。确需撤回网关部分时，先停用新增审计 timer，再从备份逐份原子恢复同名脚本至 `/usr/local/sbin/`，移出新增的 v6ab drop-in 并执行 `systemctl daemon-reload`。盒端旧入口在 `/data/adb/dsh-gateway/dsh-tv-boot-20261126.7XedRr/before/`。恢复旧网络策略会重新引入已记录的风险。

## 直播断流

19:31 的 DIYP 读流错误紧随 Android 默认网络断开。网络随后约每 10 秒重建。从旧进程的命令行核实，`/data/adb/dsh-gateway/watch.sh` 仍在循环清除 eth0 的 IPv6 地址。其启动入口虽有 `.disabled-20261125` 后缀，仍在 Magisk 的 `service.d` 内且可执行。

已将旧入口移至 `/data/adb/dsh-gateway/99-gateway.sh.disabled-20261125`（0600），终止了该脚本的旧实例。最后一次网络重建发生在终止进程之前，因此这一步消除的是重复触发条件。后续观察到默认网络保持在 110。盒端分别从“综合高清”和“北京卫视”读到 HTTP 200 及 261837 字节的 MPEG-TS 正文。此次验收保留 SmartTube 前台，未在 DIYP 里切台。

## SmartTube 卡在 127.538 秒

SmartTube 32.80 在同一位置反复重载，音视频缓冲见底。故障窗口内，一条 Googlevideo 连接约 38 KB/s，播放器仍收到正文并报告保护状态 OK。实播恢复时，网关记录到原 ZGO 出口的两条 TCP 视频连接持续收包。排查中曾把新连接短时指向 Rack，回读确认恢复播放的媒体连接仍在 ZGO，随后已将选择器恢复为 `zgo-hy2`。

电视端 `/data/adb/service.d/98-smarttube-transport.sh` 以 0700 安装。它在软件包可见后查询 SmartTube 的用户 0 UID，仅对该 UID 新建的 IPv4 UDP/443 流返回端口不可达，使客户端可以回退到 TCP。重复执行会复用现有规则。实机已验证规则命中、TCP 媒体正文和 1080p 持续解码；本次保留前台播放，未重启验证。

恢复后在 19:39:41 至 19:42:02 每约 12 秒采样，原视频保持播放，硬解帧从 502 增至 9170，掉帧、帧错误和硬件错误均为零。播放器已请求到 310 秒处的媒体分片。

撤回时把此入口移出 `service.d`，按 `iptables -S OUTPUT` 显示的实际 UID，将该条规则的 `-A` 改成 `-D` 单独删除。在生产盒上可用 `dumpsys media_session` 配合 `/sys/class/vdec/vdec_status` 间隔采样；状态为播放时进度字段可能保持上次发布的数值，应同时核对解码帧持续增长。

## 网关 DNS

电视把 UDP 和 TCP 53 发给网关。网关现役 `dsh-dns-relay.service` 运行 `/usr/local/sbin/dsh-dns-relay.py`，监听 LAN 的 UDP 53 和回环 TCP 19553。`dsh-dns-tcp.socket` 接收 LAN 的 TCP 53，由 `dsh-dns-tcp.service` 交给回环监听。两种协议优先走现有 sing-box DNS 分流。YouTube、Googlevideo、缩略图和播放器 API 的 A 查询如遇超时或 SERVFAIL，会经独立香港 SOCKS 入口尝试有证书校验的 DNS-over-TLS。备用入口按探针映射中的名称查端口。国内域名、AAAA 和有效的否定回答沿用原策略。两个香港入口共享香港节点。

升级时先将中继部署到网关并确认回环 TCP 19553 已监听，再应用本目录 TCP 服务单元。离线回归运行 `python3 dsh-dns-relay-test.py` 和 `bash dsh-media-test.sh`。验证备用路径时，在单独的回环测试端口启动中继，将测试进程的主上游指向本地未监听端口。实测 UDP 与 TCP 各获得 8 条 A 记录。生产盒端验证了 YouTube UDP、缩略图 TCP、央视 IPv4、YouTube AAAA 空回答与无效域名 NXDOMAIN。

## 冷启动通过后的第二次播放错误

11 月 26 日 20:17:57 起，SmartTube 的两条流先超时，随后 YouTube 及缩略图域名报 `UnknownHostException`。网关同期记录电视 UDP DNS 超时，媒体和远程 DNS 都走失联的 ZGO 出口。Android 默认网络仍为 101。原线路短暂恢复后，同片又停在 607.024 秒。出口守护已连续两次探测失败，但旧逻辑只将播放器状态 6（缓冲）列入恢复条件，漏掉了状态 7（错误）且硬解已停止的现场。

修正后的守护复核当前出口故障、备用可达，以及前台 SmartTube 的活动会话和解码状态。20:22:10 它自动把新连接切到香港。20:22:54 至 20:24:26，同片 1080p 硬解从 633 帧增至 6227 帧，掉帧与解码错误均为 0。两条实际 Googlevideo 连接走香港，音视频分片推进到 730 秒和 732.5 秒。20:24:01 网关启用了上述 DNS 回退，播放窗口跨过了此次部署。

此次变更的旧文件位于网关 `/var/backups/dsh-tv-media-20261126.UzaaqH/before/`。撤回 DNS 时需成对恢复中继程序和 TCP 服务单元，再执行 `systemctl daemon-reload` 并重启这两个 DNS 服务。出口恢复条件可单独从同目录还原 `/usr/local/sbin/dsh-media-state.sh`。
