# 评审任务:P003 小可 —— Android on-device 开源 ASR + TTS 选型

你是首席语音架构师。基于下面 cc 已做的联网调研(2026-06)+ P003 约束,**对抗性评审这个选型决策**:挑战、补充、判断硬门槛、给推荐与落地路径。不是复述调研,要给判断和取舍。

## 决策上下文(川哥已定方向)
- 部署位置:**手机端侧 on-device**(模型跑在 Android 手机里,不走云)。
- 动机:**可控 / 不依赖第三方**(不被火山云接口变更/限流/审核绑定)。注意:川哥**没有**选"离线可用"作为动机。

## 约束(铁律)
1. 中文普通话 + **5-10 岁童声**(历史痛点:成人模型对童声识别率常掉 <50%)。
2. 「小可」有**专属音色**(现火山云 TTS 特定 voice),换开源要么找儿童友好预置音色,要么 voice clone 复刻。
3. Android = Jetpack Compose 原生薄壳 + WebView(Web 核心复用),模型在原生层跑、JS Bridge 喂 Web(已有 sherpa-onnx 唤醒词集成经验)。
4. demo 阶段;实时低延迟(对话丝滑)。
5. 现状基线:火山云 bigmodel 流式 ASR(definite 语义判停)+ 火山云 TTS(小可专属音色),儿童场景已实测有效。

## cc 已联网调研结论(两个子代理 WebSearch,2026-06)

### ASR 候选(端侧中文)
| 方案 | 关键数据 | 童声 | 流式 | 集成 | license |
|---|---|---|---|---|---|
| **sherpa-onnx + 流式 Zipformer-zh** | 14MB(small)~726MB,RTF 0.068-0.15(成人CPU) | 无benchmark | 真流式(Transducer,天然endpointing) | 我们有经验 | Apache2.0 |
| sherpa-onnx + SenseVoice-Small | 成人CER 2.96%,70ms/10s | 无benchmark | **非真流式**(模拟流式,需外挂Silero VAD) | 同框架 | Apache2.0 |
| Moonshine-tiny-zh | 27MB,MIT,2025-09新出 | 无benchmark | 真流式 | Maven,中文无demo | MIT |
| Vosk | 中文CER 23-38% | 无 | 流式 | Android SDK成熟 | Apache2.0 |
| FireRedASR v2 | 740MB~1.7GB,精度高 | 无 | CTC版支持流式但体积大 | sherpa-onnx | Apache2.0 |

**ASR 关键发现(已验证)**:① **无任何中文 5-10 岁童声公开 benchmark**(非搜索遗漏,是行业现状);② 成人模型对童声退化严重(英文 Whisper 成人WER~3%→儿童~25%,+22pp);③ 中文儿童数据集稀缺(ChildMandarin 3-5岁41h / SLT2021 ~400h),不足训专用模型;④ 童声 CER **只能真机实测**,提升唯一已知路径 = fine-tune。

### TTS 候选(端侧中文)
| 方案 | 关键数据 | 音色 | 延迟 | 集成 | license |
|---|---|---|---|---|---|
| **sherpa-onnx + VITS/MeloTTS-ZH** | 60-120MB,RTF<<1,首音<100ms | 单一成人女声,无儿童 | 低,达标 | 我们有经验 | 商用友好 |
| sherpa-onnx + Kokoro-82M | ~330MB,103说话人(含中英女声) | 无儿童,可挑年轻女声近似 | 低 | 同框架 | 友好 |
| sherpa-onnx + ZipVoice(clone) | int8,**Pixel10Pro RTF≈1.0** | 零样本克隆需5-15s参考音 | **中端机RTF>1.5,实时不达标** | 同框架 | 友好 |
| CosyVoice/F5/GPT-SoVITS | 音质最好 | 强克隆 | **端侧不可行**(所谓端侧多是局域网服务器) | — | — |

**TTS 关键发现(已验证)**:① 端侧成熟框架**只有 sherpa-onnx**;② **端侧 voice clone 技术可行但有代价**——实时克隆 RTF≈1 卡延迟,实用模式只能"离线生成 speaker embedding 固化为预置音色"(非每次实时克隆);③ 端侧克隆质量 vs 云端大模型**自然度可感知下降**,儿童音色共鸣还原率更低、无 benchmark;④ **无中文儿童预置音色**,要真儿童音色需自采 1-4h 干净数据微调 VITS;⑤ Piper 原仓库 2025-10 已归档转 GPL-3.0(license 注意)。

## 要你评审 / 产出(每家独立,我综合四家取并集 + 标各家独有)

1. **挑战 / 补充**:cc 调研有没有漏的端侧中文 ASR/TTS 方案(2025-2026)?候选数据有没有错或过时?

2. **两个硬门槛的现实判断**:
   - ① **中文童声 on-device ASR** 到底能不能做到"可用"(demo 能接受)?成人模型直接用够不够?fine-tune(ChildMandarin等)值不值得投入、能提多少?
   - ② **端侧复刻「小可」音色**现实吗?"离线 embedding 固化预置"这条路质量够不够 demo?还是该换一个预置儿童友好音色、放弃复刻?

3. **★ 第一性原理对抗(最重要,请认真打)**:川哥的真实动机是「可控 / 不依赖第三方」(**没选"离线"**)。而这个动机 **self-hosted(自己服务器 VPS/工作站部署开源 ASR/TTS 替火山云)同样满足,且不牺牲童声质量/音色/延迟/集成简单度**(继续走现有 WebSocket 云链路,只是换成自己的服务器)。**on-device 额外只多给了"离线"——但这不是川哥的动机。**
   - 那么:**on-device 对这个 demo 到底值不值?** 它要付出(童声识别率风险 + 音色降级 + WebView 原生集成重写 + 中端机延迟)的代价,换来的"可控"self-hosted 也能给。
   - **是不是 self-hosted 才是更契合"可控"这个真实动机的解?** 还是 on-device 有 self-hosted 给不了的、对这个产品真正重要的东西?
   - 尊重川哥已倾向 on-device,但请对抗性把 trade-off 摆到最清,供他最终决策。诚实给你的判断。

4. **推荐方案 + 落地路径**:分两种情形给——(a) 若坚持 on-device:选哪个 ASR + 哪个 TTS + 怎么集成 + 童声和音色怎么兜底;(b) 若 self-hosted:选什么、相对 on-device 的得失。

5. **风险 / 坑 + 必须真机实测项**。

输出:结论先行,区分【已验证/推断/建议】,中文,报告末尾按真实模型身份署名。