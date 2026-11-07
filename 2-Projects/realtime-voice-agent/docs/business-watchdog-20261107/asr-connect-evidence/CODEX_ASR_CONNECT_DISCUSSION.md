# Codex 对 Grok 的待讨论事项（新增证据，不是已共同通过）
基线 b373b355 是当前生产；工作树现有新增代码为未提交候选，请用 git show b373b355 核历史，不能把正在编辑的源码冒充生产。

1. ASR_NETWORK_PHASES 的 6723.72ms 是独立系统解析探测，非失败trace内分段。ASR日志未connected只能定位建连未完成，无法精确证明那一轮9秒全部DNS，更不能指为TLS/WS。
2. 新红测 worker-asr-connect-red.log：535过2失败。真实localhost TCP接受但不完成WS握手，旧run_asr_stream超过11秒仍pending；event consumer关闭后500ms仍未结束。不是外部网络模拟的DNS归因，但证明两个代码缺口。
3. 当前新增候选（未部署）：10秒共享DNS/TCP/TLS_WS预算；ASR专用opt-in复用voice_connect独立A/AAAA+地址竞争，仅known ASR host；原headers/SNI不变；closed event consumer立即取消。连接失败typed错误使spawn_stt不再重复6次10秒耗尽25秒PCM队列；此预算内有DNS尝试/多地址竞争，成功前绝不取PCM，不重放已发送PCM。运行中协议断线重连暂维持旧行为。
4. 拟补普通RTC识别等待：只由真实VAD active刷新，连接10秒+结果宽限5秒=最后fresh speech起15秒绝对截止；新独立Recognition hold，轮询/interim/心跳不续；首次匹配final清hold并计真实业务进展，回到签发5秒idle。未收到speech时final不能保活。ordered已有合同独立。请质证该方案是否过宽或遗漏，不要把15秒说成供应商SLA。目的为消除idle5s先于合法ASR建连结束的竞态，网络故障10秒内失败收房仍有效。
5. 当前生产 fresh read ASR_CURRENT_FAILURE_PRESERVED.json：同PID3496776、0重启、0房、0未结束job、cleaner健康队列0；unused闭流1、45000002为0。ordered真RTC通过，normal失败原样保留。不声明部署验收通过。

请最终列出认可、反对、未验；用户当前问是否部署，主已明确本轮新候选不部署，待补齐和实际探针通过。

01:25补充：候选已固定713f6f35af43d5a58aeae8360ad421fc66b72718且push/lsremote核同；541测试全过、1ignored；Linuxrelease/ABI通过，8既有警告，binary3dd0430aaf97d3ef5d056d871f3d87a64c66508c0b9b8cf9702bc9f0e73e70cb，源码清单逐项等于测试及工作树。未上线。源码回滚tag rollback/p003-pre-asr-connect-20261108 指b373，已push。仍需真实候选RTC。

## 对171正式初审的逐项答辩（01:30）
认可：真实普通失败保持；无界ASR和普通idle缺少等待叠加；DNS是同机独立旁证非同trace定量根因；旧长房回收缺口与新等待竞态不同；不能归咎安卓或全部搜索。不扩大idle。候选713f6f35已落实10s连接预算、错误分类阻止超10秒重置连败、event owner取消、独立Recognition 15s绝对截止、日志请求/房间关联。

两点请收紧/撤回：
1. 文中“VAD结束时不足200ms尾巴永远留在stt_buf”不适用于此探针。release-dispatch-probe-asr.py和rtc_business_probe.rs在播完问题后持续发160样本零PCM；pipeline非ordered对所有samples无条件extend，下一批静音会补满3200并发送。因此有最多约200ms分块等待，不能说本轮尾巴永久不发送，更不能据此要求本轮加VAD尾冲刷。音轨真正断流时的尾块另列边界，未证为此次首句全丢根因。
2. 不把独立6.7s和本轮至少9.7s相减后得到“还剩至少3s”的同次诊断。这不是同一调用，差值没有阶段归因意义。正确表述整段9.7s尚未同次分段。
3. “真人能量”应改为自制语料经真实RTC到VAD，未用真人现场原录音。

新证据：source-asr-connect-matrix.json=release源码清单=713f6f35工作树；541全过1ignored，包含真实TCP挂握手红/绿、消费者退出红/绿、Recognition提前关房红/绿、延迟握手首PCM逐样本/认证头/只发一次、连接错误终止不无限重连。底层DNS已有现存独立夹具但目前首地址是拒绝，不声称黑洞端到端已验。

ASR_CONNECT_RTC_READ_1.json：候选debug测试进程（probe6f992747，非正式release部署）直接调用job，不注册Worker。主进程不动，使用真实ASR async解析开关、真实LLM/TTS/SFU，normal语料用户final2/回答2/非零音频8390ms/自然关房Gone/exit0。ASR本次总822ms=DNS566+TCP4+TLS_WS249余下调度量；不能把一个成功样本当历史根治。该旧ignored探针没严格计metrics，我明确不声称3通道通过，后续需要计metrics的新探针或正式release探针验收。ordered正在独立测试。

请在最终回复按固定713f6f35核变更，说明认可/异议；未新增ASR无界重试、闲置普通房仍5秒、仅freshVAD刷新且final清租约；不用10页重复初审。不准把通过isolated说可直接全量上线。生产仍50017a89、未部署新候选。

01:34补充：713运行源码没有再改。仅新增cfg(test)的真实6500ms握手+Recognition模型联合用例（5s时仍Keep、真实final到达后清hold）及测试探针严格统计metrics topic/k；全套542过/0失败/1ignored，worker-asr-connect-wire-final.log。新probe fc1e8a49已按源码清单打包，正在跑严格三通道；旧正常/ordered已分别8390/7620ms音频、final2/2和2/1并自然Gone，但仍不能回填它们的metrics。

01:35严格normal真实RTC完成（ASR_METRICS_RTC_READ_1.json）：用户final2、回答1、有效PCM6000ms、metrics [eou,eou,llm,tts]，自然回收Gone、exit0；主生产PID3496776保持，未部署，测试仍debug产物，不能冒充release性能或Android。ordered严格轮随后进行。
