# P003 R17 真人反馈修复、全量历史回归与训练实施计划

> **2026-10-26 18:28发布补充**：用户明确“那就部署吧，我安排明天继续测试”，授权原两台P1体验候选先发布。Task1/2代码与后台preview已部署；本轮6房RTC、真实ASR变体续讲同task、取消、聊天后空闲补播、短窗断连及回滚留证。Task1完整负例/停止关键词实听、Task2真人新签发与接单关联仍待明天；Task3–6未完成，Task7完整性能/训练验收未完成，不改为全通过。原一周截止/P2关闭/真实账本/额度保持。见项目 `R17_DEPLOYMENT_ACCEPTANCE_20261026.md`，此前“尚未部署”是历史检查点。

> **执行方式：** 使用 executing-plans 逐任务执行；代码由codex本人编写，不委派。用户已授权持续优化，并于2026-10-26要求将全量历史训练/回归纳入下一版，无需重复请求同范围实施许可。

**Goal:** 修复R16p真实输入与跨房任务归属缺口，建立全量可取得历史的数据集、回归台账和离线路由训练候选，保持普通聊天延迟门。

**Architecture:** 线上保守快路继续处理聊天/控制，新增证据异步记录；离线读取受限快照，按可信设备/会话/时序分组回放，模型只在离线/影子验证。最终候选以同一源码和二进制完成Linux、RTC、性能、到期和回滚验收后发布。

**Tech Stack:** 既有TypeScript/Hono/SQLite Brain、Rust Worker及共享路由预览；Python标准库负责私有快照/数据处理；可训练基线使用独立环境中的scikit-learn，导出纯数据模型，不给Worker增加Python依赖。

**Spec:** [真实对话回归与训练设计](../specs/2026-10-26-p003-history-training-design.md)；[真人日志核验](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/P003_SEARCH_R16P_FEEDBACK_REVIEW_20261026.md)。

## Global Constraints

- 沿用Brain `codex/p003-brain-search-tools-20261021` 和Worker `codex/p003-worker-tool-lifecycle-20261021`，不新分支、不合main。
- 普通聊天不等待搜索、不新增前置云端分类请求，不为搜索分片增加全局判停等待。
- 保留首句合同、完整SN认证、非目标设备派单、取消/期限/跨设备隔离；P2保持关闭。
- 真人窗口截止2026-11-02 11:19 CST，S04/S38范围不扩大；原额度与账本保留，不重放旧控制器。
- 原始正文、音频、凭据、可逆身份映射不入Git；数据文件700目录/600文件，工件公开仅摘要和合成夹具。
- 不把模型输出落库、server completed或PCM发布当成用户实际听到。
- 正式性能每组30计划配对、≥20有效；median增量≤100ms、经验P90≤300ms，无新增缺正文；未通过不声明新版全面验收。

路径缩写：`B=2-Projects/P003GameDemo20260513/apps/server`（Brain树），`W=2-Projects/realtime-voice-agent/rust-worker`（Worker树）。下文新文件均明确标“新增”，不存在是计划状态，不代表已实现。

## Task 1：明确搜索续讲的有限识别容错

**Files:** 修改 `W/src/search_policy.rs`、`W/src/search_policy_cases.rs`、`W/src/search_routing.rs`。

**接口：** 继续使用`intent(&str)->Option<Intent>`、`RoutingSession::route(...) -> Decision`，不改变设备或Brain恢复协议。

- [x] 用新增12个续讲正例、18个保护反例加载原代码：16test通过/1失败，原代码对带赘字的明确续讲返回None。
- [x] 整句匹配有限礼貌前缀、宾语前置、一字赘余/一次重复；不做全局拼音替换。
- [x] 新room、配置变化、澄清状态、后台宽泛chat规则及无配置fallback路径回归。
- [x] Linux `cargo test --offline --locked` 440项；preview测试26项；`bash scripts/build-local.sh` release/ABI通过。binary `7000e190f882d0bc13fd4b9c8f1c91485736fdc6c547d5f181ccaa7c9b01766f`。
- [ ] 在独立合成身份真实RTC复核：发起任务→停止→退出→重连→含识别前缀的续讲，核原task/revision/cursor、首声、收音、字幕；取消/过期/其他SN反例同批执行。
- [ ] 与本轮脱敏证据提交Worker分支，push并核远端SHA；发布仍等待Task 7全部前置门。

## Task 2：派单原因和实际接单证据

**Files:** 修改 `B/src/search-canary-policy.ts`、`B/src/search-canary-runtime.ts`、`B/src/routes/device-session.ts`、`B/scripts/search-canary-policy.test.ts`、`B/scripts/device-session.test.ts`；新增`B/scripts/search-canary-runtime.test.ts`。

**接口：** 新增纯函数`explainSearchCanarySelection(i:CanaryInput): {agent:string;reason:CanaryReason}`，`CanaryReason`为`selected|disabled|invalid_scope|not_target|wrong_agent|contract_incompatible|window_invalid|lease_invalid`。原`selectSearchCanaryAgent`调用同一函数返回agent。runtime另给lease剩余毫秒和generation；签发成功日志记录`selected_agent`、`canary_reason`、`lease_remaining_ms`，不得输出token或用户正文。

- [ ] 添加以下固定边界测试，运行后确认新接口尚不存在或断言失败：

```ts
assert.deepEqual(explainSearchCanarySelection(input),
  {agent:input.canaryAgent,reason:'selected'});
assert.deepEqual(explainSearchCanarySelection({...input,leaseUntilMs:input.nowMs}),
  {agent:input.baselineAgent,reason:'lease_invalid'});
assert.equal(explainSearchCanarySelection({...input,enabled:false}).reason,'disabled');
assert.equal(selectSearchCanaryAgent({...input,leaseUntilMs:input.nowMs}),input.baselineAgent);
```

- [ ] 将现有判定条件转换为有限reason，缺健康租约优先于未知能力诊断，agent选择保持不变，不新增读文件/网络等待。保留15000ms租约、6000ms最短剩余窗、168h上限及2台allowlist约束。
- [ ] runtime测试使用临时健康文件、固定时钟和独立config库，覆盖满2槽→租约0→释放→刷新恢复，以及无效JSON/过期/时钟未来；不拿缓存推断实际Worker在线。
- [ ] session测试核JWT、响应expected_agent和成功日志selected_agent三者相同；回普通链路时reason明确；非目标首句合同逐字段相同；敏感扫描不含JWT。
- [ ] 日志关联签发room→Worker接单room；分离“签发到了候选”和“候选确实接单”。运行既有canary policy/process/isolation和device-session测试后提交。

不在本任务提高并发或改满载时排队策略。候选忙时保普通聊天，显示“本次搜索暂不可用”的设计须有独立能力协议，不能让普通LLM凭空承诺已经搜索。

## Task 3：全量只读快照、脱敏及归属台账

**Files（新增）:** `B/scripts/history-regression/export_history.py`、`corpus.py`、`test_corpus.py`、`README.md`（同目录）；`B/scripts/history-regression/schema.json`。

**接口：**

```python
# export_history.py：CLI，源库只读，私有目录必须不在Git树内且不存在。
# --main-dir --canary-dir --cutoff-ms --output-dir
# 产物 raw-main.jsonl/raw-canary.jsonl/identity-map.json/manifest.json
# corpus.py：build_corpus(records, identities, cutoff_ms) -> (rows, manifest)
# 每行HistoryRecord字段遵守spec；不确定会话必须room_key=None。
```

- [ ] `test_corpus.py`用标准库unittest建立合成SQLite：2设备、一个灰度别名、同ID复制、同文本不同轮、1个孤立账号、1条ts晚于cutoff、1条session_id=rtc。断言如下：

```python
self.assertEqual(manifest['source_rows'], manifest['included'] +
    manifest['duplicates'] + manifest['unresolved_identity'] + manifest['excluded'])
self.assertIsNone(next(x for x in rows if x['source_row_id']=='legacy')['room_key'])
self.assertEqual(next(x for x in rows if x['source_row_id']=='legacy')['commit_state'],'unknown')
self.assertNotEqual(rows_by_id['repeat-a']['record_id'],rows_by_id['repeat-b']['record_id'])
```

- [ ] 用`sqlite3.connect('file:...?...mode=ro',uri=True)`和只读事务固定各库视图；固定统一cutoff、记录每库捕获时间及来源hash。账号映射前后核同；同ID同字段复制可合并来源，冲突保留collision，不按文本直接删除真实重复。
- [ ] 去重前后分别输出按设备/日期/角色/来源统计。隐私字段用私有HMAC映射和实体占位；phone/email/credential正反例测试，原正文只留受限原件。复制源库只作私有快照，不写生产数据库。
- [ ] 执行`python3 -m unittest discover -s scripts/history-regression -p 'test_*.py'`；私有试导出核源库未修改、文件权限、计数闭合和哈希；再导出全部16台当前映射＋可证历史别名。其余516条单列，不无证归入设备。
- [ ] 全量导出后再公布实际去重消息/可回放轮数、最早最晚时间、来源缺口；提交脚本/合成测试/脱敏manifest，**不提交数据JSONL或身份map**。

## Task 4：新增会话与播放证据，避免继续制造不可用语料

**Files:** 修改 `B/src/routes/custom-llm.ts`、`B/src/conversation-store.ts`、`W/src/pipeline.rs`、`W/src/llm.rs`、`W/src/playout.rs`；新增 `B/src/conversation-evidence.ts`、`B/scripts/conversation-evidence.test.ts`；Worker新增`src/conversation_evidence.rs`及其模块测试。

**接口：** 新的旁路证据表`conversation_event`存`event_id,account_id,room_id,turn_id,response_id,kind,at_ms,source`，kind限定`generated|committed|published|aborted|client_received`；旧conversation字段和外部接口保持兼容。Worker随已经鉴权的Brain请求携带有界turn/response标识；服务端以认证账号和room校验，不接受正文中自报SN。client_received只接受真正客户端回执，不从Worker published推导。

- [ ] 写失效测试：same event_id幂等；错account/room拒绝；generated不能自动变published；没有回执保持unknown；旧无字段记录仍可读。
- [ ] 普通推理请求只生成标识，异步有界队列批写旁表；最多1024事件、50ms或64条flush，溢出计数/告警，不阻塞语音。来源不明不回填旧记录；关房时尽力flush，未落库须计缺失。
- [ ] `custom-llm`保存实际room/response关联，不再把新的rtc记录都当一个可重建session；保留旧兼容字段供管理后台，消费方通过旁表读取可信会话。
- [ ] 故障注入慢磁盘/队列满/DB不可写：聊天不中断，事件损失可见。常态事件完整率100%，溢出时不得报告语料完整。新增可观测性开关关闭后恢复旧路径。
- [ ] Linux/实际SSE检查新字段不影响流式顺序、身份或首句合同；与Worker同任务完成一次取消、插话、0帧中断链路后提交两分支。

## Task 5：全量回归执行器与真实反馈序列

**Files（新增）:** `B/scripts/history-regression/replay.py`、`evaluate.py`、`test_replay.py`；`W/tools/search-route-preview/src/replay.rs`。修改该工具`src/main.rs`接显式`--replay-jsonl`，默认后台预览JSON协议不变。修复涉及`W/src/search_tasks.rs`、`search_dialogue.rs`、`stt_volc.rs`、`search_policy_cases.rs`；答案证据涉及`B/src/tools/search-executor.ts`、`cctv-news.ts`及对应测试。

**接口：** 每条重放输入`{record_id,room_key,event,text,at_ms}`，event为start/input/end；同进程按可信room保持RoutingSession，reset仅在真实start/end；单行≤16KiB、每条128字符仍按现合同处理超限，不能静默截断。输出`{record_id,action,rule_id,elapsed_us,status,reason}`；无可靠room时逐条text_only，不伪造连续状态。Python执行器对每条源record保留一条最终台账，异常退出可按record_id恢复。

- [ ] 合成序列测试复现09、10旧task混淆、08错误对象、11实际分片间隔、05正文播放中插话、取消/过期/跨SN、16执行成功但确认0帧。先断言当前失败，再按根因实现。
- [ ] 回归测试运行真实同源路由器；单个可信会话超过64条仍保状态，不因预览原64条限制隐式reset。相同文本不同turn不能去重成一次；热配置变化按实际版本事件重放。
- [ ] 源task/revision绑定、mock搜索来源和冻结时间；完整普通聊天/个人话题可即时退出查询上下文。对同音词不确定时澄清，不自动把社交/饮品内容替换成卫星/改查。单音节无ASR单独计识别缺口。
- [ ] 语义全量批次冻结输入与成本预估，隔离环境串行/有界执行，失败不追加凑绿。断点文件记录完成ID、失败原因、请求token数、模型/提示/源码hash；无历史来源不作历史事实正确性评分。
- [ ] 输出100%源记录覆盖台账，以及分别的路由/语义/不可重建比例。只有全部合格输入结束才标“全量可回放语义回归完成”；RTC风险集另报，不用合成音频冒充历史真人音频。

## Task 6：离线路由模型训练候选及盲测

**Files（新增）:** `B/scripts/history-regression/split.py`、`train_router.py`、`test_split.py`、`router-model.schema.json`；模型权重存私有版本工件，不提交原始样本。

**接口：** `split_groups(rows,seed)->mapping`输出train/validation/heldout；训练输入为已人工校核route_label与该轮可见上下文，输出`model.json`、`evaluation.json`、`model-card.md`。模型JSON包含词表、IDF、系数、类别、阈值、训练manifest SHA和允许上下文，不含训练原文或可逆身份。无签名/摘要校验、类别不齐或指标不达门不生成promotable=true。

- [ ] 测试设备/会话/近重复簇不跨集，训练词表不看到heldout专有词；空类别、组数不足、未来信息泄露均失败。固定seed和划分manifest，不为分数重抽盲测。
- [ ] 在隔离Python环境核依赖后训练`TfidfVectorizer(analyzer='char',ngram_range=(1,3))`＋线性分类基线；只训练人工确认样本，严重不平衡单列，不用“全是chat”的总准确率冒成绩。
- [ ] validation确定阈值，heldout仅最终比较一次；输出每类precision/recall、混淆矩阵、错误ID、误触发率及区间。与同一数据上的既有规则基线比较，spec的macro-F1/误触发/控制召回门均满足才标候选可晋级。
- [ ] 权重导出前后用固定输入核分数误差≤1e-6；训练报告明确这只训练路由分类器，未微调现有DeepSeek聊天模型。用户人格/私有经历不跨账号注入。
- [ ] 若结果不达标，保留失败模型卡和数据、继续规则路径，不将模型强行部署。若通过，先以离线重放/隔离影子验证本地推理P95≤1ms；真正接入Worker需新增签名模型加载和一键回退门，不能在本任务顺手切线上模型。

## Task 7：同版验收、回滚及交付

**Files:** 更新两个项目`docs/search-tools-20261021/`的验收、部署manifest、回滚、MEMORY、README；延迟验收沿用仓内`voice-agent-ops/references/search-latency-acceptance.md`。新增同日期可转发测试回执，不覆盖旧失败报告。

- [ ] 先核现场版本/资源/窗口/真实额度，建立新的逐文件回滚记录；独立合成SN、独立数据、独立HTTPS和退出timer。验证码/凭据不输出。
- [ ] 冻结最终两分支SHA、二进制SHA、配置及模型SHA，跑全部单测、Linux release/ABI、隔离、路由负例、真实RTC和三组性能。构建中版本变化则明确新批次，不能拼接不同版成功样本。
- [ ] 正常聊天优先；每组预定30配对，少于20有效或超过median/P90门均不通过。附和必须有实际ASR，正文插话必须已经有PCM；缺样本不能写“都没问题”。
- [ ] 回滚代码/模型指针往返，核真实数据/额度未变；短窗到期核服务端关房与客户端断连、随后新会话回现役。JWT秒级floor和毫秒期限差异按合同核，不能把157ms取整误判为过期；依赖步骤前一步失败则不启动下一步控制器。
- [ ] 门通过后按当前授权只更新候选、保留真实窗口最新期限；现场有真人会话时服务端自行协调空闲部署，不把“选时段”推回用户。
- [ ] 回执列本轮实际部署、通过/失败/待验收、重点09/10/08/11和非天气话术；端侧补录16退出trace和05真正正文插话。送Air Downloads，回读SHA。技术记录及代码commit+push两原分支并核远端SHA。

## 当前完成范围

截至16:24：反馈/日志核验和数据规模盘点完成；Task1代码及Linux回归/构建完成。Task2代码及本地5组/Linux124项/tsc已完成，尚未部署；Task3–7未实施完成；没有训练权重、没有全量模型回放、没有把本轮补丁部署真人。原goal仍继续，不以规划文档替代后续实现和验收。

署名：codex（OpenAI）| 2026-10-26 16:24（北京时间）

17:37 Task2检查点：policy/runtime/main/session四个源码及四组相关测试已修改；新增runtime测试覆盖缓存刷新、满载租约、过期、旧字段、坏JSON、未来观测时间；session测试核签发/JWT/日志同agent及回落原因、首句合同与敏感扫描。Linux124/124及tsc通过。实际接单关联需后续部署后的现场日志，历史缺证仍保持未核实。
