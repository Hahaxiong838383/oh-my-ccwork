# 主池 TTS DNS 独立备用实施与验收

授权：用户同意按 Codex/Grok 推荐最小方案执行，自检验收后部署。Codex 亲自写代码，Grok 只读独立评审；不重复询问已授权的发布/push。

基线：文档 HEAD 014e4fe6083a4e6c5c12942b5f7a91c8a3bde3c4，运行源 e9806c7f，主 binary 057f1972…；部署前重新核实际值。仅主池最小增量，保留主池 ASR handoff、业务看门狗与所有现役功能。倾听、搜索、Brain、设备范围及系统 DNS 不变。

## 合同

- 复用倾听池已有、限固定 TTS 域名的 200ms 独立 DNS 备用；不开定时主动探测，不自动切全机 DNS。
- 正常查询不启动备用；最多两个额外 lookup 并发、不排队；现有 650ms 连接恢复与前台共享 10s 截止保持。
- DNS 有效否定回答不冒充超时；快速传输错误明确验证。保留地址族独立、CNAME/TTL、TLS SNI/证书及取消所有权。
- 返回实际 DNS 路径，不把开关开启当备用胜出。

## 顺序及完成证据

1. 保存基线与回滚锚；失败测试证明旧主池在系统 DNS 挂起、备用正常时仍超时。必须是行为失败而非编译错误。
2. 最小移植并补边界测试，定向及完整 cargo test；构建正式 Linux artifact、源码哈希/ABI核同。
3. Grok 固定候选独立复核。隔离正式 artifact 跑同语料普通/ordered RTC，并通过仅隔离进程可见的 DNS 故障验证备用路径；不更改生产 DNS 进行注入。
4. 固化发布清单与可执行回滚；确认三池运行无漂移、SFU 无房、主池无未结束任务后部署，只新增主池 DNS 备用开关。
5. 上线正式派单普通/ordered RTC、同连接时序/实际音频/自然关房/资源/稳定性核验；核其它池及系统DNS未变。失败按本次基线回滚，不退更旧版本。
6. commit/push 及远端核同，回执交付本机与 Air Downloads，逐条完成审计。

## 执行记录

- 本轮开始：主工作树 clean，HEAD 014e4fe6；已有计划及资源/Grok评审已完整读取。此前资源评估属于 progress，本轮执行实现，不是重复状态汇报。
- Pre-flight：voice_connect 返回新增 dns_path 由 tts_xfyun 消费，两者必须一起改；tts.rs 恢复预算保持不变。旧辅助 resolver 的快失败边界另测，不能凭慢请求测试外推。

署名：codex（OpenAI）| 2026-11-08

- RED：旧主池路径在真实本地UDP静默故障下，750ms仍未利用健康备用，r27用例按预期失败（非编译错误）；保留source/log。随后移植倾听核心，仅改voice_connect和TTS路径回传，新增NODATA/NXDOMAIN/TTL0/双故障取消测试。

## 最终状态

2026-11-08 19:06:57 CST主池发布；568项回归通过，正式二进制四项隔离矩阵及两项线上合成派单通过，188.4秒同PID/异常重启0。回滚前置检查及Air同SHA交付完成。详见 [最终回执](P003_MAIN_TTS_DNS_REPAIR_RECEIPT_20261108.md)、[运维记忆](OPERATIONS_MEMORY.md)、[Grok复审](GROK_CODE_REVIEW.md) 和 [主13复核](REVIEW_RESOLUTION.md)。本次仅收口主池DNS备用缺口，历史其他语音问题维持对应证据边界。
