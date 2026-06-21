# 评审任务:小可端侧本地 ASR —— SenseVoice vs Zipformer 深度对抗(重点:SenseVoice 值不值)

你是首席语音架构师。在下面**已锁定的决策**下,深度分析"本地 ASR 到底选谁"。重点评 **SenseVoice 这个选项值不值得用**(川哥点名要把它纳入)。不要复述,要给判断、对抗、明确推荐。

## 已锁定决策(不要再翻,基于前几轮 team 已定)
- 架构 = **本地 ASR(手机端侧,动机:隐私 ASR 不出端 + 手机端壁垒)** + **云 TTS(豆包,保住小可专属音色)** + 云 LLM。
- runtime = **sherpa-onnx**(团队有 Android 集成经验,唤醒词已用),WebView + JS Bridge 喂 Web。
- **童声识别率:川哥明确说"不用太在意"** —— 它是所有成人模型的共性退化、不构成候选间区分度,本轮**不再作为主轴**(最多一句诚实提醒,别再大篇幅论证)。
- 候选收窄到端侧两强:**Zipformer-zh vs SenseVoice-Small**(Fun-ASR-Nano 可提及)。

## 产品 = 小可:5-10 岁儿童中文语音陪伴 AI,实时对话,**有字幕**(逐字打字机字幕),会打断/续问/退出。

## 本轮要你深度分析的四个问题(焦点)
1. **SenseVoice 的情绪识别 + 音频事件检测,对"儿童情感陪伴"到底有多大价值?** 能不能真的用进对话——让小可"听出"孩子开心/难过/哭/生气 → 调整回应语气/内容?这是产品体验跃升,还是 demo 噱头(情绪标签准不准?中文儿童场景可靠吗?LLM 怎么消费这个情绪信号)?诚实判断。
2. **SenseVoice 端侧"模拟流式"(非真流式,需外挂 Silero VAD)对"实时对话 + 逐字字幕"的真实代价多大?** vs Zipformer 真流式(Transducer,逐字 partial 出字幕 + 天然 endpointing 判停)。小可有逐字字幕,SenseVoice 没有 partial 是不是字幕体验硬伤?判停延迟差多少?
3. **能不能两者结合?** 例如:Zipformer 主跑(逐字字幕 + 判停),SenseVoice 旁路只出情绪标签;或一句话说完后 SenseVoice 补一次情绪分析。端侧**同时跑两个 ASR 模型**内存/算力/发热吃得消吗(中端机)?还是只能二选一?
4. **最终推荐**:本地 ASR 选 Zipformer / SenseVoice / 两者结合?给明确选择 + 落地路径。

## cc 的初判(请对抗性挑战)
> cc 倾向 **Zipformer 主力**(真流式=逐字字幕顺 + 判停丝滑,这是实时对话+字幕的命门,也是小可之前最痛的"判停时快时慢"的正解;14MB 最轻),**SenseVoice 作为第二步"情绪增强"**(并行旁路出情绪,不当对话主力,因为它判停弱)。请压力测试:这个"主+旁路"是不是最优?还是 SenseVoice 精度+情绪足够强、该直接当主力(用 VAD 兜判停、放弃逐字字幕)?

## 已知事实(cc 调研,可质疑/补充)
| | Zipformer-zh | SenseVoice-Small |
|---|---|---|
| 成人中文精度 | 好 | 更高(CER 2.96%) |
| 流式 | ✅真流式 Transducer,逐字 partial,天然 endpointing | ❌模拟流式(sherpa-onnx APK 名 `simulated_streaming`),无 partial,判停需外挂 Silero VAD |
| 情绪/事件 | 无 | ✅自带情绪识别 + 音频事件检测 |
| 体积 | 14MB(small)起 | ~100MB(int8) |
| 多语言 | 中(英) | 中英日韩粤 |
| 集成 | sherpa-onnx,有经验 | sherpa-onnx,同框架 |
- SenseVoice:ASR + emotion + audio event,非自回归,比 Whisper 快 15x(官方)。
- Fun-ASR-Nano(2025-12 新,31 语言,轻量):太新,中文实测未知,可作备选提及。
- 现状基线:火山云 ASR definite 判停(要被本地判停替换)。
- 端侧 AEC 风险:本地 ASR 会录到云 TTS 的小可声音 → 需播放时压制 ASR。

## 输出要求
结论先行 → 四个焦点问题逐一判断 → 明确推荐(选谁/结合)+ 落地路径 → 风险 → 区分【已验证/推断/建议】→ 中文 → 报告末尾按真实模型身份署名。