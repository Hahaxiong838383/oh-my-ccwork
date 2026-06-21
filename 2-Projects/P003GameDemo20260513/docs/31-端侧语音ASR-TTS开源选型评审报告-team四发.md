# docs/31 · 小可端侧语音(ASR/TTS)开源选型 —— 评审报告(team 四发)

> **任务**:川哥问「手机端 demo 能不能用开源本地部署的 ASR/TTS,选最适合的,优劣对比,team 评审给报告」。决策方向川哥已定:**on-device(手机端侧)+ 动机=可控/不依赖第三方**。
> **方法**:cc 联网调研(2 个子代理 WebSearch,2026-06)拿候选事实 → team 顶级四发对抗评审(grok-4.3 / codex gpt-5.5 / gemini-3-flash / gemini-3.5-flash 深度)→ cc 综合。
> **四家原始 + 调研 Context Pack 存档**:[`_doc31-voice-stack/`](_doc31-voice-stack/)。日期:2026-06-20。

---

## 0. 一句话结论(四家一致,最高置信)

> **在「可控/不依赖第三方」这个动机下,on-device 是错误选择;四家无一例外强烈推荐 self-hosted(自建服务器部署开源模型替火山云)。** on-device 要付出三笔大代价(童声识别率废 + 小可音色降级成电音 + WebView 原生集成重写 3-4 周),换来的唯一独有价值是「离线」——而川哥**没有**把离线列为动机。self-hosted 同样「完全不依赖第三方」,却能保住童声质量、音色、低延迟,且 App 几乎不动(只改 WebSocket URL)。

四家原话:grok「on-device 不值得坚持」/ codex「不要单线豪赌 on-device」/ gemini-flash「on-device 极不理性、舍本逐末」/ gemini-3.5「典型的过早优化陷阱」。

---

## 1. 决策上下文
- 部署位置:川哥定 **on-device**;动机:**可控/不依赖第三方**(明确未选「离线可用」)。
- 硬约束:中文 + **5-10 岁童声**(历史痛点) + **「小可」专属音色** + WebView 架构 + 实时低延迟 + demo 阶段。
- 现状基线:火山云 bigmodel 流式 ASR(definite 判停)+ 火山云 TTS(小可音色),儿童场景已实测有效。

---

## 2. cc 联网调研:候选与硬事实(2026-06)

### ASR 候选(端侧中文)
| 方案 | 关键数据 | 童声 | 流式 | 集成 | license |
|---|---|---|---|---|---|
| sherpa-onnx + 流式 Zipformer-zh(端侧首选) | 14-726MB,RTF 0.07-0.15(成人CPU) | 无benchmark | ✅真流式,天然endpointing | 有经验 | Apache2.0 |
| sherpa-onnx + SenseVoice-Small | 成人CER 2.96% | 无 | ❌非真流式(需外挂Silero VAD) | 同框架 | Apache2.0 |
| Moonshine-tiny-zh | 27MB,2025-09新 | 无 | 真流式但自回归端侧易幻觉复读 | 中文无demo | MIT |
| Vosk | 中文CER 23-38% | 无 | 流式 | SDK成熟 | Apache2.0 |

### TTS 候选(端侧中文)
| 方案 | 关键数据 | 音色 | 延迟 | license |
|---|---|---|---|---|
| sherpa-onnx + VITS/MeloTTS-ZH | 60-120MB,首音<100ms | 单一成人女声,无儿童 | ✅达标 | 友好 |
| sherpa-onnx + Matcha-TTS(gemini补充) | 50-80MB,RTF 0.05,音质比VITS饱满 | 同上 | ✅ | 友好 |
| sherpa-onnx + Kokoro-82M | 330MB,103说话人 | 中文G2P不稳/机械感 | ✅ | 友好 |
| sherpa-onnx + ZipVoice(clone) | 中端机RTF>1.5 | 零样本克隆 | ❌实时不达标 | 友好 |
| CosyVoice/F5/GPT-SoVITS | 音质最好,强克隆 | — | ❌端侧不可行(需GPU服务器) | — |

**关键发现(已验证)**:① 端侧成熟框架**只有 sherpa-onnx**;② **无任何中文 5-10 岁童声公开 benchmark**(行业现状);③ 端侧 voice clone 实时不可行,离线固化 embedding 质量差(电音);④ 大模型级 ASR/TTS(SenseVoice-Large/CosyVoice)**只能服务器跑**。

---

## 3. team 四发一致结论(五条,最高置信)

1. **on-device 在「可控」动机下不划算 → self-hosted(四家一致)。**
2. **童声 on-device ASR 不可用**:成人模型直接识别 5-10 岁童声 CER 40-60%(gemini 给证据:儿童基频 250-400Hz vs 成人 100-240Hz,成人模型特征层把童声当噪声/失真);demo 灾难。fine-tune 性价比低(2 周+,端侧小模型易灾难性遗忘,勉强降到 25-30% 仍不够流畅对话)。
3. **端侧复刻「小可」音色不现实**:实时 clone RTF≈1 死路;离线固化 embedding 在端侧轻量 VITS 上还原度差,带金属电音,丧失温暖童真,demo 验收不过。
4. **self-hosted 落地极简**:App 架构不动,仅改 WebSocket endpoint URL 指向自建服务器;ASR 上 SenseVoice-Large / Faster-Whisper-v3 + Silero VAD(童声鲁棒强);TTS 上 CosyVoice2 / GPT-SoVITS,用「小可」15s 高清音频做 reference 零样本克隆,95-99% 还原。开发 2-3 天打通链路。
5. **on-device 唯一该上的前提**:目标是「证明手机端 AI 技术壁垒 / 隐私离线能力」(codex),而非当前声明的「可控」。

---

## 4. ★ 核心对抗:on-device vs self-hosted(四家共识对比表)

| 维度 | on-device | self-hosted | 倾向 |
|---|---|---|---|
| 控制权/不依赖第三方 | ✅ 可控 | ✅ 可控(同样摆脱火山限流/审核/计费) | 平 |
| **童声 ASR 精度** | 极差(受限端侧小模型) | 极佳(可上 SenseVoice-Large/Whisper-v3) | **self 压倒** |
| **TTS 音色逼真** | 极差(VITS 电音,丧失童真) | 极佳(CosyVoice 克隆 95-99% 还原小可) | **self 压倒** |
| 延迟 | ~300ms(中端机降频后飙升) | 200-400ms(GPU 推理 + 网络) | 平 |
| **集成复杂度** | 极高(JNI/C++/OOM/音频流拼接/AEC) | 极低(改 URL,App 不动) | **self 压倒** |
| 迭代速度 | 慢(每次改要重打 APK) | 快(服务端调参即时) | **self 压倒** |
| 单用户成本 | $0(零边际) | 自有硬件零租金 / 或 GPU VPS $20-80/月 | on 略胜 |
| 离线可用 | ✅ | ❌ | on 独有(**川哥未选此动机**) |

**结论**:on-device 唯一净优势是「离线 + 零边际成本」;在「可控 + demo + 质量优先」的目标下,self-hosted 在童声/音色/集成/迭代四个维度压倒性领先。

---

## 5. 两个硬门槛裁决(四家一致)
- **童声 ASR**:on-device 不可用(CER 40-60%);demo 阶段不值得 fine-tune。self-hosted 可上大模型 + 童声实测选型,胜算高。
- **小可音色**:端侧基本要么换预置女声(身份感断裂,孩子觉得「小可变声了」)、要么接受电音降级。self-hosted CosyVoice 零样本克隆可保住音色身份。

---

## 6. 推荐方案:self-hosted(cc + 四家)

**选型**:
- ASR:`FunASR/SenseVoice-Small 或 Large` 或 `Faster-Whisper-large-v3` + `Silero VAD`(保留 definite-style 语义判停)。
- TTS:`CosyVoice2`(或 GPT-SoVITS),用「小可」15s 火山音频做 reference 克隆。

**落地架构**:FastAPI + WebSocket 流式网关 → 客户端仅把 WS URL 从火山改成自建服务器,Web/原生壳几乎不动。链路 2-3 天打通,童声/音色调优另算。

**★ 自有硬件零租金起步(cc 增值,四家不知道)**:川哥**不必租 VPS**——
- **dev198**(HP ZBook,NVIDIA RTX A2000 Mobile + CUDA 13.2,已验证):可跑 SenseVoice / Faster-Whisper(ASR);
- **Studio M2 Max 32GB**(纯算力,MPS):可跑 CosyVoice 类 TTS(Apple Silicon)。
- ⚠️ **待实测**:RTX A2000 Mobile 显存(入门级)跑 CosyVoice-Large/SenseVoice-Large 可能吃紧 → 可能 ASR 走 dev198 CUDA、TTS 走 Studio MPS 分担,或选量化/Small 档。具体吞吐+显存够不够**必须真机实测**,不猜。

---

## 7. 若川哥其实要「离线 / 隐私 / 手机端壁垒」:on-device 才值得

四家一致前提:**只有当真实需求里含「离线可用」「儿童数据绝不出端」「证明手机端 AI 壁垒」时,on-device 的代价才划算。** 若是:
- ASR:`sherpa-onnx + 流式 Zipformer-zh`(真流式 endpointing,有集成经验)+ ChildMandarin fine-tune + int8 量化;
- TTS:`sherpa-onnx + Matcha-TTS`,放弃 clone,改服务器离线训单人 VITS/Matcha(用 1h 干净音频)导出 ONNX 固化;
- 兜底:gemini 的 trick——Native 层把童声**降调(shift down)**适配成人模型(治标);ASR 失败回退云/self-hosted。

---

## 8. cc 推荐的折中(采 codex,两全)

> **demo 主线先 self-hosted 保体验基线**(童声/音色/速度都稳),**同时把语音引擎抽象成可替换接口**(原生统一封装 `SpeechEngine`,JS Bridge 只收 partial/final/endpoint/TTS-audio-state,Web 层不感知具体引擎),**on-device 作为并行技术预研**;等童声实测 + 音色验收过门槛后再决定是否切端侧。这样 demo 不赌、未来 on-device 能力作为壁垒慢慢磨,可替换接口让切换零伤筋动骨。

---

## 9. 必须真机实测项(四家汇总)
1. **童声 CER(P0)**:5-10 岁儿童 ≥20 人、每人 30-50 句,覆盖近讲/远场/噪声/拖音/打断;记录 CER + **意图命中率 + 端点截断率 + final 延迟**(codex:不能只看 CER)。
2. **TTS 盲测**:同批用户盲测 火山小可 / 端侧预置 / 端侧 clone / self-hosted clone,记录相似度+自然度+儿童友好度。
3. **性能分层**(若 on-device):低/中/旗舰机 RTF、内存(**Android heap 256/512MB,ASR100M+TTS150M+WebView 易 OOM 被杀**)、**连续 15 分钟降频「越聊越卡」**。
4. **★ AEC 自循环(on-device 致命坑,gemini-flash)**:Native ASR 拿不到 WebView 播放的音频回路做硬件 AEC → 把小可自己 TTS 当用户输入 → 系统自我对话死循环。必测。
5. self-hosted 显存/吞吐:dev198 A2000 / Studio MPS 跑 SenseVoice/CosyVoice 的实际表现。

---

## 10. 各家独有亮点
- **codex**:折中路径(§8)+ 评估指标不只 CER(意图成功率/端点截断率/儿童拖音场景)+ on-device 该上的真前提。
- **gemini-flash**:AEC 自循环死循环(§9.4,on-device 独有致命坑)+ CosyVoice 15s 克隆 99% 还原。
- **gemini-3.5**:补 **Matcha-TTS**(flow-matching,比 VITS 音质好 RTF 0.05,cc 调研漏了)+ Moonshine 自回归端侧幻觉复读 + Android OOM/降频量化分析 + 童声降调 trick。
- **grok**:量化预估(成人模型童声可用概率 <40%,fine-tune +8-15pp 但 2 周,音色复刻成功率 <60%)+ 可替换引擎抽象。

---

## 12. 最终选型定稿(2026-06-20 · 川哥决策演进 + 第二轮 team 四发)

**决策演进**:on-device(川哥坚持·隐私 ASR 不出端 + 手机端壁垒)→ 务实混合:**本地 ASR + 云 TTS 豆包**(端侧复刻音色过不去,TTS 退回云保小可音色)→ 本地 ASR 候选 Zipformer vs SenseVoice 第二轮四发对抗 → **定 Zipformer-zh,弃 SenseVoice**(四家一致)。

**最终栈(锁定):**
| 环节 | 方案 |
|---|---|
| ASR(听) | **本地 sherpa-onnx + 流式 Zipformer-zh**(14MB,真流式:逐字 partial 字幕 + 天然 endpointing 判停) |
| LLM(想) | 云(现状不变) |
| TTS(说) | **云豆包**(字节系,保小可专属音色) |
| 情绪感知 | **云 LLM 文本级推断**(system prompt 识别"呜呜/哼/考试没考好"等语气词);未来真要声学哭笑 → **1-2MB 专项 AED**(如 YAMNet),**不上 SenseVoice 100MB** |
| 判停 | Zipformer 自带 endpointing 规则(rule1 静音>1.2s / rule2 说话后静音>0.3s)+ 轻量 VAD,**弃火山云 definite 判停**(docs/25 批2 那套换掉) |
| AEC | TTS 播放时**原生层物理静音/挂起 ASR**(非 JS 软控),防本地 ASR 录到小可自己声音的自激死循环 |

**SenseVoice 为何弃(第二轮四发一致)**:① 情绪识别成人语料训练,儿童误判率 >40%(兴奋尖叫→判生气,大笑→判哭),误判伤陪伴"聪明感";② 模拟流式无 partial → 逐字字幕硬伤 + 判停 800-1200ms(vs Zipformer 300-600ms);③ 与 Zipformer 双跑端侧内存 >250MB,中端机 OOM/发热降频,串行后处理又拖首包或情绪只能用于下一轮(实时价值归零);④ 想要的"情绪感知"有更优替代(LLM 文本 + 轻量 AED)。

**必须真机实测**:Zipformer 童声 CER(川哥说不强求,建议仍测)/ 端侧判停延迟 / AEC 静音切换时序 / 中端机内存+连续会话温升降频。

**下一步**:起草本地 ASR(Zipformer + 端侧判停 + AEC)集成实施方案,给 fresh context 开干。第二轮四家原始见 [`_doc31-voice-stack/round2-sensevoice/`](_doc31-voice-stack/round2-sensevoice/)。

---

## 附:决策提示
- 若「可控」非当前最紧急 → 火山云继续用最省事(基线已有效);要「可控」→ **self-hosted(自有硬件零租金起步)是四家一致答案**。
- on-device 留作未来「离线/壁垒」场景的技术预研,用 §8 可替换接口保留切换能力。
