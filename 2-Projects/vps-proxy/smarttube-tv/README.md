# SmartTube 与电视代理源码发布快照

本目录保存`~/home-lan/4-Assets/Code/`三个项目的可校验快照，发布到私有仓`Hahaxiong838383/oh-my-ccwork`。实现真源仍在home-lan，不在两处分别演化；更新时先修改、测试并提交真源，再同步快照和清单。

- `video-proxy-boot/`：基础版开机校时、实际DNS就绪、系统与应用DNS缓存恢复。
- `youtube-failover/`：五级视频出口、两HY2独立worker、真实正文/DoT守护、配置生成与集成启动脚本。
- `tv-network-status/`：独立桌面联网提示APK、root watcher及安装/重启验收。
- `SOURCE-MANIFEST.json`：71份源码/测试/文档的SHA256、大小、Git可执行位和真源commit。
- `ACCEPTANCE-20261024.json`：脱敏启动时序、实播及缓存验收摘要，不含生产配置或原始日志。

本次真源commit：`c15f0b693f919caa0ee2870102cc722d22f21445`。最新状态与经验见
[启动与联网浮窗复盘](../2026-10-30-电视启动与联网浮窗复盘.md)。

- Rack 双栈已正式激活；[启动提速](../2026-10-30-电视启动40至50秒优化结果.md)后两次软件重启完整网络就绪46.60/45.07秒。
- 联网浮窗已上线；[实际重启验收](tv-network-status/ACCEPTANCE-20261030-REBOOT.json)网络就绪46.91秒、成功窗显示2081ms后退出；中途人工HOME返回桌面用于验收。
- 最终版本物理拔电、SmartTube实际影片、长期稳定性与播放中主出口故障迁移仍未验；DIYP直播恢复不能代替SmartTube实播。
- [初次安装验收](tv-network-status/ACCEPTANCE-20261030.json)的“未重启”仅描述当时阶段；后续重启证据见上条。

历史阶段：双栈[正式激活](ACCEPTANCE-20261030-ACTIVATED.json) → [204秒到77秒](../2026-10-30-电视启动延迟优化.md) → [45～47秒](../2026-10-30-电视启动40至50秒优化结果.md)。
2026-10-24基线见[DNS与断电恢复复盘](../2026-10-24-电视DNS与断电恢复复盘.md)，更早见[四级代理复盘](../2026-10-18-SmartTube与四级代理复盘.md)。
生产配置、节点凭据、签名密钥、账号数据、原始日志及APK/DEX/二进制不入本快照。


## 2026-10-24 正式运行基线

系统DNS、Magisk早期双栈保护、现有sing-box1.14.3持久DNS缓存与5分钟optimistic已启用。
SmartTube32.68使用原生“禁用自动网络错误修复”阻止长缓冲自动改DNS；账号与画质不清改。
软件重启及用户断电启动均验证通过：8.26秒保护、78.89秒完整DNS就绪、79.64秒启动审计结束；
最后SmartTube2560×1440连续帧增长，drop/软硬解码错误0，系统DNS设置保持。
生产release40801839/config e74294d3的完整摘要见验收JSON；外部boot脚本查设备boot-assets-current.json。

本批实现已通过66项保护/boot断言、26项真实缓存断言、17项事务测试、15项集成断言、6项接线测试，
以及Android独立netns/合成事务和实际启动。归档时逐文件核对已提交真源，不重复操作电视或重跑无关测试。
缓存真实写入和断电后文件使用已验，跨启动查询命中未独立证明；长期实播及主出口故障迁移仍待验。
新增复现入口为youtube-failover下test_dns_guard.py/test_dns_persistence.py/test_dns_upgrade_apply.py/test_dns_wiring.py，
在临时副本运行；依赖与边界见该目录README。SOURCE-MANIFEST v2记录Git模式，避免把本机umask生成的权限当成clone必须复现的权限。

## 2026-10-18 历史版本与运行状态

2026-10-18 22:41记录：四级代理已启用，顺序Rack HY2 → Rack Reality → ZGO Reality → ZGO HY2；两HY2各自独立重连，DNS独立走两Reality候选。正式目录`/data/adb/video-proxy/youtube-failover`，release为`e6d3398ba0764d85730533c6475d5fa6ec98341b085b37b2fbbf3271ad10395f`。本次归档不改变现网。

基础版`video-proxy-boot/video-boot-start.sh`已验断电恢复；当前集成版是`youtube-failover/video-boot-start.next.sh`，其新冷启动仍待验。已验四出口正文、两HY2公网UDP、两Reality DoT、同UID生产TUN正文与备用ZGO自动重建；新版实际播放主出口故障迁移、Netflix实播回归和长期稳定性仍待验。源码可构建不等于这些现场验收已完成。

## 2026-10-18 历史发布复现

2026-10-18在独立`/tmp`源码副本完成以下361条断言，未操作电视。依赖沿用现有JDK21、Android SDK34、NDK26、sing-box1.14.3及固定SHA的JSON测试jar；依赖路径和覆盖变量见各项目README及脚本，二进制不随源码附送。

| 目录 / 测试入口 | 断言数 |
|---|---:|
| video-proxy-boot / test-net.sh | 60 |
| video-proxy-boot / test_boot_flow.py | 101 |
| video-proxy-boot / test_dns_cache.py | 24 |
| youtube-failover / test.sh（传输） | 15 |
| youtube-failover / test.sh（守护） | 63 |
| youtube-failover / test_runtime.py | 61 |
| youtube-failover / test_integration.py | 15 |
| youtube-failover / test_socks_chain.py | 15 |
| youtube-failover / ip-identity-test/run.sh | 7 |

两目录的`build.sh`重新构建通过，产物与此前部署记录完全一致：

| 产物 | SHA256 |
|---|---|
| video-boot-net | `07f8649cbe7b70547800e6b71368f5dba344476772d64136643dab5e9c92047c` |
| video-dns-cache.dex | `2331981fc2c377f67952d0373a32747ce98fb08ae774a1795131aa564f78f376` |
| guard.dex | `c0424ae04b41f92775bbc6ba32683c680f5b3829b808cde1bf51fcb6deef71ed` |

建议先将快照复制至独立`/tmp`目录再测试。YouTube测试先`build.sh`，再`test.sh`，最后IP专项；三个命令使用同一`TASK_BUILD_DIR`。`test_socks_chain.py`会在脚本同目录生成配置/日志，必须在临时副本运行。真实依赖缺失或测试失败应明确报告，不跳过后声称通过。

重新部署前从设备受保护配置生成runtime，不重用旧stage或提交生产JSON。历史备份、release摘要、实际进程加载和逐文件SHA须分别核验；本目录不是一键覆盖现网的安装包。
