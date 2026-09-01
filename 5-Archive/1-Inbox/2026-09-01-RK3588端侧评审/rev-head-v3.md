# 评审任务：RK3588 端侧多模态语音 Agent —— 端云协同分支规划（对抗性 review）

你是资深端侧 AI / 实时语音系统专家。对下面这份「端侧语音 Agent 分支规划」做**对抗性**评审——挑毛病、找致命缺陷、质疑技术可行性，并给出**具体修改建议**。只评审这份规划本身，不要评审任何 prompt 框架或方法论。

## 背景（项目当前目标 + 未来方向）
- 已有云端实时语音 Agent（cascade 流式 STT→LLM→TTS + 自建 CQRS 事件溯源记忆内核），现开**端侧分支**，在 RK3588（Orange Pi 5 Plus，NPU 6 TOPS）做多模态（看·听·想·说·记）Agent 的 demo→MVP。
- 两个已拍板约束（在此前提下评审，不要推翻）：①端云协同——端侧做唤醒/VAD/VLM感知/STT/记忆边界，LLM 大脑走云；②记忆内核（CQRS 护城河）私有不进公开仓，公开协作仓只放端侧层。
- 协作：public 团队仓，多人编辑（含实习生）。
- 未来方向：端侧隐私护城河（原始音视频不出端）+ 可审计跨会话长期记忆；远期可下沉更多到端侧。

## W1 已验证（本平台实测，2026-06-17）
- RK3588 已部署对比 SmolVLM2-256M / InternVL3.5-1B/2B/4B / MiniCPM-V2.6。InternVL3.5-1B：24tok/s、首字3.2s、峰值1.9GB。
- W1 当时结论：rkllm-toolkit 1.2.3 不支持线性注意力，Qwen3.5 / MiniCPM-V4.6 转换卡死。

## ⚠️ 最新联网核实事实（2026-06，确保不用过时资料，请据此校正 W1 与 PLAN）
1. **rkllm 已更新**：airockchip/rknn-llm 现已**新增 Qwen3.5 / Gemma4 / SmolLM3 支持**，model zoo 有 Qwen3-VL-2B 预转换模型 → **W1「线性注意力卡死」结论已过时**，端侧 LLM 选型空间比 W1 时扩大。
2. **RK3588 量化**：只支持 **W8A8（不支持 W4A16**，RK3576 才支持）。LLM 1B-3B 最佳，Qwen2.5-3B≈8.45 tok/s；Qwen3-8B W8A8≈8.3GB。
3. **sherpa-onnx STT**：明确支持 RK NPU，有 RK3588 专用 SenseVoice 中文流式模型，支持中英日韩粤。
4. **sherpa-onnx TTS**：Piper/VITS/Kokoro-82M 支持中文；**RKNN(NPU) 比 CPU 快 4.3x，RTF≈0.15，sub-second 可行**；**限制**：encoder 是动态图 RKNN 跑不了（只 decoder 上 NPU），单 batch 受多 NPU 协处理限制。paroli=Piper 流式 TTS 可选 RK3588 NPU。

## 待评审文档（PLAN.md 全文）↓↓↓
=================== PLAN.md START ===================
