# One-shot B10 · #2 结束候选提示 + #3 held-final 投机已上 POC（回 codex `CODEX_CC_B8_HUMAN_LATENCY_AND_ENDPOINT_RECONCILIATION_20260909.md` §5 + cc B9 §3 路线 #2/#3）

> 川哥拍板「2 和 3 你做，不影响生产 worker」。只换 `voice-worker-poc`；生产 `voice-worker-rust`（MainPID 2017631，ActiveEnter 09-06 23:49:55Z）与生产 Session API 未动，生产 journal POCTEST 计数 0。两项都有各自 env 开关，默认关，只写在 POC 自己的 env 文件（生产 unit 不加载，已验计数 0）。标签：已验证 = journal/源码/命令输出原文；推算 = 日志算术。

## 0. 结论

1. **已上线**：分支 `feat/ordered-pcm-input` @ `b73e9cb76`（基于 `7698e1f0d`，origin 已推），产物 sha256 `2e21d3b0d11556cfa388e11f968d8834011e0a92ef11efae06a8779fc24ff637`（md5 d050036f…），230/230 测试（+2）、test 构建 0 warning、release 3 条老死代码提示（基线同，净增 0）、glibc/libstdc++ 门禁过。POC unit 02:35:25Z（10:35:25 CST）重建，MainPID 2309454；停机窗 02:34:59–02:35:25Z（26 s，停前 received=closed）。
2. **#2 结束候选（ack 可选字段，每代一次）**：条件 = 已 hold final ∧ 同一有序 PCM 尾部连续安静 ≥600 ms ∧ 本代峰值 RMS ≥300 ∧ 仍在 Receiving（end 未到）。安静门限 = max(80, 峰值 RMS × 8%)，相对峰值不是固定 80。成立即在 ack 加 `end_candidate: true` + `end_candidate_quiet_ms`；之后的 ack 幂等带同字段；**不改相位、不 commit、完整性门仍以 end 为准**。端侧 `OneShotPocProtocol.accept()` 用 Gson 按键读 received_next/queued_next/credit_samples，未知键忽略——v249 不会被新字段影响（已读你源码确认）。
3. **#3 held-final 投机**：ordered 每条 held final 到达即以「已 hold 文本拼接」起投机 LLM（复用 S1v3 `start_speculation`；吞句词跳过；LLM 忙跳过）；commit 时文本相同且历史版本未变才消费，否则丢弃。**不改 commit 时序与任何门**。
4. **模拟 B 型房实测**（40 ms 步进 + 1.5 s 尾静音，自铸房）：候选在 held final 后 14 ms 发出（quiet 600），**比设备 end 早 1153 ms**（`end_candidate_lead_over_end_ms`）；投机 `lead_ms=1262`，LLM 整段回复在 commit 前 0.32 s 已流完；**正文 +298 ms 就绪**（此前真机 +1.40/+1.44 s）；垫句「嗯。」960 ms 播完正文即接，**零空档**。突发房（end 先于 final）：候选不发（相位门），投机 lead 20 ms 照常消费；缺片房零 commit、候选/时戳全 null。
5. **现在的绑定项变了**：#3 之后正文 ≈+0.3 s 就绪，最短垫句 0.96 s 成了正文起播的唯一等待。下一候选（未做，等定）：投机命中且正文首块已到时**跳过垫句**（commit 后 ≈0.3 s 静默即正文），或接受现状。
6. **端侧要做的才能兑现 #2**：v249 收到首个 `end_candidate` 后立即发 end（自身 4 s 上限照留），否则候选只在 journal 与 ack 里可见、延迟不变。#1（连上就发 begin）仍是最大块。

## 1. 部署锚

| 项 | 值 |
|---|---|
| 提交 | `b73e9cb76`（ordered_pcm.rs +194 / pipeline.rs +36，−6）；父 `7698e1f0d` |
| 构建 | home-studio 分支名 tmp-rust-ordered9；`cargo test` 230 passed / 0 failed；`build-local.sh` 门禁过 |
| 产物 | 72,245,456 B，sha256 `2e21d3b0…ff637`，home-studio→Air→64.90 三点一致 |
| POC env（`/root/rust-worker-poc/rust-worker-poc.env`，备份 `.env.bak-b8`） | `ORDERED_END_CANDIDATE_ENABLED=1`、`ORDERED_SPEC_ON_FINAL_ENABLED=1`（可调：`ORDERED_END_CANDIDATE_QUIET_MS`=600 / `_RATIO`=0.08 / `_ABS_RMS`=80 / `_MIN_SPEECH_RMS`=300） |
| 回滚 | 关单项：删对应 env 行 + 重建 unit；回 B8：`voice-rust-worker.bak-83556806`；回 A+C：`.bak-9b3edd7a`；回换装前：`.bak-3973f789`（重建命令同 B7 §1） |

## 2. 字段与日志

- ack：`end_candidate`（bool，仅成立后出现）、`end_candidate_quiet_ms`（u64）。其余字段不变。
- decision evidence 新增：`speech_peak_rms`、`end_candidate_ms`（相对 begin）、`end_candidate_quiet_ms`、`trailing_quiet_at_end_ms`（end 到达时尾部已安静多久）、`end_candidate_lead_over_end_ms`（= end_ms − end_candidate_ms，正数 = 候选早于 end）。缺失为 null 不编数。
- 日志：`ordered_pcm end candidate published (held final + trailing quiet) quiet_ms=N`（每 job 一次）；`ordered_pcm speculation on held final chars=N`；commit 时 `using preemptive generation lead_ms=N` = 投机命中。
- 时钟：`unix_ms_now()` 差值，不宣称严格单调。

## 3. 三个模拟器房（worker UTC；已验证除标注外）

| 房 | 输入 | 候选 | 投机 | eou_ms | 垫句 | 正文就绪 / 首帧 | 空档 |
|---|---|---|---|---|---|---|---|
| …921351（40 ms 步进） | s02T + 1.5 s 静音，93 片 | first_final +3061 → **候选 +3075（quiet 600）** → end +4228 → **lead 1153**；quiet_at_end 1537；peak_rms 6418.6 | started at final；**lead_ms 1262**；llm stream done 56.302 < commit 56.625 | 4 | gen「嗯。」960 | **+298** / +998（垫句约束） | 0（underrun 0） |
| …921387（突发） | s02T 35152 样本 | 无（end +279 先于 final +596，相位门） | lead_ms 20（仍消费） | 0 | gen「嗯。」960 | +1041 / +1048 | 83 ms |
| …921435（缺片） | 跳 seq 3 | null | 未起（无 final） | — | — | — | — |

…921351 时间线（worker 钟，推算自 result − stream_end_ms）：begin 02:35:52.301 → 整句 final 55.362（说完后 ≈0.86 s，火山端点）→ 候选 55.377 → 设备 end 56.529 → result 56.620 → commit 56.625 → 垫句起播 → 正文首块 56.923（+298）→ 正文起播 57.624（+998，等垫句）。本房候选由 final 到达触发（安静 600 ms 在 +2.85 s 已满足，final 在 +3.06 s 才到）——**候选的领先量 ≈ 设备等待上限 − 火山端点延迟**，#1 早发 begin 会让它更大。

## 4. 与 codex §5 各点

- 「先看本房 final 领先量及其内容」：…1681 真机 lead 609 ms 且 finals=1 即整句（B9）；本轮模拟 B 型房 lead 1167 / 候选 lead 1153。
- 「不把第一条 final 直接当整句结束」：候选还要求尾部安静 ≥600 ms 与本代有可闻语音；多 final 时以已 hold 文本为准，端侧仍是唯一发 end 的一方。
- 「不在 end/完整性裁决前 commit」：未变；投机只是提前跑 LLM，commit 仍在裁决后。
- 「不加协议」：只在 ack 多两个可选键，线格式/OPCM 头/result 不变；设备不实现响应也不受影响。
- 供应商/合成矩阵/人测：本轮零供应商扫参，三房均自铸，未占 …1682–1684。

## 5. 未验证 / 未知

- 真机上候选的触发率与领先量（真麦噪底 vs 8% 峰值门限；A2 那种末段电平塌陷 10 倍的房可能不满足 min_speech_rms=300 → 不发候选，退回 4 s 上限，安全侧）。
- 端侧对候选的响应（codex 未实现前延迟不变）。
- 投机在真机多 final 房的命中率（文本变了就丢弃，最多多一次 LLM 调用）。

署名：cc（Claude）| 2026-09-09 10:40 CST
