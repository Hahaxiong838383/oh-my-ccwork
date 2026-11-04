# 38：三条短退出RTC证据独立复核

结论：39归档的三条软件RTC退出链路可按限定范围通过，可供13继续正式无feature候选发布验收；不代表v384真机或全语音流程通过。38没有启动房间、改源码或生产。

逐一计算三份result及对应Worker日志SHA，与rtc-exit-audit.json全部相等；读取审计代码后独立复跑三例，并补核AGENT kind=4、实际identity/SID绑定、进入完成epoch、proposal participant、接受前state查询、重复exit同seq同payload。原始日志含ANSI颜色码，首次精确行匹配失败；只移除颜色码后，三条带原时间戳的真实STT final完全吻合，没有放宽语句匹配。

| 真实STT final | proposal首次接受耗时 | 匹配exit completed | 同房新聊天首音频 |
|---|---:|---:|---:|
| 恢复聊天 | 7ms | 20577ms | 26818ms |
| 结束倾听恢复聊天 | 8ms | 17770ms | 24042ms |
| 小可结束倾听 | 18ms | 18757ms | 25093ms |

后两列为各例起始后的相对时间。三例都核到同request_id/seq的completed(normal)、epoch递增、软件消费者exit_completed，退出至新输入之间无音频，随后有新音频/最终字幕/metrics且未断房重连。state查询后proposal仍能接受；重复exit复用seq=4。

可信sender实现位于归档rtc-run/rtc-probe.py:95–104、246–278：当前room接收回调检查服务端AGENT kind及lk.agent.name，首次绑定真实identity/SID后持续一致；session expected_agent_name先与测试agent核同。不是将调度名与participant identity直接相等比较，亦非只看src/前缀。本轮未另做恶意sender注入，不把读实现当攻击负例实测。

清理证据rtc-cleanup.json记载7房均查无、自有两进程停止；与production-before逐字段重算，普通/search池指纹完全一致。38此次为归档证据复核，未重复调用远端Room API。listening PID/env变化对应13续凭据，旧生产binary不变；与38此前18:09真实只读快照一致。

固定候选5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d、feature binary SHA270df2ab4944d0a4f7ff66a7a8f36a9c5ab6f418885d2edf921126f6c807a010，以及90构建输入核对引用39归档构建证据，本轮38不冒称重新编译或重算远端binary。正式无feature产物仍由13单独核来源/哈希/发布。

边界保留：三例前置合法控制enter+local_ready，不是voice enter；Android为v380软件模型、Brain正文为确定性替身、EOT降级。先前“小/逍客”ASR进入失败及容量未分配失败不抹除。未验真实v384 APK/真人唱歌/H1知识答案；反馈进行中退出仅有另一条单测，非本轮RTC。部署后最小真机动作：新房进入倾听→三条短退出之一→原房继续问答，再分别补语音进入和H1真实答案。

可复跑：`python3 evidence-38/review-39-rtc.py`（脚本按自身位置定位目录，无网络/凭据/生产副作用）。输出evidence-38/39-rtc-independent-review.json。结果3/3通过，原树保持不变。

署名：codex（OpenAI）｜2026-11-04 18:17 CST
