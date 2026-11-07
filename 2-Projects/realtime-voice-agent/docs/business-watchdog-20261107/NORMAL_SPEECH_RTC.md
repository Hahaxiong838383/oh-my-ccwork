# 业务回收候选：正常语料真实RTC验证

**正常RTC问答与有序首句超时转RTC后问答，两轮均通过。不是生产部署、不是安卓真机或延迟达标验收。**

运行源码1f947fe4不变，探针直接调用正式job但不注册Worker/不接真实派单。合成SN99999901、独立房、签发5000毫秒空闲策略。自制normal-short.wav（SHA 9ea46b2c…b10f0b03），与此前A/B语料相同，不用真实用户录音。

| 场景 | ready | RTC接管 | 用户final / 回答final | 接收非零音频 | 结果 |
|---|---:|---:|---:|---:|---|
| 普通RTC | 6741ms | 直接 | 2 / 1 | 8110ms | exit0，原SID Gone |
| 有序首句无begin后切RTC | 3107ms | 5610ms | 2 / 1 | 6370ms | exit0，原SID Gone |

两轮回答均解释天空蓝色。播放期间保留会话，输出结束后才按无进展策略回收。详细SourceDrained与回读日志、时间与SHA见JSON及私有原件。audible_ms只计平均绝对幅度>200的音频帧，不是完整音轨时长；不能拿它与played_frames的总时长相减推断丢包或截断。ready仍有3.11–6.74秒差异，不宣称连接慢已解决，也没有以合成探针替代真人实听。

## 失败和纠正

首轮探针缺字幕导致exit101，虽Worker有ASR→LLM→TTS→SourceDrained，未直接宣布通过。增加细分观察后第二轮确认客户端audible_ms6390，但两类final均0。根因在测试令牌：Agent使用了普通参与者授权，缺video.agent。

LiveKit官方转发代码对非Agent的legacy Transcription不转发：[participant.go](https://github.com/livekit/livekit/blob/master/pkg/rtc/participant.go)。本机锁定livekit0.8.3依赖代码也核实采用此类Transcription数据包。仅修探针的Agent room-join grant后上述两轮都收到了用户与回答字幕；生产源码未因此修改。此对照不能反推历史用户字幕故障均同因。旧二进制/失败日志完整保留。

## 当前线上边界

00:16新鲜只读证据：02000053仍是原SID及原两位ACTIVE参与者；前3分钟18个audio统计窗、整数mean_amp均0，无新turn/playout记录。整数均值非逐样本零，不能据此归责安卓采集。原始输入故障、12张未匹配新票和整体建连时延仍未闭环。

署名：codex（OpenAI）| 2026-11-08
