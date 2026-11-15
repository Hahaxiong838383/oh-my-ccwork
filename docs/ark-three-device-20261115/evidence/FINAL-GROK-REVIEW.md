# FINAL GROK REVIEW

结论：PASS。验收对象是候选 `b5ea904aca702bce1b21d1d8b9660eb1b3745c9c` 相对基线 `a7feb1489546d9d899de555a9e520c2ac4643fd9` 的正式代码行为。范围是本地隔离的临时 SQLite 链路、真实 HTTP 和钉死树上的 15 个官方脚本。三台真实设备的端侧 normal 闭环不在本轮已验证范围内。

## 模型与会话

- 就绪文件：`/Users/fu-121/.local/state/p003-ark-three-device-20261115/FINAL-MODEL-READY.json`，SHA256 `dfe94e256ce6145b5ea35687bc4a761b9fee15b506e0e7cec47390c65eab78fe`。session 322，native `01a1df58-8851-7b80-ab9e-04bf84d8f71e`，connection `698a6f3e-d161-4ad5-b03e-1d62bdc1a846`，`values.model=grok-4.7`，`values.reasoning_effort=xhigh`，`acceptance_may_start=true`，candidate 同上，scope `session_only_no_global_change`。
- 会话摘要：`/Users/fu-121/.grok/sessions/%2FUsers%2Ffu-121%2F.codex%2Fworktrees%2Fp003-ark-currency-20261115/01a1df58-8851-7b80-ab9e-04bf84d8f71e/summary.json` 的 `current_model_id=grok-4.7`，`reasoning_effort=xhigh`。
- 事件：同目录 `events.jsonl` 的 `turn_started.model_id=grok-4.7`。当前文件里这条 `turn_started` 只有一次。
- 对话记录：同目录 `chat_history.jsonl` 里保留的 assistant 回合是 `model_id=grok-4.7-build`，`model_fingerprint=fp_5719f1aec35dd73c`，`reasoning_effort=xhigh`。
- 压缩前的首个动作留在 `compaction/segment_000.md`：该回合只读取就绪文件，`reasoning_effort=high`。该动作只做启动核对。其后同段记录为 `xhigh`。Codeg `get_session_info(322)` 对上了 parent 13 和 external id，返回里没有 model 或 effort。
- Node：`/Users/fu-121/.local/node-v24/bin/node`，`v24.19.0`，SHA256 `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1`。

## 候选

- 提交说明：`fix(ark): query natural reward questions and read stardust and card history`，2026-11-15 21:14:08 +0800。
- 基线说明：`docs(ark): record live data gaps and facts verification lessons`，2026-11-15 20:59:34 +0800。
- `git diff --stat a7feb148..b5ea904`：6 files, +111/-15。文件为 `apps/server/package.json`、`scripts/ark-direct-http.test.ts`、`scripts/ark-natural-history.test.ts`、`src/ark/answer.ts`、`src/ark/history.ts`、`src/xiaoke-kb.ts`。
- 钉死工作树：`/tmp/ark-accept-b5ea904`。官方脚本开始前和 harness 结束后 `git rev-parse HEAD` 都是 `b5ea904aca702bce1b21d1d8b9660eb1b3745c9c`，porcelain 行数为 0。`node_modules` 是指向实现树 `apps/server/node_modules` 的符号链接。源码 import 使用 `/tmp/ark-accept-b5ea904/...` 绝对路径。
- 实现树 `/Users/fu-121/.codex/worktrees/p003-ark-currency-20261115` 在官方日志开头的 HEAD 是 `1aa462f47b3677564b04bd854d04444cc3304acf`。本轮跑完后再读是 `69150858b1636193de8b252ef432895c7c7b79c0`。候选之后、本轮结论之外的提交是 `54d3e568`、`1aa462f4`、`69150858`。
- `history.ts` blob 在候选、`54d3e568` 和当前实现 HEAD 同为 `16d67a1e5334c7e05974440638f36894c781bde8`。`answer.ts` 同为 `67ad3de71593fc93067356db2aa6c2c496566383`。`xiaoke-kb.ts` 在候选是 `46fab21782f62cd4c3852f673a1a7ae451cddb3d`，在 `54d3e568` 是 `6da9fdb7c28945688f4766644cf2ddd8ed65b159`，在当前实现 HEAD 是 `dc4983d0a764f63e73610c7eebff528e99386156`。本轮执行的是候选 blob。

## 证据

| 文件 | SHA256 | 角色 |
| --- | --- | --- |
| `grok-final-accept-b5ea904.ts` | `ad6a220db8259d498cc203da37ea69028585fc77c8cdcdcf6fef5c5cf80c8f5c` | 独立脚本，import 钉死树 |
| `grok-final-accept-b5ea904.log` | `c4733d0f79699a2edd64523b300eb9bbf95ba614fb62c15679f63c4f2c0d58ae` | 2026-11-15T13:41:30Z 重跑日志，含 `PIN_HEAD` |
| `grok-final-accept-b5ea904.result.json` | `5d986f04aa23094d4c948a55f7e9dd64c92b74f91c1bb9d6e4dc2d2022aefb9f` | 20 条结果，failed 0 |
| `grok-official-15-b5ea904.log` | `44439fe46489580aa82443d6c721048ef0ed39e0ae3c88525aaeb611aefa99d5` | 15 脚本，OFFICIAL_EXIT 0 |

结果 JSON 与已丢弃的 `grok-final-accept-322.result.json` 字节相同，因为结果体里没有工作树路径。钉死证据是脚本哈希、日志里的 `PIN_HEAD b5ea904aca702bce1b21d1d8b9660eb1b3745c9c`，以及跑后 `rev-parse`。

丢弃、不作为本轮证据：

- `grok-final-accept-322.ts` `c6a4c8139efa6c381942f830968945b85202b9ab071d6c4b0ea7afa1e2bfdf6b`，import 的是移动中的实现树。
- `grok-official-15.log` `4154ff396060f59277c679922efdc60d8486fc15346204a5957d9aa0570fe1f0`，同样跑在移动中的实现树。
- `stage321` 准备性审查可以参考，本轮结论只采用上面钉死重跑。

## 独立链路

临时 SQLite，合成设备键和合成 SN，时钟在函数链里固定为 `2026-11-15T12:00:00+08:00`。HTTP 路由使用进程自己的 `Date.now()`，断言在 POST 之后再读。链路是 `settleAnalyticsBatch` → `readArkHistory` → `resolveArkFacts` → `answerArk`，另有 `createAnalyticsApp` 的 batch/summary 和 custom-llm SSE。聊天上游是本地 mock，fetch 停在 `127.0.0.1`。failed 0，total 20。

| id | 结果 |
| --- | --- |
| stardust-after-not-delta | PASS。星尘取 `after` 4，丢弃 delta 和更早的 10，也丢弃 inventory 77。 |
| card-dedicated-after | PASS。补勤卡专用 `after` 2 覆盖更早 inventory 9。 |
| inventory-only-card-still-reads-quantity | PASS。只有通用库存时仍读 quantity 4。 |
| generic-inventory-conflict-ignores-upload-order | PASS。同一 `occurred_at_ms` 的不同值把字段打成空，两种上传顺序都一样。 |
| same-time-equal-values-stay | PASS。同一时刻相同的 3 保留 3。 |
| normal-zero-is-not-missing | PASS。normal 的 0 是 0；没有 normal 证据时是 unknown，回答里不出现“余额是0”。 |
| future-clock-ignored | PASS。未来 `occurred_at_ms` 不进入当前读数。 |
| cross-sn-isolation | PASS。另一 SN 的 77 和 grant 不进入本机。 |
| old-grant-watermark-and-idempotency | PASS。昨日和水位前的 grant 排除；同一 `reward_instance_id` 只计一次。 |
| ownership-watermark-hides-older-rows | PASS。同一 id 的 5 与 9 冲突后奖励为空；所有权水位挡住更旧行。 |
| normal-evidence-required | PASS。只有 `gm_override` 的逻辑日不能提供当日事实。 |
| gm-source-rejects-day | PASS。`source_kind` 为 gm、GM、gm/debug 时整日作废。 |
| gm-unknown-snapshot-not-relabeled-normal | PASS。GM/unknown 快照不提供 888/111/7/2分钟；非 normal 快照压住 daily，可信历史星尘 42 仍可回答。裸 GM 快照走查不到。 |
| observation-chest-filter | 观察，见下方残留。harness 把它记成 pass:true，只为留下原文。 |
| asked-resource-filter | PASS。星尘/星辰只答星尘 5；补签卡只答补勤卡 1 张；金币答家族币 20 枚；星尘和补勤卡同时问时不带出家族币 20。只有家族币 grant、钱包星尘是 42 时，“今天获得多少星尘”答星尘数量暂时查不到。 |
| natural-reward-route-and-freshness | PASS。自然收益和下一奖励走事实；约 30 秒内的 normal 进度给出宝箱、2 分钟、2 项未领取；超过新鲜窗口后倒计时查不到。 |
| half-sentence-stays-conversation | PASS。“方舟里的补”固定为“你继续说，我在听。”，不查事实、不叫模型、不出现补勤卡。“方舟里的补勤”进入模型，DEV 标记去掉，系统提示含“没有说完整”“不结束对话”“不输出任何控制标记”。关灯保留 `[[DEV:3]]好的`。 |
| eligibility-not-invented-from-inventory | PASS。补勤卡 after 3 加上 2026-10-30 的消耗记录时，具体日期资格查不到，并说明不能只凭补勤卡数量判断。库存数字可以出现。 |
| http-batch-summary-answer | PASS。合成 SN：星尘 42、卡 3、所问 grant 5、跨 SN 77 隔离、GM 日 unknown、缺 normal 不说余额是 0、normal 0 是 0、未来 +1 小时仍停在 4；错账号 403，坏 internal token 401。 |
| http-chat-route-room-eligibility | PASS。半句静态、未说完走模型并去掉 DEV、自然事实、新鲜/过期进度、价格问句走“设备页面”且不查事实、错房间不调 facts。 |

“兑换游戏道具需要多少星尘”命中静态用法，落在设备页面说明，不查事实，也不编价格。

## 官方 15 脚本

工作目录是钉死树的 `apps/server`。命令是同一 Node：`--experimental-sqlite --import tsx scripts/<name>.test.ts`。`OFFICIAL_EXIT 0`。14 个 node:test 脚本合计 95 条，fail 都是 0。`ark-resource` 打印 `ark-resource regression passed`，进程退出码 0，日志里没有 node:test 条数。

| 脚本 | tests | pass | fail |
| --- | --- | --- | --- |
| ark-answer | 7 | 7 | 0 |
| ark-currency-http | 4 | 4 | 0 |
| ark-currency | 8 | 8 | 0 |
| ark-daily-context | 1 | 1 | 0 |
| ark-direct-http | 1 | 1 | 0 |
| ark-feedback | 11 | 11 | 0 |
| ark-history | 14 | 14 | 0 |
| ark-http-sse | 9 | 9 | 0 |
| ark-knowledge | 4 | 4 | 0 |
| ark-natural-history | 8 | 8 | 0 |
| ark-proxy-service | 1 | 1 | 0 |
| ark-proxy | 4 | 4 | 0 |
| ark-resource | 自定义通过 | 进程 0 | 日志无条数 |
| ark-runtime | 7 | 7 | 0 |
| ark-state | 16 | 16 | 0 |

`ark-natural-history` 的 8 条是候选树上的脚本。后两个实现提交加进的语句用例不在这 8 条里。

## 语料

`/Users/fu-121/.local/state/p003-ark-feedback-20261115/RESULTS-final-closed.jsonl` 只做源文件复核。256 行，222 个 id，errors 0，非 200 为 0。文件内 commit 是 `0efa24f913b087f7ed200e031a5aa74593691108` ×250 和 `94a40ceb21705dd2f94fdcac62215df98a83d386` ×6。route：`ark_direct` 189，`model` 61，`other` 6。`candidate_rerun=false`。本候选没有对这 256 条再调用 LLM。用户原文没有发往供应商。

## 真实设备

03800006、02000026、02000031 本轮没有重查生产库或生产 API。代码路径把 GM 和 unknown 留在非 normal：快照数值不升成 normal，整日 GM 证据不能冒充 normal。这三台要出现 normal 回答，仍要等端侧提交 normal。本轮没有伪造真人事件，也没有改真实数据。

## 残留复现

问句：`今天获得几个宝箱`。合成当日 normal 发奖同时包含家族币 20、星尘 5、普通宝箱 2、补勤卡 1。实际回答：

`今天已同步的发奖记录有家族币20枚、星尘5、普通宝箱2个、补勤卡1张；后续同步可能补齐更多记录。在读写台前有效使用达到奖励门槛，进度条奖励点亮后点击领取，就能获得对应家族币或道具。`

所问资源筛选对家族币、星尘、补勤卡是收窄的。宝箱不在这组 wanted 集合里，所以这句把当日已同步发奖全部列出。这是候选行为的残留，不把家族币/星尘/补勤卡筛选判成 FAIL。

## 未验界限

- 三台真实设备的生产库、生产 API 和端侧 normal 闭环。
- 256 条语料在本 SHA 上的新 LLM 调用。
- 价格表或目录表。价格问句只验证了静态设备页面路径。
- 全天使用时长。已验证的是带上限的 progress checkpoint 和新鲜窗口。
- 候选之后的 `54d3e568`、`1aa462f4`、`69150858`。
- `stage321` 准备性审查的原始日志。
- `.env` 和 PM2 全量，按任务要求没有读、没有打印。
- 实现树源码没有被本会话修改、提交或部署。

## 发布边界

命名行为的代码验收是 PASS，可以作为该候选的代码可发布结论。它不表示三台现网设备已经能回答 normal。现网这三台在端侧 normal 到达之前，代码应继续回答 unknown。
