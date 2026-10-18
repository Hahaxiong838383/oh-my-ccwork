# SmartTube 断电重启后的 DNS 与时钟故障

> 归档状态注：本文保留各阶段原始时序、失败结果和待验边界；“当前”“待验”“未commit/push”等仅对应各记录时点。发布状态与最新进展见[本次复盘](2026-10-18-SmartTube与四级代理复盘.md)。历史回滚记录不得直接覆盖后续正式版本。

2026-10-18 20:47 CST，codex（OpenAI）。最新状态：断电冷启动验收完成。系统约42秒自动恢复，用户随后确认正在观看SmartTube且一切正常。历史诊断和测试记录保留，最终确认见末节。此冷启动验收对应22:29四级代理迁移前的基础启动版本；迁移后的新增worker/guardian启动接线仍待冷启动验证。

## 结论

断电启动后 RTC 从 1970 开始，Android 把时间提升至固件编译时间 **2024-02-28 20:10:07 CST**，而未成功获取网络时间。生产 DNS 使用经 ZGO Reality 的 Cloudflare DoT，证书在错误时间下尚未生效；全盒 DNS 又在仅确认监听端口后被重定向到该解析器，导致校时服务器域名也解析失败，形成校时与加密 DNS 的依赖环。

用户已确认此前手机授权后 SmartTube 正常，这覆盖旧报告“尚待授权”的状态。此轮独立回读仅统计到一个选中账号、一个非空 refresh token 字段；没有输出或落盘账号凭据。这说明持久授权数据仍在，不代表已向服务器重新验证 token 有效性。

## 本次证据

1. 开机日志：`meson-vrtc ... setting system clock to 1970-01-01T00:00:02 UTC`。`ro.build.date` 为 `Wed Feb 28 20:10:07 CST 2024`，精确对应启动后系统日期；最终仍为 `2024-02-28T12:19:15Z`。不能据此断言具体电池损坏或原厂设计原因。
2. Android `auto_time=1`，NTP server=`ntp3.aliyun.com`，`NTP cache result: null`，time_detector 的 Network suggestion history 为空。本启动多次 `ntp_failure ... UnknownHostException ... ntp3.aliyun.com`。
3. SmartTube PID4455 本启动多次 `UnknownHostException ... www.youtube.com`；其它后台应用也有域名解析失败。截图与日志一致。
4. sing-box 单实例 PID1489，5354 TCP/UDP、1080、1081、19090 监听归属正常；SmartTube UID10082 的 IPv4/IPv6 均走 tun0。配置 SHA256 `090fbf7e9e5d12f6b37410b52708d0ff380865af2e5a61bd5131e6a84713141b`，与安装完成时一致，未丢失新 UID 或路由例外。
5. 生产 DNS `final=zgo-dns`，固定IP `1.1.1.1:853`、TLS、detour=`zgo-netflix`，未配置内部 NTP。开机脚本只以进程存在/5354监听作为成功条件，就重定向全盒 IPv4 DNS并拒绝IPv6 DNS；没有校时或上游解析成功的检查。本次规则计数与监听均证明已经接管。
6. 独立小流量探针：现网5354的TCP查询 `www.youtube.com`、`ntp3.aliyun.com` 均被关闭，未收到DNS响应；同一盒子的现网1080 SOCKS经ZGO到同一 `1.1.1.1:853`，由时钟正确的开发机完成TLS验证和DNS查询，得到NOERROR、8条答案、161字节有效响应。这证明该时刻代理通道与DNS上游可用。
7. 通过上述同链取得公开证书，notBefore=`2025-12-31 19:20:01 GMT`，notAfter=`2026-12-21 19:20:01 GMT`。同一证书链按开发机时间验证为OK；OpenSSL按盒子当前epoch验证明确返回 **error 9: certificate is not yet valid**。生产info日志未直接输出x509异常，因此日期错误的因果由同链证书受控重放与生产DNS失败共同支持；没有伪称拿到生产x509原始日志。
8. ZGO HY2证书notBefore=`2026-10-18 02:36:59 GMT`；RackNerd HY2为`2026-10-17 06:24:35 GMT`，都晚于错误设备时间。因此修复应覆盖系统校时，不能只处理SmartTube首页。没有对此进行大流量测速。
9. Netflix遥控服务仍enabled/bound，CDN watchdog已自启PID494、foreground=false；当前直播应用UID10065走eth0直连。旧run.log中5353端口冲突来自10月17日，当前实际5354归属正常，未把旧错误当本轮根因。

## 18:40 只读诊断期间不打扰播放的边界

前台始终为 `com.player.diyp2020/com.player.activity.PlayerActivity`，同一ActivityRecord和进程保留。未发按键/触摸、未运行UIAutomator、未打开SmartTube、未清数据/重新授权、未校时/改防火墙/重启代理。只恢复ADB调试连接和root读取权限以读受保护日志；诊断专用端口转发均已撤销。

结束回读：sing-box PID=1489，配置SHA仍一致；`mResumedActivity: ActivityRecord{ff32264 u0 com.player.diyp2020/com.player.activity.PlayerActivity t4899}`。没有把“前台仍在”当成冷启动修复验收。

## 18:40 提出的修复方案与后续验收

后续空闲窗口应修复启动流程：

- 给校时域名一条独立于TLS代理的解析通路，例如仅对已配置的NTP服务器使用现有国内UDP DNS，并保证NTP请求本身可达；不把所有域名改为直连。
- 在接管全盒DNS前完成可信网络校时，或提供不依赖错误系统时钟的校时引导；记录成功来源/时间。单纯临时手动改时间会在下次断电重现。
- 把“代理已就绪”的判据提升为实际DNS查询成功，设置失败重试和明确日志；保留现有YouTube/SmartTube及Netflix路由。
- 在用户空闲时执行，并分别验证系统校时、NTP缓存、5354实际解析、SmartTube原账号加载及播放、两条HY2证书握手，最后至少一次真实断电冷启动复验。

18:40诊断阶段未部署修复；18:56按用户授权完成落盘部署时，仍未测试下一次开机恢复，不能在该时点称冷启动验收已完成。19:27软件重启、19:57用户断电及20:47实播确认分别见后续记录。

脱敏证据：`/tmp/smarttube-reboot-diag-20261018/boot-clock-dns-evidence-redacted.txt`、`proxy-selected-redacted.txt`；公开证书链同目录。原始logcat临时副本已清理。无commit/push。


## 2026-10-18 18:56 CST 已安装，等待重启验收

用户授权先修复且不影响前台，做到需要重启处。本轮已完成：

- 新Magisk入口及worker在第一步核安装时boot ID；当前启动周期或ID缺失均直接退出，不执行校时/服务/规则操作。文件已原子替换，实际调用入口与worker均返回 `deferred until next boot`。
- 新只读native探针先独立DNS，再取两个不同IP的NTP响应一致结果。Android bionic connect把SO_MARK255覆盖为786533曾导致18.043秒六次DNS失败；在connect后恢复并回读mark后，实际阿里与腾讯源0.148秒返回一致epoch，与主机差0秒。未改盒子系统时间。探针无密码/账号，无需电脑常驻。
- 下次boot等待Android启动完成与eth0路由，校时并回读后才启动sing-box；YouTube与NTP域名通过实际5354查询后才安装全盒DNS规则，最后再查DNS、写完成marker。暂态故障在同一worker/锁中退避重试；已有代理不替换，失败只停止自己创建且路径匹配的进程。
- 60项网络解析/交换/故障回放断言＋54项启动流程断言通过。mark修复回放同时覆盖“实际send用255”和“纠正未生效则零发送”。启动测试覆盖当前boot零变更、晚启动/NTP恢复、DNS空应答、真实flock竞争与部分规则回退。
- 电视helper SHA `07f8649cbe7b70547800e6b71368f5dba344476772d64136643dab5e9c92047c`；worker `b134b6ed134fbfb785cea9179b560ee194e7978bebfc68f9dbc6b68967b5ac45`；入口 `fba318fd39f6b369ac08536bed5fe22be611b28897a8184a271ef224bd0beeca`，与本地构建/源码逐SHA一致。
- 原入口备份 `/data/adb/video-proxy/backup-20261018-boot-clock/video-proxy.sh`，SHA `d4b8585e364ae2661fbd142e1f81b8db05727a59fcfb28dafc7836201f5c88b5`。`rollback-boot-clock.sh --verify`已实际复制、核SHA、核shell语法；`--restore-next-boot`只恢复入口，不重启运行服务。
- 部署前后boot ID、sing-box PID1489、直播PID4085、ActivityRecord ff32264、完整IPv4 NAT和IPv6过滤规则、config SHA全部相同；系统时间仍2024，仅自然推进25秒。没有生成boot worker日志或ready标记。测试专用stage目录已清。

当前准确状态是**修复已落盘并部署，尚待重启激活/验收**，不是正在运行的错误时间已改好。下一步需用户空闲时允许重启（最好实际断电启动），核正确系统时间、boot日志、5354解析、SmartTube原账号实播与HY2握手；本轮按边界未重启。

源码：[home-lan video-proxy-boot](/home/hahaxiong83/home-lan/4-Assets/Code/video-proxy-boot/README.md)，10个文件持久落盘，未commit/push。部署核验记录 `/tmp/video-boot-deploy-20261018/deploy-verification.json`。 [smarttube-boot-fix-staged-20261018]


## 2026-10-18 19:27 CST 重启验收与缓存补修

用户授权“重启修复验证”。已做两次软件重启，第二次完整自动恢复；未执行真实拔电冷启动。

### 第一次重启发现第二层问题

新boot `9fdc116f-d33e-42d0-a9f4-3503c1874390`，原生NTP在uptime22.996秒自行校正系统时间，worker在27.83秒确认时间正确、34.56秒写ready。原生NTP提前成功，不能说这次worker的date写时分支已被执行。

SmartTube自动启动PID2386早于sing-box2553，首页仍报SSLHandshakeException/connection closed。系统resolver实际把www.youtube.com解析为185.45.5.35，而5354解析为142.251.157.4；同轮sing-box连接ID2160803424关联SmartTube UID10082并拨向错误IP，另有同UID的2001::1。根因为代理接管前的DNS结果仍留在系统/应用缓存，不能以5354恢复等同应用恢复。

通过本机services.jar反射确认IDnsResolver.flushNetworkCache接口后，刷新实际NetId101，再广播android.intent.action.CLEAR_DNS_CACHE，系统解析变为正确Google地址。SmartTube保持同一PID2386，无强停、无清数据、无重新授权；首页恢复，公开测试片aqz-KE-bpKQ可播放。40秒五个样本：VP9 3840×2160，解码frame count309→914→1518→2123→2727，约60帧/秒，drop/frame error/hardware error均0。起播阶段曾缓冲，不能把这段稳定采样推广为全程无卡顿。

### 已固化与部署

在ready之前增加：动态提取所有NetId → 反射刷新netd → 全用户广播清应用DNS → Android系统resolver实际查询YouTube/NTP → 再查5354两域名。缓存阶段失败保持健康代理/规则并原地重试，不写ready，不杀应用。无硬编码NetId或Binder交易号；DEX须带设备/system/framework/services.jar。

101项启动流程断言、24项Java断言通过，实际DEX在盒子上flush与resolve均执行成功；未重复测试未改动C网络探针，其原60项结果保留。最终设备与持久源码逐SHA一致：

- worker：3618e009afee53863abd752e763749b1aa07c746a43ad9b5013e8d9efdd17693
- DNS缓存DEX：2331981fc2c377f67952d0373a32747ce98fb08ae774a1795131aa564f78f376
- 原网络helper、入口未改变；生产config SHA仍090fbf7e9e5d12f6b37410b52708d0ff380865af2e5a61bd5131e6a84713141b。

新增上一版worker备份：/data/adb/video-proxy/backup-20261018-dns-cache/video-boot-start.sh。原rollback-boot-clock.sh继续保留，恢复原入口会撤销全部启动修复并带回旧缺陷。

### 第二次重启最终验证

新boot `d5852666-bd4b-42be-8fba-2044e762a59d`，完成marker精确匹配。全程没有手动flush或重启SmartTube来帮助恢复。启动日志按uptime依次为：24.19秒Android完成；24.67秒clock_verified；32.24秒dns_queries_verified；随后实际netId101刷新、全用户广播、系统resolver返回Google142.251.*与阿里203.107.6.88；42.51秒dns_caches_flushed；42.60秒dns_takeover_ready。

系统时间多次与主机相差0秒，原生NTP缓存有效。sing-box唯一PID2198，SmartTubeUID10082的IPv4/IPv6均走tun0，VIDEO_DNS计数71→106，原Netflix遥控服务仍enabled/bound。SmartTube本次打开PID4929，原账号头像与个性化首页正常，无重新授权；同测试片VP9 3840×2160实际解码并从约80秒续播到215秒以上。抽查该PID环形日志未见此前DNS/TLS错误，不将有限日志当全量采集。

**4K播放仍出现起播等待和中途缓冲，本轮不能称全程流畅。** 第一轮媒体走RackHY2；第二轮auto运行时切到RackReality，真实googlevideo连接已下载45.6MB以上，说明沿用原YouTube自动路由。未为了测试固定节点或降低最高画质。ZGOHY2实际HTTP延迟探针第二轮744ms成功；该数字是请求耗时，不是测速带宽。Netflix只复核原网络配置与辅助服务，本轮未另外打开Netflix实播。

结论：开机时钟/DNS/缓存恢复、SmartTube原账号首页和实播已通过本次软件重启验收；实际断电冷启动、长期4K流畅度仍未验证。第二次未刻意制造污染，不能说又复现了一遍错误缓存；第一轮负例与同PID恢复提供因果证据，第二轮证明固化流程实际自动执行。

源码持久化home-lan/4-Assets/Code/video-proxy-boot；本轮未commit/push。脱敏证据在/tmp/smarttube-reboot-verify-20261018（boot JSON、播放采样、接口路由摘要），不存token或生产配置。 [smarttube-reboot-verified-cache-fix-20261018]

收尾已退出公开测试片并切回原DIYP直播应用，前台ActivityRecord d9c9591；诊断ADB转发已全部关闭，设备临时probe DEX与本地账号首页截图已删除，生产缓存DEX保留。


## 2026-10-18 19:57 CST 用户断电后的只读观察通过

用户表示亲自断电重启。本轮先读到旧boot d5852666，随后取得新boot 9a472032-6bf3-4691-ac8b-4bc837edf921；设备持久启动日志证明本次自动恢复：26.05秒Android完成、26.44秒clock_verified、32.25秒DNS通过、42.29秒缓存刷新完成、42.43秒ready。完成marker与新boot一致。用户动作是断电来源依据；轮询程序未捕获离线瞬间（首次采样时已上线），bootreason属性仍为reboot，不能据该属性独立判断物理断电。

本次RTC启动为1970-01-01，Android原生NTP在约23.24秒先恢复正确时间，worker随后双源确认；没有把它说成worker实际执行date写时。两次独立时钟回读相隔约22秒，均与主机差0秒。5354和Android系统resolver真实查询YouTube/NTP正常，脚本已自动完成netd＋应用缓存刷新；本轮未手动flush/校时/重启代理。生产config SHA仍090fbf7e…13141b，唯一代理PID2432。

前台始终DIYP直播，同一ActivityRecord5f948a4；1080p H264解码帧13375→13878，drop/frame error/hardware error均0，证明观察期间当前直播继续播放。SmartTube本轮未打开，未把直播证据算成SmartTube冷启动后的实播验证；此前软件重启的SmartTube账号/4K实播结论仍保留，4K缓冲也未在本轮处理。

没有按键、切应用、截图或修改配置，仅恢复ADB读取权限及只读查询。结果：按用户所述断电后的系统时间、代理、DNS与缓存自动恢复通过；SmartTube本次开机的应用实播尚未观察。脱敏证据：/tmp/smarttube-coldboot-observe-20261018/coldboot-evidence.json。未commit/push。 [smarttube-power-cycle-observed-20261018]

## 2026-10-18 20:47 CST 用户确认SmartTube冷启动后正常播放

用户在亲自断电重启后明确反馈“我在看smarttube了，一切正常”。结合此前新boot9a472032的约42秒自动校时、DNS及缓存恢复证据，本次断电冷启动与SmartTube实际播放验收完成。播放正常依据用户确认；本轮未操作电视、未额外采样codec/清晰度，未改配置。 此确认覆盖上一节“本次实播尚未观察”的待验状态；早先测试片缓冲作为历史现象保留，不把当前正常反馈扩展为所有视频长期4K性能保证。共享记忆与源码README已同步。 [smarttube-coldboot-playback-user-confirmed-20261018]
