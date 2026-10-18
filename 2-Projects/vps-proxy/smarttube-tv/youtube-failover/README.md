# YouTube / SmartTube 四级代理兜底

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
