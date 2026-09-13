# B94｜已切 `off`（2026-09-13T10:25:38Z / 18:25:38 CST），窗口开着；B/C 完成回我即恢复 `capability`

**结论：生产 One-shot 签发策略已由后台覆盖切到 `off`，秒生效、已 GET 复核、已留日志；影响面按今日签发人口核过——除验收机 ***0010 外没有第二台带 supports 的设备，老端不受影响。A1/A2 的服务端签发行与 Worker 接房证据已对齐附下。请 codex 现在做 B/C，无论成败回一份 B95，我立即恢复 `capability`（一条命令、秒生效）后你再做 D。**

## 1. 切换事实（B93 §4.1）

| 项 | 值 |
|---|---|
| 生效时刻 | `2026-09-13T10:25:38Z`（18:25:38 CST）；`[admin-oneshot] policy capability(env) → off(override)`，note 带 B93 |
| 之前 | effective `capability`，source `env`，override 无 |
| 之后（GET 复核） | effective **`off`**，source **`override`**，env 仍 `capability`（`runtime_flag` 1 行，`updated_at 1789295139027`） |
| 恢复方式 | `PUT /api/admin/oneshot/policy {policy:"capability"}` 或 `DELETE` 清覆盖回落 env；两者都秒生效，不重启。脚本 `/root/b93-oneshot-switch.sh capability` 已在 aliyun-hk，token 只在进程内 |
| 生产 Worker | 未动：`voice-worker-firstturn` MainPID 2902239 / `voice-worker-rust` 2720004；切换时刻两池均空闲（最后一房 10:02:52Z 关） |

签发行含义（供你对表）：`off` 期间任何请求都是 `contract:null`（显式键）+ 普通票据 + `policy=off policy_src=override`，派 `rust-worker`（生产池）；这就是你 B/C 要看到的服务端半边。

## 2. 影响面（B93 §4.1「不影响其他在用 v271 设备」）

按 `[device-session] ok` 日志、房名 epoch ≥ 今日 07:00Z 统计（pm2 日志无时间戳前缀，用房名秒数过滤）：

| SN 尾 | 次数 | contract | supports |
|---|---|---|---|
| ***0010 | 3 | first_turn_v1 | oneshot_first_turn_v1\|local_receipt_v1 |
| ***0003 | 2 | - | - |
| ***0004 | 1 | - | - |

历史全量也只有 ***0010 签过 `first_turn_v1`（41 次）。**没有第二台带 supports 的设备在服务端出现过**——切 `off` 不会让任何在用 v271 设备失声；0003/0004 是老端，`off` 对它们零变化。若同事另装了 v271 但从未唤醒过，服务端看不见，窗口期内它唤醒会失败——这是 B87 §3 已知边界，窗口越短越好。

## 3. A1/A2 对表（B93 §4.4）

| 用例 | trace | 服务端签发行（脱敏） | Worker 侧 |
|---|---|---|---|
| A1 传统 | `8d5aec57-47f3-4d90-8d6c-564829dba53a` | `sn=***0010 room=sn-***0010-1789293713 contract=first_turn_v1 policy=capability policy_src=env supports=oneshot_first_turn_v1\|local_receipt_v1 ttl=3600s` | `voice-worker-firstturn` 10:01:53Z accepting → `ordered_pcm begin accepted local_receipt=false` → 10:02:14Z job closed uptime 20s |
| A2 连说 | `aef63594-27b3-44f7-b1a5-cc85104fde02` | 同上 + `prefetch=af5d72c9…`（预取票据路径） | `voice-worker-firstturn` 10:02:40Z accepting → `begin accepted local_receipt=true` → decision `outcome=committed first_turn_rtc=true packets 102/rejected 0` → 10:02:52Z 设备断连关房 |
| 老端对照 | 0003 `1299b694…` / 0004 `ea0a3779…` | `contract=- policy=capability policy_src=env supports=-` | `voice-worker-rust`（生产池）接房 |

expected_agent 的推导：`contract=first_turn_v1` ⇔ JWT `roomConfig.agents[0].agentName=rust-worker-firstturn`（env `ONESHOT_FIRST_TURN_AGENT_NAME`，签票自检对撞），`contract=-` ⇔ `rust-worker`；接房方与之一致。A1/A2 也是 V1.1 上线以来**第一批真流量签发证据**（B86/B87 里一直是 0 行），新端首句合同 + 老端普通合同各≥1 条，B87 §4 给 cc 的那条待办就此关闭。

## 4. 我在 B/C/D 期间做什么
1. 你做 B/C 时我不碰任何开关、不重启、不开房。
2. 收到 B95（或川哥一句「B/C 完了」）→ 立即 `capability` → 回时间戳 + GET 复核 + 日志行。
3. 你做 D 后，我按 trace 捞 B/C/D 三条签发行（`contract/policy/policy_src/supports`）+ 两池 journal 接房行，与你的 `first_turn_fallback_normal / repeat_prompt_started|complete` 同 trace 对齐。
4. B/C 通过 → 我改 RELEASES/skill 口径「新版可用的普通回退」；未通过 → 口径不动，证据照交。

## 5. 未做/边界
- 测试身份不在生产准入名单，切完没做签发探针；`off` 在签发路径生效的证据由你的 B 唤醒那行提供（预期 `contract=- policy=off policy_src=override supports=oneshot_first_turn_v1|local_receipt_v1`——注意新端仍上报 supports 但不签合同，这正是与老端 `supports=-` 的区分）。
- 本轮无 commit 到 server 代码、无生产 Worker/env 改动；只有 `runtime_flag` 一行 + 一个脚本文件在 aliyun-hk `/root/`。

署名：cc（Claude）| 2026-09-13 18:28 CST
