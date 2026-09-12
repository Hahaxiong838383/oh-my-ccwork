# B37｜灰度换装完成回执（无采音部署）

日期：2026-09-12。**只换了 `voice-worker-firstturn` 一个 unit，两条音频采集通道都关。未铸房、未跑音频、未改语音策略。**

## 1. 结论先行

换装完成并验证通过。**生产 `voice-worker-rust` 的 PID / ActiveEnter / NRestarts 三项与换装前逐字相同**，二进制未被触碰。灰度新进程注册成功、零错误、零新增采集文件。

你 §4.1 那条陷阱我自己核过源码确认成立，**而且实际情况比你写的更危险**：`EOT_SNAPSHOT_DIR` 不只定义在灰度自己的 env 文件里，**也定义在 `/root/rust-worker/rust-worker.env` —— 那是生产 worker 自己的 env 文件，灰度 unit 在层叠中也加载它**。改那个文件会直接关掉生产的采集。所以我一个 env 文件都没动，改用 unit 级 `UnsetEnvironment=`。

## 2. 你 §3.4 点名要的四项

| 项 | 值 |
|---|---|
| 旧二进制 SHA256（回滚锚） | `637a77fdf89bc0dfdeab8a8d2f42d52dfbffde085d62a80dc9236dd423e29275` |
| 新二进制 SHA256 | `4ba3b3a8a834667e218de77965e6f9f3a5905bd2b7f7f8edb2ec42b16e380f99` |
| 灰度 MainPID / 启动时刻 | **2695094** / `2026-09-12 03:56:16 UTC`（= 11:56 CST），`NRestarts=0` |
| 灰度换装前 | PID 2612447 / `2026-09-11 07:54:26 UTC` |
| **生产 换装前** | PID **2017631** / `2026-09-06 23:49:55 UTC` / `NRestarts=0` |
| **生产 换装后** | PID **2017631** / `2026-09-06 23:49:55 UTC` / `NRestarts=0` —— **三项逐字相同** |
| 生产二进制 | SHA256 前 24 位 `f3707e7eae7e3a42def95a61`，mtime 仍是 `2026-09-06 23:49:50 UTC`，未触碰 |
| 采集通道 ① 旧 EOT | **`EOT_SNAPSHOT_DIR` 在新进程环境中出现 0 次 = 真 unset**（不是空串） |
| 采集通道 ② 新打断快照 | **`INTERRUPT_SNAPSHOT_ENABLED` 出现 0 次 = 未设 = 关** |

**两个开关分开报，没有用「新开关关了」代指「全关」。** 阴性判断都配了正锚：同一条 grep 通道上 `AGENT_NAME=rust-worker-firstturn` 命中 **1** 次——证明通道有信号，「0 次」是真的没有，不是 grep 写错了。

## 3. 换装过程与逐步核验

**飞行前（只读）**

- 空闲判据：`received job request` 5 次 / `job closed` 5 次，相等 = 无活跃房；最后一条是 `job closed`（02:05:24 UTC）。**停之前又重新核了一次**，不是拿飞行前读数顶替。
- `readlink -f` 对撞：灰度 `/root/rust-worker-firstturn/voice-rust-worker`，生产 `/root/rust-worker/voice-rust-worker` —— 不同路径、不同 inode（777150 / 1032741），无软链塌缩。

**备份（`/root/b36-backup/`）**

- `voice-rust-worker.old`（含上表完整 SHA）、`voice-worker-firstturn.service`、`rust-worker-firstturn.env`，均 `cp -p` 保留时间戳。

**二进制三点对撞**：构建机 → Air → 64.90，三处 SHA256 全等且等于 B35 交给你的值；落位后再核一次 `/proc/2695094/exe` 的 SHA256 仍是该值 —— **跑着的确实是这个文件，不是「我放上去的那个文件」**。

**unit 改动（只在灰度 unit）**

```text
UnsetEnvironment=EOT_SNAPSHOT_DIR
UMask=0077
```

`systemd-analyze verify` 通过。改完确认：`/root/rust-worker/rust-worker.env` mtime 仍是 `2026-09-03`、其中 `EOT_SNAPSHOT_DIR` 键仍在（**生产的采集不受影响**）；生产 unit 文件 mtime 仍是 `2026-09-07`。

**执行**：`daemon-reload` → 再核空闲 → `stop`（MainPID 归 0）→ `install -m 755` 换二进制 → `start`。**全程只碰这一个 unit。**

**换装后核验**

- `/proc/2695094/status` → `Umask: 0077` ✓
- `registered worker worker_id=AW_jCS2M5KZX3tw server="1.13.2"` —— 注册成功、在等活
- 启动后 err 级日志含 worker 的行数 **0**（正锚：info 级 681 行，证明通道有效。注：`journalctl -p err | wc -l` 会因 `-- No entries --` 占位行返回 1，不能当成 1 条错误）
- **换装后新增采集文件/目录数 = 0**（`find -newermt` 计数，非截断；正锚：该树历史条目 16 个，证明 find 有效）
- **`WorkingDirectory` 下相对 job 目录数 = 0** —— 你担心的空串写出相对路径**没有发生**
- 灰度内存 24MB（上限 900M）；`voice-worker-rust` / `voice-worker-colleague` / `voice-console` 三个服务均 active

## 4. 回滚（随时可用，一步）

```text
systemctl stop voice-worker-firstturn
install -m 755 /root/b36-backup/voice-rust-worker.old /root/rust-worker-firstturn/voice-rust-worker
systemctl start voice-worker-firstturn
```

unit 与 env 的原件同在 `/root/b36-backup/`。回滚后应核 SHA 回到 `637a77fd…29275`。

## 5. 本次生效的行为变化（就这一条）

采集全关的前提下，新二进制相对旧版对灰度设备的**唯一**可观察差异是 ready 的诊断日志：

- 新增 `control publish result`（含 `publish_ok` / `send_ms` / `scheduled_at_job_ms` / `trace`，**不含 room**）
- 旧行改成 `session.input_ready published(scheduled) trace=…`（同样去掉了 room）

**发包本身一字未改**（同样的 DataPacket、同样 reliable、同样 spawn 异步），没有重发、没有改发射点。打断取证的代码路径在开关关闭时第一行即返回。

⚠️ 范围提醒（B35 已说过，这里再钉一次）：**我只去掉了这三条新诊断行的 room，worker 其余日志仍普遍带 `room=sn-…`**，journal 整体并没有变成无 SN，别按已脱敏处理整份日志。

## 6. 采集窗口的准备（按你 §4.2，尚未执行）

你指出 `events.jsonl` 在 **sink 根目录**而非 job 子目录，B35 我那份按 job 目录清单删只覆盖得到 WAV —— 成立，已采纳你的建议：

真正人验时用**本窗口独占的新根目录**（仍在受保护快照树下），开窗即落「窗口根 + job 清单」，根/job 700、WAV/events 600（`UMask=0077` 已就位，实测新建时再复核）；收尾只按该专属根清理，**绝不删历史混合 events**。兜底定时在开窗那一刻就用 `systemd-run --on-active=24h` 排好，覆盖 WAV 与 events；清理前先停采集、等后台写入收束、校验路径在快照根下且拒绝符号链接逃逸、逐条按清单删，**不裸 `rm -rf`**。

**这是计划，尚未部署。** 开窗时我会把实际执行状态回交，不把计划写成已做。

另：两条通道共用同一 sink 的配额与清理，「每房打断配额 3」不等于 EOT 通道总共只录 3 段 —— 这点我记下了，开窗用独占根正好也把两边的账分开。

## 7. 本轮做了什么 / 没做什么

做了：备份 → 传二进制（三点对撞）→ 灰度 unit 加 `UnsetEnvironment` + `UMask` → `daemon-reload` → 停/换/起灰度 → 逐项核验。

没做：未铸房、未跑任何音频、未开任何采集、未改 Session API / 灰度名单 / TTS 首段开关 / 回声门 / VAD / 短词门 / STOP·EXIT / AEC / 音量 / 追补环（仍 0）、未碰任何共享 env 文件、未重启生产或其他任何 unit、未删除任何历史采集文件。

状态：**灰度换装完成且无采音；等你开端侧 first-turn flag 并确认川哥在旁，再协调 10 分钟受控窗口。**

署名：cc（Claude）| 2026-09-12 11:59 CST
