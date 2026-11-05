> 发布前独立评审原文。当前部署状态及未采纳建议的理由，以本目录正式回执和CONNECTION_RECOVERY_DECISION.md为准。

限定范围 **PASS**，这次没有发现阻断缺陷。审查对象是 git 对象 `19ac09674c0d42d91419ec8411e7175c34b3c204`（相对基线 `8f5fbb873737a8d7ae1c6094ba53007c689e015d`）。我只做了 `git show` / `git diff`。没有跑测试，没有 SSH，没有改代码，没有部署，也没有用工作区里可能移动的文件代替这个 SHA。你报告的 484 passed 我不能代为确认。

这是句就绪后的建连预算防护。6075 的 TLS/WS 卡住、t22 的已连接断供，证据都还开着。

## 预算

`take_for_sentence`（`tts.rs` 212–216）从句就绪进入 `recover_connection`，外层只有一段 `timeout(10s)`（253–282）。650ms 内 primary 失败会立刻 `connect().await`；650ms 后才 `try_acquire` 起一条 spare。spare 失败只等 primary，primary 失败只等 spare。`connect` 是 `FnOnce`，同一句到不了第三条连接。

`connect_observed` 自己的 10 秒（`tts_xfyun.rs` 63、294）包在这层 timeout 里面。备用或替换晚启动时，内层计时器不能把句就绪后的墙钟再拉出一段完整的 10 秒。到点外层丢掉整个 future。`synthesize_connected`（447–451、475）过龄直接 `tts_acquired_connection_expired`，没有第三段冷连。

已结束的失败或过龄预热在进这层 timeout 之前就被取走（`tts.rs` 200–207），冷 primary 从句就绪重新计这同一段 10 秒。这是决策里保留的成功容忍度，不是失败后再加一段 10 秒。

## JoinHandle

进行中的预热先被 `mem::replace` 进局部 `pending`（197），再移进 primary future。调用方槽位这时已是 `Off`，所以竞速结束前的 `start_prewarm`（118）不会 Drop 掉仍在跑的 primary。spare 胜出或外层 timeout 丢掉 primary 时，`Prewarm::drop`（240–245）对仍在槽里的 `JoinHandle` 调用 `abort`。`take`（221–236）在 `await` 完成前不会把 handle 拿出去。取消父任务时，替换连接还没开始就会一起被丢掉。

现有取消测试打的是 `recover_connection` 的 future Drop，以及 flag 关时的 `take()`。我没有看到一条「真的 `Prewarm::arm`，spare 胜出后 JoinHandle 被 abort」的测试。控制流能对上，这是证据缺口，不是可复现的脱钩。

## 容量 0 / 过龄

`SPARES` 是进程内 2 个许可，`try_acquire`，失败不排队（269–273）。名额为 0 时继续等 primary，仍在同一段 timeout 里；primary 失败才允许一次不占许可的替换。primary 一直挂起则不会调用 `connect()`，到点返回 `tts_foreground_connect_budget_exhausted`。

已完成且 fresh 的预热直接返回，不占许可。已完成但失败或 `age >= 12s` 的 socket 在冷 primary 之前丢掉。进行中的预热若稍后返回过龄 `Warm`，`filter(Warm::fresh)`（209–210）丢掉它，再在同一预算里走替换或已启动的 spare。`synthesize_inner` 发送前再查一次 fresh（468–475）。

## flag 关 / 下一句预热

`P003_TTS_CONNECT_RECOVERY_V1` 只有字面 `"1"` 才为真（158–160），默认关。关时仍是 `take()`，然后 `synthesize(..., allow_cold_connect=true)`（120–130）。`arm` 只在 `latency_mode && !recovery` 时走旧 `connect_hedged`（187–189）。这个提交不写 `P003_TTS_LATENCY_V1`，`pipeline.rs` 的垫句条件和 Reply/Say/搜索三个 `match` 都没改。火山分支不进这里。

flag 开时，`take_for_sentence` 返回之后才 `*warm = start_prewarm()`，成功和 `Err` 都会执行（115–119）；`?` 在 arm 之后。下一句预热是单连接，不占 `SPARES`，也不和当前句的 spare 嵌套。输家在 `recover_connection` 返回前已经 Drop。

## 部分 PCM

文本只在胜出的那条 `Warm` 上发送一次（491）。读失败、关闭、对端结束都是直接 `Err`（507–513），循环里没有重连，也没有第二次 `build_request`。带上部分 PCM 的那条 `ws` 随这次调用丢掉，不会交给下一句。下一句用的是 arm 出来的另一条连接。

已送进 `pcm_tx` 的字节，Reply 的 `Err` 仍然不 `track`（`pipeline.rs` 3851–3853）。这是原有的「孤儿 PCM 会响、字幕进度不记」边界。这次没有把它变成同一句再写一次。

## 上线

现在不要把 `P003_TTS_CONNECT_RECOVERY_V1=1` 做小范围上线。

flag 保持关闭时，这段代码和现网路径一致，候选可以继续留在未部署状态。生产仍应是 `06eb` 加 `ASYNC=1`。打开 flag 只改变「句就绪之后、发出文本之前」的建连：同一段 10 秒、最多一条并发 spare。t22 那种已经拿到首包、之后约 2 秒无 PCM 的断供，仍走原来的 `RECV_TIMEOUT`、读循环和播放；这次测试也只是把欠载复现出来。6075 那种 TLS/WS 挂满约 10 秒时，第二路能否在同一预算内接通，仓库里的本地握手桩不能证明。两路一起失败时，这一句大约 10 秒后无声；搜索路径仍会在第一句 `Err` 上 `break`，后面的句子一起不播。
