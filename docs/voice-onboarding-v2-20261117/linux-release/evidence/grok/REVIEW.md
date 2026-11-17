# 主 13 语音教学 V2 发布与回滚评审

署名：Grok。只读。没有改业务代码，没有 SSH，没有部署，没有改配置。

结论：**可以按既定顺序做这次替换。** 主 Worker 只在空房时换 binary，Brain 只换 8 个文件，两道教学闸保持关闭。发布器在备份、漂移拒绝、异常回滚、默认关闭这四件事上没有足以阻止这次发布的问题。

这次结论只覆盖「闸门继续关闭」的代码替换。APK 未测。038 不是 V2 联调设备。教学声学闭环未做。

## 阻断

无。

## 已核对的身份

工作树 `/Users/fu-121/.codex/worktrees/p003-voice-onboarding-20261117` 的 HEAD 是 `786a135bcc2f42037b117ec2d3582fcb3af2409b`。`42df1d0320aec5338c9d1be2c11de6e514966944` 是它的祖先。八个 Brain 文件的工作树 SHA-256 与 `BRAIN-MANIFEST.json` 的 `after` 一致，也与该 HEAD 的文件字节一致。四个已有文件的 `before` 与提交 `18a230754941ad9781db4d39e5a12a9622fc7349` 以及在线 precheck 一致。四个新文件在该基线提交和在线 `src/` 里都不存在。

唯一未跟踪项是 `docs/voice-onboarding-v2-20261117/linux-release/`。它不在 `786a135` 里，本次不把它当候选证据。

`STAGED-CANDIDATE.json` 的 `deployed` 为 false。两边的 `check` 都已在目标机返回，且声明没有改运行态：Worker `idle: true`，Brain `gates_off: true`、`files: 8`、`port: 3001`。

## 发布器

Worker 脚本只替换 `/root/rust-worker/voice-rust-worker`。动手前要求主机名、运行中的 binary、磁盘 binary、候选 binary、env 文件和 systemd unit 都是固定哈希；`check`/`apply` 时期望旧哈希，`rollback` 时期望新哈希。env 和 unit 只备份，不回写。倾听池和搜索池只比较 `MainPID`、`NRestarts`、`ActiveState`。空房条件是 `ListRooms` 的 `rooms` 为空，且 cleanup 状态健康、`remaining == 0`、年龄小于 120 秒。`check` 已经满足这组条件。

`apply` 先把旧 binary、env、unit 写入 `worker-before`，再停服务、换 binary、等 `registered worker`。异常路径在已经停过服务时停干净，若新 binary 已写入则从备份写回旧字节并 `start` 旧哈希。备份文件在替换前落地。

Brain 脚本只替换清单里的 8 个路径。动手前要求 8 个文件处于 `before`（新文件必须不存在），pm2、`.env.local` 和整个 `src/` 快照没有并发变化。`VOICE_ONBOARDING_ENABLED` 与 `VOICE_ONBOARDING_V2_ENABLED` 按文件解析都不得为 `1`，否则 `check`、`apply`、`rollback` 一起拒绝。在线 precheck 的 `flags` 是空对象，这两项以及 `LIVEKIT_AGENT_NAME` 都没有以朴素 `KEY=value` 出现。

两份 SQLite 用在线 backup，并对备份做 `quick_check`。回滚字段写死 `database_restored: false`，源码恢复不碰数据库。异常时按清单把 8 个文件恢复到 `before`（新文件删除），再重启旧进程。替换后要求其余 `src/` 文件哈希不变，其他 pm2 进程的 pid、状态、重启次数和 cwd 不变，env 文件哈希不变。

闸门关闭时，这次重启不会为了健康检查去建教学表。`index.ts` 只把 store 工厂挂到路由上。无 worker JWT 的 `POST /v1/internal/voice-onboarding/v2/step` 在打开 store 之前返回 403 `worker_unauthorized`。`issueVoiceOnboarding` 只有在总闸、普通池、非倾听、精确 agent 和 SN 名单同时成立时才构造 store。store 构造函数里的 `family_member` 加列和教学表创建不会走这次默认关闭的启动路径。

## 非阻断

1. Brain 的 `pm2 restart p003-voice` 没有空房判断。主 Worker 有。脑端重启会打断当时的设备会话。两次 apply 都放在同一次空房窗口里。
2. 在线 `src/` 快照是 220 个文件。其中 4 个是要替换的旧文件，其余 216 个由哈希比对保住，另外 4 个是新文件。脚本保住的是整个 `src/` 里清单以外的文件，实测数量是 216，不是 360。`src/` 以外的 scripts、package.json、deploy 不在快照里，脚本也不写它们。
3. SQLite 备份在文件不存在时会静默跳过，不要求恰好两份。apply 回执里的 `dbbackups` 必须同时看到 `devices.db` 与 `profile.db`，且当时 `quick_check` 已通过。少于两份就按失败处理，不要继续认为备份完成。脚本不会把整库回灌。
4. Worker 的 `rollback` 子命令要求服务仍是 `active`，且进程和磁盘都已经是新哈希。apply 过程中的异常会自己写回旧 binary 并启动。脚本被杀死、单元已停、或事后进入 `failed` 时，不要依赖这个子命令。人工把 `worker-before/binary` 拷回 `/root/rust-worker/voice-rust-worker`，模式保持可执行，再 `systemctl start voice-worker-rust`。
5. Worker 异常路径在写回旧 binary 之前有 `assert sha(B)==NEW`。刚写上的文件若不是新哈希，断言会跳过 `start(OLD)`，服务停着。候选文件在检查后被改掉才会走到这里。备份字节仍在 `worker-before/binary`。
6. 倾听池和搜索池的 binary 哈希不在 Worker 脚本的比对里，只比对单元身份。脚本不写这两个路径。precheck 与隔离 SDK 前后看到的哈希是：倾听 `c7e70e77e4600e09b02f885101a17e8e7cea0e9635bc430d456b88081b6289d5`，搜索 `c7bec7df92c47136fd0c91e5c2b4ed59c918ffa7158cdfb3a63415fa1e221b25`。
7. 重启后的 403 只证明新路由会拒绝没有 worker JWT 的请求。总闸开着时，无 JWT 同样是 403。闸门证据是 `.env.local` 的解析和文件哈希，加上代码里只有精确 `=== "1"` 才开启。
8. 发布器的 env 解析比 Node `--env-file` 窄：不认 `export ` 前缀，不去行尾注释。当前文件被解析成没有任何 `VOICE_ONBOARDING_*` 项。Node 不会用文件里的值覆盖 pm2 里已经存在的同名变量；脚本没有读 `p003-voice` 的进程环境。没有证据表明进程环境里这两项已经是 `1`。
9. 八个文件逐个替换。Python 异常会恢复。SIGKILL 落在循环中间时，`rollback` 会因为文件没有全部到达 `after` 而拒绝，需要按 `brain-before` 人工对齐。正常异常路径会恢复并重启。
10. `umask 077` 会把新源码收成属主 `0600`、Worker binary 收成属主 `0700`。Worker 路径在 `/root`，分析服务单元写的是 `User=root`。执行用户需要就是 `p003-voice` 的运行用户。check 没有打印 uid。

## 测试边界

Linux 构建日志，源码 `786a135bcc2f42037b117ec2d3582fcb3af2409b`，Node v24.19.0：

- Brain：`tests 30 / pass 30 / fail 0`。日志含「默认关闭；倾听、搜索、未知 agent 和客户端拿不到 grant」。
- Worker 全库：`639 passed; 0 failed; 2 ignored`。两个 ignore 是 `stt_volc` 的真实供应商合成 WAV，以及 `rtc_business_probe` 的真实 RTC 探针。它们没有算进 639。

在线源码 staging 的 `brain-stage-tests.json`：Node v22.22.2 与 v24.19.0 都是 exit 0，`production_mutated: false`。这份 json 只有退出码，没有把 30 这个数字再写一遍。30 的正文在 Linux 日志里。

隔离供应商 SDK：普通池 `normal` 一轮，`passed: true`，rc 0。候选 binary 是新哈希。生产三个单元的 pid、重启次数和 binary 哈希在跑完后与开跑前相同，主 Worker 仍是旧哈希。边界写明：私有 loopback SFU、合成身份和 LLM、真实 ASR/TTS、SDK、不是 Android、没有改生产服务、配置或房间。

这轮 SDK 是普通对话路径。它不是教学 begin、不是声学闭环、不是 APK。

## 明确未测

- 新版 APK：未测。结果是 `NOT_RUN`。OTA precheck 里 5 条发布记录，最高 `version_code` 367（`1.2.2-canary.353`），没有 400。
- 038 自报 v400：不是 V2 能力证明，也不能写成实机可用。倾听池 window 当前 `enabled: true`，名单里有 `BJP00326070803800006`。教学 grant 要求普通池且不是倾听。038 走倾听池时，正常池教学 grant 会拒绝。
- 单机真实联调：等新版 APK 和 SN 确定后再做。在那之前两道闸保持关闭。

既有代码审查不在本次重开。`40233116` 上的 ordered 首句阻断已经由后续提交处理，`42df1d0` 的退出增量审查没有代码阻断。那些审查都没有把真机或 APK 写成通过。本次也不写。
