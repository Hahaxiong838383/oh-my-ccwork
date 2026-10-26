# R16 研究依据、取舍与证据边界

本轮仍以普通聊天延迟无明显回退为优先目标。语音处理与搜索逻辑修改在独立候选，共享派单层仅更新已授权的一周窗口策略及健康状态相关3文件；研究资料是设计参考，实际采用由本项目源码、现场取证和回归决定。真人窗口是否开放以本轮最终回执为准。

## 连接长尾

真实系统调用观察到A记录已返回、仍等待AAAA约188ms。这证明组合解析会互相等待，但不能解释此前所有4至5秒长尾。候选改用异步解析，并发查询A/AAAA、带TTL缓存及有界TCP竞速；IPv6延后50ms，每族最多8个地址、错峰250ms，取消时释放未完成连接。证书校验、SNI与原10秒总预算保留，现役仍用旧路径。

参考[Happy Eyeballs v2](https://www.rfc-editor.org/rfc/rfc8305.html)、[Hickory发布记录](https://github.com/hickory-dns/hickory-dns/releases)及[解析配置说明](https://docs.rs/hickory-resolver/0.26.1/hickory_resolver/config/struct.ResolverOpts.html)。实际依赖固定0.26.3并读源码核对；这是针对现有路径的有界竞速，不声称完整实现RFC8305或保留所有系统解析语义。隔离实验覆盖AAAA不回、IPv6单栈、首地址失败、TTL与取消；真实语音延迟还需最终同版配对。

## 可靠关房

[RoomService文档](https://docs.livekit.io/reference/other/roomservice-api/)明确区分房间操作与查询；本轮不再把请求成功或Worker jobs为零当成房间已关闭。候选持久记录房间SID及进程身份，前台有界重试，独立定时补偿按SID复核、删除后再查询确认。失败保留记录并反映到健康状态，健康缺失或过期时派单失败关闭。401/403及重定向不重试；仅传输、408/429/5xx有限重试。

[reqwest客户端文档](https://docs.rs/reqwest/0.13.0/reqwest/struct.ClientBuilder.html)用于核对连接复用、重定向和重试控制，实际版本0.13.4以锁文件与源码为准。候选主进程崩溃、清理地址故障、恢复补偿及短窗实际RTC断连均已留私有证据；最终版本、新会话回现役和周截止配置仍须分别验收，不能互相替代。

## 附和与ASR

配置空的二遍ASR设备名单并不代表关闭，实际含义是全部设备启用。相同合成“哦”经真实RTC传输后，二遍路径4次生成无关句，一遍路径4次没有生成该句。完整与最小热词均复现，不能归因“热词已证实有问题”。候选关闭二遍、保留一遍，并针对搜索附和关闭DDC；生产不变。单字被上游省略与正确识别后进入专用续播分支须分开计数。

参考[火山双向流式ASR](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[热词及上下文](https://docs.volcengine.com/docs/DoubaoVoice/hot-words-and-context?lang=zh)、[单字识别说明](https://help.aliyun.com/zh/isi/support/faq-about-speech-recognition)。这些资料支持排查边界，不代表保证每个单音节都有文字。

## 答案依据与一次复核

借鉴[先找原句再核对主张](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)与[服务器管理引用](https://platform.claude.com/docs/en/build-with-claude/citations)的思路，未引入Claude接口：服务器拆分检索摘录并编号，模型只返回主张和事实编号，原句由服务器重建。数字、时刻、范围、年龄边界、闭馆例外增加机械检查；它们补充人工语义审查，不是事实正确性的完备证明。

继续使用DeepSeek一次搜索、最多两次生成及20秒总预算，第二次为独立短校对提示，不追加第三次调用。对比诊断曾试用pro做复核，耗时约1.9至2.1秒、flash约0.8至1.4秒，未显示足够收益，部署仍为flash。[官方模型及计费说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)用于核对型号，少量诊断不构成模型整体优劣结论。

有依据但多余的数字触发一次简化，不单独导致整答失败；无依据数字及条件反转仍拦截。英文闭馆规则曾将节日闭馆误作“除外”，改为仅对明确可识别的原文语法确定性整理，未知语法仍走校验。随后真实测试暴露同段前缀及年龄范围丢失，分别补红绿回归。保留失败轮次，不把20条ready直接算20条内容合格。

最后一轮又发现“含羞草”回答把不同来源的小叶闭合、叶柄下垂机制接在一起。R16p对简单成因问题要求各主张的来源集合有共同交集，允许附加第二来源佐证；比较类问题不套这个规则。正反例同时覆盖“无共同来源的拼接”和“有共同来源加佐证”，避免把所有多来源回答都拦掉。这只是可检验的保守约束，同一来源仍可能被误读，最终20个固定查询另由codex逐项对照原句，见[R16_QUERY_REVIEW_20261026.json](R16_QUERY_REVIEW_20261026.json)。

R16p固定查询20项均有可支持核心答案的原句；专业术语的儿童理解、来源自身年龄表述歧义、实时数据变动仍有边界。该结论只覆盖冻结样本，不能外推任意问题无幻觉。模型输出及来源摘录原件在受限证据目录，项目仅保存逐项结论、限制、哈希与关联编号。

## 隔离测试账本

09:05:33（北京时间）起，新一轮自动化使用独立验收账本，同样每设备100/日、全局1000/日。切换前真实候选账本当日S04=66、S38=91，完整保留；未清零、未提高额度。正式开窗前必须在关闭、空闲状态恢复原配置，并核原账本SHA及现场健康，公开回执如实说明当日剩余额度。验收账本不会随迭代失败重置。所有原始日志、合成音频与凭据留受限目录，不进入Git。

署名：codex（OpenAI）| 2026-10-26（北京时间；执行中）
