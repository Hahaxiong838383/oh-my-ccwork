**评审 Finding（仅建议，无任何执行意图）**

**问题确认**：给定约束下，TTS 自声触发 KWS 是真实 P1，硬件 AEC 对 STREAM_MUSIC 无效，notifyTtsState 已存在但未作用于 KWS，barge-in 需求明确，demo 阶段禁止重型 DSP。

**候选评估要点**：
- A：彻底防自唤醒，但直接违反 barge-in 需求；工程量低（仅 gate），低端机零负担。
- B：保留 barge-in，但 TTS 链路重构 + 实时 AEC，demo 阶段工程量与低端机负担均过高。
- C：已知毁音色/路由，违背约束 3，排除。
- D：利用现有 notifyTtsState 时间窗做启发式（阈值抬高 / 文本窗口屏蔽 / 300ms 二次确认），成本最低，部分保留 barge-in。
- E：A 为主 + 能量包络不匹配检测作为粗 barge-in 信号，平衡较好。

**按推荐度排序（demo 阶段）**：
1. **E（A 主 + 能量粗 barge-in）**  
   实现要点建议：AudioEngine.notifyTtsState(true) 时暂停 KWS 喂帧并忽略命中；同时在同一时间窗内启动简易 RMS 能量检测（当前 AudioRecord 缓冲区计算），能量突增且不匹配 TTS 已知包络时触发 barge-in 回调（不走 KWS）。notifyTtsState(false) 后延迟恢复 KWS。  
   理由：防自唤醒彻底，barge-in 需求用低成本信号兜底，零 DSP，改动集中于 AudioEngine 一处。

2. **D（纯启发式）**  
   实现要点建议：notifyTtsState(true) 进入时间窗后，动态抬高 sherpa KWS 阈值（或临时 ignore 命中）；对“即将说小可”的文本段做短窗屏蔽；命中后加 300ms 人声持续确认。notifyTtsState(false) 立即恢复。  
   理由：零新增检测逻辑，纯利用现有信号，工程量最小。

3. **A（纯 gate KWS）**（仅作为兜底）  
   实现要点建议：notifyTtsState(true) 完全 gate KWS；false 后延迟恢复。  
   理由：防自唤醒 100% 有效，但牺牲 barge-in，需 PTT 按钮作为唯一兜底。

**demo 阶段一句话结论**：推荐 E（或退 D），在 AudioEngine.notifyTtsState 路径上加能量粗判别即可在低成本下同时满足防自唤醒与 barge-in 需求。

**长期正解建议**：将 TTS 搬原生播放并引入 WebRTC AEC（或 speexdsp），同时保留 VOICE_RECOGNITION 源；或探索 sherpa 侧更强的 speaker embedding 区分自声 vs 童声。

署名：grok（xAI）
