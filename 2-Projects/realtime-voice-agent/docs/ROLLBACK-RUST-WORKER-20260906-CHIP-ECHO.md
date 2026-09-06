# 回滚记录 · rust-worker 芯片候选回声门 + 命令句单出口（2026-09-06）

> 变更：feat/rust-worker `9f9a96af2`（A 芯片候选播放窗持有 / B 命令句单出口）+ `25da353f1`（B 不 abort 在途轮，自检发现的 result 早于 commit 时序 bug）。本记录在部署前写好，部署后已补终值。

## 现役锚（部署前实读，64.90 `/root/rust-worker/`，服务器时钟 UTC）
| 项 | 值 |
|---|---|
| 二进制 | `voice-rust-worker` 72,035,640 B，sha256 前 16 `464da5a4c6122326`，= commit `1011e38a7` |
| 进程 | MainPID 1883691，ActiveEnter 2026-09-05 04:41:54 UTC（12:41:54 CST） |
| env | `rust-worker.env` md5 前 16 `d0bd412276756936`（本次**不改 env**） |
| 自动备份 | `deploy-worker-bin.sh` 换装时会 `cp voice-rust-worker voice-rust-worker.bak-<UTC 时间戳>`，即本次部署产生的 `.bak-20260906-*` 就是 464da5a4 原件 |

## 新版（已部署，第二次换装后以本节末行为准）
- commit `9f9a96af2`；二进制 sha256 前 16 `9172323a41aae661`（72,054,344 B，md5 a77b95b4…）；MainPID 1944292，ActiveEnter 2026-09-06 04:37:22 UTC（12:37:22 CST）；换装时 64.90 在途 job 0（received=closed=32）。
- 旧版备份实名：`/root/rust-worker/voice-rust-worker.bak-20260906-043721`，sha256 前 16 `464da5a4c6122326`（已核对）。
- 单测 195/195（新增 5）；clippy 与基线同一组存量 9 处，无新增；glibc ≤2.39 / libstdc++ ≤3.4.33 门禁过。

## 回滚三档（由轻到重，都要在活动 job=0 时重启）
活动 job 判据（在 Mac 上跑，aliyun-hk 到 64.90 的 key 受限）：
```bash
ssh root@64.90.13.117 "T=\$(systemctl show voice-worker-rust -p ActiveEnterTimestamp --value); journalctl -u voice-worker-rust --since \"\$T\" --no-pager | grep -c 'received job request'; journalctl -u voice-worker-rust --since \"\$T\" --no-pager | grep -c 'job closed'"
```
两个数相等 = 无在途 job。

1. **只关新行为（零二进制）**：`rust-worker.env` 追加 `DEVICE_CHIP_PLAYBACK_HOLD=0` 和/或 `DEVICE_CMD_SINGLE_EXIT=0` → `systemctl restart voice-worker-rust` → 日志核 `chip candidate held in playback window` 不再出现 / `command turn single exit` 不再出现。可只关一半。
2. **二进制回滚**：`cp /root/rust-worker/voice-rust-worker.bak-20260906-043721 /root/rust-worker/voice-rust-worker.new && bash /root/rust-worker/deploy-worker-bin.sh`（脚本自带 sidecar 清零等待与 registered 锚），核 `sha256sum voice-rust-worker | cut -c1-16` = `464da5a4c6122326`。
3. **源码回滚**：feat/rust-worker `git revert 0732a4ac6` 重走 home-studio 构建链。

## 回滚触发判据
- 真人一句命令被执行两次 / 回复被芯片截断再次出现（journal：播放窗内 `command_word 决策` 仍 `accepted` 且紧跟 `agent turn aborted`）。
- 真人连续两次「再亮一点」第二次不执行（journal：第二句 commit 后既无 `chip_candidate_confirmed_by_asr` 也无 L2 `llm device intent executed`）。
- 命令句提交后既无冻结短句也无 LLM 回复（单出口把嘴堵死：`command turn single exit` 之后 24 s 内无 `device command result` 也无「暂时没能确认调整结果」）。

## 终值（2026-09-06 12:41 CST，第二次换装）
- 现役 commit `25da353f1`，二进制 sha256 前 16 `73f8d5e8fbc56693`（72,054,632 B），MainPID 1944923，ActiveEnter 2026-09-06 04:41:03 UTC（12:41:03 CST）；换装时在途 job 0（received=closed=1）。
- 备份链：`voice-rust-worker.bak-20260906-044102` = 中间版 9172323a（9f9a96af2，只上线 3 分 41 秒，其间 1 个 job = 003 房（12:37:33 CST 起 17 s，journal 零 command_word/零提案/零回复事件，未触及新分支））；`voice-rust-worker.bak-20260906-043721` = **原版 464da5a4**（回滚目标）。
- 二进制锚（grep -a）：`command turn single exit`=1、`chip candidate held in playback window`=1、旧标识 `DeferredMotor`=0；env md5 仍 `d0bd412276756936`。

## 追加 · 词表补充（2026-09-06 13:25 CST，与二进制无关）
- 生产 `/root/rust-worker/device_aliases.tsv` 加 13 条口语别名（label 4/6 各 5、label 24 各 3），备份 `device_aliases.tsv.bak-20260906-pre-oral-aliases`（md5 3e3ad036…→ 新 c0835fa2…）；254→267 键，零跨标签冲突（本地脚本核）。
- 生效方式：零 job 时 `systemctl restart voice-worker-rust`（13:25:23 CST，PID 1949922，registered 1，零报错；二进制 73f8d5e8 与 env 未变）。表在房内首次匹配时懒加载，日志锚 `device alias 词表已加载 entries=267 origin=env-file`。
- 回滚：`cp device_aliases.tsv.bak-20260906-pre-oral-aliases device_aliases.tsv` + 零 job restart。仓库内置表已对齐（feat/rust-worker 6191ca0b9），只作 env 缺失兜底。


## 追加 · 第三次换装：开场重叠窗放宽本地招呼语回声门（2026-09-06 18:40 CST）
- 现役 commit feat/rust-worker `0019bb8e0`（含 `37e634c0b` 重叠窗 + `6191ca0b9` 内置词表对齐 + 「吊井」补回），二进制 sha256 前 16 `838999a88518891a`（72,047,104 B），MainPID 1985062，ActiveEnter 2026-09-06 10:39:24 UTC（18:39:24 CST），换装时在途 job=0（received=closed=26）。
- 备份链：`voice-rust-worker.bak-20260906-103923` = 上一现役 `73f8d5e8fbc56693`（25da353f1）。词表：`device_aliases.tsv.bak-20260906-pre-diaojing`（改前，md5 c0835fa2…）→ 现役 md5 `8e05852c447c7b92`（与仓库内置表逐字节一致）。
- 二进制锚（grep -a -c）：`local-audio echo suppressed (opening overlap)`=1（新）、`command turn single exit`=1、`chip candidate held in playback window`=1；env md5 `d0bd412276756936` 未动。
- 新门语义：设备房建房秒（房名尾巴≈唤醒时刻）+1000 量化 + `LOCAL_AUDIO_GREETING_MAX_MS`（默认 3200）+500 余量 = 截止；说完时刻 ≤ 截止的 commit，若 ≥2 字且与本地招呼语对撞库 LCS≥0.3 → 判回声丢弃（日志锚上行）；命令词/急停/退出词不进此门；截止之后维持原 LCS≥0.8 门。
- 回滚三档：① 零二进制：`rust-worker.env` 加 `LOCAL_AUDIO_GREETING_MAX_MS=0` + 零 job restart（只关新门）；② 二进制：`cp voice-rust-worker.bak-20260906-103923 voice-rust-worker` + 零 job restart（回到 25da353f1，词表「吊井」仍在，无害）；③ 词表：`cp device_aliases.tsv.bak-20260906-pre-diaojing device_aliases.tsv` + restart。
- 触发回滚的信号：真人在招呼语播放期间开口的短句被吞（日志锚出现且文本明显是用户话）连续 ≥3 次；或任何命令句被该锚吞掉（理论上被命令词豁免拦住，出现即 bug）。

## 追加 · 第四次换装：开场重叠窗改普适起点判据（2026-09-06 19:50 CST）
- 现役 commit feat/rust-worker `fcb9f81ef`（= 第三次 `0019bb8e0` + `ebb88e9a8` SN 应急表 + `fcb9f81ef` 起点判据），二进制 sha256 前 16 `37f1f19fd9bbe050`（72,044,504 B），MainPID 1987686，ActiveEnter 2026-09-06 11:50:00 UTC（19:50:00 CST），换装时在途 job=0。
- 备份链：`voice-rust-worker.bak-20260906-114959` = 第三次现役 `838999a88518891a`（0019bb8e0，19:50 前）；`.bak-20260906-103923` = 25da353f1。
- env：`rust-worker.env` md5 `d0bd412276756936`（**未改**）；19:44 曾追加 `LOCAL_AUDIO_OVERLAP_SKIP_SN_HASHES`(0006) 后于 19:48 用 `rust-worker.env.bak-20260906-pre-overlap-skip` 恢复——川哥要求普适方案，SN 例外不作为交付；该键代码里保留为空表应急杆。
- 新门语义（v3）：放宽分支（LCS≥0.3）只在「设备房 + 本会话第 1 句 + 首个 VAD 起点距输入环启动 ≤ LOCAL_AUDIO_OVERLAP_ONSET_MS(450) + 说完时刻 ≤ 建房秒锚 + 非命令/急停/退出」时启用；其余一律原门。日志锚同前，多 `onset_ms`。
- 回滚：零二进制 `LOCAL_AUDIO_GREETING_MAX_MS=0`（只关放宽门）；二进制 `cp voice-rust-worker.bak-20260906-114959 voice-rust-worker` + 零 job restart（回到第三次、无起点判据、无应急杆）。
- 触发回滚的信号：明早 0006 v237 首句房「就绪后立刻讲个故事」被 `opening overlap` 吞（应不可能：起点 ≥600ms）；或任何设备第 1 句真人话被吞且 onset_ms ≤450（判据阈值错）——先降 ONSET_MS 到 250 再考虑关门。

## 追加 · 第五次换装：放宽门 v4——判据改「第 1 句 + commit 前无 VAD 起点」（2026-09-07 07:29 CST）
- 现役 commit feat/rust-worker `ab32d4219`，二进制 sha256 前 16 `77465e8285fe6916`（72,039,336 B），MainPID 2013814，ActiveEnter 2026-09-06 23:28:07 UTC（07:28:07 CST），换装时在途 job=0。
- 备份链：`voice-rust-worker.bak-20260906-232805` = v3 `37f1f19fd9bbe050`（fcb9f81ef）；`.bak-20260906-114959` = 838999a8…（0019bb8e0）；`.bak-20260906-103923` = 25da353f1。env md5 `d0bd412276756936` 未动（`LOCAL_AUDIO_OVERLAP_ONSET_MS` 已从代码删除，env 中本就没有）。
- 为什么换：v3「VAD 起点 ≤450ms=回声」被今早真人打破（起点 +51/+104ms 也是真人），且回放昨日两条真幽灵句 journal 无 VAD 起点——v3 分支对真幽灵永不命中、对真人早开口反而命中。v4 只对「commit 前从未出现 VAD 起点」的第 1 句放宽（+ 截止 + 豁免 + LCS≥0.3）。
- 回滚：零二进制 `LOCAL_AUDIO_GREETING_MAX_MS=0`（关放宽门，原门不变）；二进制 `cp voice-rust-worker.bak-20260906-232805 voice-rust-worker` + 零 job restart（回 v3，注意 v3 判据反向，回滚意义只在 v4 出现新问题时）。
- 触发回滚的信号：任何设备第 1 句真人话被 `opening overlap` 吞且日志 `vad_onset_seen=false`（说明真人太轻没触发 VAD 且句子像招呼语）连续 ≥2 次 → 先把 LCS 阈值/截止收紧再谈关门。

## 追加 · 第六次换装：ASR 预连提前到建房阶段（2026-09-07 07:36 CST）
- 现役 commit feat/rust-worker `a1acbf517`（= v4 `ab32d4219` + 预连），二进制 sha256 前 16 `1d8f0b759cd65494`（72,052,008 B），MainPID 2015142，ActiveEnter 2026-09-06 23:35:50 UTC（07:35:50 CST），换装时在途 job=0。
- 备份链：`voice-rust-worker.bak-20260906-233549` = v4 `77465e8285fe6916`；`.bak-20260906-232805` = v3 `37f1f19f…`；env md5 `d0bd412276756936` 未动。
- 语义：job 层 assignment 到达即 spawn ASR 长连（`asr stream task spawned (preconnect)`），pipeline 接管；其余不变。
- 回滚：`cp voice-rust-worker.bak-20260906-233549 voice-rust-worker` + 零 job restart（回 v4，握手回到 pipeline 内）。触发信号：房间内 `asr 断线重连`/`火山 ASR 流异常` 频次上升（预连期间服务端空闲断开）或首句转写反而变慢。

## 追加 · 第七次换装：pipeline 预组装（2026-09-07 07:50 CST）
- 现役 commit feat/rust-worker `3a2af41c3`（= 预连 `a1acbf517` + 预组装），二进制 sha256 前 16 `f3707e7eae7e3a42`（72,137,496 B），MainPID 2017631，ActiveEnter 2026-09-06 23:49:55 UTC（07:49:55 CST），换装时在途 job=0。
- 备份链：`voice-rust-worker.bak-20260906-234953` = 预连版 `1d8f0b759cd65494`；`.bak-20260906-233549` = v4 `77465e82…`；env md5 `d0bd412276756936` 未动。
- 语义：job 收到 assignment 即 `tokio::spawn(pipeline::prebuild)`（ASR 预连 → 配置/LLM·TTS 客户端与预热/回声库拉取 → `spawn_blocking` 加载 VAD 模型/填充语库/声纹库），订到轨后 pipeline 接管；prebuild 失败或 join 失败 → 原地组装（旧行为）。锚：`pipeline prebuilt`（elapsed_ms）早于 `user_track_subscribed`，`pipeline takeover prebuilt`（prebuilt_age_ms）。
- 回滚：`cp voice-rust-worker.bak-20260906-234953 voice-rust-worker` + 零 job restart（回预连版）。触发信号：`pipeline prebuild failed` 频发、`track_to_input_loop_ms` 未下降、或 job 提前退出后残留 ASR 连接告警。
