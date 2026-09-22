# 公司 Mini TCP 时钟停滞导致 PRNAS 子网转发失败（2026-09-22）

## 结论与现场边界

PRNAS 本体与公司局域网正常；公司 Mini 的新连接默认临时端口分配失败（errno49），公司子网代理因此受损。临时扩充 Mini 的端口范围后，Air 上直连及经系统代理访问 `http://10.10.61.18:5000/` 都立即恢复 HTTP200。

更深证据指向内核 TCP 时钟停滞，而非单一进程持续刷短连接：大量 TIME_WAIT 元组长时间不消失，单条 TCP 连接的 TSval 在3秒内完全不增长；Mini uptime已53天，其实际内核对应源码包含32位毫秒计数及不处理回绕的单调更新比较。符合约49.710天计数回绕后时钟停止更新的问题。没有据此宣称已定位到一个应该杀掉的应用进程。

## 变更前证据

- 公司 dev198、Studio 到实际 `192.168.61.18:5000` 均 HTTP200。
- Air 和 home-studio 到 `10.10.61.18:5000` 失败；Air无代理直连也失败，排除仅浏览器/Xray分流造成。
- Mini普通socket连接 PRNAS、Studio、dev198、回环15888均报 `EADDRNOTAVAIL / Can't assign requested address / errno49`。
- Mini显式绑定本机有线地址192.168.61.66后，到同一PRNAS立即HTTP200；网线和NAS不是故障点。
- 默认49152–65535共16384个临时端口，现场观测16383个不同端口已占用。约23150条TIME_WAIT；fd总量远低于kern.maxfiles，不是文件描述符耗尽。
- 多个应用都有滞留元组，xray约8315、limactl约3999等；不能仅凭累计数量认定它们正制造风暴，更不应直接批量kill。

## 已执行的临时恢复（用户授权）

只改 Mini 运行态一项 sysctl：

```
net.inet.ip.portrange.first: 49152 -> 32768
```

上限65535不变。未改永久sysctl配置，未调整TCP MSL，未清空防火墙，未重启Mini/NAS/Air，未杀业务进程。

Mini回滚记录：`/tmp/easytier-prnas-port-range-20260922.json`（0600），记有旧值。不要在端口仍被耗尽时直接恢复旧范围；应维护重启后核对默认范围，或先确认有足够可用端口。

验证：
- 修改后Mini普通socket访问NAS HTTP200、Studio SSH banner正常、EasyTier RPC可达。
- Air HTTP5000无代理与经10808代理均HTTP200；22:22复验约0.018s、0.035s。
- Air HTTPS5001从握手被关闭变成明确的自签证书错误（curl60）；网络已恢复到证书验证层，不能宣称证书可信问题已修复。本次没有忽略证书验证登录、安装根证书或更改NAS证书。
- Mini EasyTier PID32437、Xray PID41888未变。
- 22:22观测TIME_WAIT23434、扩展范围占用16700/32768，说明只是提供了余量，并未清除内核滞留状态。

## 更深根因证据

- Mini实机：macOS26.2，build25C56，Darwin25.2.0；内核 `xnu-12377.61.12~1/RELEASE_ARM64_T8132`。
- uptime53天10小时，boot时间2026-07-31 11:29:14。
- MSL配置15000；等待65.3秒后，23219条基线TIME_WAIT中23208条四元组/owner仍存在且字节计数相同；仅11条消失，58条新增。
- 对dev198 SSH服务建立一条不认证的诊断TCP连接，3秒后发送客户端服务标识；Mini出站TSval在22:20:32.534667至22:20:35.564209的5个包里全部为3613658751。抓包仅限指定对端和端口，不采集业务载荷；抓包子进程已结束。
- Apple对应版本公开源码 `bsd/netinet/tcp_subr.c` 的 `calculate_tcp_clock()` 使用uint32保存uptime毫秒值，并仅在旧值小于新值时更新。2^32毫秒约49.71027天；回绕后新值变小，与实机现象高度吻合。
- 对应版本源码（本次实际读取）：https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.61.12/bsd/netinet/tcp_subr.c （约3835–3863行）。当时读取的main也保留同类逻辑，不声称某个更新版本已经修复。

## 后续真正恢复措施

1. 安排公司Mini维护窗口，先盘点其业务、虚拟机、在跑任务及自启动，再经用户明确确认整机重启。重启可清除当前滞留内核状态，但不等同于该版本代码缺陷永久修复。
2. 重启后验收TCP时钟推进、TIME_WAIT正常老化、默认端口恢复、公司子网NAS管理口，以及Mini承载的其他业务；别只验ping/开机。
3. 系统升级前核对具体修复版本及兼容性；未核实前不许承诺升级已修复此缺陷。不要拿降低MSL或长期无限扩端口代替根治。
4. 子网双网关还需端到端后端健康机制；peer在线不代表网关能连接NAS。本次未撤销Mini子网宣告、未改dev198路由。

当前5000已恢复，5001证书问题独立保留；临时端口扩容不是长期根治。本轮未重启整机、未commit/push、未更新共享/私有记忆。

## 22:35–22:40 重启前远程恢复检查（未执行重启）

- FileVault Off；Remote Login On，系统 `com.openssh.sshd` enabled，SSH公钥认证开启；authorized_keys存在且0600、.ssh0700。
- `cn.easytier.mesh` 为root系统LaunchDaemon，RunAtLoad/KeepAlive均true，enabled；二进制root0755、配置root0600均存在。macOS原生plutil lint和JSON转换通过；Python严格XML读取因字符兼容问题失败，不能把它误报为launchd已损坏。
- 落盘peer含公司dev198 `192.168.61.233:11010` 和Studio `.177:11010`，两条实际TCP均可达；因此Mini重启重新发现节点不必只依赖香港公网。
- Mini有线Ethernet是手工固定192.168.61.66/24、网关192.168.61.254；当前1000baseT全双工。
- 用户自动登录已配置，系统对应凭据文件存在且root0600；没有读取其内容。sleep=0、autorestart=1。这里只确认配置，未把它等同于重启后实机验收。
- 三条真实SSH均成功：mini-mesh约0.27s、`ssh -J dev198-mesh mini`约0.50s、mini-pub约2.59s。公网FRP在临时端口扩容后也恢复。
- 兜底首选dev198跳板→Mini有线SSH：dev198的EasyTier/SSH均active+enabled，独立机器不随Mini重启。系统SSH/EasyTier不依赖用户GUI登录；FRP/Xray/mycc等是用户LaunchAgents，依赖登录阶段，因此公网FRP不能作为唯一恢复通道。
- h-b2 Lima VM目前Running，已有用户登录自启动任务；任务last exit0且当前无PID是一次性启动器完成的正常形态，不是虚拟机停止。
- 仍有运行中的Claude/Codex会话、h-b2虚拟机、1052-OS前后端及mycc等业务。没有结束会话/停VM/重启，需明确维护窗口再优雅收口。
- 本次仅检查并保存本段证据，没有更改FileVault、自动登录、SSH安全设置或启动项。

## 22:42 起用户明确授权重启：执行与恢复验收

- 用户授权「现在执行mini重启，1052-os可以先停止」。先核对PM2仅管理1052-backend/frontend两项，逐项复核PID/路径后使用PM2正常stop，两项均stopped。仅disable/bootout用户启动项 `gui/501/io.pm2.1052os`，保留应用文件及PM2记录；重启后1052进程为0且启动项仍disabled。
- h-b2先经 `limactl stop h-b2` 正常关闭（22:43:00确认停止），没有force-kill虚拟机。
- 通过系统shutdown安排22:44:24重启；22:44:32观察到SSH暂不可用，22:45:07经dev198跳板重新登录成功。
- boot值由1785468554变为1790088289（新boot：2026-09-22 22:44:49），证明整机确实完成重启，而非只重启服务。
- 三条真实SSH均重新通过：mini-mesh约0.23s、dev198跳板约0.58s、mini-pub约1.37s，身份/主机名一致、严格host-key校验保持开启。
- 临时端口扩容自动恢复系统默认49152–65535；原2.3万条残留清空，启动48秒时TIME_WAIT81。
- 对dev198同一SSH测试连接再次抓包，22:46:23.905848到22:46:26.933264，Mini TCP TSval从2029604032增至2029607060，增长3028ms；与重启前同样3秒间隔0增长形成对照。TCP时钟推进已恢复。该测试socket的前后TIME_WAIT采样均为空，不把它单独当作自然老化实证。
- Air访问PRNAS5000：直连与经系统代理均HTTP200（约0.017s）；5001到达证书验证层，仍保留NAS原自签证书错误，未改证书或绕过验证登录。
- EasyTier、Xray、FRP、mycc、H平台Mini启动服务均拉起；mycc /health HTTP200 status=ok；Mini经Xray访问外部HTTPS HTTP200。
- h-b2已由原登录启动项自动恢复Running，并实际 `limactl shell h-b2 uname -s` 返回Linux，不仅是进程存在。
- 1052-OS按用户要求保持停止。以后需要恢复时，由agent执行 `launchctl enable gui/501/io.pm2.1052os` 后bootstrap原plist；或PM2仅start这两项。不要未经用户请求自动拉起。
- 本次解决当前内核滞留状态，不代表macOS26.2的长期运行回绕缺陷已从代码层修复；没有更改系统版本。原交互式CLI任务被整机重启中断，不声称其自动续跑或所有业务功能完成端到端验收。


## 用户验收后收口

2026-09-22 用户明确授权更新记忆、落盘并commit/push；本报告与新「EasyTier组网速查」代码一起按文件白名单提交。共享记忆记录维护结果、1052保持停止、系统内核长期复发风险，不把本次重启写成永久根治。
