# v376 倾听 Worker 联调回执（2026-11-03）

**结论：Worker候选修复及隔离联调已完成，待主13发布和安卓真人复验。** 固定源码/构建提交为`70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`。按主13最终裁定支持可信唤醒后15秒内、单次、有限自然进入语句；完整口令及原控制握手保留。三个最终RTC场景通过，未将历史现场或真实Android标为已修复验收。39未部署、未改闸/名单/窗口。

## 历史事实与边界

附件SHA：`aac82635aee578d14664f9470abb322303a676733a8858c82056278874c32ddf`。时间为11/2 19:52–20:01 CST，早于21:56/22:00新发布，不使用新配置解释旧测试。

- trace `af4602f5-6491-45a3-9e5e-ee1cefb44af4` 唯一对应房后缀1793620643，设备末03800006；SN SHA `bfa324aa8d74878a183994dd71241ec5d00fd058c5a52d23bfd265089a2268f4`。钱包ASR、普通commit及附件已知答复的TTS元数据已交45，未输出其他用户正文。
- 历史及本轮只读核查同一倾听PID2222439，unit `p003-listening-worker.service`，启动11/2 18:03:10 CST；agent `p003-search-listening-20261030`。binary SHA `c2c8081581ae86c8155bbaf51af5eec34a05454bf8c3d8047fb74b326adcb4f5`，构建源 `b663e0e09d423ba282e21e242569774466fcfdb0`。其pipeline/job/listening_adapter/listening_voice四文件与本树起点980b6482逐字一致，不能归因于本树倾听修复未部署。
- 38历史authority证据：8次签票均rev6、voice control能力有效、正确agent/build；两次尝试grant分别到20:28:02及20:29:20。没有持久entry/lease记录并不证明从未发过失败HTTP。

| 历史输入 | Worker证据（CST） | 判定 |
|---|---|---|
| 第一尝试，房1793620682，trace `3c770bf4-2eb6-4bf6-8cc9-38ab3970b77e` | 19:58:13.199两字final仅唤醒词；13.242同SHA普通commit | 不是完整进入口令；原parse返回None。日志未直接打印意图reason，此原因由现役源码与脱敏输入核对得出 |
| 第二尝试，房1793620760，trace `172f1281-3387-4401-b697-de5456ed5534` | 19:59:22.628首句wake_only；32.609九字final；32.655同SHA普通commit | 九字表达不含呼名且不含“听”；非有限完整口令。距首句9.982秒，不能当“完整口令被丢弃” |
| 20点之后 | 附件客户端 `quiet_hours_absent/device_use_gate` | 有效夜间门禁；本轮未改时钟、GM、现场有人状态或门禁。没有伪造夜间真机验证 |

第二条final SHA：`f72a2cffbcf2647bf902ca1e5b848ca63fd2cdbd53f489fd0f1377d99244b483`。ASR/commit部分日志不含room，原证据标注`unbound_no_room`；必须结合PID、邻近job生命周期及38签票关联，不用过滤后的零行宣称没有输出。历史原声和完整Android原始日志未提供，不能确定TTS、端采集或ASR何处丢失/切分，不能归责端侧。

## 最终实现与验收

运行逻辑只改`listening_voice.rs`、`listening_adapter.rs`、`pipeline.rs`；另改纯规则测试与既有软件probe。

- 复用现有“小可”×1～3的wake_only规则，ordered→RTC交接与普通RTC final均走同一回声门，再建立控制识别窗口。窗口来自实际final，不来自partial，不产生成功播音或普通LLM回复。
- 单调时钟15秒（满15秒失效），同job/room/trace/epoch。一个未消费窗口只允许一次明确唤醒刷新；partial不刷新。下一实质final无论是不是模式请求都消费窗口；普通句立即进入原判停/聊天流程，不等待15秒。
- 只在能力、grant、Normal phase、voice_invitation和scene配置有效时提议进入。模式变化/关闭/暂停清理；新Adapter无继承。只产生原proposal，3秒proposal TTL与15秒识别窗口分开；Android继续唯一分配seq，enter/local_ready/completed及租约门不变。
- 自然句解析返回控制意图及真实尾随叙述，不伪造“小可”前缀写入普通chat、故事或记忆。反馈/退出依旧要求原完整呼名，唱后反馈仍需要前置静音边界。

有限自然词表：

| scene | 接受范围（必须在上述窗口内） |
|---|---|
| story | 先听我讲个故事／讲故事／讲一个故事；我给你／我要给你／我想给你 + 讲个故事／讲一个故事 |
| sharing | 先听我说一会儿；先听我分享一下；我想和你分享一件事；我给你分享一件事 |
| singing | 听我唱首歌；先听我唱歌；我给你／我要给你 + 唱首歌／唱一首歌 |

不是任意含“故事/唱歌”的子串匹配。保留引语、第三人称、否定、含义问题、歌词/台词说明、反问等负例；有风险的限定尾句保守拒绝。有限规则不能保证ASR切分、失标点或歌词场景零误触。**识别语义已按主13的`MAIN-LISTENING-FIX-DECISION.md`扩展，wire JSON三份字节未变，不能声称原识别语义完全不变。**

### 本次匹配最终源码的证据

- 本机纯Rust核心7项通过（包含15秒边界、9982ms、普通句消费、跨epoch及误触负例）；新增“我想给你讲…”先红后绿。Linux完整Cargo **611通过**（566+29+9+7），2个HTTP ignore另实际运行 **2通过**；测试feature隔离transport专项 **1通过**。不把旧517/536/545/605当新结果，不重复累计本机7项。
- Brain使用已提交`eeac0a68`的真实RTC fixture包，SHA `952e58ac01c278836ee7466f771cf0bc10469dbddb2bc0c344c4e22f7424848a`，65输入独立逐项与提交核对；后续38归档472606b0未改变这些源码。HTTP joint使用当前已提交Brain源码单独打包，33输入已核。
- 最终RTC测试binary SHA `1fda3c073fbc7a110186d36fabbeb45fe33838780eabd5fbfa9e85d114b6ea1a`，compile SHA=70d5f98a；不是生产二进制。独立agent `p003-listening-p0-v376-session39`、18739端口、新SQLite/合成身份。

真实部分为SFU/上行RTP及ordered PCM/ASR/Worker job→Orchestrator/Brain注册与config ACK、签票授权/TTS/客户端audio、transcription、metrics、control及Room API。Android是软件替身，输入为合成WAV，文本provider确定性替身；不是真人设备、唱功评价或模型质量验收。

| RTC用例 | 结果 |
|---|---|
| 修复前完整口令 | 通过；旧起点980测试二进制，仅作正向对照 |
| 修复前ordered唤醒+RTC剩余口令 | **失败保留**：proposal=0，进入超时；不是绿色测试 |
| 最终完整口令 | 通过；trace `p0-39-dbd3d108-5e5a-4939-96eb-9bc4d9b541ed` |
| 最终相同分段方式 | 通过；trace `p0-39-0be6d460-7307-4813-96a1-5af9348deabe` |
| 最终延迟自然请求（重复呼名WAV，ASR首final为单呼名） | 通过；trace `p0-39-a48449c0-b9e6-4767-b516-568a2da2430c`；两个真实ASR final相距 **12147.180ms**，覆盖超过现场9.982秒的等待；不是凭合成音频长度推算 |

旧split manifest未记录wake/tail WAV SHA，因此前后对照确认的是相同ASR分段形态，不宣称音频字节完全相同。自然测试的重复呼名WAV被ASR归为单次“小可”；重复呼名final由代码测试覆盖，不能把此RTC算作重复final验证。每组一次，不代表长稳。38已对固定70d5f98a三包逐事件独立复审，无新阻断。

三个最终房均逐事件核到enter proposal→state查询→enter→received→local_ready→completed、续讲静默、一次反馈含续讲标记、exit proposal→normal、普通聊天audio/字幕/metrics及Room API自动删房。每包日志为累计记录，必须按同轮trace/room/session归属，不把前房lease算给后房。

历史九字原文只在HK2内存中提取，交**与70d5f98a逐项核同的实际新parser**检查，结果`matched=true, scene=story`，原文SHA仍为f72a2c…；未导出正文。它证明规则覆盖现场输入，不证明历史房发生了新proposal。

原始证据索引、SHA、输入清单及断言见[验证记录](evidence/v376-worker-verification-20261103.json)。本轮全部隔离进程（含实际Worker2379825与启动器2379824、Brain2379812）已停止且/proc不存在；测试房由客户端Room API确认删除。最终只读核查普通/Search/倾听生产PID、binary及window SHA与开工时一致。

## 正式产物、增量发布与回滚（交主13）

正式release源70d5f98a，Cargo artifact **features=[] / test=false**，SHA **`27a72325f781e37d1114f91b58feb53bfd38de4b1e6ec2ca6453a7745bcd5e86`**。glibc≤2.39、GLIBCXX≤3.4.33门禁通过，HK2实际ldd无缺失；未将此二进制作为生产服务启动。

包位于本轮协调目录`39-evidence/release-package/`：正式binary、SOURCE_INPUTS、PROVENANCE、HK2依赖检查、五文件source.patch、原/新manifest、离线manifest准备工具、INSTALL_ROLLBACK及SHA256SUMS。没有.env、设备凭据或用户正文。现有原分支代码70d5f98a已push并ls-remote核同；后续文档归档HEAD与构建SHA分开记录。

发布仅两处：HK2倾听binary（只重启`p003-listening-worker.service`）；Brain现有`/opt/p003/listening-canary-20261030/listening-release.json`只改目标agent build_sha和evidence_ref，不重启Brain。准备前旧manifest SHA e64bd73e…已独立读取核同，新manifest SHA `608eeea328f129acaf7a46b78f1005a192a7c10db2fcbacb6470fbd5dcbd5765`。过渡期build不匹配应保持未ready；13发布前再次核active_sessions=0、原单038及保护状态。

精确回滚：本轮Git起点980b64821d88d76650a59480294d25a26839bbe4；现役源码b663e0e0，binary c2c808…，manifest e64bd73e…。13操作前在两主机分别备份原始字节/owner/mode；异常只恢复旧binary+旧manifest，再启动同倾听unit并核旧build/ACK。**不恢复或修改window、generation、env、名单、数据库，不重启普通/Search/Brain，不自动续窗**；旧expiry1793786311000保持。包附具体步骤，39未执行发布。

## 白天现场A01–A06（交13统一安排）

先确认正常使用门禁、单机授权未过期、v376包及正确SN；不给任何设备扩窗/换包。每例记录CST、room/session/trace、ASR final、proposal/enter/local_ready、音频及字幕结果；保留失败，不只看服务端closed。

| 编号 | 真人操作 | 验收标准 |
|---|---|---|
| A01 | 一口气“小可，先听我讲个故事。”紧接两句故事 | 真实final完整命中；proposal→enter→local_ready→completed；普通LLM/filler不插话，续讲不丢 |
| A02 | “小可”停顿后接“先听我讲个故事” | 发布候选后验15秒内成功、满15秒/换房不继承；加测约10秒后有限自然句及普通句消费，真人结果不能提前标通过 |
| A03 | 在倾听中叙述、问普通问题、引用歌词 | 无普通回复/硬件/搜索误触，无新反馈许可 |
| A04 | “小可，我讲完了，请说说你的看法。”后插话 | 一次短反馈，可打断，不续播旧输出，回到倾听 |
| A05 | “小可，结束倾听，恢复聊天。”再问普通问题 | exit完成，房不被语音退出关闭，普通聊天恢复，不补播旧音频 |
| A06 | 唱歌模式、唱后停顿+完整反馈口令；正常夜间无人策略另记 | 唱中歌词/静音不触发，反馈不杜撰音准；夜间无人继续遵守门禁，不通过改时钟/GM完成 |

署名：codex（OpenAI）| 2026-11-03


## 主13生产发布验收追加（2026-11-03 12:00 CST）

**主13已完成原单038范围发布及发布后健康核验；真实Android/真人实听仍待验收。** 上文保留为39交付时的隔离测试、发布计划与边界快照，本节更新部署状态，不把隔离替身证据升级为真机通过。39本轮仅核主13落盘证据、归档文档和标签，未访问或操作生产、未改源码、未重跑既有测试。

已完整读取并交叉核对主13的release-record、activate-worker、activate-brain、post-worker-check-1、post-brain-stable与SERVER_DEPLOYMENT；同时与发布前Worker/Brain快照比较。

- 11:55:48 CST启动倾听Worker PID **2386175**，正式源码 **70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d**；实际进程/文件二进制SHA均为 **27a72325f781e37d1114f91b58feb53bfd38de4b1e6ec2ca6453a7745bcd5e86**。
- 11:56:34.095 CST启用manifest，SHA **608eeea328f129acaf7a46b78f1005a192a7c10db2fcbacb6470fbd5dcbd5765**。12:00稳定检查ready/effective=true、config revision=applied ACK=6，沿用单038、原expiry1793786311000与generation。
- 发布完成后观察 **267.602秒**；新PID NRestarts=0，journal registered_worker=1、error=0、panic=0、received_job=0。没有新job，因此该窗口证明进程/登记与配置健康，不能证明上线后的真人语音链路已经验收，也不代表长期稳定性。
- Brain **185份源码**逐项SHA、admin及PM2状态与前快照完全一致；普通Worker PID1825469、Search PID2143116的PID/启动时间/二进制未变；window/env SHA及generation均未变。
- 除两处功能发布文件，主13同步更新Worker同目录`release.json`的 **build_sha、binary_sha256、bytes** 三字段，分别对应70d5f98a、27a723…、77997808字节。该发布元数据SHA由 **b616f758439d2a2e194bdbf7683615546bce86eb7b1b449afed06e9a3e26834f** 更新为 **5c8a65380c085cc428df365d3681a1bb84421c753f8077793855c53ab0a0a821**，已备份并纳入回滚，不能仅恢复二进制而留下新元数据。

实际备份：HK2 `/opt/p003-listening-canary-20261030/backups/v376-listening-20261103T033634Z`；Brain原manifest `/opt/p003/listening-canary-20261030/backups/v376-listening-20261103T033634Z/listening-release.json`。异常时仅恢复原Worker **binary+release.json** 与原Brain manifest，停止/启动倾听unit；保持当前window/env/generation/数据库，不回灌整库。旧源 **b663e0e09d423ba282e21e242569774466fcfdb0**，源码回滚标签 **rollback/p003-listening-pre-v376-20261103** 指向该提交，不用本次文档提交替代构建源。

主13最终交付原字节归档：[联调回执](v376-joint-handoff-20261103/P003_V376_JOINT_FIX_AND_TEST_RECEIPT_20261103.md)、[SERVER_DEPLOYMENT.json](v376-joint-handoff-20261103/SERVER_DEPLOYMENT.json)。其钱包包引用按原字节保留；配套钱包包由主13独立交安卓，不重复收入Worker仓。两文件复制后逐字节及SHA核同。详细证据来源SHA与比较结果附现有[验证JSON](evidence/v376-worker-verification-20261103.json)的`main13_production_deployment`节。

下一步仍是安卓钱包补丁集成/安装与真实snapshot对账、真人倾听L01–L06；本次不宣称已完成。共享记忆与Air交付由13负责。

署名：codex（OpenAI）| 2026-11-03
