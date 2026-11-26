# X96 以太网开机接线

Android 11 的 IpClient 负责静态 IPv4 和以太网默认路由。电视盒在 2026-11-26 19:31:07 至 19:32:32 记录了 9 次配网失败。每次重新配置时 IpClient 都启用 IPv6，路由器通告带入两个 IPv6 DNS。旧守护每 10 秒移除 eth0 地址，与默认网络重建及 DIYP 读流失败时间相符。

## Magisk 安装位置

| 仓库文件 | 盒端位置 | 属主与权限 |
|---|---|---|
| x96-network.sh | /data/adb/dsh-gateway/x96-network.sh | root:root 0700 |
| x96-post-fs-data.sh | /data/adb/post-fs-data.d/99-x96-network.sh | root:root 0700 |
| x96-service.sh | /data/adb/service.d/99-gateway.sh | root:root 0700 |

安装时预建 `/data/misc/x96-boot-status`，属主为 root:shell，模式 0755。普通 adb shell 可以读取这个目录的回执。写入采用同目录临时文件、0644 和原子重命名。安装启用支持同步 `--ensure` 的 `/data/adb/service.d/98-smarttube-transport.sh` 后再启用晚期入口。

先在两个 Magisk 启动目录以外保留现役 99-gateway.sh、属主、权限和摘要。将三份新文件暂存在启动目录以外，在同一文件系统内设置属主和权限后，依次原子移动公共脚本、早期入口、晚期入口至表内位置。原晚期脚本 v5 须由新入口原位替代。另核实已退役的 99-gateway.sh.disabled-20261125 和其他可执行备份均在启动目录以外。确认旧 watch.sh 进程已退役。盒端没有可用的根权限时保留当前 adbd 会话。

早期入口同步尝试一次，防火墙可以在 eth0 创建前按接口名安装匹配。它复查七条规则后记录 X96Network 的 early 标记。晚期入口启动单例监听，以阻塞方式接收 eth0 的 link、address、route 事件，在 Android 启动完毕时再次核对；规则缺失才插入。单独清除防火墙又未触发网络事件时，可调用一次以下入口完成复核和修复。

```sh
/system/bin/sh /data/adb/dsh-gateway/x96-network.sh --ensure
```

同一 boot 的 early 和 late 文件保留各阶段首次通过时的 uptime 整秒数。每个文件一行，内核 boot ID 和 uptime 秒数之间以一个空格分隔。晚期入口在启动、网络变化和开机后的第 30、60、120、240、300 秒同步核验 SmartTube 传输规则并回读七条网关规则，两部分均成功后刷新 verified。系统运行超过五分钟才首次启动监听器时，也会立即核验。五分钟后只等网络事件。手工运行公共脚本的 --ensure 只验证七条网关规则，启动阶段的回执由相应入口写入。

IPv4 UDP/TCP 53 继续送到 192.168.1.19。IPv6 规则在 eth0 入站丢弃 ICMPv6 134，出站阻止外部单播和 DNS 53。链路本地和组播仍可用于邻居发现和本地服务。lo 保留原行为。现存路由和地址由 Android 管理，之前写入的 disable_ipv6 在本次运行保持原值。安装时若仍有应用正在使用外部 IPv6，等这次播放结束再激活出口规则。

## 验证

离线回归在只有 lo 的 Docker 网络命名空间中运行。下例使用 home-studio 已有的镜像及宿主上的 iproute2、iptables、Python 3，测试自动建立和销毁一对临时 veth。

```sh
docker run --rm --pull never --network none --user 0 --cap-add NET_ADMIN \
  -v /usr:/usr:ro -v /etc/alternatives:/etc/alternatives:ro \
  -v "$PWD/tv-gateway":/fixture:ro --entrypoint /bin/bash \
  personal-brain:20261125.9 /fixture/x96-network-test.sh
```

回归覆盖启动前无 eth0、重复执行、重复启动 watcher、移除两条规则后由地址事件恢复，以及 IPv4 默认路由、IPv6 地址和内核开关保留。以真实报文检查 RA 丢弃、发往外部的 IPv6 请求及链路本地 DNS 被拒，同时从 veth 对端收到普通链路本地和组播 UDP。

自然开机后，在同一 boot ID 上核对 X96Network 的 early、late 标记和七条实际规则。若早期 logd 未接收标记，读取 /data/misc/x96-boot-status/early，核对其中的 boot ID 与 uptime。同一次开机的日志和文件均未提供 early 回执时，记为早期阶段未验证。确认 dumpsys network_stack 的最近一次 IpClient 配置持续成功，dumpsys ethernet 的有效 DNS 只有 .19，ip -4 route show table eth0 的默认网关为 .19，ip -6 route show table eth0 无外网默认路由。在播放期间读取默认 netId 和播放器进度，并独立取一个直播源片段验证。下一次自然重新配网时重复上述核验，关注 RA 规则计数是否增长。进入生产网络时保持正常播放；重写和丢规则的故障注入只在隔离命名空间里做。

## 撤回

先移出两个启动入口，按实际进程命令行精确停止 x96-network.sh --watch，保留网络接口及播放器。用安装前的规则快照识别本次新增项，对应链上逐项执行精确删除。安装前已有的 IPv4 DNS 重定向应保留。恢复开机文件取自核对过的备份；具有已知故障的循环清地址脚本继续留在归档目录。下次开机复核 Android 的默认网关、DNS 和播放状态。
