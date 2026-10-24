# 电视盒 DNS 与冷启动维护

适用现有 X96 Android 电视部署的 sing-box / SmartTube 网络与启动链。设备地址、包版本、
PID、boot ID、节点及前台从当次现场取证；连接前查共享设备记忆，不照抄历史值。
Netflix 登录、遥控适配、DRM 不走本流程。

## 先确定正在维护哪一份

- 实现真源：`~/home-lan/4-Assets/Code/youtube-failover/`；基础校时/DNS helper 在邻目录
  `video-proxy-boot/`。当前集成 worker 是 `youtube-failover/video-boot-start.next.sh`，
  不能用基础版同名用途脚本覆盖它。
- 发布快照：`~/mycc/2-Projects/vps-proxy/smarttube-tv/`，同步时核其 `SOURCE-MANIFEST.json`，
  不在快照和实现仓分别演化。
- 运行真源：设备 `/data/adb/video-proxy/` 的实际配置、完整 argv、release、manifest 与授权标记。
  修改前从 live 逐文件核 SHA，保留已上线的 DoT/TLS、worker 等修正；旧 stage 不是覆盖源。
- **事务也有生命周期**：现有 `dns-upgrade-20261024` 的九文件事务每次 boot 仍预检 old/new SHA。
  以后合法修改受管文件，须同步更新或显式退役该事务并验证新启动链；只改 `config.json` 和
  `active-main.sha256` 会让下次启动因漂移拒绝。使用现有 staging/transaction 工具先读其契约，
  不把一次迁移脚本当成永久无条件重放器。
- 事务外 `video-dns-guard.sh` 与 post-fs-data 入口的当前 SHA 以
  `boot-assets-current.json` 为准；旧 release manifest 的 `boot_assets` 是首发快照。
  运行修正、仓库源码、发布快照、当前资产清单要对应，不能只验其中一处。

现场说明见[2026-10-24 实施与断电验收](../../../../2-Projects/vps-proxy/2026-10-24-电视DNS三项加固实施与待重启验收.md)。
报告前部有安装阶段历史状态，以末尾最新实际验收为准；不要把旧“待重启”结论再次当现状。

## 只读取证与播放归属

用户要求不影响前台时，先读 resumed Activity、媒体会话、解码器和应用进程，再判断允许操作范围。
后台进程存在不等于没有播放；系统解码帧也可能属于直播或哔哩，不能作为 SmartTube 验收。
按 boot、完整 argv、exe 和 startticks 识别主代理/worker；同一 sing-box 二进制有多个合法实例。

取目标应用当前 PID 的保留日志，结合实际连接、DNS 查询与 guardian 正文结果。
日志计数零要注明采集窗口；TCP 通、HTTP 空壳 200、小页面通均不足以证明视频恢复或吞吐改善。
采样实际影片的连续帧增量、分辨率、drop/解码错误与对应前台/媒体归属；宽高为 0 时不推定画质。
每次改设置后重新取播放样本，修正前的 4K 样本不能证明最终设置下仍在 4K。

## SmartTube：查所有设置写入方

先核安装的 versionName/versionCode，再固定对应 tag/commit 及子模块版本读源码。
仓库 HEAD 可能和已装包不同；32.68 的长缓冲处理重启播放引擎，后续 HEAD 才加整应用重启分支。

32.68 的 `ErrorFixerController.onLongBuffering()` 可强制切为 OkHttp + Google DNS。
因此手动设为系统 DNS 后还须观察是否改回 `2`；仅文件改对不能证明运行时持久生效。
源码能解释潜在写入方，未捕获分支日志时不要断言那次回写必由此触发。

| 设置 | 32.68 的位置与语义 |
|---|---|
| `preferred_dns_type` | `GlobalPreferences.xml` 独立 int：0 系统、1 系统且 IPv4 优先、2 Google 明文 DNS；实际文件名从包路径核对 |
| 禁用自动网络错误修复 | `PlayerTweaksData` 的 `video_player_tweaks_data`，`%OB%` 分隔，index 51（第 52 项），`true` 表示禁用 |
| 活动 profile | 默认 prefs 的 `multi_profiles` 与 `last_profile_name` 决定 key；启用多 profile 且名称非空时为 `<profile>_video_player_tweaks_data` |
| 数据真源 | `files/app_prefs/<effectiveKey>` 优先；缺失才从默认 SharedPreferences 同名 string 迁移，不是始终存在于 XML |

原生选项“禁用自动网络错误修复”说明 VPN 用户可能需要启用。它还禁止两类网络错误自动换播放引擎，
仍保留 client 切换、普通重载、SABR、字幕及解码恢复；不能描述为“只关 DNS”或“关闭全部自愈”。
DNS 是全局设置，禁自动修复按 profile 保存；切换或新增 profile 后需重新核查，不批量改无关偏好。

需要离线改偏好时，只在应用停止或下次应用启动前进行。运行中单例与延迟保存会覆盖外部修改。
若没有经核验的偏好修改工具，处理纯数据时按原始字节用 `%OB%` 拆分，确认字段存在且为布尔值，
只替换 index 51，再逐项断言其余字段不变。**不按逗号拆分、不补 `null`、不重建所有默认值**：
补占位会把原本缺省为 true 的布尔项变成 false。缺字段或版本不符时先查该版本或走原生设置。
备份留在设备受保护目录，原子替换保持 owner/group/mode/SELinux，并检查 XML `.bak` 恢复路径。
只回报目标字段与非目标字段一致性，不输出 profile 名、账号项或整份偏好。

## 开机保护：早装规则，独立等联网

`post-fs-data` 在应用启动前做有界本地规则安装；联网、校时和主代理启动由后续异步链完成。
“保护已安装”与“能正常解析/播放”是两项时间指标，禁止合并成“几秒即可联网”。

- IPv4 TCP/UDP 53 重定向本机受保护 DNS；IPv4 filter 拒绝逃过 NAT 的 53；IPv6 拒绝明文 53。
  没有可信解析时失败关闭并等待恢复，不回退污染 UDP，也不固定 YouTube/CDN IP。
- 保留已验证的 mark 255 bootstrap 例外。Android `connect()` 可重写 SO_MARK，helper 必须在连接后
  重设并回读再发包；已有 `video-proxy-boot/video-boot-net.c` 实现这一点。
- 规则验收要核 **OUTPUT 首钩和链内有序前缀**；仅 `-C` 证明存在会漏掉前置 RETURN/ACCEPT。
  识别 `-S` 的十六进制 mark、隐含协议 match 和 REJECT canonical 格式。修复不先 flush/unhook，
  失败不撤已生效保护。启动轮询可补 netd 重建后的钩子，不能据此保证轮询间绝无瞬间缺口。
- 先查目标 BusyBox 能力。该盒 Magisk BusyBox 的 `flock` 不支持 `-w` 或数字 FD 用法，使用已验的
  pathname + command 形式配合有界 timeout；Linux 测试通过不能代替此检查。
- 开机异步子进程可能丢失可用 PATH。用纯 shell 取脚本目录及绝对 BusyBox/系统工具路径，并在
  `PATH=/nonexistent` 下执行**真实已安装入口**、等到后台自己的成功事件，不能只直接运行内部函数。
  该入口可能安装规则和启动 watcher，只在已授权验收窗口或隔离环境执行，不属于只读取证。
  早期绝对路径仍可能暂不可用；保留规则并有界重试，验恢复日志和最终规则。
- 真机规则兼容测试可用独立 netns；执行任何 iptables 前必须证明子/父 netns 不同，不支持隔离就记录未验。
  宿主规则比对剔除计数器和时间戳，否则流量变化会造成假漂移。

## DNS 持久缓存：分层证明

当前 1.14.3 已支持 `experimental.cache_file.store_dns=true` 与
`dns.optimistic={enabled:true,timeout:"5m"}`，不为此默认升级内核。
保留既有 `experimental` 的 API 等字段，勿用新对象覆盖。缓存有界不是 CDN 地址永久正确的保证。

| 证据 | 能证明的范围 |
|---|---|
| 配置 check | 版本接受字段，不能证明活进程正在使用 |
| 主进程 fd 指向生产 DB，查询后 DB 更新 | 实际打开与写入；不代表跨 boot 命中 |
| 可控上游请求计数 + 空 DB 负锚 + 重启后返回缓存载荷 | 持久缓存命中；测试所用平台/停止方式必须注明 |
| 阻塞上游时先返旧值、释放后换新、超窗不得继续旧值 | 乐观窗口与刷新机制确实执行 |
| 断电后 DB 存在且被打开 | 文件与使用恢复；仍不等于实际查询命中 |

复用 `youtube-failover/test_dns_persistence.py` 的真实 sing-box 回环测试。
Linux SIGKILL 后命中不能替代 Android 掉电耐久验收；旧域名超出窗口后在 DB 中找不到，不单独证明缓存坏了。
生产跨启动命中若未取得受控查询与上游对照，直接标为未独立证明，不用文件大小或配置代替。

## 冷启动验收与恢复边界

授权范围要求等待重启窗口时，先完成源码、隔离测试、备份与下次启动部署，不热改 release 让现有 guardian 失效。
配置、发布副本、active SHA、release/enabled、manifest 用现有事务一致更新；未知漂移拒覆盖。
配置失效才触发已验证的整组回退，普通网络失败保持保护并重试；回滚标记要防自动切回坏包。

重启后按新 boot 核：事务与当前资产 SHA、主/worker/guardian 的唯一身份、真实 DNS/系统缓存 ready、
后台审计自己的结束事件、SmartTube 设置持续保持与实际影片帧增量。软件重启、实际断电、长期观察分别报告。
Android 可能先以旧日期启动再校时；不要用墙钟或校时前异常的 logcat monotonic 推进程先后。
取 `/proc/<pid>/stat` 第 22 字段 starttime，除以当机 `getconf CLK_TCK` 得启动 uptime，
解析时注意 comm 字段括号/空格，再与同 boot 保护日志 uptime 对齐。

2026-10-24 已观察一次实际断电后自动恢复与 SmartTube 1440p 持续帧增长、drop/error 为 0；
该历史样本不承诺下一版本或长期稳定性。验收后仍区分“已启用”“自动冷启动通过”“缓存命中已验”和“长期性能未验”。
