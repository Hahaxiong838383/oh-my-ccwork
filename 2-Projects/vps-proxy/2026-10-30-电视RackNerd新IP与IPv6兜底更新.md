# 电视 RackNerd 新地址与 IPv6 兜底更新

## 后续：启动慢已修复

[启动延迟优化](2026-10-30-电视启动延迟优化.md)已部署并授权软件重启验收：204.19秒降到77.30秒，无失败重试；下方是修复前的开机记录。

## 历史：用户再次开机后的自动恢复验收

新boot `4915630e-f955-48a0-a4b3-67e711d41194`；未人工改配置、重启服务或操作前台。约8.01秒安装DNS保护，82.92秒校时成功，204.19秒DNS/系统缓存就绪，204.63秒启动审计完成。期间保护检查/收尾失败两次停主代理重试，早期两轮探针失败；自动恢复后双栈出口、YouTube正文、完整1MiB、DoT、5354全部通过，15文件SHA/权限及外部资产一致。不能写成顺畅无重试启动；具体失败调用尚未带返回码定位，锁竞争只是待证假设。

最后DNS走Rack、YouTube视频选择器仍ZGO，guardian 5视频/3DNS候选获当前boot授权；主代理15997及两worker/guardian在后段探测期间保持。SmartTube32.68保存的DNS=1（系统/IPv4优先）、禁自动网络错误修复=true；DNS缓存文件被主代理打开。当前DIYP 1080p直播帧79→6131，drop/解码错误0；不是SmartTube实播验收。用户手动开关机已观察到新boot，不独立声称物理拔电。启动延迟仍待优化，缓存跨boot命中/SmartTube实播/长期稳定性仍未验。

[本次脱敏验收](smarttube-tv/ACCEPTANCE-20261030-COLDBOOT.json)。本节及验收为6d7c14ab之后的新记录，随启动优化作本地提交归档，不push。

## 历史：用户关机交接

用户已报告手动关机；本轮不再连接或唤醒电视，未独立观测关闭状态。双栈已部署，关机不代表新版冷启动验收完成；下次用户开机后再核启动链、guardian/DNS及SmartTube实播。详见[共享记忆快照](smarttube-tv/MEMORY-20261030-ACTIVATED.md)。

## 最新结果：2026-10-30 09:17 正式激活并验证通过

用户开机后授权部署。当前boot `63d7299d-c0c1-49a1-b8e5-fbd947205b06`，新15文件release/config已经落到正式目录，
不再是“暂存未生效”。激活返回0，09:17:02写completed；新主代理22890、guardian22995、Rack worker23087运行，ZGO worker8765保持。

- 新IPv4 142.11.225.39及IPv6 2607:9d00:2000:28b::2f70:e3d的REALITY 24443已经接入五级视频/三级DNS候选。
- 生产19102/19105分别验证Rack出口、YouTube有效正文、完整1048576字节下载；19111/19113分别验证真实DoT A答案；5354系统保护DNS成功。
  下载限速128KiB/s，非测速。通过IPv6连VPS后目标站仍看到Rack IPv4出口，这是服务器出站选择，不是IPv6接入失败。
- 正式15文件SHA/权限全部匹配新payload；新DEX检查5视频/3DNS、authorized=true/dry_run=false；运行时守护日志已真实探测新IPv4与IPv6 DNS成功。
- 三处启动消费点已转新事务，外部DNS保护脚本和service.d入口SHA未变；缓存与Netflix/ZGO配置保留。
- 当前DIYP直播UID10065不在TUN，实际连接192.168.1.211:4022；PID4746和前台组件保持，1080p25解码帧4748→17262→20492，drop/软硬解码错误均0。
- 重载先恢复原视频/DNS ZGO选路，保留原恢复防抖。09:20:28运行日志selection_verified证明DNS已自动切回dns-rack-reality，最终API回读一致；YouTube视频selector仍yt-zgo-reality（当前播放是DIYP），IPv6候选已实测可用。

### 激活时发现与修正

旧boot worker退出后，主代理/guardian/两worker仍继承boot-start.lock的FD3，锁持续存在。
首次激活在拿锁阶段退出，未改生产配置/进程。实际/proc/locks与FD链接定位后，维护激活改为独立rack-activation.lock；
先验证旧boot锁仅由已知代理/guard持有、保留ZGO worker持锁，真正boot worker或未知持有者拒绝，未删除旧锁。
新启动子进程关闭维护锁描述符，完成后实际flock返回0，证明确实释放。

前台门从只允许极空间扩为经现场确认在TUN外的DIYP，并通过600权限授权组件文件精确绑定当前前台；不是放开任意播放器。
本地6项恢复/前台/锁生命周期回归通过，Android真实Magisk BusyBox旧行为返回1（锁仍持有）、修正返回0（释放）对照通过。
维护脚本由源码上传逐字节核验；该锁恢复针对本次已核验运行结构，不能不核持有者就用于其他设备。

### 验收边界与交接

本次完成生产代理端口与DNS链路验证，保留直播；未打开SmartTube/Netflix，未做新版同UID/TUN端到端或新故障注入，未额外测速HY2。
没有重启盒子。新版实际断电启动、SmartTube实播及长期稳定性仍需后续窗口；旧版本断电通过不能冒充新版验收。
Cloudflare维护继续搁置。旧stage备份仍留在设备root受限目录。

源仓本地commit：`0620d3f6839388ade3471e3cebcc8469dc110041`；源码快照已同步，本轮mycc以`codex/tv-rack-dualstack-20261030`分支作本地提交归档，不push。
证据摘要：[ACCEPTANCE-20261030-ACTIVATED.json](smarttube-tv/ACCEPTANCE-20261030-ACTIVATED.json)。
本机本轮证据 `/tmp/tv-rack-activate-20261030/`，完整生产凭据不入Git/记忆。

## 历史：00:23 暂存结果（已由上方正式激活推进）

已完成源码、隔离验证和电视上的受保护暂存，**尚未激活**。准备重载前电视变为离线：ADB offline，
随后5555连接报No route to host，ping两次无回复，ARP FAILED。不能据此直接断言用户已关机。
未运行激活脚本、未写本boot授权、未改启动接线，因此现有正式配置仍保持旧地址；下次开机也不会自动应用新stage。
已向用户询问是否关机，尚未收到回复。

## 已完成内容

- 三份Rack Reality出站迁到142.11.225.39:24443，SNI r.chenchuan.cc；与VPS核uuid、公钥、short ID保持一致。
  主配置与独立Rack HY2 worker只更新IPv4，未轮换凭据、未额外测试HY2。
- 增加2607:9d00:2000:28b::2f70:e3d:24443视频/DNS候选和19105/19113回环探针。
  视频顺序Rack HY2→Rack Reality IPv4→Rack Reality IPv6→ZGO Reality→ZGO HY2；DNS为Rack IPv4→Rack IPv6→ZGO。
  保留三次成功/300秒恢复门和原Netflix、ZGO、DNS缓存、TUN UID。
- Java原来将4/2候选数量与顺序固定，已允许明确的5/3扩展，同时保留旧配置兼容与未知顺序/worker/重复端口拒绝。
- 从现网manifest与全部字节生成15文件事务，涵盖原九文件、DEX、两守护配置、Rack worker配置及SHA、service-start。
  三处boot消费点接替旧事务，失败整组回退；旧外部DNS保护补丁保持。

电视stage：`/data/adb/video-proxy/rack-dualstack-20261029`。
新release：`5618bda5a8bfe4f1b15bbf66669801df5df2d226d4a772a74eea3ac0f2b62e65`；新config SHA：`d2fab1002448987d5e8fd2ac647aeb1acfa2330c5dfaa985af1266c8f73a8f6e`。
备份与凭据仅在设备root目录或内存；不入Git。

## 验证

| 范围 | 结果与边界 |
|---|---|
| 新地址独立电视探针 | v4/v6各YouTube有效正文、完整1MiB、真实DoT A答案通过；128KiB/s限速，不是峰值测速 |
| 播放保护 | 极空间UID10068未入TUN，NAS192.168.1.23:5055连接；同boot、代理四进程身份与选择器保持，1080p24帧25461→26331，drop/解码错误0 |
| 源码 | 15传输断言、74守护断言、3增量配置测试/实际sing-box check、27事务测试通过 |
| 真机暂存 | 15文件逐字节/权限、manifest、sing-box check、DEX候选5/3、同boot普通apply零动作通过 |
| Android隔离事务 | 实际Magisk BusyBox与shell，15文件apply/rollback逐字节通过；未启动任何隔离payload中的服务 |
| 激活恢复分支 | 独立审查指出3处失败路径问题，已修正并通过4项临时文件回归；进程动作是记录替身，不冒充真机重载验收 |

独立探针不是生产TUN/SmartTube实播验收。前次IPv6间歇失败仍保留，本轮短窗成功不证明长期稳定。

## 恢复后必须继续

1. 核新boot/当前前台/正式配置、stage及旧SHA，确认未漂移；新服务器当前服务与路径再验。
2. 本机最终激活脚本尚未上传；stage也尚缺只含tag的initial-selections.tsv（上传前首次读取即因离线失败）。
   先比对stage manifest的initial_selections与当前API选择，有漂移重新独立staging，不能覆盖已有备份。
3. 补齐上述文件，核恢复分支最终版本后，按实际播放窗口授权当前boot并重载代理。保留极空间及ZGO worker，拒绝未知前台变动。
4. 从生产19102/19105和19111/19113各验真实正文/完整载荷/DoT，再验5354、主配置/15文件、新guardian候选、外部DNS保护与播放帧。
   真实下次冷启动仍需单独观察。

代码真源 `~/home-lan/4-Assets/Code/youtube-failover`，本地commit `3a4bcf1112f72e3eaebe43998bc6f3d3861bc962`；
已同步smarttube-tv 51文件快照和SOURCE-MANIFEST，mycc本轮未commit/push。
脱敏摘要：[ACCEPTANCE-20261030-STAGED.json](smarttube-tv/ACCEPTANCE-20261030-STAGED.json)。
原始有界证据 `/tmp/tv-rack-update-20261029/`；Cloudflare维护继续搁置。
