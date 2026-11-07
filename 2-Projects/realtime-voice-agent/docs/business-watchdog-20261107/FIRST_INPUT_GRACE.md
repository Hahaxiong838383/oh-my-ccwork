# 首次输入与VAD竞态修正（未部署）

## 已复现的反例

固定87c/d18候选：启动总预算60秒、签发idle=5000ms。连接/预构建用了40秒，第一帧只有160样本（10ms），VAD需要512样本（32ms）。input_frame先把ready置真，而last_progress仍是assignment时刻。40.010秒job tick先于VAD便返回Close，正常首句会被打断。

这是主Codex实际执行Rust Runtime测试的失败（526通过/1失败），不是仅Python转写或现场根因推测。日志worker-startup-vad-race-red.log保留。Grok166也独立指出该路径；167进行合同质证，不将报告全部意见机械当成已证故障。

## 修正语义

- 输入首次真实非空帧在启动期限内到达时，单独记录一次ready_at。正常idle基线为max(ready_at,last_progress)，给首个VAD窗口和用户输入完整的已签发空闲间隔。
- 不把静音计入业务进展；后续静音帧、重复ready永不更新ready_at或last_progress。
- 第一帧在启动60秒到期或之后到达仍不能恢复；空帧不解除启动保护。
- 这是对早期模型“从assignment直接计算首次空闲”假设的明确修正。原首静音帧测试已改成“一次性起步，重复静音不续”；不是隐藏测试失败。60秒是接入上限，不是每个已接通房间都必须存活60秒的最低值。

## 验证

全套Linux527/527；新增40秒延迟首帧→10ms检查→32ms fresh VAD→5秒idle边界通过。重复ready、空帧、迟到首帧、300秒合法idle、绝对任务截止和原TTS/生命周期回归保持。去掉job.rs中新引入的unused Context import。

尚未验：真实RTC/实机、ordered→RTC转场宽限、实际OutputGate/本地承接与reply截止组合、DeleteRoom非CAS边界、其他两个pool移植。d18 release245bd99…已经编译并通过ABI，但早于本修正，不可拿它声称包含此次修复。

署名：codex（OpenAI）| 2026-11-07
