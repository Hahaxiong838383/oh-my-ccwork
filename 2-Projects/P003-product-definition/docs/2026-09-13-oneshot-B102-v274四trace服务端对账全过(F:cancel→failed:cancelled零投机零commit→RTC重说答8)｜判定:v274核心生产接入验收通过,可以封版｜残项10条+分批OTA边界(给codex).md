# B102｜v274 四条 trace 服务端对账全部通过；判定：**v274核心生产接入验收通过，可以封版**；附残项 10 条与分批 OTA 边界

**结论：按 B101 §6 只查既有日志（未改代码、未切策略、未重启、未录音）。D/E 首句全句到达并各一次提交（10 字 / 28 字），T 走 wake_only 再普通轮，F 收到 ordered cancel 后 worker 给出 `failed:cancelled action=repeat_prompt finals_held=0` 并切 RTC，首句零 speculation / 零 commit / 零 caption / 零正文，重说作为普通新轮一次提交答 8；四房全在 firstturn 池，生产池对 0010 零命中；所有签发行 `contract=first_turn_v1 policy=capability policy_src=env`。无阻塞。判定原句：v274核心生产接入验收通过，可以封版。服务端封版件已落（release.json 版本卡 + RELEASES 封版记录 + 标签），残项与 OTA 分批边界见 §6/§7。**

## 1. 四轮对账（worker 钟 UTC；设备钟比 worker 钟固定慢约 1.75 s，不跨钟相减）

| 轮 | trace | 签发 | firstturn begin | 设备 `end` | 识别全文 / 样本 / 尾静音 / 丢片 | 提交 | 首个远端音 | worker underrun | 关房 |
|---|---|---|---|---|---|---|---|---|---|
| D 短连说 | `855b8a5e-…` | ✓ first_turn_v1 / capability / env | 13:58:44.713Z `local_receipt=true`，首块 +42 ms | `end_ms=917`（设备 begin→end 1125 ms） | **「小可小可3+5等于几」10 字**，first_final 1342 ms；61,920 样本 = 3.87 s；尾静音 630 ms；packets 99 / rejected 0 / cropped 0 | 1 次（eou 0，投机 lead 10 ms） | **正文**（设备本地承接 → `filler skipped`，`receipt_done` +606 ms 放行，body first frame since_turn 1299 ms，ttfb 290） | 0 | idle cancel seq 2 → ClientInitiated |
| T 传统 | `645a03ba-…`（prefetch） | ✓ | `local_receipt=false` | `end_ms=400` | 「小可小可」4 字 → `no_task wake_only`；37,280 样本；尾静音 410 | 普通轮 1 次「3+5等于几」（eou 788 / stt 746） | filler「嗯……」1000 ms → 正文 since_turn 1599，ttfb 313 | **1×562 ms @800 ms**（filler→正文交接） | idle cancel seq 4 |
| E 长连说 | `7d129eac-…`（prefetch） | ✓ | 14:00:02.834Z `local_receipt=true` | `end_ms=4755`（设备 4757 ms，< 6 s 预算） | **28 字全句「小可小可请你认真听我把这句话说完再回答我到底3+5等于几」**，first_final 5036 ms；128,000 样本 = 8.0 s；尾静音 1400；packets 202 / 0 / 0；interims 18 | 1 次（eou 43） | 正文（`receipt_done` 放行，since_turn 1047，ttfb 291） | 0 | idle cancel seq 6 |
| F 超预算重说 | `21306920-…`（prefetch） | ✓ | 14:00:51.346Z `local_receipt=true`，首块 +17 ms | **未到** | 首句：`finals_held=0`（ASR 未出 final；与端侧 speech 4768 ms / quiet 0 一致） | **首句 0 次**；重说普通轮 1 次「3+5等于几」14:01:04.276Z（eou 897 / stt 850） | filler「嗯，怎么说呢。」2400 ms → 正文（ttfb 250） | 0 | idle cancel seq 8 |

`end_candidate_ms` 在 D/T/E 均 null（设备 `end` 先到，候选用不上）；F 无终态 evidence（失败 result 不 dump，B100 缺口）。生产池 13:58:30–14:01:40Z 对 0010 **0 行**。

## 2. F 闭环逐点（B101 §6.3）
1. **收到 cancel**：14:00:56.402Z `ordered_pcm result {"status":"failed","reason":"cancelled","action":"repeat_prompt","finals_held":0,"received_next":577440}`——begin accepted 后 5.06 s；设备 `first_turn_cancel_sent` 22:00:54.649 CST 与 worker 收到时刻的差正好是两钟固定偏移（≈1.75 s，D/T/E/F 四房 begin 都是这个差），即 cancel 即时到达。
2. **outcome cancelled → RTC**：同一毫秒 `input phase → rtc reason=first_turn_failed:cancelled`；result 里的 `action=repeat_prompt` 就是端侧 66 ms 后收到的 `first_turn_phase outcome=FAILED` 的来源。
3. **旧首句零输出**：begin→cancel 的 5.06 s 内没有 `speculation on held final`、`turn committed`、`caption final published`、`filler picked`、`body first frame`（对照 D/E 全有）。
4. **重说 = 普通 RTC 新轮**：14:01:03.7Z `S1v3 preflight tail='三加五等于几'` → 14:01:04.276Z `turn committed: 3+5等于几`（普通判停口径 eou 897）→ filler → 正文 → playout underrun 0。`preemptive miss … spec_text=三加五等于几` 是普通路径对 interim 的投机被丢弃，不是首句泄漏。
5. **关房**：control cancel seq 8（idle）→ MUTED → ClientInitiated，无异常。

## 3. 邻机与环境（只陈述观察，不断言来源）
每次 0010 唤醒后 1–3 s，***0003 / ***0004（D 轮还有 ***0006）各签一次普通合同并接生产池房，且**都听到并回答了 Air 的话**：T 轮 0003 committed「三加五等于几」并播出；E 轮 0003/0004 均 committed「这句话说完再回答我到底3+5等于几」并播出（与 0010 的回答 14:00:09–13.7Z 重叠）；F 轮 0003 committed 重说句并播出，另有一句「哦」barge。四房 0010 的识别全文均正确，未见邻机声进入 0010 的 commit。

## 4. underrun（worker 播出侧口径，独立于端侧统计）
D 0 / **T 1×562 ms**（filler 1000 ms 播完时正文尚未就绪，body first frame since_turn 1599 ms）/ E 0 / F 0。同型历史：旧 D 374 ms、B 房 turn3 222 ms、邻机 0003 F 轮 735/475 ms。这是 filler→正文交接的既有播出缓冲问题，两池都有，与 v274 无关，列残项 3。

## 5. 判定与封版件
**v274核心生产接入验收通过，可以封版。**
- server：线上 `device-session.ts` `3feaa45b…` / `admin-data.ts` `43230d3c…` / `config-store.ts` `4d95aef2…` 与仓库 HEAD 逐字节一致；`ONESHOT_FIRST_TURN_POLICY=capability`（env），`runtime_flag` 0 行，pm2 pid 1636316 未重启。
- Worker：`voice-worker-firstturn` exe `c2b84b2e…`（299b074）MainPID 2902239，MAX_JOBS 10 / MemoryHigh 1200M / Max 1500M；`voice-worker-rust` MainPID 2720004 未动。
- APK：v274 `1.2.2-canary.262`（274）85,670,286 B，sha256 `0017dc5072c3a0fa6db77db4e3c7dc72bfd3aaa84e05b0d021e455156d59ddda`；回滚包 v272 `9f0eec54…`。
- 本轮服务端动作：`release.json` 版本卡更新为 v274 + 封版信息（单文件替换，`readFileSync` 每请求读，不重启，先备份）；`RELEASES.md` 封版记录；git 标签 `p003-v1.1-oneshot-sealed-20260913`。策略未切、worker 未动。

## 6. 已知残项（封版时冻结，不阻塞）
1. Worker 次级判停候选（端侧 `first_turn_worker_candidate`）离线覆盖、实机未命中——等自然样本；命中后我按 trace 对 worker `end candidate published quiet_ms` 行。
2. ready 3 s 兼容兜底（`input_ready_fallback mode=compatibility`）仍在，未修。
3. worker 播出 filler→正文交接 underrun（§4），既有问题，非 v274 引入；worker 侧改动待 V1.1 解冻。
4. worker 被动断连 / 失败代次不 dump `decision evidence`（B100 缺口），一行改动待排。
5. 同声场多设备同醒（§3）——真实产品场景未处理，多机家庭/教室会「齐答」。
6. off 回滚点在 v274 上未实机复验（v272 实机 B/C 通过；你口径：v274 九文件差量不含 wake/contract 解析，离线 1035 项含回落测试）。建议第 1 批 OTA 后做一次 B/C，我切开关 5 分钟。
7. 真人听感 / 物理首音时延未测（Air 代理 D 2556 / T 771 / E 1841 / F 722 ms 含观测链路）。
8. APK 85.67 MB > 80 MB 目标（< 150 MB 红线）。
9. v271 原包不追溯（off 对 v271 仍是止扩）；v273 REJECTED，版号不复用。
10. 生产池 `voice-worker-rust` MemoryPeak 1.12 GiB（MemoryHigh 1.4 GiB 的 82%），与 One-shot 无关；分批期间老端流量仍走它，需盯。

## 7. 分批 OTA 边界（服务端）
- **容量算术（真数据，不是配置相除）**：firstturn 池 MAX_JOBS 10；今天 17 房峰值并发 **1**、MemoryPeak **48 MB**（单房级）；近 7 天签发过的设备 **9 台**（`ota_device_status` 9 行）。9 台同时说话也 ≤ 9 < 10。规则：峰值并发 ≤ 70% MAX_JOBS（7）；机队 > 14 台前先扩（单房内存很小，直接加 MAX_JOBS 或第二实例都行）。
- **池满的样子**：LiveKit 无该 agentName 可派 → 首句房无 worker → 端 6 s 超时 → 提示重说，但 RTC 也无人接（B99 §2「无可信 phase 关闭」出口）。分批期间看 firstturn journal `accepting` 与 `job closed` 差、签发行 `policy/supports`、`result outcome` 分布（task / no_task / failed:cancelled）、underrun。
- **建议**：第 1 批 = 0010 + 1–2 台此前只走普通合同的老端（0003/0004）→ 我交每台首次 `first_turn_v1` 签发行 + firstturn 接房 → 一次 off B/C 复验（残项 6）→ 第 2 批余下。回滚顺序不变：后台 off（v272+ = 普通回退）→ 端侧回退 v272 → 服务端文件级回滚 `_backup/20260913-070625-b84-policy/`。
- 证据钩子（分批期间我按 trace 交）：`[device-session] ok … contract/policy/policy_src/supports`；firstturn `begin accepted local_receipt`、`result outcome`、`decision evidence`（samples/end_ms/trailing_quiet）；`end candidate published`（残项 1）；`playout metrics underrun`。

署名：cc（Claude）| 2026-09-13 22:20 CST
