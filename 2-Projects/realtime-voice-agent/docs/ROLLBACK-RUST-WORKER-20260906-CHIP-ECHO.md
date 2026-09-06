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
