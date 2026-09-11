# B30｜单机灰度已接通：定向派单上产 + 专用 worker unit

日期：2026-09-11 16:10 CST。状态：**服务端定向派单已部署生产、专用 worker unit 已注册、公网 E2E 11/11、同房两轮已跑通。可以开你那台的端侧开关了。**

---

## 0. 先说三件你需要知道的

1. **你 §3 的发现是对的，我核了源码**：`AGENT_NAME='rust-worker'` 是常量（`device-session.ts:20`，你说 21 差一行），JWT `roomConfig.agents[].agentName`、响应 `expected_agent_name`、签发自检三处全用它。签了合同不改派单 = 设备发 begin 给一个没有代次状态机的二进制。已修并上产。
2. **⚠️ 你建议的"复用现有支持 v1 的开发 unit"，我查完否了——那个 unit 是残废的**，直接接真机会给孩子一个降级体验。详见 §2。所以我**另建**了专用 unit，不是复用。
3. **灰度机 SN 我不用加准入名单**：准入判定是台账优先（`isSnAllowed`：DB 有记录以 status 为准，env `DEVICE_SN_ALLOW` 只是无记录时的兜底），这台在 `device_registry` 里已经是 `active`（全表 9 台）。没动任何准入配置。

---

## 1. 你要的第 1 项：名单、产物锚、agent name、unit

| 项 | 实取值 |
|---|---|
| 单机名单条目数 | **1**（`ONESHOT_FIRST_TURN_SN_ALLOW`） |
| SN 的 sha256 | `459f07ae630820e4a12462a55e4e42e6e906b99c865d22845db233055b7c59ee` —— **与你 §2 逐字符相符** |
| 新 agent name | `rust-worker-firstturn` |
| 新 unit | `voice-worker-firstturn.service`，MainPID **2612447**，ActiveEnter 2026-09-11 07:54 UTC |
| 新 unit 二进制 | `/root/rust-worker-firstturn/voice-rust-worker`，sha256 前 24 `637a77fdf89bc0dfdeab8a8d` |
| 该二进制的源提交 | `93dfb62be`（= `feat/ordered-pcm-input` HEAD，B26 回执 §表已锚定同一对应关系） |
| server 提交 | `f011ace1a`（`feat/oneshot-first-turn-signing`，已推 origin） |
| server 生产路径 | `aliyun-hk:/opt/p003/server/src/routes/device-session.ts`，三点 md5 一致 `eafe9820bb9b4f5c10fe3380b368bf18`（本地 = 生产 = git 对象） |
| 部署前备份 | `/opt/p003/_backup/20260911-155819-b29-firstturn/`（route + test + .env.local） |

**其他现役 worker 未被替换**（本轮结束时只读复核）：

| unit | 状态 | 说明 |
|---|---|---|
| `voice-worker-rust`（**生产**） | active，MainPID **2017631**，ActiveEnter **2026-09-06 23:49:55 UTC** | 与本会话开始时同值，**全程未重启未换包**，二进制 sha24 `f3707e7eae7e3a42def95a61` 未动 |
| `voice-worker-colleague` | active | 未动 |
| `voice-console` | active | 未动 |
| `voice-worker-poc` | **inactive**（本轮主动停） | 腾进程位给新 unit，宿主 3915M 无 swap；其目录与二进制原样保留，随时可 start 回滚 |

---

## 2. 为什么另建 unit 而不是复用 POC unit（你 §3 那句"需确认"）

我按你说的逐项核了 POC unit 的实际进程 env，**三项不合格**：

| 键 | POC unit | 生产 | 后果 |
|---|---|---|---|
| `P003_DEVICE_COMMANDS_ENABLED` | **0** | 1 | 设备命令整条链关闭 |
| `P003_DEVICE_INTENT_EXECUTE` | **0** | 1 | 意图执行关闭 |
| `LLM_BASE_URL` / `LLM_MODEL` | **火山 ark 原始端点** / `doubao-seed-2.0-mini` | `kidshub-ai.hahaxiong.cc/v1` / `xiaoke-device` | **绕开大脑** = 无情景记忆、无人格成长、无设备记忆、无退出语义 |

拿它接真机，孩子会得到一个"能对话但什么都不记得、也不听设备指令"的小可。所以：

**新 unit 的 env 链与生产 `voice-worker-rust` 逐行相同**，末尾只叠加一个差异文件：

```text
/root/realtime-voice-agent/.env
/root/realtime-voice-agent/poc-eou.env
/root/rust-worker/rust-worker.env          ← 生产同一份
/root/rust-worker-firstturn/rust-worker-firstturn.env   ← 只放差异，13 个赋值键
```

启动后读**进程实际 env** 验证继承（不是读配置文件，读的是 `/proc/2612447/environ`）：

```text
LLM_BASE_URL=https://kidshub-ai.hahaxiong.cc/v1     LLM_MODEL=xiaoke-device
P003_DEVICE_COMMANDS_ENABLED=1                      P003_DEVICE_INTENT_EXECUTE=1
SESSION_EXIT_SIGNAL_ENABLED=1                       VOLC_ASR_NONSTREAM_ENABLED=1
AGENT_NAME=rust-worker-firstturn                    WORKER_MAX_JOBS=2
```

**代码能力方面你可以放心**，这条我用祖先关系证了：`feat/rust-worker`（生产线）的 HEAD `3a2af41c3` **就是** `feat/ordered-pcm-input` 与它的 merge-base ——即 one-shot 分支落后生产线 **0** 个提交、领先 **22** 个。灰度二进制 = 生产线全部能力 + one-shot。（main 上没有 worker 源码，只有 GHA 工作流和两份文档快照，别去那儿找。）

---

## 3. 你要的第 2 项：四个最小签发自检（**公网 E2E，不是本地单测**）

在 `aliyun-hk` 上签 1 天期临时凭据，打**公网** `https://kidshub-ai.hahaxiong.cc/v1/device/session`。凭据只进 shell 变量、不落盘不回显，脚本跑完即删。

```text
对照机 = …0003（台账内另一台 active）

  ok   ①灰度机+supports → contract 非空
  ok   ①灰度机+supports → expected_agent_name=rust-worker-firstturn
  ok   ④JWT roomConfig.agents 恰好 1 项
  ok   ④JWT agentName = 响应 expected_agent_name
  ok   ④metadata 三字段 = 响应 contract
  ok   ④metadata.trace_id = 响应 trace_id
  ok   ②同机无 supports → contract null
  ok   ②同机无 supports → 仍派旧 agent rust-worker
  ok   ②旧路径 metadata 不含三键
  ok   ③非名单机+supports → contract null
  ok   ③非名单机+supports → 仍派旧 agent rust-worker

公网 E2E: 11 过 / 0 不过
```

另有**本地单测 28/28**（新增 B29 五例）。其中两条值得单独说：

- **fail-closed 用例**：名单内 + supports 但 `ONESHOT_FIRST_TURN_AGENT_NAME` 未配 → **拒签新能力**，退回 `contract:null` + `rust-worker`，metadata 不含三键。就是你 §3 说的"缺少可用新派单目标时应拒绝新能力签发"。
- **负向验证**：把 `agentName` 改回旧常量注入真 bug → 恰好 B29 ① 与对撞负锚两条翻红，还原后复绿。证明这套判据有区分力，不是恒绿。

自检函数也改了口径：原先是 JWT 和响应**各自**对同一个常量（实现与守护共用一个参数，改错了一起错）；现在是**拿响应里的 `expected_agent_name` 去 JWT 里找**，并断言 `agents` 恰好 1 项。

---

## 4. 你要的第 3 项：新 unit 的真实预算

```text
ORDERED_BEGIN_TO_END_TIMEOUT_MS=12000    （代码默认 7000）
ORDERED_MAX_TOTAL_S=16                   （代码默认 12）
ORDERED_BEGIN_TIMEOUT_MS=2500            （= 默认）
ORDERED_LOCAL_RECEIPT_ENABLED=1  ORDERED_LOCAL_RECEIPT_MAX_MS=3000
ORDERED_FILLER_SHORTEST=1  ORDERED_END_CANDIDATE_ENABLED=1
ORDERED_SPEC_ON_FINAL_ENABLED=1  ORDERED_SKIP_FILLER_ON_SPEC=1
TTS_FIRST_CLAUSE_MIN=4
```

**⚠️ 请按 12000 而不是 7000 理解**。你 §4 写的是"默认 begin→end 7 秒预算下的保守首版"——我这边实际给的是 12000ms。我没有改短也没有为你改长，这是隔离验证期一直在用的值；放宽只会避免过早失败，**真正的约束是你端侧自己那个 6 秒本地终点**。你要我改回 7000 说一声，一行的事。

**`ORDERED_RTC_CATCHUP_MS`：键不存在 = 默认 0 = 追补环关。** 进程 env 里该键计数为 0（我第一次的判据写错了——用键名做 grep 把注释行也算进去了，改成只匹配行首赋值才是真的）。

**原普通语音未被本轮改动**：音色/音量/STOP·EXIT/空闲策略/热词/人格指令全部来自生产那份 `rust-worker.env`，我的差异文件里一个相关键都没有（`^(LLM_|P003_DEVICE_COMMANDS_ENABLED|P003_DEVICE_INTENT_EXECUTE)` 赋值行数 = 0）。生产 unit 本身连重启都没有。

---

## 5. 你要的第 4 项：新合同房的 input_phase 原包 + 同房第二句

铸一间派给 `rust-worker-firstturn` 的隔离测试房（`sn-POCTEST0001-*`，2h TTL，签 `local_receipt=v1` + `oneshot_first_turn=v1`），模拟器跑一轮首句 + 同房 RTC 第二句。**没有用真机身份，真实设备数据零污染。**

**input_phase 原包**（worker→设备，原样）：

```json
{"phase":"rtc","reason":"first_turn_committed","stt_spawned_ms_ago":537,
 "catchup":{"samples":0,"skipped":"disabled"},
 "ordered":{"input_id":"d1e9ba40-02f7-46f1-8d78-6ed470afdb9c",
            "session_id":"d2fa99ba-bab0-490e-a0d1-dcc1f59d4dfa",
            "end_sample":34409,"outcome":"committed","no_task_reason":null}}
```

**result 原包**：`{"t":"result","status":"complete","outcome":"task","next":"rtc","input_id":"d1e9ba40…","received_next":34409,"queued_next":34409,"finals":2,"finals_held":2,"text_chars":8,"reason":null}`

**同房第二句摘要**：

| 项 | 值 |
|---|---|
| 首句（ordered） | "小可一加一等于几" → `outcome=task` |
| 本地承接 | `ack_local_receipt=accepted`；**`nonzero_before_receipt=0`** —— 正文门确实扣住了，端侧 receipt 之前 worker 一个非零帧都没发 |
| end → 相位切换 | end `t_ms=812`，input_phase `t_ms=1363` |
| 第二句（同房 RTC，经 mic 轨真推） | "那3+3呢" → ASR final 拿到，agent 回 "三加三呀……等于六！嘿嘿，这个也难不倒小可。" |
| `speaking_starts` | **2** —— 同一间房两轮独立生成 |
| `control_types` | `session.input_ready` / `session.output_ready` / `session.input_phase` |

顺带一条**旁证**：第二轮回答里那句"嘿嘿，这个也难不倒小可"带人格口吻——说明这个 unit 走的确实是 kidshub 大脑而不是 ark 裸端点，§2 那套 env 继承是真生效的，不只是 env 打印好看。

**证据归档**（远端 main，路径 `2-Projects/realtime-voice-agent/docs/oneshot-b6-20260909/`）：

| 文件 | sha256 前 24 | 字节 |
|---|---|---|
| `b29_sim_results.jsonl` | `60d07d5cfc60b9793610c51e` | 24038 |
| `poc_journal_b29_firstturn_20260911.log.txt` | `325e939275c20d12555fcc25` | 111914 |
| `opcm_poc_rooms_20260911_b29.public.json` | `e1d885f00ae0ae4dbd29359b` | 2530 |

脱敏自检：token / 真 SN 形态**零命中**。哈希只给前 24 位（我自己就是截断取的，不补全）。

---

## 6. 你 §5 的五条复核，我的回应

1. 撤回"归档未推送"——**收到，原因你自己查清了**（reference repo 的 fetch refspec 只跟 `feat/rust-worker`）。这条我也记了教训：协作方报"远端是 X"时先判祖先关系，别急着重推。
2. wire 文件 SHA256 与字节数与我这边一致。
3. 78 条原包、5/5 全等、负锚不匹配——与我这边逐项对上。你那份多一个尾换行、`1a1856a1…`、6918 字节，"语义一致不冒称字节哈希一致"这个说法准确，我认这个口径。
4. cancelled 引自 B23、原 phase 确实缺 catchup，不给它补——同意，新文件的 sample note 就是这么写的。
5. 纯唤醒 7360 只证明门缺口不证明真机自声污染——**这正是我 B28 §6 的措辞**，我们口径一致。追补保持 0。

---

## 7. 现在可以做什么 / 还缺什么

**你可以开那台的端侧开关了。** 服务端会给它签 v1 合同并把房派给 `rust-worker-firstturn`；不声明 supports 的请求、自动欢迎、prefetch、其他 8 台设备，全部照旧走 `rust-worker`。

**回滚**（按你 §7 的顺序）：① 你先关端侧 first-turn 开关并重启 Launcher；② 服务端清空 `ONESHOT_FIRST_TURN_SN_ALLOW` 的值 + `pm2 restart p003-voice`（或清 `ONESHOT_FIRST_TURN_AGENT_NAME`，两者任一为空都会 fail-closed 退回旧路径）；③ 需要时 `systemctl stop voice-worker-firstturn`。生产 unit 与二进制全程没动，不在回滚路径上。

**仍标 pending，不拿旧数字顶替**：

- 真人两轮体验（①仅唤醒→greet→提问→第二句→退出 ②连说→receipt→正文→同房第二句→停/退出）——**未验**，等你开关后请用户测。
- greet/receipt 交界抢说是否漏字——**未验**，追补关着，按你 §4 的说法单独记风险。
- 设备命令在灰度房是否真执行——env 开着，但 `P003_DEVICE_INTENT_EXECUTE_CANARY_SN_HASHES` 是另一张灰度表，这台在不在里面我没查也没加，**不是本轮范围**。你真人测到"开灯"没反应时先看这个，别当 one-shot 的锅。
- 新 unit 长跑内存：当前 38M（跑完一个 job 后回落），限额 MemoryHigh 700M / MemoryMax 900M，压力事件 low/high/max/oom **全 0**。宿主可用 2013M 无 swap，我把它压得比生产小就是为了保生产余量。

署名：cc（Claude）| 2026-09-11 16:10 CST
