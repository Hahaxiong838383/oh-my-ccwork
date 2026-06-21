我会按“只读评审”输出结论与 findings，不执行任何仓库操作。重点会压力测试 SenseVoice 是否值得做主力，以及 cc 的“Zipformer 主力 + SenseVoice 增强”是否真成立。 
**结论先行**
- 【判断】本地 ASR 主力应选 `Zipformer-zh`，不是 `SenseVoice-Small`。
- 【判断】SenseVoice 值得纳入，但不值得当实时对话主 ASR；它的合理位置是“句后情绪/事件增强器”，而不是字幕和判停链路的核心。
- 【判断】cc 的方向基本正确，但“并行旁路”要降级为“按需/句后补跑”，中端机不建议长期同时跑两个 ASR 模型。

**1. SenseVoice 情绪/事件价值**
- 【已验证】SenseVoice-Small 提供 ASR、情绪识别、音频事件检测能力，确实比纯 ASR 多一个“小可情感陪伴”可消费的信号层。
- 【判断】它的价值是“锦上添花”，不是“体验跃迁”。开心、笑声、哭声、明显生气这类强信号可能有用；“有点难过/委屈/撒娇/疲惫”这类细粒度儿童情绪，不应期待稳定可靠。
- 【推断】SenseVoice 的情绪标签大概率来自通用语音场景，儿童中文陪伴域会有明显 domain shift：童声高频、夸张语调、哭闹夹杂语音、背景动画/TTS 声音，都可能让情绪/事件标签误报。
- 【建议】LLM 只能把 SenseVoice 输出当“弱提示”，格式类似：`emotion=possibly_sad, confidence=medium, event=cry?`；回复上用柔性措辞，例如“听起来你好像有点不开心”，不要让它单独决定安抚、报警、家长通知或剧情分支。
- 【判断】如果没有小可真实儿童音频集做标注回放评测，SenseVoice 情绪更像 demo 能力；只有在高置信哭声/笑声/生气等粗粒度事件上，才可能稳定转化为产品收益。

**2. SenseVoice 模拟流式代价**
- 【已验证】Zipformer 是真流式 Transducer，能持续给 partial，天然适合逐字字幕和 endpointing；SenseVoice 在 sherpa-onnx 里是 simulated streaming，需要外接 VAD，不能提供同等级逐字 partial。
- 【判断】对小可这种“实时对话 + 逐字打字机字幕”的产品，SenseVoice 无 partial 是硬伤。字幕会从“边说边出”退化为“说完一段再吐字”，用户感知明显。
- 【推断】SenseVoice 判停延迟由 VAD 静音阈值、分段策略、模型推理共同决定；为了避免截断孩子拖长音/停顿，静音阈值不能太短，结果会让“说完后等一下才响应”的问题回潮。
- 【判断】可以用短 chunk 模拟刷新字幕，但会出现文本跳变、重写、漏上下文和判停抖动，本质上不等价于 Zipformer partial。
- 【结论】如果小可保留逐字字幕、打断、续问、退出这些实时交互，SenseVoice 不适合当主 ASR。

**3. 两者结合是否最优**
- 【判断】“Zipformer 主跑 + SenseVoice 情绪增强”是最优方向，但不建议持续并行双 ASR。
- 【推断】`Zipformer-zh` 约 14MB，SenseVoice int8 约 100MB；实际端侧常驻还会有解码器、特征缓存、运行时内存、WebView、JS Bridge、播放链路和云 TTS 音频缓冲。中端机长期双模型并行会增加 CPU 竞争、发热、耗电和延迟抖动。
- 【建议】更稳的方案是：Zipformer 实时出 partial、final 和 endpoint；同时缓存本轮音频；endpoint 后把完整 utterance 交给 SenseVoice 做一次句后情绪/事件分析。
- 【建议】不要阻塞首包回复等 SenseVoice。LLM 先基于文本响应；如果 SenseVoice 在短预算内返回高置信情绪，可用于调整当前回复语气，否则写入下一轮对话状态。
- 【判断】只有在旗舰机、插电场景或后续实测 RTF/温升足够安全时，才考虑 SenseVoice 低频并行；默认产品路径应避免常驻双跑。

**4. 最终推荐**
- 【推荐】第一阶段只上 `Zipformer-zh` 做主 ASR：解决逐字字幕、判停、打断、续问、退出，这是小可实时体验的命门。
- 【推荐】第二阶段引入 `SenseVoice-Small` 做句后情绪/事件增强：只消费高置信粗粒度信号，先灰度，不进入强决策链路。
- 【推荐】第三阶段用小可真实儿童中文音频评测 SenseVoice：至少覆盖开心、哭、发脾气、撒娇、背景动画声、云 TTS 串音、多人说话，再决定是否扩大权重。
- 【不推荐】SenseVoice 直接当主力 ASR，除非产品愿意放弃逐字字幕体验，并接受 VAD 判停带来的延迟和抖动。
- 【备选】Fun-ASR-Nano 可以继续观察，但当前不应压过 Zipformer/SenseVoice 组合，原因是中文儿童实时对话实测不足。

**主要风险**
- 【风险】本地 ASR 会录到云 TTS 的小可声音，必须在播放 TTS 时做 ASR gating、回声压制或暂停识别，否则 Zipformer 和 SenseVoice 都会被污染。
- 【风险】SenseVoice 情绪误判会伤害陪伴感，尤其把孩子正常兴奋识别成生气/难过时，回复会显得“自作聪明”。
- 【风险】如果为了 SenseVoice 等情绪结果而延迟 LLM 首响，会牺牲实时陪伴最核心的流畅性，得不偿失。

署名：codex（OpenAI）
