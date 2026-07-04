# 声纹识别(Speaker ID)方案 — 调研定稿 + Phase 1 交接

> 2026-07-03 调研定稿(全网 + GitHub 检索 + API 源码验证)。川哥拍板:**Phase 1 回家后开工**,本文档即开工蓝本。
> 结论:**sherpa-onnx 本地旁路** —— 部署在现有阿里云 HK ECS 的 voice-worker 进程内,不加机器、不用 GPU、不调外部 API。
>
> **状态(2026-07-03 深夜,川哥真机验收"效果不错")**:Phase 1 ✅ + Phase 2 身份注入最小版 ✅。
> 落地要点与蓝本的差异:①比对不用 SpeakerEmbeddingManager,numpy 余弦自算(要 score 分布标定)
> ②**注册必须用通话信道音频**(录音 app 注册 score 0.07 → `SPEAKER_ID_DUMP_DIR` 采集换纹后 0.63-0.68,
> 盲测 0.876)③阈值标定 0.50(同人 0.54-0.68 / 非同人 <0.28)④setup 预载=后台线程延迟 4s 错峰
> (2核补位竞态)+ job 内禁同步加载 onnx(铁律)⑤P2=粘滞身份注入 FastLLM messages 末尾近因位
> (借 MyJavis 34663dfaa),首句建立身份第二句生效。运维 SOP 见 `voice-agent-ops` skill 声纹段。

## 0. 一句话架构

worker 进程内加"第二个 silero":26MB CAM++ 中文声纹 ONNX(setup_fnc 预载),pump 侧 ring buffer 留存本轮用户 16k PCM,turn 结束后 `asyncio.to_thread` 异步提 embedding 比对注册库,结果只作元数据 —— **不进热路径、不门控、不阻塞**,与 1.9-2.1s 延迟预算零交集。

```
阿里云 HK ECS 47.239.204.68(现有 2核2G)
└─ voice-worker(systemd,现有进程)
   ├─ silero VAD(ONNX,已有)← 部署形态先例
   ├─ 火山 ASR/TTS、LLM 赛马(云 API,不动)
   └─ [新增] 声纹旁路
      ├─ campplus_zh-cn.onnx(26MB,setup_fnc 预载)
      ├─ AudioRingBuffer(pump 侧写入,cap ~15s)
      ├─ turn 结束 → to_thread(extract → manager.search)→ 日志/元数据
      └─ assets/speakers/registry.json(name → embedding,几 KB)
```

## 1. 选型矩阵(2026-07-03 检索结论)

| 方案 | 判定 | 理由 |
|---|---|---|
| **A. sherpa-onnx speaker-id(13.4k★)** | ✅ 采用 | 现成中文 ONNX 模型 + 注册/检索 API 全带 + 纯 CPU + 项目已有 sherpa 经验(Android KWS) |
| B. 3D-Speaker(3.0k★)/ WeSpeaker(1.3k★) | 备选 | 模型源头库;仅将来 fine-tune 童声时直接碰 |
| C. LiveKit MultiSpeakerAdapter + Speechmatics/Deepgram diarization | ❌ 主路不用 | 要换掉火山 ASR(中文质量+跨境延迟风险);但其 prompt 标签范式值得抄 |
| D. 火山声纹四接口 / 数据湖 ERes2Net 算子 | ❌ | 比对绑火山 RTC(本项目铁律=摆脱它);数据湖版疑为批处理算子非实时(未验证) |
| E. pyannote/diart/FunASR 流式 diarization | ❌ | 盲分离"谁在说"≠"是不是注册的人";2核2G 扛不动 |

## 2. 已验证事实(可直接引用,勿重新调研)

- **模型资产**(release tag `speaker-recongition-models`,注意官方 tag 拼写就是错的):
  - `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` **26MB ← Phase 1 首选**
  - `3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx` 68MB(精度更高更重,备选)
  - `wespeaker_zh_cnceleb_resnet34.onnx` 25MB(备选)
  - 下载:`https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/<文件名>`
- **Python API**(读官方示例 `python-api-examples/speaker-identification-with-vad.py` 逐行验证):
  - `sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=..., num_threads=1, provider="cpu")` → `SpeakerEmbeddingExtractor(config)`(有 `config.validate()`)
  - `SpeakerEmbeddingManager(extractor.dim)` → `.add(name, embedding)`(同名多段自动求平均)/ `.search(embedding, threshold=0.6)` 返回名字、未命中返回空
  - 输入:单声道 float32、任意采样率(咱是 16k int16 PCM → `np.frombuffer(...,int16).astype(np.float32)/32768`)
- **接入点(现有代码,零新管线)**:
  - 16kHz 单声道 PCM 已在手:`tier_a_cascade` room_input(audio_sample_rate=16000)
  - 逐帧 tap:`volc_stt.py` `_pump_input` S1v3 已逐帧算幅度(`_mean_abs_amp`,~:214),同处喂 ring buffer
  - turn 边界:`FillerAgent.on_user_turn_completed`(承接音已用此钩子,同点消费 speaker 结果)
- **LiveKit 官方范式参考**:`livekit/agents` 仓 `examples/voice_agents/speaker_id_multi_speaker.py` —— prompt 用 `<S1>`(未知)/`<Name>`(已知)标签标注说话人并明示 LLM 别把标签念出来。Phase 2 抄这个标签范式,STT 不换。

## 3. Phase 1 任务清单(旁路观察,~1 天)

1. **依赖**:HK `/root/voice-venv/bin/pip install sherpa-onnx`;模型下载到 `/root/realtime-voice-agent/assets/models/`(境内下载慢就本地下完 rsync)。
2. **注册脚本 `scripts/enroll_speaker.py`**:输入任意 wav/m4a(内部 ffmpeg 转 16k/16bit/mono)→ 提 embedding → 存 `assets/speakers/registry.json`。设计借 MyJavis `voiceprint/registry.ts` 范式:显示名↔slug↔ownerId 映射 + 人数上限 + 同名重注册即换纹;音频时长校验借 `wav.ts` 范式(建议 ≥15s 有效语音)。
3. **旁路组件 `engines/speaker_id.py`**:
   - `AudioRingBuffer`:engine 持有、构造时传给 VolcSTT,pump 逐帧 append,cap ~15s(超出丢最旧)
   - `on_user_turn_completed` → buffer 快照 → `asyncio.to_thread(extract + search)` → INFO 日志 `speaker id: name=X score=Y dur=Zms infer=Wms`
   - extractor 在 `setup_process` 预载存 proc.userdata(2核机 onnx 冷加载阻塞 event loop 的坑,silero 同款修法,勿在 job 内首载)
   - env:`SPEAKER_ID_ENABLED`(**默认 0**,Phase 1 灰度开)/ `SPEAKER_ID_MODEL` / `SPEAKER_ID_THRESHOLD`(0.6 起标)
4. **实测门槛(全过才算 Phase 1 完成)**:
   - `free -m` 前后对比:RSS 增量(1.6G 小机红线;预估 <100MB 是推断,必须实测)
   - 单次推理耗时:预期几十~200ms 量级(推断),日志实测;>500ms 要查
   - 川哥真机多轮对话:日志观察命中/score 分布 → 标定 threshold(含"未注册人说话"的负样本)
5. **回滚**:env 开关默认关 = 天然回滚;开工前打 tag `voice-agent-pre-speakerid`。
6. **三门**:ruff + mypy + pytest(ring buffer/注册脚本/int16→float32 转换补单测)。

## 4. Phase 2/3(每阶段单独拍板)

- **Phase 2 身份消费**:识别结果**结构化**进 prompt(memory-as-data 防注入,`<Name>` 标签范式)+ 记忆按 owner 归属(身份证据层状态机)。
- **Phase 3 pVAD 门控**:非注册人不触发 turn,治"电视/旁人误唤起"(team 评审认定的最优解;参考 FireRedChat)。

## 5. 红线(继承既有裁决,勿重新踩)

- **声纹 Score = 概率,非强认证;声纹 ID 绝不当记忆主键**(串账比遗忘致命)→ 记忆 `feedback_voice_agent_memory_design_traps` 六陷阱全文适用。
- **童声 EER 劣化**:成人语料训练的 encoder 对孩子要单独标定阈值 + 定期重注册 → 记忆 `feedback_realtime_asr_speaker_discrimination_pvad_over_denoise`。
- 火山四接口(MyJavis `apps/server/src/voiceprint/`)**比对绑 RTC,本项目只借 registry/wav 校验的设计**,不引其代码。
- **隐私**:声纹属敏感个人信息(生物识别),embedding 与注册音频**均不出服务器、不进 git**(assets/speakers/ 加 .gitignore)。

## 6. 参考链接

- sherpa-onnx speaker-id 文档:https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html
- 模型 release:https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
- 官方示例(与本场景同构):https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/speaker-identification-with-vad.py
- LiveKit 多说话人示例:https://github.com/livekit/agents/blob/main/examples/voice_agents/speaker_id_multi_speaker.py
- 3D-Speaker:https://github.com/modelscope/3D-Speaker · WeSpeaker:https://github.com/wenet-e2e/wespeaker
