# X96 以太网开机接线

Android 11 的 IpClient 负责静态 IPv4 和以太网默认路由。电视盒在 2026-11-26 19:31:07 至 19:32:32 记录了 9 次配网失败。每次重新配置时 IpClient 都启用 IPv6，路由器通告带入两个 IPv6 DNS。旧守护每 10 秒移除 eth0 地址，与默认网络重建及 DIYP 读流失败时间相符。

## Magisk 安装位置

| 仓库文件 | 盒端位置 | 属主与权限 |
|---|---|---|
| x96-network.sh | /data/adb/dsh-gateway/x96-network.sh | root:root 0700 |
| x96-gateway-route.sh、x96-gateway-watch.sh | /data/adb/dsh-gateway/，同名 | root:root 0700 |
| x96-gw-probe、x96-dns-conntrack（编译产物） | /data/adb/dsh-gateway/，同名 | root:root 0700 |
| x96-post-fs-data.sh | /data/adb/post-fs-data.d/99-x96-network.sh | root:root 0700 |
| x96-service.sh | /data/adb/service.d/99-gateway.sh | root:root 0700 |

安装时预建 `/data/misc/x96-boot-status`，属主为 root:shell，模式 0755。普通 adb shell 可以读取这个目录的回执。写入采用同目录临时文件、0644 和原子重命名。安装启用支持同步 `--ensure` 的 `/data/adb/service.d/98-smarttube-transport.sh` 后再启用晚期入口。

在 Linux x86_64 的本目录使用 Android NDK r26 构建两个 ARMv7/API 30 程序。安装时对照构建输出核对盒端 SHA-256。

```sh
export ANDROID_NDK_HOME="$HOME/.local/share/codeg-android-toolchain/android-sdk/ndk/26.0.10792818"
out=$(mktemp -d)
./build-x96-gw-probe.sh "$out/x96-gw-probe" "$out/x96-dns-conntrack"
python3 -B x96-gateway-watch-test.py
```

保留本次安装前盒端入口、公共脚本及网关端 guard、审计的副本和权限摘要，另存 IPv4 rule、表 189、nat/mangle 规则快照。备份和暂存均在 Magisk 启动目录之外。先更新 Armbian 的 guard 和审计，再在盒端同一文件系统内依次原子安装两个程序、公共脚本、早期入口和晚期入口。旧的清地址脚本及可执行备份始终留在启动目录外。前台有播放时可先暂存文件，晚期入口在下一次自然开机启动两个单例守护。

早期入口同步尝试一次，防火墙可以在 eth0 创建前按接口名安装匹配。它复查七条规则后记录 X96Network 的 early 标记。晚期入口启动单例监听，以阻塞方式接收 eth0 的 link、address、route 事件，在 Android 启动完毕时再次核对；规则缺失才插入。单独清除防火墙又未触发网络事件时，可调用一次以下入口完成复核和修复。

```sh
/system/bin/sh /data/adb/dsh-gateway/x96-network.sh --ensure
```

同一 boot 的 early 和 late 文件保留各阶段首次通过时的 uptime 整秒数。每个文件一行，内核 boot ID 和 uptime 秒数之间以一个空格分隔。晚期入口在启动、网络变化和开机后的第 30、60、120、240、300 秒同步核验 SmartTube 传输规则并回读七条网关规则，两部分均成功后刷新 verified。系统运行超过五分钟才首次启动监听器时，也会立即核验。五分钟后只等网络事件。手工运行公共脚本的 --ensure 只验证七条网关规则，启动阶段的回执由相应入口写入。

早期默认将 IPv4 UDP/TCP 53 送到 .19。双网关守护接管后由 X96_GW_DNS 选定实际 DNS。IPv6 规则在 eth0 入站丢弃 ICMPv6 134，出站阻止外部单播和 DNS 53。链路本地和组播仍可用于邻居发现和本地服务。lo 保留原行为。现存地址由 Android 管理。安装时若仍有应用正在使用外部 IPv6，等这次播放结束再激活出口规则。

## 双网关验读

双网关守护等开机完成、eth0 有链路且地址为 192.168.1.144/24 后运行。主备的 SOCKS5 端口分别为 1080、1081。健康探针在四秒总时限内并行读取 i.ytimg.com 的 A 记录及 connectivitycheck.gstatic.com 的 HTTP 204，其中 DNS 套接字用专用标记 0x40000000 避开重定向，SOCKS5 套接字直连指定的局域网端口。任一项失败即返回非零。经普通应用路径发出的 IPv4 外网流量另用标记 0x20000000、优先级 8999 和路由表 189，家庭直播、组播和广播不走该标记。切换会清除电视指向上一网关的旧 DNS 映射。

以下命令在盒端 root shell 分别验证两条备选线路，并读取当前状态。`gateway` 的格式为「内核 boot ID、所选 IPv4 地址」。切换成功须通过路由、DNS 与防火墙回读后才更新回执。

```sh
cd /data/adb/dsh-gateway
./x96-gw-probe 192.168.1.19
./x96-gw-probe 192.168.1.254
read -r epoch gw < /data/misc/x96-boot-status/gateway &&
  [ "$epoch" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
  /system/bin/sh ./x96-gateway-route.sh check "$gw"
```

在已连至盒端 ADB 的主机，从本目录运行 `python3 -B x96-gateway-path-test.py 192.168.1.19`，备用期间改用 `192.168.1.254`。此命令使用盒端 BusyBox 和 root tcpdump，对普通套接字的 UDP/TCP DNS 回答、校验证书的 HTTPS 缩略图正文及三者的以太网下一跳 MAC 分别取证。播放验收另取前台解码帧和媒体收包增量。查看切换原因可读盒端 `logcat -d -s X96Gateway`。

## IPv6 与开机验证

离线回归在只有 lo 的 Docker 网络命名空间中运行。从 vps-proxy 项目根目录运行下例，使用 home-studio 已有的镜像及宿主上的 iproute2、iptables、Python 3，测试自动建立和销毁一对临时 veth。

```sh
docker run --rm --pull never --network none --user 0 --cap-add NET_ADMIN \
  -v /usr:/usr:ro -v /etc/alternatives:/etc/alternatives:ro \
  -v "$PWD/tv-gateway":/fixture:ro --entrypoint /bin/bash \
  personal-brain:20261125.9 /fixture/x96-network-test.sh
```

回归覆盖启动前无 eth0、重复执行、重复启动 watcher、移除两条规则后由地址事件恢复，以及 IPv4 默认路由、IPv6 地址和内核开关保留。以真实报文检查 RA 丢弃、发往外部的 IPv6 请求及链路本地 DNS 被拒，同时从 veth 对端收到普通链路本地和组播 UDP。

自然开机后，在同一 boot ID 上核对 X96Network 的 early、late 标记和七条实际规则。若早期 logd 未接收标记，读取 /data/misc/x96-boot-status/early，核对其中的 boot ID 与 uptime。同一次开机的日志和文件均未提供 early 回执时，记为早期阶段未验证。确认 dumpsys network_stack 的最近一次 IpClient 配置持续成功，dumpsys ethernet 的静态 DNS 只有 .19，ip -4 route show table eth0 的默认网关为 .19，ip -6 route show table eth0 无外网默认路由。另按上节核验实际选中的网关和 DNS。在播放期间读取默认 netId 和播放器进度，并独立取一个直播源片段验证。下一次自然重新配网时重复上述核验，关注 RA 规则计数是否增长。进入生产网络时保持正常播放；重写和丢规则的故障注入只在隔离命名空间里做。

## 撤回双网关

1. 先确认 .19 探针健康，并等外网播放结束。保留网络和播放器进程。还原本次部署前固定主网关版本的晚期入口，按完整命令行识别并停止 `x96-gateway-watch.sh` 的单一实例，防止撤回途中再次切换。
2. 用盒端 root 运行 `/system/bin/sh /data/adb/dsh-gateway/x96-gateway-route.sh apply 192.168.1.19`，再用 `check 192.168.1.19` 核验。先确认旧的 UDP/TCP 53 到 .19 的直接 DNAT 两条均存在，缺项按备份补齐。
3. 对照安装前快照，只删除 OUTPUT 对 X96_GW_ROUTE / X96_GW_DNS 的精确跳转、两条自有链，以及本次新增的优先级 8999 规则和表 189 的两条路由。复核同一条真实报文测试仍指向 .19 后，移出 `gateway` 回执，再还原公共脚本、Armbian guard 和审计。IPv6、SmartTube 和早晚期接线沿用撤回前的固定主网关版本。若 .19 尚不可用，保留可用备网关至维护窗口。

## 撤回 11 月 26 日开机修复

先移出两个启动入口，按实际进程命令行精确停止 x96-network.sh --watch，保留网络接口及播放器。用安装前的规则快照识别本次新增项，对应链上逐项执行精确删除。安装前已有的 IPv4 DNS 重定向应保留。恢复开机文件取自核对过的备份；具有已知故障的循环清地址脚本继续留在归档目录。下次开机复核 Android 的默认网关、DNS 和播放状态。
