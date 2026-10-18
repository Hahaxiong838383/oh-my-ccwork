# SmartTube、冷启动与四级代理恢复复盘

2026-10-18，codex（OpenAI）。范围：SmartTube安装后的断电恢复、HY2会话失效、四级代理兜底与本次源码归档。

## 结果与验收边界

SmartTube原账号授权后播放正常；基础版开机校时、DNS与缓存修复已完成用户亲自断电后的播放确认。22:29用户授权重载后，四级代理与独立HY2重连正式启用：**Rack HY2 → Rack Reality → ZGO Reality → ZGO HY2**。两HY2各自独立worker，Netflix原有ZGO通路保留。

新版本已验四出口完整正文、两HY2真实公网UDP、两Reality真实DoT、SmartTube同UID生产TUN正文，以及未选中ZGO worker约两分钟自动重建。**尚未验证新版冷启动、SmartTube播放中主出口故障迁移、Netflix实播回归与长期稳定性**。基础版冷启动成功不能覆盖后来改过的启动接线；正文通也不能证明4K带宽够。

本次复盘、测试与Git归档不操作电视、不重载代理。生产状态取自22:41收尾记录，不冒充本次重新采样。

## 经验与固定做法

| 问题或误判 | 本次证据 | 后续固定做法 |
|---|---|---|
| 断电后把联网失败归因于账号 | RTC回到1970，系统停在2024固件时间；DoT和HY2证书按该时间尚未生效，自动NTP又依赖故障DNS | 校时引导走数值IP与独立网络路径，先时间、再代理、再真实DNS；不清账号或重装碰运气 |
| 给Android socket预设mark就认为绕过代理 | connect后mark255被平台改成786533；再次设置并回读才恢复正确路径 | 以连接后的实际mark与路由为准，正负锚都测，不能只看设置调用成功 |
| 5354有答案就认为APP也恢复 | 5354返回正确地址，系统resolver仍命中先前污染缓存；清netd并广播后原APP PID恢复 | 动态识别NetId，清系统与应用DNS缓存，验证系统解析，再做末次5354门；暂态缓存失败不停止健康代理 |
| 所有卡顿都沿用开机DNS根因 | 时间/DNS/有线正常；同盒同参数同时对照，旧HY2实例两目标超时、新实例成功 | 新问题重新建立同时对照；将“旧连接状态失效”与“QUIC底层触发原因已找到”分开，后者仍未证实 |
| delay/204/selector名称证明健康 | sing-box 1.14.3的delay是有状态HEAD探针，会改健康历史；PUT /configs返回204但未实现重载 | 成功必须验完整载荷、独立回读选路和生产UID/TUN；全局DELETE会ResetNetwork，不能用于局部修复 |
| 用自选域名作为DoT身份 | ZGO路径cloudflare-dns.com的SNI超时，而生产1.1.1.1身份在Python和Android都成功 | 探针沿生产tls.server_name，否则沿server，保留系统信任/IP SAN；未读服务端配置就不认定SNI重写 |
| 单次3秒超时判发布失败 | 首轮DNS在4.15秒返回有效答案，门已触发真实回滚 | 使用有总界限、有间隔的真实查询重试，保留失败回退；不能靠放宽答案有效性掩盖问题 |
| 配置SHA一致就算已加载 | 新配置在磁盘时旧main仍可能运行；两个worker与main使用同一sing-box二进制 | 新PID/API selector与端口归属独立核验后再授权守护；进程身份用boot、starttime、exe和完整config argv |
| 只维护比当前更优的候选 | 当前首选正常时，从未选中过的末位ZGO也可能已坏 | 定期维护所有未选中HY2；局部重建前复核当前路健康、目标仍坏且无存量流，预算先落盘 |
| 正常回迁也清连接 | 迁移故障旧流需要清理，健康Reality旧流仍可继续播放 | 故障切换仅清该组旧故障链并检查迟到连接；正常回迁只改新连接，不全局重启 |
| 有回滚脚本就算可恢复 | 首次发布实际回滚成功；撤销gate后workerctl stop也会拒绝 | 回滚要核产物与实际恢复；撤gate后按完整身份精确TERM，不能重开gate或killall绕过 |
| 采样窗结束等于系统未恢复 | 110秒采样先报失败，随后独立日志/PID/预算证实ZGO自动重建约两分钟 | 保留原测试失败记录，追加独立证据；不能改报窗口内成功，也不能把测试连接当实播验收 |
| 沿用单对象探针的30MiB/h估算 | 当前lane每30秒最多256KiB+2MiB；另有每分钟备用维护 | 按真实路径逐项算：当前lane270MiB/h，首选稳态405、末位675MiB/h；异常、协议和重传开销额外 |
| 旧stage或源码快照等同现网 | v2 stage已被生产DNS身份修正超越；生成器策略变动曾不进入release摘要 | release摘要包含生成配置；源码commit、逐文件manifest、部署SHA和实际运行行为分别核验 |

## 可复现源码与版本边界

- 真源：`~/home-lan/4-Assets/Code/video-proxy-boot/`、`youtube-failover/`。
- GitHub发布快照：[smarttube-tv](smarttube-tv/README.md)，逐文件SHA和真源commit见`SOURCE-MANIFEST.json`。沿既有Netflix发布方式，home-lan本地提交，快照推送到私有`Hahaxiong838383/oh-my-ccwork`。
- `video-proxy-boot/video-boot-start.sh`是已验冷启动的基础版。现网集成版来自`youtube-failover/video-boot-start.next.sh`，SHA `d3ef80ede9373523e094719ec9411b3056c83a290f0ea38aebd979754a6e7a5e`；新冷启动待验。
- 22:41生产release：`e6d3398ba0764d85730533c6475d5fa6ec98341b085b37b2fbbf3271ad10395f`；主配置SHA：`57a41d455b0964a547cebef6abfdd042e61268aea817408c8922b805d716281b`。
- 当前Java SHA：`bd75b87fcc1f0da4f101e9e14af9a38d784484ff132e5c362fe766016056476b`；DEX SHA：`c0424ae04b41f92775bbc6ba32683c680f5b3829b808cde1bf51fcb6deef71ed`。生产JSON、凭据、设备数据、二进制与原始日志均不入快照。

本轮归档修正文档历史状态、示例secret文件路径及测试依赖说明，不改变生产实现。发布复现结果见快照README；测试未连接电视。

## 后续验收入口

1. 用户正常观看SmartTube时观察真实媒体下载、解码帧与错误，至少两小时；短正文探针只证明链路可用。
2. 在用户允许的窗口验证实际播放主出口故障迁移，记录卡顿、实际chains和恢复时长；同时回归Netflix。
3. 另获重启指令后验证新版断电恢复，需新boot之后的时间、DNS、缓存、main/worker/guardian及实际播放证据。

这三项保留为待验，不以代码通过、上一版断电通过或用户先前“一切正常”替代。

## 阶段报告

- [SmartTube安装与YouTube同路由](2026-10-18-SmartTube安装与YouTube同路由.md)
- [断电重启DNS与时钟排障](2026-10-18-SmartTube断电重启DNS与时钟排障.md)
- [卡顿与HY2会话恢复](2026-10-18-SmartTube卡顿与HY2会话恢复.md)
- [自动兜底与重连规划](2026-10-18-电视代理自动兜底与重连规划.md)
- [四级兜底实施与验收](2026-10-18-电视代理四级兜底实施与待启用验收.md)（文件名沿用，顶部为已启用状态）

署名：codex（OpenAI）| 2026-10-18
