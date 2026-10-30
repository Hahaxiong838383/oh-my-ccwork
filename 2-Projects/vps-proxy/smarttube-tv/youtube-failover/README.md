# YouTube / SmartTube 代理兜底

## 2026-10-30 第二阶段启动优化（最终版本两次软件重启通过）

完整DNS/系统缓存就绪从77.30秒降至46.60秒、45.07秒；对应后台审计47.82秒、46.31秒。
只加速事务和主代理扫描的第一版实测51.15秒，因此继续优化两个HY2的跨boot进程扫描。
最终guardian/两worker串行阶段约4.93/5.51秒，未改成并行；DNS查询33.24/32.87秒完成，
缓存验证之后才写ready。设备实际Android完成检查24.50/23.69秒，不再把旧脚本53.57秒检查点当成系统启动耗时。

`video-proc-scan.c`在一个原生进程中枚举完整/proc，保留原exe与完整cmdline谓词，
不依赖comm或PID文件。返回0=命中、1=确认无、2=不确定；调用方仅采用0/1，缺失、
摘要不符、符号链接或异常均回退原shell。锁前/锁后检查、worker PID/startticks/端口和停止检查均保留。
只读Android正负锚约0.06秒；原事务无匹配扫描12.406秒。

当前stage `/data/adb/video-proxy/boot-fast-20261030-workers`，release
`496aee8b509dbc0b735bd5307a9ca1cb2cdc2ca9cfb300b678c0c110a1f9d924`。
`rack-dualstack-v2`只比v1增加已有`youtube-failover/workerctl.sh`，恰16文件；v1仍15、旧DNS事务仍9。
helper/事务引擎/独立入口置于不可变stage，700权限与SHA回读，调用方钉住helper摘要。
service.d指向新stage入口，安装当次boot零动作；跨boot先完成事务再执行root boot脚本。
整组回滚后该入口仍调用同一事务的`rolled_back_preserved`，然后执行恢复的旧boot；旧stage必须保留。
`applied-boot-id`继续每boot记录，不以文件没变为由跳过校验或取消坏配置回退。

构建：`bash build-proc-scan.sh`，沿用已有NDK26/ARMv7 Android30编译器；输出默认
`/tmp/video-proc-scan-build/`，可用`TASK_ANDROID_CC`/`TASK_BUILD_DIR`覆盖。使用
`stage_boot_fast.py --serial ... --stage-name boot-fast-YYYYMMDD[-suffix] --helper ... --evidence /tmp/... --wire-next-boot`
先从live核manifest并生成完整备份，再接线；不直接重跑旧Rack IP迁移stager。
原生扫描二进制与生产配置不入Git，ARM产物SHA
`279a372e0e4ddbd0e8304f2b2c123b19401ed2e60708d1118926f5b3358e2357`。

本轮验证：scanner/事务/新入口/接线93个unittest；DNS/当前boot69断言；
worker原生和fallback各61断言；集成15断言；activation恢复6测试。
16文件/依赖/外部资产SHA权限、唯一进程、双栈真实YouTube正文/完整1MiB/DoT/5354通过。
DIYP1080p直播自动恢复，SmartTube保存DNS1及禁自动网络修复true保持。
这轮未操作SmartTube前台，不用DIYP冒充其实际影片验收；物理拔电、长期稳定性另验。

## 2026-10-30 启动锁竞争优化（软件重启已验）

用户手动开机后的新boot4915630e自动恢复耗时204.19秒；规则已有效时，两个启动检查入口并发执行`--install`，非阻塞flock失败可触发boot停主代理并等待30秒重试。真机对照：持锁4秒，旧版verify=0而install=1，释放后install=0。故障不是凭节点握手/下载速度推断。

`video-dns-guard.sh --install`现在先做完整有序规则/首钩校验；有效则只读通过，缺失才进入原互斥修复。锁/timeout失败后再完整校验一次；仍不满足则记录返回码并失败，既不无锁改规则，也不因锁忙放行坏保护。同boot安装屏障保持。外部脚本及`boot-assets-current.json`同步，15文件事务/config/release均不改；回滚备份在设备`/data/adb/video-proxy/backup-dns-lock-20261030`。

69项保护/boot回归通过，新增真实flock竞争的有效规则正锚、缺钩负锚和释放后恢复；Android同一持锁复现修正为verify=0/install=0。授权软件重启boot`cc87426c-5bc4-4fb8-a62f-01a6d5f208e4`：8.17秒保护，54.15秒校时，73.98秒真实DNS查询，77.30秒完整缓存/DNS就绪，77.88秒审计结束，无retry/failure事件。相比204.19秒缩短62.14%；Android启动及既有完整性预检、worker启动仍有耗时，不能承诺每次固定77秒。

主代理/guardian/两worker各唯一；重启后v4/v6生产出口、YouTube有效正文、完整1MiB和真实DoT通过，5354正常，15文件SHA/权限一致。DIYP1080p直播自动恢复且帧持续增长/drop/error0。未操作SmartTube/Netflix，实播仍未验；本次软件重启不能替代新版实际拔电与长期稳定性验证。原始脱敏证据`/tmp/tv-boot-opt-20261030/`，项目归档见mycc的同日启动优化报告。

## 历史：2026-10-30 09:17 已激活 RackNerd 双栈

15文件事务已应用，release `5618bda5a8bfe4f1b15bbf66669801df5df2d226d4a772a74eea3ac0f2b62e65`，
config SHA `d2fab1002448987d5e8fd2ac647aeb1acfa2330c5dfaa985af1266c8f73a8f6e`。
正式19102/19105的IPv4/IPv6入口各通过Rack出口、YouTube完整正文与1MiB；19111/19113各通过真实DoT，5354正常。
两种入口的目标站出口都为Rack IPv4，这是服务器出站选择，不否定客户端通过IPv6连接VPS。
新guardian5/3候选authorized=true，外部DNS保护SHA保持。DIYP UID10065在TUN外，连接局域网192.168.1.211:4022；
前台PID4746与ZGO worker8765保持，1080p25持续帧增长，drop/解码错误0；未重启盒子或操作应用。
重载恢复原ZGO选择，保留三次成功/300秒恢复门；节点可用不等于已强制所有流量切Rack。

首次重载因boot-start.lock被旧守护子进程继承而在任何生产修改前退出。
维护激活改为独立rack-activation.lock，并验证boot锁只由已知旧代理/guard持有、保留的ZGO worker实际持锁；
未知持有者或真正boot worker直接拒绝，未删除boot锁。新服务启动前关闭继承的维护锁FD，结束后真机获取维护锁成功。
前台从单独极空间扩为两种已验证TUN外播放器，并要求600权限authorized-foreground-component与当前组件精确匹配。
本地6项恢复/前台/真实锁回归通过；Android Magisk BusyBox原始启动锁不释放负锚与修正后释放正锚通过。
该激活入口仅适用于已核验的此次旧运行结构，不是任意前台/任意锁状态的通用重启器。

正式代理端口验证不等同于新版SmartTube实播或同UID/TUN端到端验证；本次未启动SmartTube。
新启动链已落盘且15文件/权限一致，真实下一次断电启动仍待用户窗口；HY2未额外测速、Cloudflare仍搁置。

## 历史：2026-10-30 00:23 暂存后离线（已由上方激活结果推进）

基于设备当前 release 增量修改，未用旧 stage 覆盖。新增 IPv6 Reality 视频/DNS候选，
顺序为 Rack HY2 → Rack Reality IPv4 → Rack Reality IPv6 → ZGO Reality → ZGO HY2；
DNS 为 Rack Reality IPv4 → Rack Reality IPv6 → ZGO Reality。保留原重试、三次成功/300秒恢复门、
DNS旧连接回收、Netflix与ZGO配置；初次重载默认选择采用暂存时的真实当前选择，不强制切换。

- `amend_rack_dualstack.py`：纯内存修正现网配置。更新三份Rack Reality地址/端口/SNI、主配置及独立worker的HY2地址，
  增加19105/19113回环探针、路由与候选；不轮换凭据、不改变DNS缓存或TUN UID。
- `stage_rack_dualstack.py`：先核live manifest/当前资产/旧事务，备份与payload仅写设备700目录；
  JSON/DEX/脚本真机校验、逐文件回读、当前boot零动作后输出脱敏收据。
- `dns-upgrade-apply.sh`：默认保持旧9文件契约；`rack-dualstack-v1` 扩为精确15文件，
  增加guard DEX/两份守护配置/Rack worker配置和SHA/服务启动脚本。其它路径、漂移与活跃Rack worker拒绝。
  `--apply-authorized`/`--rollback-authorized` 只接受600普通文件的当前boot授权；普通动作同boot仍延后。
- `activate-rack-dualstack.sh`：只由明确维护调用，不作开机入口。先核已授权且经现场验证的TUN外前台及worker安全门，
  先接好新启动事务，再短暂重载主代理/guardian/Rack worker；保留ZGO worker。
  激活失败按完整15文件回退；不重启盒子，不操作应用。

旧 `dns-upgrade-20261024` 的 payload/backup 保留历史；新事务接管 `video-dns-service-start.sh`
和两份 boot worker 的apply/rollback路径。早期DNS保护脚本及 `boot-assets-current.json` 保持。
下一次实际冷启动需要独立验收，不能由同boot重载推出断电恢复已验。

验证：15传输断言、74守护断言（含真实IPv6候选切换及ZGO回退的隔离API测试）、3配置修正测试与实际sing-box check、
27事务测试（含SIGKILL恢复、权限/漂移/锁/进程边界）通过；Android隔离目录上的15文件apply/rollback逐字节通过。
电视新v4/v6后台各YouTube有效正文、完整1MiB和真实DoT通过，当前极空间帧增长且drop/error0；这是独立探针证据。
本轮不额外测速HY2，不处理Cloudflare域名。

00:15前后设备ADB转offline，随后ARP无法解析、TCP5555报No route to host，原因未判定为关机。
**未运行激活脚本、未写当前boot授权、未改启动接线，仍是旧正式配置；下次开机不会自动启用这份stage。**
受保护stage为 `/data/adb/video-proxy/rack-dualstack-20261029`；15文件与真机DEX 5/3检查已经通过。
设备离线后本机补上激活回滚的三项审查修正：应用状态精确读回、未apply时恢复旧启动入口及服务、
回滚后同boot重试拒绝；并补充重载/回滚均恢复暂存时真实选择器，避免旧配置默认选中失效地址。
4项恢复分支回归已通过（真实临时文件恢复，进程动作是记录替身，不冒充真机重启验收）。这些激活脚本修改仅在源码，尚未上传/运行；`initial-selections.tsv`尚未写入设备，不能直接运行激活脚本。

恢复操作时须先核新boot/前台/正式15文件与stage旧SHA一致、新节点服务和独立请求可用。
读取stage manifest的initial_selections，与当前API选路核对；有漂移就重新制作独立stage。
补齐只含selector/tag的initial-selections.tsv，上传最终激活脚本，重新审查/验证恢复分支后，
按实际用户使用窗口写本boot授权并激活。部署后从生产19102/19105与19111/19113验证两地址族，
5354/完整文件SHA/guardian5-3候选/外部DNS保护/播放归属一起验；真实下一次冷启动另记。
证据 `/tmp/tv-rack-update-20261029/`。


## 2026-10-24 19:32 断电启动观察通过

用户执行断电重启后，ADB从offline恢复，新boot`310f7f71-50e7-4c96-8a06-75a2ab20b26a`。
全程仅后台读取及两次小DNS查询，没有启动APP、发按键、重启代理或改设备。
release/config仍为下节的40801839/e74294d3；9文件状态标记、两外部脚本SHA均正确。
主代理7551、guardian7593、worker8180/8685各唯一且自动启动。

- DNS保护8.26秒安装。SmartTube进程启动时间由`/proc/4657/stat`第22字段2967、
  实测`CLK_TCK=100`得到29.67秒，保护提前21.41秒。校时前logcat的monotonic显示负数，不用它计算时序。
- 8.32秒后台审计遇一次`/system/bin/iptables: not found`，已有保护不撤；后续自动恢复。
  设备时钟从2024年校正，一次时间源重试后52.66秒校时成功，78.89秒完整DNS就绪，
  79.64秒自动写出`startup_audit_ready`。这次闭合了上轮watcher补丁的实际启动验证，无手工补跑。
- DNS5354真实YouTube/NTP查询成功，耗时0.101/0.085秒（含ADB开销）。缓存文件131072B/600，主进程fd7打开。
  旧`www.iana.org`字节此时未找到，不能据此认定跨启动命中或失败；旧查询早已超过5分钟窗口。
- SmartTube DNS1与禁自动网络修复true保持。先720p，后VP9 2560×1440实播；
  19:31:17→19:31:38帧2369→3018→3664，drop/软硬解码错误均0。
  PID4657保留1935行日志中八类网络/证书/播放异常为0；这是观察窗口，不承诺长期绝不卡顿。

证据`/tmp/tv-dns-powercycle-20261024/`、`/tmp/tv-dns-powercycle-review-20261024/`。
本轮只更新验收记录与共享记忆，未commit/push。下节“未再次重启/断电未验”是19:25历史状态，已由本节推进；
生产缓存跨启动的真实查询命中仍未独立证明。

## 2026-10-24 软件重启验收与追加修正

用户明确授权重启后，新 boot `495ff7a2-b163-4451-b5e9-b2eb444b0c79` 已应用新配置。
当前 release 为 `40801839b020a05fdc7c7e49ed4702e39831033564ec4ddfaaab460d6ac9f82b`，
config SHA 为 `e74294d370dfd088e92703505bcf003c02f7ceef443bf6744c7d37ced924a551`。
9文件新SHA/权限、applied/ready、唯一主代理6353、guardian6395、worker6880/7303均通过。
DNS保护uptime7.65秒安装，早于哔哩20.640秒、官方YouTube27.704秒、SmartTube88.808秒启动；
完整DNS/系统缓存就绪67.67秒，等待期间保持保护。不是把DNS恢复到7秒，也不是证明轮询间绝无缺口。

生产主进程fd7实际打开600权限的`dns-cache.db`；新域名`www.iana.org`查询后DB SHA/mtime变化，
该域名由不存在变为存在，证明缓存文件实际写入。尚未实测生产DB跨下一次重启的命中。

本次发现并修复两处运行时问题：

- post-fs-data异步watcher解析`dirname`为不存在的`/vendor/bin/dirname`而退出。
  改纯shell路径计算、绝对BusyBox与`/system/bin/iptables`，在真机以`PATH=/nonexistent`
  执行**已安装post-fs-data入口**，后台实际写出`startup_audit_ready`（uptime593.63）。
  代理PID和防火墙规则保持，播放帧5447→5587、错误0。扩展后共66项guard断言/6项接线测试通过。
  此补丁尚未再重启验证，当前是实际入口及后台子进程验证；不可误记为第二次冷启动。
- SmartTube32.68播放后发现DNS1回到2。pinned源码`ffa164…`的`ErrorFixerController.onLongBuffering`
  存在强制Google DNS并restartEngine的路径；未捕获本次对应分支日志，不能排除手动改动。
  为阻止该自动改写，已启用原生
  “禁用自动网络错误修复”（官方说明VPN环境可启用），再将DNS设回1并重开SmartTube。
  实际`multi_profiles=false`；仅改`files/app_prefs/video_player_tweaks_data`中`%OB%`分隔的
  第52字段（index51）false→true和全局DNS字段，其他字段、owner/mode/SELinux保持。
  该选项还停止两类自动换播放引擎，保留client切换/重载/SABR与解码恢复；不是禁用全部自愈。
  备份`/data/adb/video-proxy/backup-dns-autofix-20261024`。别读取当前仓HEAD当32.68：新版才restartTheApp。

最终设置下实播：SmartTube PID12673，19:19:14→19:19:45，VP9 1280×720/30fps，
帧103→413→722→1030，drop/软硬解码错误均0；DNS持续1、禁自动网络修复持续true。
后三次前台为画质等对话框，解码仍持续；此前1080p/4K样本属于较早设置阶段，不能混作最终设置的画质验收。
19:22:51→19:23:22继续只读观察，同PID的AV1帧11575→13616、drop/软硬解码错误0，两设置仍保持。
该驱动的宽高读数为0，无法据此判断分辨率；未改用户画质。当前PID保留的1835行logcat中，
DNS/TLS/连接/超时/播放异常六类计数均0，仅代表保留日志窗口。主代理及worker PID、boot和两脚本SHA保持。

早期脚本属于release目录之外的追加修正，**当前SHA真源为设备
`/data/adb/video-proxy/boot-assets-current.json`**，覆盖首发manifest的`boot_assets`快照。
guard SHA `79808bef5532521e62d489f17662fcf3842353a09ee6a447cb941fe4b303d7c2`；
post-fs-data SHA `fdaa9f12954f2a51ab3d8dfac43cac24009ddbdeb96cf03eb18daef84ff3594c`。
事务不覆盖这两个外部文件，后续不得拿首发stage中的旧guard覆盖当前修正。
9文件迁移事务在后续每次启动仍预检old/new SHA；以后合法修改其中任何文件时，
须同步更新该事务的基线与回退组，或在完整接替启动链后显式退役事务。
只改config及active-main会让下次启动因未知漂移拒绝执行，不能以当次热运行正常作为交付判据。
证据`/tmp/tv-dns-reboot-20261024/`；软件重启不等同实际断电启动，长期不卡顿仍需观察。

## 2026-10-24 19:01 安装阶段记录（已被上方重启结果推进）

用户授权三项：SmartTube 使用系统受保护 DNS、应用启动前双栈 DNS 保护、现有
sing-box 1.14.3 持久 DNS 缓存及 5 分钟 optimistic 窗口。当前前台哔哩哔哩播放保留；
未重启盒子、主代理或 guardian。

- SmartTube Beta 的 `preferred_dns_type` 从 2 改为 1（系统 DNS、IPv4 优先）。
  确认无媒体会话且前台为哔哩后，仅 force-stop SmartTube，防进程缓存回写。
  XML 其他字段、owner/group/mode/SELinux 不变，备份在设备
  `/data/adb/video-proxy/backup-dns-smarttube-20261024`；下次实际打开仍待验收。
- `video-dns-post-fs-data.sh` 在 Magisk post-fs-data 阶段安装保护，只有有界本地规则操作；
  IPv4 NAT 接管 53→5354，额外 IPv4 filter 拒绝漏网 53，IPv6 拒绝 53。
  双栈 TCP/UDP 和 mark 255 校时绕过均覆盖。规则按有序前缀验收、不 flush，失败不撤保护。
  后台启动审计最多 240 秒，boot worker 多阶段复核。不能以轮询证明 netd 从不造成瞬间缺口。
- service.d 异步入口先运行 9 文件事务，再启动原有开机校时/代理流程。
  新配置只增加 `dns.optimistic={enabled:true,timeout:"5m"}` 和
  `experimental.cache_file={enabled:true,path:"/data/adb/video-proxy/dns-cache.db",store_dns:true}`。
  保留四级节点、Netflix、DoT 和 API 配置；发布副本、SHA、release、enabled、manifest 一起更新。

安装屏障绑定 boot `35c9236d-6904-481f-8515-e30d910c7d46`，本 boot 所有新入口实测零动作。
正式配置仍为下文原 SHA/release；下一次启动目标：

- release：`40801839b020a05fdc7c7e49ed4702e39831033564ec4ddfaaab460d6ac9f82b`
- config SHA：`e74294d370dfd088e92703505bcf003c02f7ceef443bf6744c7d37ced924a551`
- 事务及完整备份：`/data/adb/video-proxy/dns-upgrade-20261024`

代码：`stage_dns_upgrade.py` 只暂存；`install_dns_wiring.py` 安装下一 boot 接线；
`dns-upgrade-apply.sh` 只接受 old/new SHA，未知漂移拒绝覆盖，进程已运行则拒绝激活。
失败回滚整组，事务中断可重放（SIGKILL已测，真实断电待验），回退标记防止坏包自动再次激活；配置校验失败自动回退，
外网暂时失败保留保护并重试。凭据只在内存与设备 root 私有目录，启用接线前后已 sync。

验证：61 项保护/生产 boot 隔离断言、26 项真实 Linux sing-box 缓存断言、17 项事务测试、
15 项原集成断言、5 项启动接线测试均通过。Android 独立网络命名空间真实验证规则与数据包
计数；Android 合成文件事务实测 apply/rollback 并逐 9 文件回读通过。实际 Magisk BusyBox
只用 pathname+command `flock -n`，不支持 `-w` 或数字 FD 模式。

安装后主代理 3510、两 worker 4757/5442、guardian 3595、双栈规则和路由保持；
前台哔哩 720p30 帧 71285→71477，drop/软硬解码错误 0。当前冷启动时序、生产缓存文件
实际打开及 SmartTube 登录首页/实播仍待用户重启窗口，不能将隔离验证写为已经冷启动修复。
完整记录：mycc/vps-proxy `2026-10-24-电视DNS三项加固实施与待重启验收.md`。

本目录维护电视独立HY2 worker、真实正文与DNS守护、配置生成和授权后启动接线。
当前状态（2026-10-18 22:37 CST）：用户已明确授权重载，**正式目录已启用，主代理PID25241、guardian及两HY2 worker在线**。没有重启盒子或切前台应用。四出口完整正文、两HY2公网UDP、两Reality真实DoT与同UID生产TUN正文验证均通过；后续冷启动及长期SmartTube实播仍待验证。

正式目录：`/data/adb/video-proxy/youtube-failover`。当前release-id：`e6d3398ba0764d85730533c6475d5fa6ec98341b085b37b2fbbf3271ad10395f`；主配置SHA：`57a41d455b0964a547cebef6abfdd042e61268aea817408c8922b805d716281b`。原stage v2属于历史初包，运行目录已含下面的DNS探针修正，**不要用stage覆盖正式目录**。

首轮发布因3秒DNS门早于4.15秒有效答案而自动回退；第二轮采用有界真实查询重试成功。运行时另修正DNS探针TLS身份：从生产DoT的`tls.server_name`或`server`派生，当前为`1.1.1.1`，保留系统信任和IP SAN验证。ZGO路径对域名SNI超时、对IP身份成功，Android与独立Python对照一致；服务器是否配置SNI重写未核，不当成事实。该修正仅重启guardian，主代理与两worker PID保持。

候选顺序：Rack HY2 → Rack Reality → ZGO Reality → ZGO HY2。两HY2各自独立回环
worker，避免重连影响Netflix。主代理保留TUN、Netflix与DNS；YouTube专属selector
默认Reality。DNS专用selector关闭故障旧DoT连接，视频恢复切回保留健康旧流。

运行凭据从设备现有受保护配置在内存生成，禁止提交生产JSON或api-secret。
新release缺少enabled（内容须匹配release-id）和当前boot授权时，worker/守护禁止
PUT、DELETE或重启；观察模式也禁止变更。仅安装文件不会接入service.d或自动激活。

构建/测试产物进build（gitignored），设备临时配置只进700目录、600文件。源码原型复用
邻目录netflix-cdn-watchdog的有界HTTP/TLS实现；不修改其生产版本。

## 首次暂存阶段验证（22:14，历史）

| 验证范围 | 结果与边界 |
|---|---|
| Java 传输与策略 | 78 项断言（15 真实回环传输 + 63 守护策略/API/授权/持久化断言） |
| 生成器及 workerctl | 59 项断言；实际 ELF 进程身份、端口归属、锁/跨 boot/PID 复用及 sing-box 配置校验 |
| 启动接线 | 15 项断言；worker 不误认为主进程、未激活零变更、授权与单实例 |
| 两层 SOCKS | 15 项真实本地断言；TCP 256KiB、非 DNS UDP 275/1043/8211B，停 worker 负锚及直连正锚 |
| Android inactive stage | 24 文件逐一独立回读 SHA；主配置及两 worker 的 sing-box check、DEX --check-config、service check/status 均通过 |

隔离断言合计167项。双SOCKS验证使用本地直连回显，**不等同于已验证公网 HY2 UDP**；策略故障通过受控探针/API fixture 验证，不能替代激活后的四线路与真实媒体验收。

暂存前后 boot、主代理PID、生产配置/两开机脚本SHA、双栈路由、NAT及IPv6过滤均相同；前台同一SmartTube播放器，1080p30 VP9解码帧41905→42043，后续43457，drop/软硬解码错误均0。未调整画质或操作应用。当时没有新监听或 worker/guardian，也没有 enabled、authorized-boot-id 或运行状态文件；22:29用户授权重载后才启用。

## 原始暂存包与当前源码

- 设备路径：`/data/adb/video-proxy/staged-youtube-failover-20261018-v2`
- release-id：`30d44fd2483f061ad8747918943d0fcce99065d6efbab434396c606e58ad7693`
- Java SHA256：`bd75b87fcc1f0da4f101e9e14af9a38d784484ff132e5c362fe766016056476b`
- DEX SHA256：`c0424ae04b41f92775bbc6ba32683c680f5b3829b808cde1bf51fcb6deef71ed`
- 运行目录预留：`/data/adb/video-proxy/youtube-failover`。stage中的guard-config及worker路径面向此目录，不能直接启动stage。
- 原生产配置、boot worker和service入口备份位于stage的`backup/`；目录700、文件600。v1已逐manifest核对、确认未启用且无活进程引用后删除，v2含相同备份。
- 本机脱敏证据：`/tmp/youtube-failover-stage-20261018/` 下的 `stage-verification-v2.json`、`platform-check-v2.json`、`v1-cleanup.json`。

部署补充：生成器新增2条TLS身份派生断言后共61条，核心回归合计169条；`ip-identity-test/`另有7条实际TLS/IP SAN正负锚。Java/DEX SHA不变。发布器release摘要现在包含生成后的配置字节，避免只改策略却复用旧release-id。此次运行目录的DNS修正作为原release的派生版本独立记录，见`manifest.json`的previous_release_id/amendment。

## 行为与尚未实现的边界

当前实现正文失败驱动的切换与局部重建、恢复防抖、两路DoT DNS兜底。视频探针仅在相关应用前台或仍有本组连接时运行；DNS独立检测。重连前必须有健康当前线路、故障worker仍坏且未被选中/无存量流。

视频回退精确清故障旧流；正常恢复只改变新连接走向。DNS selector使用`interrupt_exist_connections=true`，切换时关闭旧内部DoT。开机顺序保留校时→主代理→DNS/缓存门；新增guardian位于主代理之后、DNS门之前，防ZGO DNS故障阻挡自身恢复。

本版没有自动分析播放器缓冲/实际媒体吞吐/解码帧，也没有应用异常即时唤醒探测或主代理自动重启。正常周期30秒；候选、API和操作分别限时，故障回退耗时必须在激活后实测。正文通不能证明4K带宽够。

探针成本见[守护设计](GUARD-DESIGN.md)：当前线路双正文按最大载荷约270MiB/h，加每分钟维护后首选稳态约405MiB/h、末位稳态约675MiB/h。实际正文通常更小；故障复核/重启前验证、协议与重传开销额外计算，不是网络硬上限。不能沿用原规划30MiB/h。22:29启用后按活动条件产生巡检流量，DNS独立巡检。

## 构建与暂存

使用已有JDK21/Android SDK34及邻目录watchdog的测试JSON jar，无需安装依赖：

源码构建不需要生产配置。测试依赖 `org.json:json:20240303`（[固定 Maven 地址](https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar)，SHA256 `3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed`）；先校验下载内容，再通过 `TASK_JSON_JAR` 指定仓外 jar，测试 jar 不入仓。JDK/SDK 默认路径见本目录 `build.sh`，可用 `TASK_JDK`、`TASK_SDK` 覆盖；`TASK_BUILD_DIR` 可将构建输出放在 `/tmp`。`ip-identity-test/run.sh` 与 boot 测试仍使用脚本内明确列出的本机工具路径，运行前须核这些文件存在。两个 Python 网络测试需要已有的 Linux sing-box 1.14.3（路径见下文）；缺依赖时应停止并准备对应版本，不把缺工具当作测试通过。

```bash
bash build.sh
bash test.sh
python3 test_runtime.py
python3 test_integration.py
```

生成器实际配置验证和双SOCKS测试另依赖已有`/tmp/video-proxy/sing-box-1.14.3-linux-amd64/sing-box`。`test_socks_chain.py`会在脚本同目录输出测试配置和结果，应先复制到独立`/tmp`目录再运行；本次执行于`/tmp/youtube-failover-socks-test-20261018/`，没有测试数据落仓。

`build.sh`生成本目录`youtube-guard.dex`；发布时设备统一名`guard.dex`，本次复核产物另保留于`build/guard.dex`。二进制、构建及runtime目录均gitignored。`stage_release.py`只能上传未启用包：生产JSON只在内存读取/生成，不能将凭据配置落本机或提交。

## 部署与回滚流程

**2026-10-18用户已授权并完成代理重载。** 下面保留部署/回滚步骤，不能重复执行安装覆盖当前修正。冷启动验收另需用户重启指令；本轮没有重启盒子。

1. 重新核boot、生产config/boot SHA、应用UID和24文件manifest。任何已漂移文件先重新生成/比对，不用旧备份覆盖新改动。
2. 将最终stage复制到正式运行目录，维持700/600权限；核与生产配置对应的回退备份可用。安装新主配置与`video-boot-start.next.sh`，保留原service入口及既有校时/缓存DEX。
3. 配置检查成功后写与release-id一致的enabled；只在受控重载窗口切换主进程及新boot worker。service在主配置SHA匹配后生成本boot授权并启动guardian与两worker；不能只创建marker就声称已启用。
4. 独立验证真实选路、四出口完整正文/媒体、两层SOCKS的公网UDP、DNS切换后的实际新DoT及5354解析；逐项故障注入并测恢复时长。回归Netflix/直播，观察至少两小时，之后再做授权断电启动验收。
5. 需回滚时先撤销enabled/boot授权并停止精确认定的guardian及其监督进程，受控恢复已核过的原主配置和原boot worker，再仅停本次两个worker；撤gate后workerctl会拒绝stop，须按boot/PID/starttime/exe/完整config argv精确认定后TERM，不能临时重开gate或全局kill。不清APP数据、不撤掉既有校时/DNS缓存修复。回读生产SHA、进程、路由及实播后才算回退完成。此次首次发布已实际走通回滚，设备runtime内`rollback-activation.sh`绑定本boot；跨boot回滚须重新核身份与备份。

完整实施报告位于mycc/vps-proxy的`2026-10-18-电视代理四级兜底实施与待启用验收.md`。
