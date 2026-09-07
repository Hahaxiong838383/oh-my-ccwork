# 首句预滚（preroll）worker 侧设计（2026-09-07 定案，未开工）

> 依据与数字全在回执 `../../P003-product-definition/docs/2026-09-07-v240首句1of3根因分解…(给codex).md`（§3 方案、§6 勘误、§7 收益证据链、§8 预注册验收）；任务清单 `~/mycc/tasks/p003-首句预滚方案.md`；记忆 `project_p003_first_sentence_preroll.md`。

## 问题一句话
用户在招呼语可闻结束 −0.15…+0.3 s 开口，唤醒→worker 首帧 ≈1.24 s，谁先到抛硬币（今晚约定句 6/16 完整）。靠削时延赢不了，要把「可捕获起点」搬到端侧 AudioRecord 起点。

## 数据合同（端 → worker，reliable data）
`{"k":"preroll","seq":i,"total":n,"sr":16000,"g_end_ms":<招呼语播放头完成相对预滚起点的偏移>,"sent_ms":<端侧发送时刻(端钟,仅诊断)>}` + 紧跟 PCM s16le 分片（每片 ≤15 KiB，LiveKit reliable 上限）。端侧在收到 `session.input_ready` 时发送 [g_end−300 ms, now]。

## worker 流程
1. job 建房阶段（已有 prebuild）预连 ASR；订阅麦轨后活帧照旧入 `pcm_tx` 队列（不再直接喂 ASR），最多等预滚 400 ms；超时或 `preroll_missing` → 直接放行活帧（fail-open，即今天的路径）。
2. 预滚齐片 → 裁掉 g_end−300 ms 之前 → 取已到活帧前 200–400 ms 与预滚尾做归一化互相关（Opus 编解码后仍高相关；峰 <0.5 视为无重叠，按「预滚全喂 + 活帧从头」退化处理并计数）。
3. 预滚 + 接缝后活帧连续喂 Silero VAD 与火山 ASR（快于实时推送）；EOT 计数按帧不按墙钟，无需改。
4. 接缝前 300 ms 招呼语残余：现有 strict 回声门（单字/2–3 字子串吞）+ 新增 `strip_greeting_prefix`（textproc，LCS≥0.6 的库文本前缀剥离，仅开场窗、仅招呼语库）。
5. EOT 快照 t0000.wav 录进预滚（验收看得见前导与擦音）。
6. 日志：`preroll_received chunks=n/total bytes= g_end_ms= seam_offset_ms= seam_corr=`、`preroll_missing`、`preroll_seam_weak`。

## 测试
- 夹具：64.90 `/root/eot-snapshots/20260907T010128-b8d3d2/t0000.wav`（房 2）与 `…010145-456768/t0000.wav`（房 3）——含川哥人声，默认不入仓，复制到本地 `tests/fixtures/`（gitignore）。用前 600 ms 造预滚、后段造活帧并加 150 ms 重叠，断言 seam_offset 误差 ≤10 ms、corr ≥0.8。
- 负锚：无重叠（gap 200 ms）→ corr <0.5 且走退化路径；缺预滚 → 400 ms 后活帧放行且 `preroll_missing=1`。
- 幽灵句：裁切点改 g_end−1500 → strict 门必出现吞句（判据能红）。

## 配套（不在 worker）
S1 服务端显式派单（`device-session.ts` 签 token 同步 CreateDispatch，token 去 roomConfig.agents）；worker 加「设备 10 s 未进房关 job」守卫。端侧 D1/D2 见回执 §3.2。

## 工具
`../tools/eot_snapshot_analyze.py`（10 ms 帧 rms/过零/高频比，EOT 快照对撞）、`../tools/eot_snapshot_onset_classify.py`（起音形态分类，只做辅助）、`first-sentence-stages-20260907-0600-0912CST.txt`（33 房分段账）。
