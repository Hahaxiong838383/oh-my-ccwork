# P003 指定 SN 后台搜索：R1 部署与验收记录

> 历史记录：下文状态与前置条件仅适用于当轮。后续用户授权及实际开窗已更新为 [R3 P1全天窗口](R3_FULL_DAY_CANARY_20261021.md)；当前接续读 [MEMORY](MEMORY.md)，不得把此处未开窗/同机30轮要求当成最新状态。

**结果：灰度代码及独立候选已部署，正式两小时设备窗口未开；待真机验收。**

本轮亲自实施，未委派、未新建分支、未合 main。生产最小签发补丁已部署，灰度配置缺省关闭；所有合成探针直签候选房间，不经生产设备灰度派单，不能记作真实设备开窗。最终候选搜索/工具热闸=0、Worker 搜索 env=0、window.enabled=false/deadline=0。候选服务保留关闭待命。

## 1. 当前真值与 R1

2026-10-21 17:53 左右实时核查：Brain 3499MB 内存、约2436MB available、磁盘约12GB可用；HK2 Worker 7939MB、约6562MB available、磁盘约70GB可用。3007 经占用检查为空后用于候选。资源是当时快照，不是永久容量结论。

| 位置 | R1 / 实际取证时间（UTC） | 归档 SHA256 |
|---|---|---|
| Brain | `/opt/p003/server/backups/search-canary-R1-20261021T095400Z/brain-R1.tar.gz`；09:53:15.451 | `1f601177e907476b0272799d76ec197e2a240aa1982a91f86923c2f713dc70f5` |
| Worker | `/root/rust-worker/backups/search-canary-R1-20261021T095400Z/worker-R1.tar.gz`；09:53:29.262 | `2257d09ffc38d7fa7df5885344b6c788493e78472de19a76a00099869452c174` |

备份含源码/产物、私有配置和服务配置；私有文件只留对应服务器，不进 Git。Brain 另备实际生效的 `sites-enabled/kidshub-ai` 为 R1 下 `nginx-kidshub-active`。目录中的095400不是精确取证时刻。

- HK2 当前地址核实为 `64.90.13.177`，旧技能中的 `.117` 不使用；遇旧地址主机密钥不匹配时没有绕过校验或改 known_hosts。
- 现役 Worker SHA `deea58bf0a594a9a86a0d422fec2e36289b1f7c97b3c4857aa0e313ba5d9163d`，PID839、NRestarts0，本轮未替换/重启。
- `p003-voice` 从 PID3873258/restart24，经两次空闲最小发布到 PID1123377/restart26；一次接入签发，另一次补齐末6秒回退。检测到现役房间时曾延后操作。Analytics 与个人站 PID/重启数保持。
- 生产仅变更 `src/routes/device-session.ts`、新增 `src/search-canary-policy.ts`/`src/search-canary-runtime.ts`，并在 `.env.local` 增加候选健康文件路径；其余 R1 源码哈希核同。未发布整份候选 Brain。
- 生产 Nginx 只增加同域候选前缀，`nginx -t` 后 reload。生效文件是独立普通文件 `sites-enabled/kidshub-ai`，不可用旧 sites-available 文件冒充。
- 生产搜索灰度 runtime_flag 目前未设置，按默认关闭；没有调整 Analytics、其他设备配置或首句全局策略。

## 2. 部署与代码锚点

| 项目 | 当前实现 |
|---|---|
| Brain 分支 | `codex/p003-brain-search-tools-20261021`；执行前 `1cdc1e99ed9df2f1c52716a2dd736bba65e035b4` |
| Worker 分支 | `codex/p003-worker-tool-lifecycle-20261021`；执行前 `66b89ac2a7520ac43c58961a8de0426da2633679` |
| Brain 代码提交 | `a932949c`（派单）、`f5f1d1e1`（隔离/健康/期限）、`c665e941`（末6秒保留原票据最短TTL） |
| Worker 代码提交 | `d6c05051`（独立身份、窗口看门狗、HTTPS/sidecar边界、播报关联） |
| 最终候选二进制 | SHA256 `435caa275f1504a6c8c4b583acd670ed3ad28068b615dc3f24d6e96b3a3205ae`，72980816 bytes |
| 构建 | 隔离 home-studio Ubuntu24.04 / Rust1.98.0；GLIBC最高2.39、GLIBCXX最高3.4.31，门禁正负例通过；43个源码/构建输入逐文件核同 |
| 候选 Brain | `/opt/p003/search-canary-20261021/brain`；`p003-search-brain.service`，127.0.0.1:3007，MemoryMax600M、CPUQuota100% |
| 候选 Worker | `/opt/p003-search-canary-20261021`；`p003-search-worker.service`，agent=`p003-search-canary-20261021`、max_jobs=1、MemoryMax1400M、CPUQuota150% |
| HTTPS | `https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1`；正常证书校验，禁止重定向，健康/管理页不公开，候选路径不记录含token的URL |

各源码提交与报告提交分开。最终分支 tip 与远端对账以 Git 推送结果及最后交付回复为准，不能把报告自身尚未生成的 SHA 写成已验证。

## 3. 隔离和关闭机制

- 认证完成后用完整 SN 派单；单一名单、固定候选 agent、截止时间、健康租约和首句兼容同时满足才覆盖原 agent。请求路径只读缓存，不等待联网探活。缺失、异常、过期及距截止不足6秒回 baseline，保留5秒最短票据合同。
- Worker 每5秒带独立认证上报注册/容量，Brain 签15秒本地健康租约；满载或注册失效不续可用租约。健康不等于真实播音通过。
- 候选使用独立密钥、固定服务账号、精确目标SN；普通会话/本地文本/搜索均走候选。候选无生产设备签发、Analytics、OTA/人格日批入口。
- 全部12类DB路径及音频/OTA/健康文件必须位于候选根内，拒绝越界/未审核DB键/数据目录软硬链接；systemd限制写路径。运行时34个DB相关FD均位于候选data。只导入目标设备最小登记、人格设置与77条本地文本/元数据，不复制原始音频和整段长期记忆，不回灌生产。
- 搜索HTTP在后台actor，音频tick不等待网络；空闲门800ms，未核实/取消/跨会话结果不能迟到起播。
- 三重截止：生产签发回 baseline；候选 Brain 拒新请求、取消结果；Worker 每秒核窗口，过期或关闭便 abort pipeline、关RTC房间。截止保存在DB/文件，进程重启不刷新截止，不自动延长。
- 既有会话不热迁移：截止后测试会话结束，设备须返回入口重新进入；新票据按现役策略。重连能否被当前APK正确呈现仍待真机确认。

## 4. 已取证验证

| 项目 | 结果与样本 | 边界 |
|---|---|---|
| Brain 测试 | 10个搜索/灰度测试文件、device-session 44项、5个普通语音回归文件通过；变动后重跑6文件、TTL修正后再跑policy/session；tsc --noEmit通过 | 非全部历史测试；首轮误写不存在device-intent.test.ts失败，随后正确device-intent-protocol.test.ts 5/5通过，失败记录保留 |
| TDD负例 | 策略、JWT/metadata集成、隔离越界、空generation、健康文件越界、末6秒票据分别先红后绿 | 非真实设备认证凭据读取 |
| Worker | 最终代码 cargo test 354/354；release和ABI门禁通过 | 3个既有unused警告；不是实机吞吐/P95结论 |
| 隔离 | 进程临时DB/哨兵、越界/软链接/未知DB拒绝；候选实际普通聊天/搜索；运行期34 DB FD均隔离 | 未将正在正常写入的生产DB全文件mtime不变当证据；本地进程哨兵测试主要覆盖鉴权/路由/边界，不冒称完整真实上游矩阵 |
| 公网边界 | 无认证401、有效候选凭据但错SN403、后台路径404；TLS正常 | 不关证书校验 |
| 实际生产闭闸签发 | 合成短期凭据调用目标session=200，agent=rust-worker、ordered_pcm合同保留、JWT一致；伪造body SN403 | 合成凭据仅接口验证，不冒充持有人当前Bearer；未连接该票据房间 |
| 普通RTC合成 | 1次，音频约13.68s、用户final1/agent final3、metrics5、双ready | 非设备扬声器/真人体验 |
| 搜索并发合成 | 1次，接收4段用户final、agent final3、metrics10；结果开始补播后探针退出，账本cancelled/claimed | 不能当“搜索期间3轮完整普通回答”通过 |
| 空闲搜索完整合成 | 修正探针就绪等待后1次 completed；最终二进制又1次 completed：音频约7.74s、用户final1/agent final2、metrics3 | 有真实RTC接收，仍未实听；不是10次补播或内容质量验收 |
| 到期实测 | 合成窗口截止北京时间18:16:11.050；Worker 18:16:11.434触发、18:16:11.848删房，客户端 disconnected=true，jobs=0 | 合成短窗口，不是已开放2小时或长稳通过 |
| 停候选回滚演练 | 先关闭热闸和window，停Worker/sidecar及Brain；主站health200、生产无凭据session401、候选502；再以全关闭配置恢复候选 | 未对真实设备开启生产灰度总闸，不冒称已完成真实单机切入/回切 |
| 日志关联 | 最终任务55846b45…与delivery81a82974…可对账：排队、实际首音频发布、结束；关联room/turn/毫秒，再连trace/session和部署SHA | 首帧发布与server completed仍不等于设备扬声器听到 |

账本状态需按时间解释：两次完整补播当时为delivered/completed；退出/关窗后顶层status变为cancelled，delivery仍completed。首次补播中途退出的任务最终为expired/unknown，不能计为播放成功；JSON保存最终快照，日志保存当时事件。

最新脱敏 JSON：`CANARY_TEST_RESULTS_20261021.json`、`canary-evidence/brain-final-state.json`、`worker-final-state.json`、`worker-source-manifest.json`。私有原始日志/合成音频不提交。

## 5. 发现的问题与处理

1. 候选把空字符串当“关闭fallback”仍触发构造错误：配置改为完全移除LLM_FALLBACK_*，普通链路随后恢复；未改现役配置。
2. 打断时 capture_frame 一次 InvalidState，21ms后既有重试成功；不掩盖该告警，也不冒称真人插话门已过。
3. 第一次空闲探针在输入ready前送音，实际RTC连接重试后首句丢失，计数为0；探针改为等待输入/输出ready。该失败保留，未为“让测试绿”改产品首句合同。实际连接有v1信令超时重试，需真机首句时延进一步量测。
4. 一次候选更新时传输尚未退出便提前执行替换，出现未完成文件SHA不一致；立即停独立候选、等传输完成，核足72980816 bytes和最终SHA后才重新启动。当时window关闭、无测试job，现役未触碰。**后续安装必须串行等待传输成功，并在stop/替换前assert SHA相等；仅打印SHA不算门禁。** 不将当前NRestarts0用来抹去这次不合格激活尝试。
5. 审查发现截止前几秒可能触发既有最短TTL自检；新增负例后修复为不足6秒直接回原派单，保留合同。
6. 旧IP、旧nginx备份、历史版本均不能作为当前真值；本轮实时核查后才使用。

## 6. 未过门项目与下一步

**正式窗口未开；开始/结束均未设置。P2未开。** 目标仅BJP00326070803800006。

- 云端最近自报353/1.2.2-canary.339（17:53:52），真实认证成功17:54:11；未取得现场“关于”页/客户端日志和当前Bearer的独立读回。持有人尚未确认参与，不能说设备此刻在线。
- 尚无同机旧链路30轮基线、候选关搜索30轮、搜索并行30轮及P95比较；合成探针不能顶替。
- ordered首句、设备指令、本地回复语端侧下拉、真人pause/插话/续讲/取消/改查、退出重连实听待验；10次补播、20题质量、20会话/100轮/20搜索及2小时长稳都未完成。
- 生产总闸ON→OFF真实设备切换未做，禁止把隔离测试当实际全链路切换通过。
- 持有人可参与后，先确认当前版本/身份和30轮基线，再依计划做关搜索候选回归。全部前置完成后创建**新的**两小时截止，三侧一致，最后启生产目标SN总闸，立即重发写明实际起止的设备回执。P1真机通过才单独启P2，不自动扩面或延长24小时。

## 7. 精确回滚

1. 若以后已开窗，先令生产`p003.search.canary.enabled=0`；候选`p003.search.enabled=0`、`tools=0`、截止=0；原子将Worker window.enabled=false。不能只停新派单却保留既有会话。
2. Worker下一秒结束候选房间；确认jobs=0后按stop→cgroup/sidecar清零→停Brain。设备退出重进后核baseline票据；当前APK实际操作待现场验。
3. 若撤签发补丁，从已核SHA的Brain R1只取`server/src/routes/device-session.ts`；新增policy/runtime在解除import后移出生产。仅删除本轮`.env.local`的`SEARCH_CANARY_HEALTH_FILE`键；若期间有其他变化先对撞，不整份覆盖env/数据库。
4. 确认无现役房间和3001活动连接后重启p003-voice，验证health、认证、首句合同及普通语音。复原文件后对照R1哈希。
5. Nginx只移除本轮候选location，验证其余内容与本次变更前相符，`nginx -t`通过才reload；期间有他人修改时禁止整份旧文件覆盖。现役Worker没有换产物，无需“回滚”它。
6. 保留候选账本和脱敏证据，不回灌生产人格/埋点数据。独立候选以后再次更新时必须先确认传输完成、字节数和SHA全相等，再进行stop/原子替换/start；不在运行产物上继续传输。

署名：codex（OpenAI）| 2026-10-21 北京时间

## 后续：Worker后台灰度Tab（18:40）

已增加真实状态/版本/问题/手动待测设备界面，正式窗口仍关闭。候选Brain实际源版本精确核对为f5f1d1e1，c665e941是生产签发路径增量。部署、测试与独立R2回滚见 [后台验收记录](CANARY_ADMIN_ACCEPTANCE_20261021.md)。

## R3状态更新（20:27）

用户确认v353及完整SN，并授权明日全天体验、其他设备做对照。已开启单机P1，固定截止10月22日23:59 CST；此前未开窗/两小时限制为历史状态。详见 [R3完整记录](R3_FULL_DAY_CANARY_20261021.md)。
