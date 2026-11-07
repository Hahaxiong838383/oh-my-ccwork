> 01:24更新：空流修复b373已部署，ordered真RTC通过且unused关闭1、45000002=0；但普通真RTC失败（ready741ms、有VAD、无ASR连接/转写/回复，9.239秒因IdleNoProgress关闭）。因此不能宣布正常语音部署验收通过。最新候选及失败依据见[ASR等待修复](ASR_CONNECT_FIX_20261108.md)。下文保留01:03阶段记录。

# Worker DNS慢与ASR空流：分段取证及修复

**已确认服务器DNS慢的实例和重复负向查询放大因素，DNS缓存修正已上线并通过真实生产问答；ASR空流收尾已复现、修复且535项回归通过，二进制发布状态以后续发布回执为准。不是全语音故障收口。**

## DNS：测到哪里慢，就修哪里

01:00前在实际Worker读取进程环境后分段测量LiveKit域名，没有安卓参与、没有代理环境变量。四轮系统解析为6375.20/931.45/433.57/788.86ms；对应TCP为3.44/14.36/3.87/3.95ms，TLS为15.98–17.16ms。未认证HTTP请求收到404，仅证明TLS/HTTP能响应，不把它当WebSocket加入成功。

实际系统为Ubuntu systemd255.4，本地stub127.0.0.53，上游8.8.8.8与1.1.1.1。有效配置没有显式Cache覆盖，发行版文件记录编译默认`no-negative`。实际cache中只有该域名A记录，AAAA查询返回NOERROR/NODATA和SOA负向TTL600，连续查询仍访问上游。上游在本次矩阵中响应约35–839ms；系统累计70次超时是累计值，不能将其全部归给本次语音故障。

已确认的机制是：正向A命中不代表双栈解析立即结束，未缓存的AAAA负向回答使连接继续依赖上游。**6.375秒那一轮缺少逐DNS包取证，不能断言这6秒每一段都是AAAA重试，也不能据此认定历史所有10秒超时都同源。** SDK0.6.3的`transport timed out`包含整个建连预算，不能单凭错误名认定TLS阶段。

00:59:13 CST上线独立drop-in：`/etc/systemd/resolved.conf.d/60-p003-negative-cache.conf`，仅`[Resolve] Cache=yes`。未更换上游、未固定IP、未禁IPv6、未修改网络路由，三个Worker未重启。影响范围是该Worker主机的系统解析缓存，不限单SN。此设置按DNS有效TTL缓存正负结果，不延长TTL，含义见[systemd255官方配置文档](https://www.freedesktop.org/software/systemd/man/255/resolved.conf.html)。

即时验证：首次解析44.266ms，后四次1.642–2.491ms；再次独立分段测量7.39/2.38/2.71/2.64ms，TCP/TLS仍正常，地址集合不变。缓存确实出现type28空rrs的负向条目。冷缓存/TTL到期后的上游延迟仍可能发生，不能把热缓存收益扩大成永久零DNS风险。

01:01:46正式主Worker同语料RTC问答通过：ready871ms、用户final2、回答final1、非零音频6460ms，严格收到eou/eou/tts/llm四个指标包，服务端自然回收原SID，探针没有代删。该轮仍是合成身份，不是Android验收。

回滚点：`/root/p003-business-watchdog-20261107/dns-cache-before`，记录原配置、解析路径、三池进程和drop-in原本不存在。新文件SHA256 `b8ca5c4b6eef8bc28d0e4e0b5eb04c4b340d02ecef461a557102b82eb0d504be`。无并发漂移时仅删除本文件，重启systemd-resolved并复测解析/实际语音；不重启网络、不动Worker凭据或原配置。失败自动回滚分支已写入发布脚本，本次未触发。

## ASR：不是“等2.5秒就无音频超时”

现役配置是`bigmodel_async + enable_nonstream=true`。最初对legacy端点的对照没有复现，保留为负向对照，不能当生产模式结论。按实际async模式重测三种零PCM操作：

| 操作 | 结果 |
|---|---|
| init后2.507秒发送空NegativeSeq | 57ms后收到Error45000002 |
| init后2.505秒直接关闭连接 | 无45000002 |
| init后保持5秒，不发送PCM/结束包 | 无45000002 |

生产ordered轮新RTC流在16:46:40.445Z创建，旧空流结束后16:46:40.515Z报45000002，新流16:46:40.934Z连接；之后两段final和正常回答。代码切换时丢弃旧事件接收器，因此不能把旧流报错误写成新流重连失败，更不能将此告警解释为整轮对话没声音。之前回执中泛称“随后重连”不够准确，此处收紧为“替换的新流正常连接”。

修复只处理**从未发送非空PCM**的预连接：输入结束时发送WebSocket Close，500ms有界收尾，返回独立`Unused`状态；不发送空识别结束包、不重连。零长度Vec跳过；真正收到320个零值样本仍是有效PCM，继续原NegativeSeq/服务端final确认流程，不因静音而跳过识别。

真实localhost WebSocket夹具按上述供应商行为实现：两条空流测试先失败，实际静音PCM正向通过；修复后535 passed/0 failed/1 ignored。首次夹具将gzip字节误当PCM计数，导致额外一个测试失败；修正夹具后取得533通过/2条真实失败，再到535全绿。两份红测均保留，不用夹具错误冒充业务回归。

源码回滚标签`rollback/p003-post-watchdog-pre-asr-empty-20261108`指向a71415ea，保留已上线长房保护。此次无依赖变更，不改识别端点、热词、首句超时、TTS或设备协议。ASR候选未验项目：发布后的同款ordered真实RTC和无45000002、其他两池适配、真实Android。

## 仍需推进

- DNS冷缓存/TTL到期及真实语音连接分段；已有一次6.38秒系统解析慢，不以热缓存四轮将历史超时销号。
- ASR候选完成生产发布与ordered复测，保留主池回滚点和自然空闲纪律。
- 搜索/倾听池按实际运行版本适配；初始输入与12张签票、TTS历史流中停顿、目标真机应用仍未整体收口。

证据私有目录`/Users/fu-121/.local/state/p003-business-watchdog-20261107/`：SIGNAL_NETWORK_PHASES、DNS_RESOLVER_STATE、DNS_UPSTREAM_MATRIX、DNS_CACHE_STATE、DNS_CACHE_APPLY、SIGNAL_NETWORK_PHASES_AFTER_CACHE、DNS_RTC_RESULT、ASR_EFFECTIVE_CONFIG、ASR_EMPTY_FINAL_AB、ASR_EMPTY_FINAL_ASYNC_AB，以及worker-asr-empty-red/red-wire/green.log。日志不含用户原始录音，凭据不外发。

署名：codex（OpenAI）| 2026-11-08 01:03 CST
