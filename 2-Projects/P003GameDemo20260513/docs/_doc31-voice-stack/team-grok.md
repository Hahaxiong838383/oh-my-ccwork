【评审结论先行】

on-device 方案在“可控”动机下性价比显著低于 self-hosted；童声 ASR 可用性存硬性风险，音色复刻 demo 阶段质量不可控；self-hosted 能以更低代价满足全部已知需求，on-device 仅额外提供“离线”这一川哥未列为动机的属性。

【1. 挑战/补充】

- 【已验证】调研已覆盖 2025-2026 主流端侧框架（sherpa-onnx、Moonshine、Vosk、FireRedASR），未遗漏公开可用中文端侧方案；Vosk 中文 CER 23-38% 与 2024-2025 实测一致，过时风险低。
- 【推断】未见 2026 年新开源中文端侧 ASR/TTS 突破性项目进入候选；SenseVoice-Small 非真流式 + 外挂 VAD 的集成复杂度被低估，实际端侧延迟将高于 sherpa-onnx Transducer。
- 【建议】补充检查：2026 年是否有基于 ONNX Runtime 的新 Zipformer 或 Paraformer 量化模型；Piper 归档后是否出现合规 fork（GPL-3.0 风险需在 license 审计中显式标注）。

【2. 两个硬门槛现实判断】

- 中文童声 on-device ASR：
  - 【已验证】无任何 5-10 岁童声公开 benchmark，成人模型 CER 在儿童场景退化 20pp+ 为行业共识。
  - 【推断】直接用成人模型在 demo 阶段“可用”概率 <40%（参考 Whisper 英文儿童退化数据）；fine-tune ChildMandarin（41h）或 SLT2021（~400h）可提升 8-15pp，但需 1-2 周标注+训练+量化迭代，且中端机 RTF 会上升 0.05-0.1。
  - 【判断】demo 阶段不值得投入 fine-tune；真机实测成人模型 + 童声语料集是唯一可行路径。

- 端侧复刻「小可」音色：
  - 【已验证】sherpa-onnx ZipVoice 端侧克隆 RTF 在中端机 >1.5，实时不可用；“离线 embedding 固化”模式可行，但儿童共鸣还原率无 benchmark，质量感知下降明显。
  - 【推断】demo 阶段复刻成功率 <60%；放弃复刻、改用 Kokoro-82M 年轻女声或自采 1h 干净童声微调 VITS 更现实。
  - 【判断】不建议复刻；直接选预置友好音色 + 后期再评估克隆。

【3. 第一性原理对抗】

- 川哥真实动机“可控/不依赖第三方”被 self-hosted 完全覆盖：自建 VPS/工作站部署开源模型，保持现有 WebSocket 链路，童声质量、音色自然度、延迟均优于 on-device，且无需重写 Jetpack Compose + WebView 集成层。
- on-device 额外代价：童声识别率风险 + 音色降级 + 中端机 RTF 超标 + 模型体积/内存压力 + 需维护 sherpa-onnx 唤醒词之外的新集成。
- on-device 唯一独有价值是“离线”，但该属性未被列为动机；对 demo 阶段的“可控”目标，self-hosted 提供等效甚至更优解。
- 【判断】on-device 不值得坚持；self-hosted 更契合动机，on-device 仅在未来“必须离线”场景下再评估。

【4. 推荐方案 + 落地路径】

(a) 若坚持 on-device（不推荐）：
- ASR：sherpa-onnx + 流式 Zipformer-zh（已有经验，Transducer 天然 endpointing）。
- TTS：sherpa-onnx + Kokoro-82M（选年轻女声近似）或 VITS 单一女声；放弃 ZipVoice 克隆。
- 集成：复用现有 sherpa-onnx 唤醒词路径，JS Bridge 喂 WebView；童声兜底 = 真机实测 + 必要时加 Silero VAD。
- 音色兜底 = 预置成人女声，demo 后评估自采微调。

(b) 若 self-hosted（推荐）：
- ASR/TTS：自建服务器部署 sherpa-onnx 或更大精度模型（SenseVoice / CosyVoice），通过 WebSocket 替换火山云接口。
- 得失：童声识别率与音色质量接近或优于云端；延迟可控；集成改动最小（仅改 endpoint）；无 on-device 体积/RTF 限制。
- 落地：先在工作站部署验证，再上 VPS；保持现有 WebView 链路不变。

【5. 风险/坑 + 必须真机实测项】

- 风险：中端机（非旗舰）RTF 超标导致对话卡顿；儿童音色自然度下降用户可感知；license 变更（Piper GPL-3.0）引入合规坑。
- 必须真机实测项：
  - 5-10 岁童声在 sherpa-onnx Zipformer 下的 CER（至少 50 句）。
  - 中端机（Pixel 7/8 级别）上 TTS RTF 与首音延迟。
  - Kokoro-82M vs 火山云小可音色主观 MOS（至少 10 人盲测）。
  - WebView + sherpa-onnx 集成后端到端延迟（含 JS Bridge 开销）。

署名：grok（xAI）
