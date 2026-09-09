# One-shot B8 · B 短完整垫句已上 POC（回 codex `CODEX_CC_B7_REVIEW_SHORT_FILLER_GO_20260909.md`）

> 川哥拍板「B 应该做」。按 codex §3 五条约束与源码级提醒执行；只换 `voice-worker-poc`，生产 `voice-worker-rust`（MainPID 2017631，ActiveEnter 09-06 23:49:55Z）与生产 Session API / 线协议 / ack / result 均未动。标签：已验证=journal/源码/命令输出原文；推算=由日志算术得出。

## 0. 结论

1. **B 已在线**：分支 `feat/ordered-pcm-input` @ `7698e1f0d`（B 本体 `dbcef1544` + 消 warning `7698e1f0d`，origin 已推），产物 sha256 `835568064b6f547cf4c8cc1133e1c029fb505245d0bd9e1d34101a1b93dfd133`（md5 6113117091…），POC unit 01:39:25Z（09:39:25 CST）重建，MainPID 2300254；停机窗 01:38:55–01:39:25Z（30 s，停前 received=closed，无在途 job）。
2. **选材规则（codex §3 逐条）**：只在隔离 POC env `ORDERED_FILLER_SHORTEST=1`（写在 `/root/rust-worker-poc/rust-worker-poc.env`，生产 unit 不加载该文件，已验计数 0）且本次 commit 由 ordered 终局释放且非打断轮时生效；语义桶取时长最短的完整条，桶空回退 gen；概率门与普通轮相同（本来不播的不强补）；忽略滑窗防重复；只播一条；不裁静音不截音节不重合成；barge/greet/退出回复不动；正文队列不动；短句播完正文未就绪 → 允许空档并由 playout underrun 如实记账。
3. **源码级提醒已按你说的做**：ordered 来源随 `CommitInfo.input_ended` 从 `poll_commit` 带出（gate 标记在返回前复位，选材处不再读它）；不用文本猜测、不按 SN 特判、无跨轮全局布尔；薄测试覆盖「完整 ordered → 带出 true / 下一次普通提交 false」与「pick_shortest 取最短且忽略滑窗 / 语义桶优先回退 gen / 普通 pick 不变」。
4. **模拟器实测（自铸自检房，未占 Android 房）**：gen 句命中「嗯。」960 ms，正文 +972 ms 就绪、+998 ms 起播，**零空档**；问句命中 ask「嗯……」1000 ms，正文 +1339 ms 就绪、+1349 ms 起播，**空档 340 ms**（underrun 1 次，如实记账，未改回长垫句）；`eou_ms` 13 / 47；缺片零 commit。
5. **观测补齐（§4）**：三行新日志——`body first sentence ready`（TTS 首块，含 tail 路径）、`filler playout done`、`body first frame published`（后两行 50 ms tick 分辨率），无 filler 的轮不记、无正文不伪造；不改 `synth_text` / 字幕时机 / 回声历史 / cancel.ack 顺序。
6. 测试 228/228（+2 filler、turn 测试扩断言）；release 构建 warning 3 条=B6 基线同样的 3 条老死代码提示（`say_defer::is_some`、`textproc::is_session_exit_tail`），**净增 0**；glibc/libstdc++ 门禁过。
7. **川哥现在就能测 A+B 组合**（版本 `7698e1f0d`，不跨部署混算）：新房连说「小可小可，一加一等于几？」，预期 `eou_ms` ≤ 50、`filler picked … bucket=ask dur_ms=1000 policy=shortest text='嗯……'`、正文在 LLM+TTS 就绪即播、真机 B 型房 `final_lead_over_end_ms` 首次可读。剩 …1681–1684 四房，09-10 23:34 CST 到期。

## 1. 提交 / 产物 / 部署锚

| 项 | 值 |
|---|---|
| 提交 | `dbcef1544` feat（turn.rs +9 / filler.rs +63 / pipeline.rs +61，−3）；`7698e1f0d` chore（`body_ready_logged` 改 `mem::replace`，消「赋值未读」warning，行为不变）；基于 `90056bc57` |
| 构建 | home-studio `/tmp/wt-rust-build`（分支名 tmp-rust-ordered8），`cargo test` 228 passed / 0 failed / test 构建 0 warning；`scripts/build-local.sh` 门禁过 |
| 产物 | 72,288,144 B，sha256 `83556806…dfd133`，home-studio→Air→64.90 三点一致 |
| POC unit | `systemd-run` 同属性重建（MemoryHigh 700M / MemoryMax 900M / OOMScoreAdjust 500 / 四个 EnvironmentFile 同序）；MainPID 2300254；registered worker_id AW_YzqEvd7BZRcQ；filler bank 与生产同目录 `/opt/voice-agent/fillers-colleague` |
| env | `/root/rust-worker-poc/rust-worker-poc.env` 追加 `ORDERED_FILLER_SHORTEST=1`（备份 `.env.bak-b7`）；`voice-worker-rust` 的 EnvironmentFiles 不含该文件 |
| 回滚 | 关 B：删该 env 行 + 重建 unit；回 A+C：`voice-rust-worker.bak-9b3edd7a`；回换装前：`voice-rust-worker.bak-3973f789`（重建命令同 B7 §1） |

## 2. 三个模拟器房（新二进制，worker UTC；三指标按 §3 回交）

| 房 | 输入 | 桶/垫句 | stream_end→commit | 正文首段 ready | filler 播完 | 正文首帧发布 | 空档 | evidence |
|---|---|---|---|---|---|---|---|---|
| …918006 | s02T「小可小可不要开灯」35152 样本 | gen「嗯。」960 ms（已验证） | **13 ms**（eou_ms=13，已验证） | +972 ms（ttfb 291，推算=合成起点+ttfb） | +998 ms（已验证，tick） | +998 ms（已验证） | 0（underrun 0，played 652 帧 = 0.96+5.56） | first_final 971 / end 271 / lead −700 / stream_end 985 |
| …918027 | poc_q1T「小可小可一加一等于几」43325 样本 | ask「嗯……」1000 ms（已验证） | **47 ms**（eou_ms=47） | +1339 ms（ttfb 288；LLM race main 462） | +1049 ms | +1349 ms | **340 ms**（underrun 1，first_underrun_ms=795 自 audio_start 计） | first_final 802 / end 365 / lead −437 / stream_end 1002（finals 2） |
| …918049 | s02T 缺片（跳 seq 3） | 无（未 commit） | — | — | — | — | — | result failed missing_seq，discarded zero commit，first_final/end/lead 均 null |

- A 型突发的 `final_lead_over_end_ms` 为负属正常（end 先于 final）；真机 B 型房才是要读的正数。
- worker 侧 0 ERROR / 0 panic；received=closed=3；MainPID 未变。模拟器客户端缺片场景退出 abort 同 B7（livekit-rtc 客户端问题）。

## 3. 观测行读法

- `body first sentence ready … body_ready_since_turn_ms=N`：N = TTS 首块到达相对 turn 起始（commit）的毫秒，字段是事件时刻，**日志行本身在整句合成完才打**（别拿行时间当事件时间）。
- `filler playout done … since_turn_ms` / `body first frame published … since_turn_ms`：50 ms tick 采样，二者之差 ≈ 空档；精确值看同轮 `playout metrics` 的 `underrun_ms`。
- 时钟：`unix_ms_now()` 差值 + `Instant`，不宣称严格单调；异常倒序不作提速证据（同意你 §4）。

## 4. 对复核单其余各点

- 同意：`final_lead_over_end_ms > 0` 只证首个 held final 先到，不证整句说完；本轮未加「收到 final 就 end」的协议或端侧行为。
- 同意：H2 80/80 不排除真人吞字、不确证 H1；不扩 lookback、不加静音、不再扫供应商。
- 同意：端侧 4 s 采集窗不受 A/B 影响；input_ready ≈2 s 与采集并行，不相加。
- 你独立复跑的 ordered 20/20、TurnGate 7/7 与本轮 228 不冲突（本轮新增 2 条 filler 测试，turn 测试扩断言）。

## 5. 未验证 / 未知

- 真机 B 型房上的选材命中、空档听感与 `final_lead_over_end_ms`（等川哥/codex 下一房）。
- 「嗯。」「嗯……」在真机喇叭上的可听时长（文件含首尾静音，未测）。
- 证据归档：`realtime-voice-agent/docs/oneshot-b6-20260909/{b8_sim_results.jsonl, poc_journal_b8_sim_rooms_20260909.log.txt}`（均未 commit，① 待令）。

署名：cc（Claude）| 2026-09-09 09:43 CST
