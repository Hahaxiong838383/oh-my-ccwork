> **2026-10-27 18:07:01 R20已部署原两台P2，待真人复验。** 修作品名误拒、追问跳题、继续搜/拆句/改茶、来源提示及新闻空列表；Brain源码d35086e7、Worker源码bdfb1402，运行d07024f1…5c6b1。Linux159/tsc、448/preview29通过，7题真实API有来源；跨房同task恢复两句+12.09秒合成PCM，改查旧task取消/新task完成。原11月2日11:19截止、其他设备P1不变，主服务未重启；新R1及最终产物回滚往返完成，验证环境已关闭。四对普通聊天差+100/-300/+651/0ms，正式性能未过；TTS DNS约5秒、一次数字引用拒答、备用404仍未收口。完整字幕需审到结尾，投机LLM落库不能当实播；合成收音不代表真人听到，未做全量历史训练。
> [R20技术验收](R20_ACCEPTANCE_20261027.md) · [脱敏证据](R20_EVIDENCE_20261027.json)。**下列旧版本段落均为各自时间的快照，接手必须重核现场。**

> **2026-10-27 12:38:30 R19已部署原两台P2，待真机验收。** 03800006／00100004，原11月2日11:19截止；其他设备保持R18全量P1。运行Brain源码8a839afc（executor c2f73a7e…d514），Worker二进制未改。Linux153/tsc、七类真实API、有限Fetch成功专项、取消持久账本与跨房同task两句续播证据完成；4对普通聊天未见回退，不替代正式P95。两次取消探针断言失败单列，未将exit1改成通过。新R1与域名/元数据回滚记录齐备，独立验证关闭，未合main。
> [技术验收](R19_STUDENT_ACCEPTANCE_20261027.md) · [脱敏证据](R19_STUDENT_ACCEPTANCE_20261027.json) · [回滚](R19_ROLLBACK_20261027.md) · [真人回执](P003_SEARCH_R19_DEVICE_TEST_RECEIPT_20261027.md) · [Air哈希](R19_AIR_TRANSFER_20261027.json)。**以下“未发布R19”等均是各自时间的历史快照；下一轮仍须读实时现场。**

> **2026-10-27 11:40：R19学生兴趣场景仍在自检，未发布。** 已完成[学生话题调研与话术](STUDENT_INTEREST_SCENARIOS_20261027.md)和已定位的准入/来源/表达误拒修复。最终Linux147项通过；冻结源7题6题有效，游戏更新仍失败；新版RTC和回滚往返未完成，验证环境已关。现役仍是下面的R18，范围/截止未变。[本轮技术检查点](R19_STUDENT_CHECKPOINT_20261027.md)

> **2026-10-27 09:53 R18已部署：P1全量内测、P2原两台，待真机验收。** P1实际09:43:17开，总闸all_registered，16台有效设备、未来新增自动纳入；后台可单机排除，主设备身份/人格/历史路径不改，新搜索数据独立。P2实际09:45:58开，仅03800006/00100004，原11月2日11:19截止不变，届时回P1。后台两页已真实WebKit核验。后端来源Brain0b946fda、Worker8d873821，运行d6f63a3a…606；Linux Brain132/Worker444/preview27、固定路由24通过。取消空格修复有task cancelled＋合成接收证据；到期0.82s关房/1.35s删房、客户端断开。P2真实上游有Fetch200，RTC那次Fetch失败回退摘要，长复合句仍有ASR分段问题；P2不全量。正式延迟统计与真人实听未验收，旧失败保留；未做全量历史训练。独立验证已停，未合main；回滚不恢复整库/旧JWT或旧期限。
> [部署/测试](R18_DEPLOYMENT_ACCEPTANCE_20261027.md) · [新R1回滚](R18_ROLLBACK_20261027.md) · [可转发回执](P003_SEARCH_R18_DEVICE_TEST_RECEIPT_20261027.md) · [脱敏证据](R18_DEPLOYMENT_EVIDENCE_20261027.json)。**以下R17“两台P1/P2关”等内容均为当时历史；接手重核现场。**

> **2026-10-26 18:28:01 R17已部署并恢复原两台P1，待真机验收。** 用户本轮明确部署、明天继续测试；截止仍11月2日11:19，P2关、额度/真实数据不变。Brain来源cd0df630、Worker来源136971a6，运行binary7000e190…1766f；候选13源码、共享仅3个派单审计文件，后台preview也同版发布。Linux Brain124/tsc、Worker440＋preview26；当前产物6房间RTC及短窗到期断连有证据，跨房赘字续讲关联同task/游标，合成收音不当真人通过。正式延迟仍未验收、备用InvalidSubscription、全量历史训练/回归仍未完成。真实后台18:30核P1健康/租约/范围/版本正确，原主Worker未重启。部署脚本错误健康端口造成共享入口回滚和额外重启，已修正并如实保留；不能说本轮零失败。独立验证已关闭，保留LATENCY_STOP，不恢复旧控制器。
> [部署/测试证据](R17_DEPLOYMENT_ACCEPTANCE_20261026.md) · [R1回滚](R17_ROLLBACK_20261026.md) · [明日真人回执](P003_SEARCH_R17_DEVICE_TEST_RECEIPT_20261026.md) · [Air哈希回执](R17_AIR_TRANSFER_20261026.json)。**下列R16p现役/未部署R17等段落均为各自当时历史，不再是当前结论；接手仍须重核现场。**

> **2026-10-26 R16p真人首批反馈已核验，未完全解决。** 09续讲ASR多前缀走聊天；10一次新查询进普通链路后恢复更早task，不能当新查询恢复成功。08/11有识别/分片变形，16端侧ACK成功但确认音0帧。R17续讲容错Linux440＋preview26/release/ABI通过，尚未发布/未RTC。主库16当前设备账号26,292条消息、灰度1,924条待去重，用户要求全量历史训练/回归纳入下一版；尚未全量导出/训练/回放，旧rtc和投机生成不能当实播金标。16:37仅停独立验证服务/闸、合成房间0并恢复合成账号，真人PID/窗口未变；仍R16p、原两台P1至11月2日11:19/P2关。下一版先补派单证据与真实输入回归，普通聊天延迟优先。[本轮证据、修复及规划](P003_SEARCH_R16P_FEEDBACK_REVIEW_20261026.md)

<!-- R16_CURRENT_START -->
> 2026-10-26 11:19原会话13依用户“先开窗一周”新指令开放原两台P1，P2关。截止改为**2026-11-02 11:19北京时间**（1793589540000），旧11月1日23:59已被覆盖。当前运行仍R16p，**性能未验收通过、待真机验收**。用户已明确整周无需另选受控时段，内部协调由服务端负责；R17仅在独立验证副本继续开发，尚未发布到真人链路。保留LATENCY_STOP，禁止恢复旧控制器、旧期限、验收账本或未经协调部署。

代码锚：Brain `b6ed0f46`，Worker `8cf6a53a`，运行binary `c052c798…55a9`。Brain101、Linux Rust433+preview23及构建/ABI通过；26项合成场景、固定20题来源核验、最终产物回滚往返、短窗实际断连和隔离验证已完成，证据边界分别记录。真实账本11:09已恢复，原数据/额度保留；开窗前今日S04=66/S38=91，余额34/9，不代表未来实时余额。

性能正式计划120房间在用户开窗协调下安全停于48房间：普通聊天24尝试配对/22有效，中位增量+0.045ms、经验P90+549.68ms，超过300ms门槛；搜索/续讲正式组未执行。下列“关闭/旧截止/验收库运行”全部为历史。[窗口回执](P003_SEARCH_WINDOW_RECEIPT_20261026_SESSION13.md) · [功能证据](R16_FUNCTIONAL_EVIDENCE_20261026.json) · [短窗到期证据](R16_EXPIRY_EVIDENCE_20261026.json) · [回滚](R16_ROLLBACK_20261026.md)。接手始终核实时现场。

当前技术结论：[R16阶段验收](R16_ACCEPTANCE_20261026.md) · [完整真人用例](P003_SEARCH_R16_DEVICE_TEST_CASES_20261026.md) · [R17离线修复（未部署）](R17_OFFLINE_STREAMING_FIX_20261026.md) · [Air哈希回读](R16_DEVICE_CASES_AIR_TRANSFER_20261026.json)。

最新R17：独立Linux112项/类型检查通过；真实SSE10配对仅供分层诊断，不能代替RTC门槛。发现火山备用路InvalidSubscription，标准同系模型ModelNotOpen；新增脱敏告警/健康状态和单路重复错误计数修复，**未发布、双路兜底未恢复**。[诊断及后续](R17_UPSTREAM_DIAGNOSIS_20261026.md)。

**归档交接（2026-10-26 12:36北京时间）**：用户安排真人测试，本轮仅更新项目记忆、复盘与仓内skill；沿用R16p及一周回执，重点复核09/10跨会话续讲，R17未发布、性能门及真人体验仍未通过。以12:24:24只读证据为最新已核快照，不将其当永久状态。[复盘与接续事项](RETROSPECTIVE_R16_R17_20261026.md) · [一周真人回执](P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_20261026.md)。
**R17独立RTC接续（2026-10-26 13:15北京时间）**：第二套固定合成身份已实现，Brain115、Worker437＋preview23、Python17检查通过；搜索URL漏放行已修。实际查询1次有来源并completed，但短附和无ASR；随后1次答复校验invalid_answer，附和未发出，剩余8项未执行。验证服务及其闸已停、合成房间0；真人R16p/原两台一周P1窗口保持，完整性能及实听未验收。源码Brain eb6ac4e1、Worker 8f76a483；运行部署与源码提交分开。[本轮复盘/回滚/下一步](R17_ISOLATED_RTC_CHECKPOINT_20261026.md) · [脱敏证据](R17_ISOLATED_RTC_EVIDENCE_20261026.json)。
**R17诊断接续（2026-10-26 13:50北京时间）**：新增分阶段脱敏答案校验日志，相关43/43、Linux119/119及tsc通过，仅隔离验证。剩余8项RTC执行5项：5任务answered/completed，只有两次“对”具备ASR＋专用续播证据；“嗯嗯/哦”仍缺转写。第五项探针native退出-6，余3项未执行；原答案失败未复现，不称已修。判停参数对照无改善，未改线上。隔离服务已停且采样入口撤回；真人仍R16p，原两台一周P1保持，S04观察到新会话。性能/实听仍待验收。[诊断复盘与回滚](R17_VALIDATION_ASR_CHECKPOINT_20261026.md) · [脱敏证据](R17_VALIDATION_ASR_EVIDENCE_20261026.json)。
**R17退出与日期误拒接续（2026-10-26 15:04北京时间）**：探针退出最小复现118次首失败；限定一次性进程的受控退出固定300次正常，最终Linux6项通过。补余3项RTC有答案，case5澄清正确，“哦/嗯嗯”仍缺ASR。日期误拒已用同捕获重放修复，相关47＋Linux123/tsc通过；2条RTC任务完成，首条探针误用列表退出1、次条按ID取证及9.11秒合成收音通过，不混写全过。真人仍R16p/原两台一周P1，R17未发布；S38最新自报361，14:58两台各91/100。上一版没有全量历史训练或全量历史回归。[复盘/回滚](R17_EXIT_DATE_CHECKPOINT_20261026.md) · [证据](R17_EXIT_DATE_EVIDENCE_20261026.json)。
<!-- R16_CURRENT_END -->

> 最新R15（2026-10-24）：[执行与验收](R15_ACCEPTANCE_20261024.md) · [测试证据](R15_TEST_RESULTS_20261024.json) · [延迟全量](R15_LATENCY_EVIDENCE_20261024.json) · [回滚](R15_ROLLBACK_20261024.md) · [未开窗回执](P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_20261024.md)。**未完全解决、设备派单关闭、待真机验收。** 现役未覆盖/重启；原两SN、P2关、10月24日23:59截止不变。现场快照不代表未来状态，接手重新核实。

> 最新 R14（2026-10-24）：[联合修复与验收](R14_ACCEPTANCE_20261024.md) · [测试证据](R14_TEST_RESULTS_20261024.json) · [回滚](R14_ROLLBACK_20261024.md) · [待开窗真人用例](P003_SEARCH_R14_DEVICE_TEST_CASES_20261024.md)。核心修复已实施，普通聊天延迟门未过，三侧灰度关闭，待真机验收；下列R13及更早为历史。

> 最新（10月23日晚）：[R13用例5/10深度排查](P003_SEARCH_R13_FEEDBACK2_ANALYSIS_AND_REPAIR_PLAN_20261023.md) · [R14实施规划](../../../../docs/superpowers/plans/2026-10-23-p003-search-r14-dialogue-resume.md)。两项未修；当前R13，调查规划不等于部署。

> 最新反馈复盘：[R12真机反馈对照R13](P003_SEARCH_R12_FEEDBACK_R13_REVIEW_20261023.md) · [证据](R12_FEEDBACK_R13_REVIEW_EVIDENCE_20261023.json)。同会话续讲通过，退出后主动续讲仍未实现；当前R13复现，下一步方案尚未实施。本轮仅复盘和补测，未修改部署或开窗。

> 最新R13：[2026-10-23 16:09:02衔接音部署/验收](R13_ACCEPTANCE_20261023.md) · [测试证据](R13_TEST_RESULTS_20261023.json) · [真人回执](P003_SEARCH_R13_RECEIPTS_AND_DEVICE_TEST_20261023.md) · [回滚](R13_ROLLBACK_20261023.md)。原两台P1/10月24日23:59截止不变，待真机验收；提示更快，TTS长尾/安卓退出未解。下列R12及更早为历史，接手重核现场。

> 2026-10-23复盘与真人验收接续：[经验教训](RETROSPECTIVE_R12_20261023.md) · [项目记忆](MEMORY.md) · [知识核验](R12_KNOWLEDGE_VERIFICATION_20261023.json)。用户安排真人测试；本次仅归档，不改线上。

> R12历史入口：2026-10-23 [R12反馈/延迟验收](R12_ACCEPTANCE_20261023.md)、[测试证据](R12_TEST_RESULTS_20261023.json)、[可转发回执](P003_SEARCH_R12_FEEDBACK_AND_DEVICE_TEST_20261023.md)、[回滚](R12_ROLLBACK_20261023.json)、[Air传输](R12_AIR_TRANSFER_20261023.json)。14:18:56恢复原两台P1、10/24 23:59截止；待真机验收，安卓自动退出未解决。普通聊天延迟优先；8样本R11→R12中位1.82→1.40秒不等于长期P95或现役严格A/B。接手重核现场。

> R11历史入口：2026-10-22 [R11完整自测验收](R11_ACCEPTANCE_20261022.md)、[24项结果与证据](R11_TEST_RESULTS_20261022.json)、[可转发测试文档](P003_SEARCH_R11_SELF_TEST_AND_DEVICE_CASES_20261022.md)、[Air交付](R11_AIR_TRANSFER_20261022.json)。24/24合成RTC通过，待真机验收；原两台P1、10/24 23:59截止、P2关闭。历史快照不代表当前状态。

> R10历史入口：2026-10-22 [R10百度天气/部署/回滚](R10_ACCEPTANCE_20261022.md)、[24项混合真机用例](P003_SEARCH_R10_MIXED_DEVICE_TEST_CASES_20261022.md)、[测试证据](R10_TEST_RESULTS_20261022.json)、[央视REA评估](CCTV_NEWS_REA_ASSESSMENT_20261022.md)、[Air交付](R10_AIR_TRANSFER_20261022.json)。18:59:57百度天气对原两台P1生效，截止仍10/24 23:59，P2关。待真机验收；近期新闻资料不足、后置查询后旧问题补答和科普口语质量未收口。以下R9及更早均为历史，接手重核现场。

> R9历史入口：2026-10-22 [R9延窗/部署/回滚](R9_ACCEPTANCE_20261022.md)、[新测试回执](P003_SEARCH_CANARY_48H_TEST_RECEIPT_20261022.md)、[对话与任务复核](R9_DIALOGUE_RETEST_20261022.md)、[百度天气REA扩城研究](BAIDU_WEATHER_REA_FEASIBILITY_20261022.md)、[Air交付](R9_AIR_TRANSFER_20261022.json)。17:35:32延窗生效，原两台P1截止改为10月24日23:59，P2关；百度未接入，待真机验收。以下R8及更早截止均为历史，接手重核线上。

> R8历史入口：2026-10-22 [R8设备IP城市定位验收](R8_ACCEPTANCE_20261022.md)、[11项真机用例](P003_SEARCH_IP_LOCATION_DEVICE_TEST_20261022.md)、[IP网站REA分析](IP_LOCATION_REA_ANALYSIS_20261022.md)、[实际规则](R8_ROUTING_PROFILE_20261022.json)和[Air交付](R8_AIR_TRANSFER_20261022.json)。17:09:32恢复原两台P1，固定23:59截止，P2关闭，待真机验收。接手重新核实时状态；R7为此前路由/天气实现记录。

# 小可后台搜索候选交付 · 2026-10-21

**历史归档：R4于北京时间2026-10-22 09:23:52加入00100004。** [R4技术与回滚](R4_TWO_DEVICE_CANARY_20261022.md) · [新增设备回执](P003_SEARCH_CANARY_00100004_RECEIPT_20261022.md)。后续变更以R13为准；历史R4版本与测试不能当当前状态。

- [接续记忆](MEMORY.md) · [实施经验](RETROSPECTIVE_R3_20261021.md)
- [R3实际部署、窗口与回滚](R3_FULL_DAY_CANARY_20261021.md)
- [明日17项实测用例](P003_SEARCH_TEST_CASES_20261022.md)

- [历史 R1 部署、测试、回滚与当时阻塞](CANARY_ACCEPTANCE_20261021.md)
- [可转发设备回执（R3已开P1，待真机）](P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_20261021.md)
- [历史 R1 机器可读结果](CANARY_TEST_RESULTS_20261021.json)

下列首版材料与R1—R7均为历史快照；本次有效交接以R13及项目MEMORY为准，历史测试JSON不覆盖后续结果。

1. [实施、验证与回滚记录](IMPLEMENTATION.md)
2. [双端协议与配置合同](PROTOCOL.md)
3. [下一步单机验收清单](ACCEPTANCE.md)
4. [机器可读测试结果](TEST_RESULTS.json)
5. [Worker构建源码与产物锚点](worker-build-manifest.json)
6. [后台桌面截图](evidence/search-admin-desktop.png) · [手机截图](evidence/search-admin-mobile.png)（均为本机隔离预览）
7. [指定 SN 灰度实施与实机验收规划](../../../../docs/superpowers/plans/2026-10-21-p003-sn-search-canary.md)：沿用 Brain/Worker 两分支；Codeg 历史快照入口分别为会话 24/25，原会话 13 保留。该文件保留实施前规划和R3授权修订，执行记录见R3。

冻结完整方案位于本分支`1-Inbox/P003-DeepSeek搜索与工具调用评估-20261021/`，方案提交8aa4ca2dae58269df93cafd5ab2086b5b6bc5d74。

大脑分支codex/p003-brain-search-tools-20261021；Worker分支codex/p003-worker-tool-lifecycle-20261021；均独立工作树。没有合并main，也没有修改Air原工作目录或其分支。

候选开发由codex亲写，未委派代码任务。实际真机音频、字幕、metrics与内容质量仍是发布门，勿将单测、构建、接口200当作上线批准。

署名：codex（OpenAI）| 2026-10-21 北京时间
