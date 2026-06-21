**评审 Finding（仅建议，不执行）**

### 1. 状态机正解：推荐方向 X（每轮 Web 管，端侧完全对齐云火山态机）
**理由**：云火山态机是已验证的单轮边界（beginTurn→finishTurn→onPlaybackEnd→followup），listeningByWake/pressed、turnCount、idle 静默分级、startExit/finalizeExit 全部复用，端侧仅替换录音源。方向 Y 会引入第二套“对话中”态，增加 recording 标志分裂与 exit 路径分叉，长期维护成本更高；Z 把 endpoint 当硬边界会破坏原生连续流优势且需大改 AudioEngine。X 一致性最高，bug 根因最少。

**关键实现要点（避免二次 chat.trigger）**：
- onAsrEndpoint()：调用 finishTurn()（setVoiceStatus('thinking') + 清 listeningByWake + 停当前轮）。
- onAsrFinal(text)：先 clientRef.current?.bargeIn()（停在途 TTS），再 sendChatTrigger(text)。
- stopAsr() 路径：原生 flush 后 notifyAsrFinal 的 final 需在 Web 侧加去重（用 turnId 或 lastFinalText 比对，重复则丢弃）。
- onPlaybackEnd 端侧分支：直接复用 followup beginTurn()（内部 if(useDeviceAsrRef) startAsr('auto')），不再单独 set listening。
- 端侧 beginTurn(byWake) 仍设 listeningByWake=true，finishTurn 负责清零。

### 2. 双声音（bug1）修复要点
- onAsrFinal 必须加 bargeIn（已提）。
- 更根本：endpoint 后不让原生 reset 连续，而是 Web finishTurn 后由 onPlaybackEnd 再 startAsr('auto')，把“句切”控制权收归 Web；或在 bridge 层对同一 turnId 的多个 final 做幂等（只触发一次 chat.trigger）。
- rule2=1.1s 可微调为 1.4-1.6s（儿童语速），但不能作为唯一解。

### 3. 按钮态（bug2）修复要点
- recording = pressed || listeningByWake 保持不变。
- 端侧必须走 finishTurn 清 listeningByWake；onAsrEndpoint 后即清，onPlaybackEnd 再由新 beginTurn 设。
- 禁止端侧 onAsrFinal 后直接 set listening（会永久红）。

### 4. 语音打断（bug3）修复要点
- TTS 期 gate KWS 是自唤醒与语音打断的本质冲突（同一 AudioRecord）。
- demo 阶段可落地方案：
  - 文本感知 gating：LLM/TTS 侧在生成文本时检测是否含“唤醒词/小可”，仅对含词的 TTS 句全 gate KWS；其余句 KWS 保持激活（降敏阈值）。
  - 能量门 barge-in：TTS 播放中并行跑简易能量 VAD（或 reuse 原前端 VAD 逻辑），能量突起且非自唤醒时触发 bargeIn + stopTts。
  - 短期折中：TTS 期保留 KWS，但 onWake 后先判断当前是否 speaking，若是则 bargeIn 而非 startAsr。
- 长期：原生 AudioEngine 需支持“半 duplex”或双通道（TTS 回放同时监听）。

**demo 一句话结论**：方向 X + finishTurn 对齐 + bargeIn + 文本/能量混合 gating 是最少改动、最一致的修复路径。

署名：grok（xAI）
