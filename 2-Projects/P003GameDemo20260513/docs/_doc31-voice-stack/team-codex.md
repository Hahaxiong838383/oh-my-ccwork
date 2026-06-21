【结论先行｜建议】若真实目标是“可控 / 不依赖第三方”，而不是“必须离线”，我建议 demo 主线优先选 **self-hosted 开源 ASR/TTS**，on-device 只做并行技术预研。端侧方案在两个核心卖点上都踩硬风险：**中文童声 ASR 无公开基准，必须真机实测；「小可」专属音色端侧复刻大概率明显降级**。这些代价换来的主要增量是离线与隐私，而这不是当前决策动机。

**关键判断**
- 【已验证】cc 的大方向基本对：端侧 Android 真正成熟、可落地、许可友好的统一框架，ASR/TTS 目前仍主要是 `sherpa-onnx`。
- 【推断】漏项不是“没有模型”，而是“没有更优解”：`FunASR/Paraformer/SenseVoice`、`WeNet`、`whisper.cpp`、`whisper.cpp + quant`、`MNN/NCNN` 路线都可评估，但要么 Android 工程化弱，要么中文童声无保证，要么流式/延迟/包体不适合 demo。
- 【判断】on-device 成人中文 ASR 直接用于 5-10 岁童声，不能默认“可用”；在安静、近讲、有限话术 demo 中可能过线，但开放儿童对话风险很高。
- 【判断】端侧复刻现有火山“小可”音色不应作为 demo 主路径；最稳是接受“相似但非同一”的年轻女声/儿童友好预置，或把音色复刻放到 self-hosted。

**硬门槛 1：中文童声 On-Device ASR**
- 【已验证】没有公开中文 5-10 岁童声端侧 ASR benchmark，所以任何模型表格里的成人 CER 都不能作为上线依据。
- 【判断】`sherpa-onnx + 流式 Zipformer-zh` 是端侧首选，不是因为一定最准，而是因为真流式、endpointing、包体可控、团队已有集成经验；`SenseVoice-Small` 精度可能更好，但“非真流式 + 外挂 VAD”会削弱对话丝滑度和语义判停。
- 【判断】成人模型直接用只适合做第一轮真机门禁：如果儿童近讲 100-200 条命令/自由问句 CER、意图命中率、端点延迟都过线，才继续；否则不要幻想靠 prompt 或前端补丁解决。
- 【建议】fine-tune 值得做，但不应押公开儿童集 alone；真正有效的是采集目标年龄、目标设备、目标话术、目标噪声的自有数据。公开 ChildMandarin/SLT 类数据可做暖启动，提升幅度无法承诺，预期应按“显著降低童声退化但不保证追平成人”管理。
- 【建议】demo 评估指标不要只看 CER，要看“意图成功率、误唤醒后首句识别、端点截断率、儿童拖音/重复/口齿不清场景”。

**硬门槛 2：「小可」音色端侧复刻**
- 【判断】端侧实时 voice clone 不现实作为稳定 demo 主链路：RTF≈1 在旗舰机已接近上限，中端机、长句、WebView 并行、发热降频后会明显卡。
- 【判断】“离线生成 speaker embedding 固化为预置音色”工程上可行，但质量不等于云端专属音色；儿童/童趣音色的共鸣、韵律、情绪感最容易塌，demo 中用户会直接感知。
- 【建议】如果坚持端侧，放弃“复刻同一个小可”的表述，改成“端侧小可音色 v2”：选年轻女声/儿童友好预置，调语速、音高、韵律、短句模板，降低用户对原音色一致性的预期。
- 【建议】如果必须保留现有“小可”品牌音色一致性，self-hosted 更合理：可以用更重的 CosyVoice/F5/GPT-SoVITS/类似方案部署在自有服务器，离线克隆或微调，质量和可控性都强于手机端。

**第一性原理对抗**
- 【判断】“可控 / 不依赖第三方”并不推出“必须 on-device”。self-hosted 同样能摆脱火山接口变更、限流、审核、计费策略，并且能继续复用现有 WebSocket 云链路。
- 【判断】on-device 对这个 demo 的额外收益主要是：离线可用、隐私更强、边际推理成本为零、弱网更稳。但这些不是当前已声明的核心动机。
- 【判断】on-device 的确定性成本更大：童声 ASR 风险、音色降级、Android 原生模型集成、包体、机型性能分层、发热降频、JS Bridge 音频流同步、端点策略重做。
- 【建议】若 demo 目标是“证明产品体验”，self-hosted 更契合；若 demo 目标是“证明手机端 AI 技术壁垒/隐私离线能力”，on-device 才值得付出代价。
- 【建议】不要把 on-device 作为单线豪赌。最稳路径是：self-hosted 保体验基线，on-device 做可替换引擎抽象，等童声实测和音色验收过门槛后再切。

**若坚持 On-Device**
- 【ASR 建议】首选 `sherpa-onnx + 流式 Zipformer-zh small/medium`，以真流式和端点稳定优先；`SenseVoice-Small` 作为准确率对照实验，不作为首版实时主链路。
- 【TTS 建议】首选 `sherpa-onnx + VITS/MeloTTS-ZH` 或可用的 Kokoro 中文年轻女声，先保低延迟；ZipVoice 固化 embedding 只作为音色实验分支。
- 【集成建议】原生层统一封装 `SpeechEngine`，JS Bridge 只接收 partial/final transcript、endpoint event、TTS audio state，避免 Web 层感知具体模型。
- 【兜底建议】ASR 加“童声门禁测试 + 失败回退云/self-hosted”；TTS 加“端侧默认音色 + 服务端小可音色回退”；demo 话术尽量短句、近讲、有限域。

**若选择 Self-Hosted**
- 【ASR 建议】优先部署 `FunASR/SenseVoice/Paraformer` 或 `sherpa-onnx server` 流式方案，按儿童实测选型；需要语义判停时保留现有 definite-style 判停逻辑或自建 LLM/规则判停。
- 【TTS 建议】优先选择能复刻音色的服务端模型，如 CosyVoice/F5/GPT-SoVITS 类路线，离线生成/微调“小可”音色，再通过现有 WebSocket/HTTP 流式返回。
- 【收益】体验更接近现有火山基线，调参迭代快，包体小，Android 改动少，可控性满足真实动机。
- 【代价】仍依赖网络和自有服务器运维；隐私、离线、成本峰值需要另行设计。

**必须真机实测项**
- 【ASR】5-10 岁儿童、至少 20 人、每人 30-50 条，覆盖近讲/远场/噪声/拖音/打断；记录 CER、意图命中率、首字延迟、final 延迟、截断率。
- 【TTS】同一批目标用户盲测原火山小可、端侧预置、端侧 clone、self-hosted clone；记录相似度、自然度、儿童友好度、可接受度。
- 【性能】低端/中端/旗舰 Android 分层测 RTF、CPU、内存、发热 10 分钟后降频、WebView 同时渲染时延迟。
- 【产品】测试弱网/断网价值是否真实影响 demo；如果用户场景并不需要离线，on-device 的战略价值应下调。

署名：codex（OpenAI）
