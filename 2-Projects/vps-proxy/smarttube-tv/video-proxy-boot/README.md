# 电视代理开机校时

X96 Android 11 的开机修复。源码和测试放本目录；编译产物放 `/tmp`，不保存凭据。

本目录是接入 YouTube 四级兜底前的校时/DNS 缓存修复基线，下面的重启验收与旧 worker SHA 均属于该历史版本。2026-10-18 后续部署的当前生产 worker 来自 [youtube-failover/video-boot-start.next.sh](../youtube-failover/video-boot-start.next.sh)，SHA256 为 `d3ef80ede9373523e094719ec9411b3056c83a290f0ea38aebd979754a6e7a5e`；新接线版本的冷启动仍待验收。

入口比较安装时 boot ID，同一启动周期直接退出；所有生产变更都在屏障之后。

顺序：等待 Android 完成启动和有线网络 → 两个不同地址的 NTP 响应一致 →
设置/核对系统时间 → 启动唯一 sing-box → 真正查询本机 DNS 成功 → 接管 DNS →
再次验证5354查询 → 清除每个网络的netd缓存 → 通知所有用户的应用清DNS缓存 →
通过系统resolver解析两域名 → 再核5354两域名 → 完成标记。
校时探针只发小型 UDP DNS/NTP 请求，不设置系统时间或修改网络，使用独立路由标记和网卡绑定。
它不需要账号、代理密钥或电脑常驻。

## 验证状态（2026-10-18）

首版校时修复已经完成一次重启验证；继续发现SmartTube比代理更早启动，系统缓存了
`www.youtube.com=185.45.5.35/2001::1`，而5354返回正确的`142.251.157.4`。
仅让5354能正确应答并不足以修复已启动应用。真机刷新netd并广播清应用DNS缓存后，
系统解析恢复正确，SmartTube原PID不变。以上IP仅是故障样本，不作为代码内的匹配条件。

本版本已部署，并完成第二次软件重启真机验收。boot d5852666-bd4b-42be-8fba-2044e762a59d
在42.60秒自动ready：真实netd清理、广播、系统resolver和5354查询均成功；时间与主机差0秒。
SmartTube原账号首页和4K VP9实播恢复，但仍有起播/片中缓冲，不能称全程流畅。
随后用户亲自断电，新boot9a472032的自动恢复已观察通过（42.43秒ready，时间差0）；
只读观察时前台直播持续播放，随后用户确认“我在看smarttube了，一切正常”，冷启动实播验收完成。完整证据见mycc/2-Projects/vps-proxy/2026-10-18-SmartTube断电重启DNS与时钟排障.md。

运行配置仍是设备原有 config.json，不复制入仓。本修复不改变节点、UID路由、账号或遥控服务。

- Magisk入口：`/data/adb/service.d/video-proxy.sh`
- worker：`/data/adb/video-proxy/video-boot-start.sh`
- 只读探针：`/data/adb/video-proxy/video-boot-net`
- DNS缓存helper：`/data/adb/video-proxy/video-dns-cache.dex`
- 激活屏障：`/data/adb/video-proxy/boot-fix-installed-boot-id`
- 运行日志：`boot-start.log`（含boot ID/uptime）、`boot-start-console.log`
- 完成标记：`boot-ready-boot-id`，真实DNS应答、规则安装和两层缓存刷新均成功后才写。

## 行为与边界

等待 Android `sys.boot_completed=1` 后校时，避免早期build-date覆盖；以eth0全局IPv4和
真实路由就绪为前提。网络/时间源/DNS暂态失败在同一worker、同一flock下退避重试；
配置坏、缺文件、已有其他代理实例等明确退出，不杀已有服务。DNS不成功时不接管全盒DNS。

缓存处理使用`dumpsys dnsresolver`实际输出中的所有`NetId:`，不硬编码101或Binder交易号。
`VideoDnsCache`通过反射`IDnsResolver.Stub.asInterface()`调用`flushNetworkCache(int)`；
必须以`CLASSPATH=video-dns-cache.dex:/system/framework/services.jar`运行，否则Android 11
缺少`IDnsResolver`类。参数在任何Binder调用前整批校验；缺服务、反射失败、任一网络刷新失败
均返回非零。netd成功后才广播`android.intent.action.CLEAR_DNS_CACHE`给所有用户。
之后以新的app_process执行helper的`--resolve www.youtube.com`和`--resolve ntp3.aliyun.com`，
通过`InetAddress.getAllByName()`实际走Android系统resolver，输出`SYSTEM_DNS_OK host=... address=...`。
该模式仅允许这两个完整域名；参数错或解析失败均非零。不绑定固定IP，实际地址是否干净和视频
能否播放仍由真机验收判定。最后再次查询5354的两个域名，避免长时间缓存重试期间代理失效
却写ready。所有这些步骤失败都进入同一原地重试。
不清应用数据、不退出账号、不结束应用进程。缓存失败在同一worker原地重试，每次重读网络ID，
保留健康代理与已生效的DNS规则，不走会停止代理的`retry`/`dns_failed`分支，也不写ready。

探针默认解析阿里、腾讯、Cloudflare NTP域名（独立国内UDP DNS），取两个不同IP的有效SNTP
应答，在同一单调时刻相差不超过3秒才返回epoch。单次交换3秒、一次time操作硬deadline29秒。
它只查询，不设时；只有下一次boot里的worker调用date。SNTP是普通未加密校时协议，两个源一致
不等同密码学认证。允许时间范围2026年至2035年，后续需随生命周期维护。

本机真测的重要细节：Android bionic `connect()` 会把SO_MARK255改为786533（本次网络ID值，
不得硬编码）。探针必须在connect后重新设255并回读，之后才send；首次版本因此6次DNS超时且
eth0零包。修正后阿里与腾讯分别返回有效应答，0.148秒取得一致时间，与主机相差0秒，盒子时钟
没有改变。国内DNS正锚成功；现网错时的5354负锚超时退出1，证明就绪门不会把故障算通过。

BusyBox flock使用`文件路径 + 命令`模式。运行代理会继承该锁直到退出；同一启动周期的重复入口
在代理持锁时返回1且不重复变更。锁释放后才进入已完成marker分支。不要改成数字FD模式，旧固件
实测不兼容；不要删除锁文件来绕开单实例。worker不调用killall，只在自身启动失败时核可执行路径
后终止自身创建的进程。

## 构建与验证

```
./build.sh                       # 默认产物 /tmp/video-proxy-boot-build/，含二进制、DEX、SHA256SUMS
./test-net.sh                    # 临时目录，ASan/UBSan + 真实回环UDP
python3 test_boot_flow.py         # 隔离命令/假系统时钟，真实flock
python3 test_dns_cache.py         # 真实Java反射与参数/服务异常路径；隔离Binder形状的接口
```

60项网络探针断言（首版已验）＋101项启动流程断言＋24项Java缓存helper断言通过，含真实Android mark覆盖重放、无效DNS/NTP负例、
当前boot零变更、晚启动/断网退避/恢复、端口可用但无DNS答案、双实例竞争、规则失败撤销。
新增覆盖错误缓存清除顺序、多动态网络、netd/广播/系统解析失败时保留健康代理、原地恢复、
缓存处理期间5354从好转坏、非法Java参数零Binder访问、反射服务异常与缺类失败。
系统解析Java测试使用临时hosts文件调用真实InetAddress，不连接外网。测试不会操作电视或系统真实时间/防火墙。
构建使用本机已有NDK26/API30、JDK21、Android build-tools34和android-34公开API jar，不自动部署。
`BUILD-DEPENDENCIES.sha256`记录本轮工具依赖SHA；每次构建生成的`SHA256SUMS`同时记录
依赖、生产源文件和二进制/DEX SHA。DEX不包含平台私有接口实现，必须使用设备自己的services.jar。

历史基线部署时与设备回读一致的SHA256：

- helper：`07f8649cbe7b70547800e6b71368f5dba344476772d64136643dab5e9c92047c`
- worker：`3618e009afee53863abd752e763749b1aa07c746a43ad9b5013e8d9efdd17693`
- DNS缓存DEX：`2331981fc2c377f67952d0373a32747ce98fb08ae774a1795131aa564f78f376`
- entry：`fba318fd39f6b369ac08536bed5fe22be611b28897a8184a271ef224bd0beeca`

## 回退

原入口备份：`/data/adb/video-proxy/backup-20261018-boot-clock/video-proxy.sh`，
SHA256 `d4b8585e364ae2661fbd142e1f81b8db05727a59fcfb28dafc7836201f5c88b5`。

```
sh /data/adb/video-proxy/rollback-boot-clock.sh --verify
sh /data/adb/video-proxy/rollback-boot-clock.sh --restore-next-boot
```

verify已在电视上实际复制备份、核SHA和shell语法通过；不替换活动入口。
restore-next-boot只原子恢复旧入口，不操作时钟或重启服务；恢复后原冷启动缺陷也会回来。
原Netflix整体rollback-hybrid会覆盖service.d入口，使用它会一并撤销本修复，后续须重新核验。

## 验收边界与后续

已完成第二次软件重启后的自动恢复、实际系统解析、SmartTube原账号首页及4K VP9实播。
第一轮手动清缓存后原SmartTube PID未变且恢复，第二轮仅靠启动脚本完成；未重新授权或清数据。
用户断电后的系统时间、代理、DNS及缓存自动恢复已观察通过；随后用户明确确认SmartTube
正在播放且一切正常，本次冷启动验收完成。早先测试片缓冲为历史记录，当前用户反馈正常；
本次确认未额外测量清晰度或长期4K性能。
旧版worker另备份在backup-20261018-dns-cache/，完整回退仍用上述入口备份。
