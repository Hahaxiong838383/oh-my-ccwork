这是改 skill 前的只读基线，不是生产验收。语料只限 `.claude/skills/voice-agent-ops/SKILL.md` 和它明确链接的 `references/search-latency-acceptance.md`。两处都没有把下面五件事写成同一套可执行规则。

| 场景 | 现有指南 | 覆盖/缺失 |
|---|---|---|
| 预热失败后的 cold、并发备用连接、预算与输家任务 | 讯飞预建连失败必须降级为现连，不能变成合成失败。回滚开关是 `XFYUN_TTS_PRECONNECT=0`，不换二进制。`WARM_MAX_AGE=12s`；协议 14 秒无上行断开（`26005`），连上后干等 10 秒再发首帧曾成功、15 秒被关。承接音是预生成 wav，不经 TTS；带承接音时看 `tts_ttft_ms`，不看端到端首声。延迟 reference 另要求：受限备用握手只在慢连接触发、有并发限额、不排队，取消时释放 future/socket/permit，等待中的 JoinHandle 不能脱离 Drop 被 detach。 | **缺失具体机制与数字。** 没有「预热失败后 cold 重新获得 10 秒」、预算如何避免倍增、连接上界、输家任务泄漏的步骤，也没有「为不影响 filler 而设」的独立开关及其等待值和并发上限。12 秒/14 秒/干等 10 秒不能填这三项。reference 写明阈值在 R15，且一次调参不能当成通用推荐；本次未读 R15。 |
| 已交付部分 PCM 后同文本重试；channel 累计等 6 秒是否等于上游停顿 | 32 槽 × 每槽 181 毫秒约 5.8 秒，是 channel 容量。underrun 的定义是播放循环在 `recv` 上等、当时 channel 为空；容量只在满时起作用。`first_underrun_ms` 近 0 表示起播缓冲薄，明显靠后表示上游中途掉链。一条 WS 等于一次合成；`audio.status==2` 后同连接再发会 `26016`；无取消指令，整句发出后上游会吐完，打断只能丢弃。provider completed 不能证明 PCM 已收到。 | **两问都缺失。** 没有「部分 PCM 已交付后，同文本重试可行或不可行」。没有「正常 channel 累计等待 6 秒 = 上游停顿」。5.8 秒容量不能改写成这个 6 秒判据。 |
| tcpdump 重复 seq/len、`PACKET_STATISTICS`、counter 0 | 讯飞 `payload.audio.seq` 是帧序号 1..N，`id` 恒为 `"0"`。L2 的「行数 0 才是丢包」指的是未入房时 LiveKit 不缓存的控制包。reference 只说：隔离丢包实验成功不能代替真实成功率或长尾；看不到丢包位置时区分本机 stub 与已配置上游。 | **三问都缺失。** 技能没有 tcpdump、重复 seq/len、`PACKET_STATISTICS` 的 socket 范围，也没有 counter 0 能否证明链路零丢包。上面三条不能挪来回答。 |
| 两轮正常 RTC + 485 单测能否证明历史 TLS 挂起和流中欠载已根治 | 单测、构建、ABI 只说明已覆盖逻辑和目标环境检查通过，不能说明真实时序或真人体验。小样本只是描述；某一版通过的部分不能拼进另一版验收表。8 句 64 秒 `underrun_count=0` 被写成运气样本；真机出现过欠载；「说得顺」不是验收。外部「TLS 800ms+」只用同城 `curl` 分解 tcp/tls，不复现时第一嫌疑是对方测量机代理。文档提交不等于再次部署。 | **不能由此证明根治；「两轮」和「485」本身也缺失。** 技能没有这两项作为根治门槛，也没有历史 TLS 挂起或流中欠载的根治条款。 |
| 最新 commit 只加诊断和文档时，如何分开运行源、测试 HEAD、上一二进制 | 提交、运行产物、设备版本分开绑定。运行身份用 PID、启动时间、`/proc/<PID>/exe` 的 SHA、环境文件和本轮部署时间线，不用探针里的静态常量。`.new` 不算生效，要部署脚本跑过且 md5/SHA 已变；换装再核运行中 exe。测试侧另核源码清单、Linux 构建、ABI、运行时要读的 JSON，并核对最终源 manifest。回滚锚是已安装的上一二进制：`/root/rust-worker/voice-rust-worker` 的 `.prev`，或 `cp -p` 留下的 `voice-rust-worker.rollback-<sha8>-<ActiveEnter ISO>`；不要 `mv` 覆盖既有 `.prev`。回滚只退本轮清单里的代码或必要配置。技能开头写明文中 PID/哈希是历史快照，不能当当前状态。 | **区分方法有；「最新 commit 只新增诊断和文档」这句没有。** 因此不能从技能指定当前运行源、当前测试 HEAD，或哪一个文件就是上一份二进制。仅文档的 commit 本身也不产生新的回滚二进制。 |

署名：Grok（xAI）
