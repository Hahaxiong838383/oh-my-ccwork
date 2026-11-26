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

网关已启用 `dsh-tv-boot-audit.timer`。每次观察到新的 boot ID，前四分钟分时记录 Android 配网失败次数、网卡和 DNS、规则、YouTube 可达性、两条家庭直播源的 TS 数据，并在播放器恰好处于前台时采样硬解帧。最近 12 次结果在 `/var/lib/dsh-tv-boot-audit/<boot-id>.json`。结果 `observed_checks_pass` 需要覆盖自然启动并收到本次启动的早期、晚期、SmartTube 三种回执。`late_join_checks_pass` 表示盒已运行后才开始观察。实机当前这一轮得到后者，默认网络编号保持 110，两频道返回有效媒体。未操作前台或重启盒子。冷启动仍待自然发生。

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

上一版电视配置已将 UDP 与 TCP 的 53 端口都重定向到网关，网关原先仅接受 UDP。将本目录两份 systemd 单元安装到网关 `/etc/systemd/system/`，执行 `systemctl daemon-reload`、`systemctl enable --now dsh-dns-tcp.socket` 可启用 TCP。该监听转发至 `8.8.8.8:53`，在当前网关的策略路由中经 tun0 进入现有 DNS 分流。原 UDP 中继独立运行。

电视端 TCP 查询 YouTube 和央视分别得到 8 条、3 条回答，保留的无效测试域名返回 NXDOMAIN。停用此扩展可执行 `systemctl disable --now dsh-dns-tcp.socket` 和 `systemctl stop dsh-dns-tcp.service`。
