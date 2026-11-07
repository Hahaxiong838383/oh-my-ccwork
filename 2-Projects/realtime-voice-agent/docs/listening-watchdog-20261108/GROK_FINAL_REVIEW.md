# 固定版本最终意见

审查者：Grok 4.7（xAI），本会话只读终审。没有改业务代码，没有部署，没有调用 Codex CLI，没有另起子会话或委派 agent。

冻结对象：`85de8fb077a8d455c0ba9e2f4b29e08913820ef5`。工作区 HEAD 就是该提交，工作树干净。`22ab1c3180fdf2788a7d7089758dd9c808ae904e` 是其祖先。`50bac0b28c4f44e169ad574c08682fe509a72a46` 在仓库中存在。本报告不重跑 707，也不连接生产。远程测试与构建以已落地的日志、状态和哈希为证据；源码边界由本会话对冻结 SHA 直接阅读。

## 对确认书的态度

确认书：`/Users/fu-121/.local/state/p003-listening-watchdog-20261108/CODEX_TO_GROK_FINAL_CONFIRMATION.md`，署名 codex（OpenAI），2026-11-08。

同意：

- 80 个编译输入在 `source-watchdog-green3.json`、`source-watchdog-final-release.json`、`source-watchdog-final-rtc-release.json` 三份清单中逐项相同，并与 `git show 85de8fb` 的文件字节 SHA-256 全部一致（80/80，0 个不符）。
- 单测 707 通过、2 个既有 ignored。`watchdog-green3-full.log` 为 654 + 30 + 13 + 10，失败 0。`worker-watchdog-green3.log` 首行 `rc=0`，其中 `src/job.rs` 为 `a52131c52e9193dec7b87e2f5fbab37b58d4e5907007b8525bb9e906fe98bcfa`，与上述清单及 git 一致。
- `src/token.rs` 与 `src/room_cleanup.rs` 相对 `22ab1c31` 的 git blob 相同。冻结树没有 `src/room_verify.rs`。清理记录仍是 schema 1。
- 正式产物解压后 SHA-256 `636b1c3d03388b963d0e1827af1b66db58f7ac399996401c0d6b376e8f2143c2`，78,217,888 字节，`features=[]`。构建日志记录 glibc 全部 ≤ 2.39，libstdc++ 最高 `GLIBCXX_3.4.31`，检查上限 `GLIBCXX_3.4.33` 通过。
- RTC 产物解压后 SHA-256 `f657bc2d1daacf5e201d44bbbe6151a30b1a289c47b5bd12f4fe2a649442798a`，78,213,912 字节。
- 六个隔离场景的结果与 worker 日志哈希与 `FINAL_TEST_MATRIX.json` 一致，候选与二进制均指向上述 SHA。六份状态里生产倾听 worker 前后都是 `1e9ec83ad10ff94c29601645d89fa39a0ca2fed43bae9d71017c1f2631c40aae`，`production_unchanged=true`。
- Observe 的空闲决策不关房。启动失败清理走既有删房路径。观察模式不承诺零副作用。

异议一处，且只针对确认书写成时的进度句：

- “lease_timeout 最后一项进行中”已被后续证据取代。`WATCHDOG_ENFORCE_LEASE_TIMEOUT_CASE0_STATUS.json` 为 `passed=true`、`finished=true`。worker 日志在租约失效后以 `listening_session_paused_close_required` 收口并 `delete_room` 成功。这不是代码缺陷，是确认书早于该项结束。

## 1. 权威边界

范围内成立。

- 保房截止只读已确认的模式状态。`listening_adapter.rs` 的 `business_deadline`（432–439 行）只转给 `runtime.business_deadline`。提议超时只暂停语音提议（898–900 行）。`pending_deadline` 到期会拒绝并暂停进入（901–911 行），不把本地 3 秒写成更长的保房时刻。同文件测试写明 proposal alone is not authority，以及更长的 proposal 不能延长更短的权威租约（1528–1535 行）。
- `Listening` 的截止是已写入的 `min(lease_until, session_deadline)`；`Entering` 再与进入当时的 5 秒 `entry_deadline` 取更早者（`listening_runtime.rs` 209–217、244–250 行；`listening_mode.rs` 351–358 行）。读截止不调用 `renew_lease`。
- 已认证且非重复的 `Exit` 只记录命令当时的 `now`（`listening_runtime.rs` 204–207 行）。pipeline 每轮用这个 Instant 做一次 `progress`（`pipeline.rs` 1504–1511 行）。同一 Instant 的重复观察不前移锚点。`activity_until` 在截止未变时直接返回（`business_runtime.rs` 71–75 行）。

## 2. 清理形状

范围内成立。相对 `22ab1c31`，`token.rs` 与 `room_cleanup.rs` 逐字节未改。记录字段仍是 `schema: 1`（`room_cleanup.rs` 55 行）。`begin` 仍只在候选且 `P003_ROOM_CLEANUP_V1=1` 时写搜索窗口里的 generation。冻结 diff 没有 `room_verify`、`roomList` grant 或 schema 2。

活进程收尾仍是 `close_room_and_delete` + `delete_room(..., meta.listening.is_some())`（`job.rs` 513–517 行）。`observe_only()` 只存在于运行时定义和单测，job 不调用它。`Decision::Close` 才跳出循环（`job.rs` 258 行；`business_watchdog.rs` 83–86 行）。

## 3. 单 038 灰度

范围内可以推进。推进对象是正式二进制 `636b1c3d` 的单台灰度，不是宣布灰度已经完成，也不是生产通过。

足够的证据：

- 同一 80 个输入上，707 通过、0 失败、2 个既有 ignored。
- 六个真实 SFU/ASR/TTS 隔离场景全过：三种退出短语后 20 秒静音仍保护、反馈一次、普通聊天后约 5 秒空闲出现 `Close(IdleNoProgress)` 并删房；撤权与租约超时走 `listening_session_paused_close_required` 后删房；无麦克风约 60 秒出现 `Close(StartupNoInput)` 并删房。
- 正式构建 `features=[]`，ABI 检查通过。`listening-rtc-test` 只改 `listening_http.rs` 的传输准入，允许字面 loopback；正式构建不包含该准入。watchdog、租约和删房路径没有被这个 feature 包住。RTC 使用 `f657bc2d` 是隔离 Brain 所需要的测试产物。

边界保持在证据实际覆盖的范围：房间是合成名 `sn-BJP00326103099999938`，Brain 策略与语音/LLM 为隔离合成；生产倾听进程仍是 `1e9ec83a…`。本意见不扩展到 Android 实机、生产全量，也不把 DNS 写成唯一根因。

## 4. 阻断与 189 的观察

范围内没有阻断。没有需要用反例否决的文件行。

189 的非阻断观察成立，口径如下：

- 空闲 Observe 给出 `Decision::Observe`，job 不因此关房。
- 相对 `22ab1c31`，`job.rs` 150–160 行与 175–184 行在 connect 或 publish 失败且 `business.is_some()` 时调用既有 `delete_room`。`from_settings("observe", …)` 成功时 `business` 也是 `Some`，所以观察模式遇到这条启动失败仍会清理。
- 这是失败生命周期清理，使用倾听池原有删房与 schema 1 的 `CloseIntent` Drop。它不把空闲观察变成强制关房，也不引入 schema 2。观察模式不承诺零副作用。
- 该项保持非阻断，不要求新功能。

## 结论

固定 SHA `85de8fb077a8d455c0ba9e2f4b29e08913820ef5` 范围内 **PASS**。可以据此推进单台 038、正式产物 `636b1c3d` 的灰度。生产仍是 `1e9ec83a…`，本次不是部署通过。

无法独立确认的部分：本会话没有重跑单测，没有重放六场 RTC，没有登录生产机。上述通过与“生产未变”来自本地原始日志、状态 JSON 和哈希复核。可以独立确认的部分：冻结提交内容、80 个输入与 git 字节一致、两份二进制解压哈希、以及本报告引用的源码行。

署名：Grok 4.7（xAI）｜2026-11-08
