# Grok 独立只读评审：01:08 普通 RTC 的 ASR 建连未完成，被 5 秒空闲关掉

**失败保持成立。** 同二进制、同 PID 的 ordered 合成探针在约 70 秒前通过，不能抵消这次普通 RTC 失败。本结论不是全系统通过，也不是 Android 通过。

评审身份：xAI Grok 4.7。角色是独立只读评审。时间 `2026-11-07T17:22:50Z`。没有改源码、没有部署、没有碰设备、没有复跑探针。证据只来自本地私有目录和提交 `b373b355d20dcd47802012e1b33db72d7acc32fa` 的 blob。不引用原始话语，不引用凭据。

评审进行时，工作区相对该提交又脏了四个文件：`stt_volc.rs`、`pipeline.rs`、`business_watchdog.rs`、`business_runtime.rs`（`git diff --stat` 约 +203/−10）。那不是 01:06 上线的二进制。下面的行号全部钉在该提交，不钉在移动中的工作区。

旧房 `02000053` 不再做全量调查。沿用已共同确认的结论：服务端当时缺业务空闲回收。见 `P003_02000053_GROK_JOINT_RECONFIRM_20261107.md`。

## 0. 运行对象

| 项 | 值 | 证据 |
|---|---|---|
| 源码 | `b373b355d20dcd47802012e1b33db72d7acc32fa` | 本地 `git rev-parse` 与该提交一致；提交说明 `fix(voice): close unused ASR preconnections without empty recognition`；提交时间 `2026-11-08 01:04:06 +0800` |
| 二进制 | `50017a8998197d84fcc58957e0979ea13f56aabe0758ba9ea2ab2aff468de4d0` | `ASR_DEPLOY_STATE.json` sha256 `db894eacae02380a7bad917b1b63ee269f65abf51e5cf35d9fc79e512e2e5f62` |
| 部署 | `2026-11-07T17:06:29.039834Z`（CST 01:06:29），状态 `ASR_EMPTY_CLOSE_DEPLOYED`，PID `3488880` → `3496776`，`env_and_dns_config_unchanged: true` | 同上 |
| 本评审引用的 blob | `stt_volc.rs` `f30099fa49c09a7a6a4c4791a421c729f7cb3ed4`；`pipeline.rs` `ff53f9dedf2109aef0c83f959bc0c0880ffc4618`；`job.rs` `0a09bb00f579455c827fb627338e8df681676b34`；`business_watchdog.rs` `edb11ba879e7fd38779260c03617299d0c757433`；`business_runtime.rs` `510bb1a9f22dbaa64bbabca19136c8d2100e68b7`；`voice_connect.rs` `aa106f2116210c3760940febef9954286971f374`；`tts_xfyun.rs` `94f6e4982ad2f67b2512b0eea925a3bc20b6a89a` | `git rev-parse b373b355:<path>` |

该提交改的是空预连：`pipeline.rs` 把 `AsrEnd::Unused` 并入不再重连；`stt_volc.rs` 在从未发出非空 PCM 时发 WebSocket Close，不发空 `NegativeSeq`。`git grep` 确认该提交的 `stt_volc.rs` 没有 `voice_connect`，也没有 `CONNECT_TIMEOUT`。建连仍是第 189 行无界 `connect_async`。

## 1. 已证事实 / 推测 / 反证

### 已证

1. **普通真实 RTC 探针失败，且房间是被业务空闲关掉的。**
   - trace `ops-release-probe-7bccf169-0d98-44e6-aef9-b300e36e09dd`
   - 房间 `sn-BJP00326110799999901-1794071328679`，SID `RM_Y245vKzEVDK5`，job `AJ_iGTLQv963XbR`
   - 客户端回执 `2026-11-07T17:08:59.161343Z`，`status=FAIL`，`ordered=false`，`runtime_pid=3496776`，二进制哈希与部署一致
   - `ready_ms=741`，`user_finals=0`，`answer_finals=0`，`audible_ms=0`，`first_audio_ms=null`，事件只有 `session.input_ready` 与 `session.output_ready`，`natural_room_gone=true`，`elapsed_ms=10482`
   - `policy_source` 为运维签发的合成 metadata，不是设备票
   - 证据：`ASR_RTC_READ_3.json` sha256 `fcdccf611f7b80468401d2b552c27ee40233149b81ca7beae3793b91a21aea44`，键 `release-dispatch-asr-ordered0`
   - 签发脚本写死 `voice_idle.timeout_ms=5000`、`revision=cfg-900001`；`ordered` 仅在参数为 1 时加上。见 `release-dispatch-probe-asr.py` 第 17–18 行。Worker 日志 `revision="cfg-900001"` 与此一致。

2. **ASR 任务已启动，直到关房和进程退出都没有完成 WebSocket 握手。**
   - `17:08:49.145127Z` 二遍识别灰度命中 `bigmodel_async+nonstream`
   - `17:08:49.145205Z` `asr stream task spawned (preconnect)`
   - 源码里握手成功后的唯一信息日志是 `asr: connected (seedasr bigmodel)`，位于 `connect_async` 返回之后。`stt_volc.rs` 189–195 行。
   - 抽取窗 `17:08:45Z`–`17:09:03Z` 共 46 行，少于 110 行上限。过滤词是 `tts synth`、`stt final:`、`turn committed:`、`prompt=`、`system_prompt`，不包含 `asr: connected`。窗内该字符串、`火山 ASR 流异常`、`asr 断线`、`unused asr`、`stt 连接中断` 都是 0 次。
   - 证据：`ASR_NORMAL_FAILURE_TIMELINE.json` 文件 sha256 `235c1133d40f9d54e822e688e509798292a028ba2f0c7925707cd8777ecac15f`；内部原始 journal sha256 `8ac47dfb0ed92fa27223856050fa90eb64f43713e34ba4af756b47feed594511`；抽取器 `read-asr-normal-failure.py` 第 2–4 行。
   - 从 spawn 到 `Close(IdleNoProgress)` `17:08:58.287928Z` 为 9.143 秒；到 `process exiting` `17:08:58.848024Z` 为 9.703 秒。握手日志位于 `connect_async` 之后，此前只有同步组请求。没有异常日志。任务停在无界 `connect_async` 上，这是日志顺序能支持的最强结论。

3. **探针 PCM 的能量已经进到 Worker 的 VAD，没有进到转写结果。**
   - `17:08:50.002858Z` `契约 UserSpeechStarted`
   - `17:08:53.407806Z` EOT `probability=0.5305777192115784`，阈值 `0.18`
   - 上行路径：非空样本进 `stt_buf`，满 3200 样本才 `try_send`；VAD 窗活跃才 `progress`。`pipeline.rs` 1050、1267–1289 行。`UserSpeechStarted` 来自契约事件，不是客户端臆造。
   - 客户端 `user_finals=0`、`audible_ms=0`。服务端没有 `stt final`、没有 playout。
   - `17:08:58.390389Z` 才出现 `native audio stream queue overflow; dropped 1 queued frames`，在关房决定之后 102 毫秒。这是收尾丢 1 帧，不是这段探针音频没被 VAD 看见的原因。音频来自探针固定 wav，经真实 RTC 上行，不是 Android 设备麦。

4. **这次空闲关闭符合现有 5 秒规则，规则本身不保护“VAD 已停、ASR 仍在建连”。**
   - `business_watchdog.rs` 32 行把 idle 限制在 5000–300000。77–81 行：`last_progress.max(ready_at).max(rtc_grace)` 与 idle 做严格 `<`，否则 `IdleNoProgress`。
   - 普通 RTC 的 `Activity::Input` 只在 ordered 首句阶段有截止。`pipeline.rs` 1411–1417 行。`ordered=false` 时 `input_until=None`，hold 被清掉。没有 Recognition 类活动。
   - VAD 活跃才 `progress`（1287 行）。静音、ready 重复、pipeline 心跳都不续业务命。心跳在 `job.rs` 245–249 行是另一条 5 秒死循环闸，本房主循环明显还在跑。
   - 业务判决在 job 的 1 秒 `interval` 上。`job.rs` 249、264–272 行。首次 `Keep` 在 `17:08:49.287709Z`，`elapsed_ms=239`。下次决策日志就是 `Close(IdleNoProgress)`，`elapsed_ms=9239`。两者相隔 9.000 秒，与 1 秒节拍一致。决策只在变化时打日志，所以中间节拍仍是 Keep。
   - 因此最后一次业务锚落在 elapsed `(3239, 4239]` 毫秒，墙钟 `(17:08:52.297, 17:08:53.297]`。`UserSpeechStarted` `50.002Z` 早于这个窗口；EOT `53.407Z` 晚于这个窗口约 0.11–1.11 秒。锚不是 ready，也不是说话起点，而是说话后段的某次 VAD `progress`。ready 约在 input loop `49.386Z`（assignment 后 338 毫秒），撑不到第 8 秒仍 Keep。本探针不是 ordered，没有 first-turn RTC grace。
   - 关房比这个锚晚约 5–6 秒，其中 5 秒是签发 idle，多出来的不到 1 秒是 1 秒节拍。这不是看门狗把 5 秒算成别的数。缺口是：VAD 停止后，排队中的真实 PCM 和未完成的 ASR 建连都不是活动租约。

5. **同二进制的 ordered 探针已经证明“这条二进制永远连不上 ASR”不成立。**
   - `17:07:49.300483Z` `status=PASS`，`ordered=true`，同一 SHA、同一 PID `3496776`
   - trace `ops-release-probe-46f2382c-eda5-492c-af71-d013fa7965cc`
   - `user_finals=2`，`answer_finals=1`，`audible_ms=7090`，`ready_ms=1016`，`elapsed_ms=25229`
   - 服务端节选：`17:07:43.528931Z` playout `played_frames=968`；`17:07:48.783264Z` 在有过播放之后 `Close(IdleNoProgress)`，`elapsed_ms=24309`。这是对话结束后的空闲回收，不是说话过程中被掐。
   - 证据：`ASR_RTC_READ_3.json` 键 `release-dispatch-asr-ordered1`；`ASR_RELEASE_RUNTIME_1.json` sha256 `5d25d76a37c5df702d9c9c37b2e39da0d6ff830529662a59e6fdf4ef17f17512`。该节选跳过了中间日志，不能用它证明成功轮有或没有 `asr: connected`。客户端 final 和可听时长已经证明识别与 TTS 发生过。

6. **空 PCM 的 `45000002` 是另一件事，这次失败日志里没有它。**
   - `ASR_EMPTY_FINAL_ASYNC_AB.json` sha256 `93e75be3192dc676e431113b290b0ef47129431c8006e167d51035cd6baa4d65`，文件内时间 `2026-11-07T16:57:16.813217Z`。范围写明是直连供应商的合成零 PCM，没有生产房间。
   - `empty_final`：`pcm_bytes_sent=0`，`connect_ms=703`，`error_code=45000002`。
   - `close_unused` 与 `leave_open`：同样 0 字节，响应里没有 45000002。
   - 失败 journal 没有 `45000002`，也没有 `unused asr preconnection closed`。这次不是“空 NegativeSeq 被拒绝”。

7. **DNS 负缓存已于 00:59 CST 生效，只证明 voice-hk 的重复解析变快，不证明所有冷解析消失。**
   - `DNS_CACHE_APPLY.json` sha256 `49ef5d7c720c2acbe1d674813b5287e978ac749f3c6de282f7e932d0f8fd0c5e`，`at=2026-11-07T16:59:13.674818Z`，drop-in `/etc/systemd/resolved.conf.d/60-p003-negative-cache.conf`，文件 sha256 `b8ca5c4b6eef8bc28d0e4e0b5eb04c4b340d02ecef461a557102b82eb0d504be`。
   - 缓存条目是 `voice-hk.hahaxiong.cc`：A 有地址，type 28（AAAA）`rrs` 为空。随后 getaddrinfo 44.266 / 1.953 / 1.642 / 2.491 / 1.986 毫秒。`workers_unchanged=true`，`ttl_extended=false`，`ip_pinned=false`。
   - 部署回执写明 ASR 发布时 env 与 DNS 配置未改。负缓存仍在。它不是 ASR 主机的专项修复。

8. **失败约 2.5 分钟后，同一 Worker 对 `openspeech.bytedance.com` 的独立系统解析第一次仍要 6.7 秒；TCP 和 TLS 很快。这不是失败 trace 的分段计时。**
   - `ASR_NETWORK_PHASES.json` sha256 `23d1049cf5775f0b3b2786610a76b8eaa203b54e15439f8245bbf7fce3cbec16`，`at=2026-11-07T17:11:34.499890Z`。
   - 三次 `socket.getaddrinfo`：6723.72 / 198.29 / 4.18 毫秒。八个 IPv4。抽到的 TCP 1.34–8.07 毫秒，TLS 8.81–11.87 毫秒。HTTP 首字节 57–98 毫秒，状态都是 `HTTP/1.1 404 Not Found`。
   - 脚本 `asr-network-phases.py` 用 Worker 进程环境里的 `LIVEKIT_URL` 只取 scheme/port，主机名写死为 `openspeech.bytedance.com`，请求是 `GET /rtc/v1`。文件自己的 `scope`：未认证 HTTP，不是 WebSocket 加入。
   - 源码端点是 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`。`stt_volc.rs` 64 行。主机名相同，路径、协议和调用栈都不同。
   - 代理环境六项均为 false。`resolv.conf` 是 systemd-resolved stub `127.0.0.53`。
   - 6.7 秒小于失败轮至少 9.7 秒的未完成握手，不能把后者整段记成这次 6.7 秒样本。

9. **TTS 已经有带总预算的建连；ASR 没有复用它。**
   - `tts_xfyun.rs` 63 行 `CONNECT_TIMEOUT = 10s`。281–345 行 `connect_observed`：总超时内要么走 `voice_connect`（仅 `P003_ASYNC_DNS_V1=1` 且主机精确等于 `cbm01.cn-huabei-1.xf-yun.com`），要么系统 `lookup_host` + 一次 `TcpStream::connect`，然后 TLS/WS。
   - `voice_connect.rs` 10–64 行：hickory 超时 1 秒、2 次；A 与 AAAA 并行，AAAA 延迟 50 毫秒；最多 8 个地址，间隔 250 毫秒起跑；函数自身没有总 deadline。TCP `connect` 也没有单独超时。调用方的 `timeout` 丢掉 future 时，JoinSet 会跟着丢。
   - `voice_connect` 不接收 URL、不接触鉴权头。这点对复用是安全的。

10. **PCM 队列在这次失败里装得下首句；丢失发生在进程退出，不是 128 格已满。**
    - 3200 样本 / 16 kHz = 200 毫秒。128 格 = 25.6 秒。`pipeline.rs` 675、1050、1268–1271 行。满了 `try_send` 丢的是当前这段，注释写明不阻塞热路径。
    - 本句 VAD 活跃大约 3 秒量级，约十几段，远小于 128。`connect_async` 返回前不读 `pcm_rx`（189 行在 select 循环之前）。首段会留在队列头部。
    - 不足 3200 样本的尾段没有在 VAD 结束时冲刷。3 秒句子的最后不到 200 毫秒可能还在 `stt_buf`。这解释不了整句零 final。
    - `spawn_stt` 682–714 行：错误才重试；连接存活超过 10 秒就把失败计数清零；超过 5 次才放弃。本次没有进入重试，因为 `connect_async` 没有返回。

### 推测（未被这次 trace 测量证实）

1. **慢的主要可变部分很可能在系统 DNS，而不是 TCP/TLS。** 旁证是 6.7 秒 getaddrinfo 对上 1–8 毫秒 TCP 和 9–12 毫秒 TLS，以及更早 voice-hk 的同类形态（提交内 `DNS_ASR_FINDINGS_20261108.md` 已记录 LiveKit 域名 6375 毫秒解析、TCP 约 4–14 毫秒）。失败轮本身没有 dns/tcp/tls/ws 四段计时。`connect_async` 在 tokio 里通常也走系统解析，但是同一次调用没有被计时。
2. **6.7 秒里面有多少是 AAAA 负回答，没有包捕获，不能拆。** 同一份 findings 已经拒绝把上一次 6.375 秒全部算成 AAAA。这次 6723 毫秒同样只有总时间。
3. **若房间再多等几秒，队列里的 PCM 有机会被转写。** 这依赖握手最终成功，以及 bigmodel_async 在迟到音频上仍给 definite。没有这次连接的成功样本。
4. **ordered 能过、普通 RTC 不能过，结构上说得通：** ordered 有 Input hold 和更长的首句窗口；普通 RTC 在 `input_ready` 后立刻说话（探针脚本 35 行），VAD 停止后只剩 5 秒。成功轮没有自己的建连分段，所以这是机制兼容事实，不是对成功轮耗时的测量。

### 反证（这些说法不被证据支持）

1. **“b373b355 已经修好 ASR 建连。”** 该提交的 `stt_volc.rs:189` 仍是无界 `connect_async`。修的是空预连不发 `NegativeSeq`。
2. **“这次失败仍是 45000002。”** 失败 journal 没有这个码，也没有空预连关闭日志。AB 对照证明的是零 PCM 终结包会被拒，不是这次普通语音。
3. **“DNS 负缓存已经把解析全部根治。”** 缓存上线后，openspeech 第一次 getaddrinfo 仍是 6723.72 毫秒。缓存的显式条目是 voice-hk，不是 openspeech。
4. **“6.7 秒那次测量就是失败 trace 的 DNS 时间，所以根因已经定量归到 DNS。”** 测量晚 2.5 分钟，是另一次 `getaddrinfo` 加 HTTP 404，而且 6.7 秒盖不住至少 9.7 秒的未完成握手。
5. **“ASR 供应商当时整体不可用 / 这条二进制不能建连。”** 同 PID、同 SHA 的 ordered 探针 `user_finals=2`、`audible_ms=7090`。
6. **“首句被 128 格通道或 native overflow 丢掉了。”** 句长远小于 25.6 秒；唯一 native overflow 在关房决定之后，且只丢 1 帧。
7. **“看门狗把 5 秒算错，或者心跳闸误杀。”** 9 秒节拍差和 VAD 锚窗口与 `idle=5000`、1 秒 evaluate 相符。主循环有 VAD 和 EOT 日志，不是心跳停跳。
8. **“扩大所有 idle 就能当修复。”** 旧长房恰恰是没有业务空闲回收。把普通 5 秒全部加长会重新打开无进展房间。本次需要的是有界的、只覆盖真实用户识别的等待。
9. **“Android 或全系统已通过。”** 两轮探针的 `policy_source` 都是合成 metadata。普通轮失败。

## 2. 无界建连与空闲关闭是否确证，慢在哪一层

**两件事都确证，而且是叠在一起的。慢的子层没有在失败 trace 上被拆开。**

确证一：部署源码的 ASR 建连没有 deadline。`run_asr_stream` 在打出 `asr: connected` 之前只等待 `connect_async`。这次从 spawn 到进程退出至少 9.703 秒，该日志没有出现，也没有错误、重试或空预连关闭。握手没有完成。

确证二：普通 idle 5 秒在 VAD 停止后把房间关掉，此时识别仍无结果。关闭决定 `elapsed_ms=9239`。最后业务锚在说话后段的 1 秒窗内，不是 ready，不是 `UserSpeechStarted`。`ordered=false` 没有 Input hold。策略按代码执行。业务结果是一句已经触发 VAD 的探针音频没有字幕、没有回答音频。

初始慢的归因：

| 层 | 对这次失败能说什么 |
|---|---|
| 业务结果层 | 已证。VAD 见到话，ASR 握手未完成，5 秒空闲关房，零 final、零可听音频。 |
| ASR 握手整体 | 已证未完成。卡在 `connect_async` 返回之前。 |
| DNS | 未在失败 trace 测量。旁证显示同一主机名的系统 `getaddrinfo` 可以单次 6723 毫秒，随后 198 毫秒、4 毫秒。这是目前最大的已知可变延迟。不能把 9.7 秒全部写成这次 6.7 秒。 |
| TCP | 旁证 1–8 毫秒。失败轮未测。不能排除当时某个地址黑洞，因为 `connect_async` 的选址和超时与后来的“解析后直连前两个地址”不是同一算法。 |
| TLS | 旁证 9–12 毫秒，而且是 HTTP 404，不是 ASR 的 WebSocket 升级。失败轮未测。 |
| 供应商识别 | 未到达。没有 connected，就没有 init 之后的识别。45000002 不是这一轮。 |
| 通道丢句 | 这一轮不成立。进程退出丢的是还没读走的队列。 |

所以：能确证的慢层是“ASR 传输握手没有在 VAD 结束后的 5 秒业务预算内完成”。握手内部，旁证把最大的已测延迟放在系统解析；TCP/TLS 在旁证里不是秒级。失败那一次还剩至少约 3 秒没有同次测量，不能宣布 DNS 是唯一根因。

## 3. 最小修复

只覆盖这次已经看见的缺口。不加大所有房间的 idle。不把未提交工作区当成已落地。

1. **建连：复用 `voice_connect`，并加一个共享总 deadline。**
   - 对 `openspeech.bytedance.com` 使用现有 `voice_connect::connect`（A/AAAA 互不阻塞、最多 8 地址、取消时丢掉失败连接）。
   - 总预算用已经存在的 10 秒量级，包住 DNS + TCP + TLS + WebSocket，一次 episode 一个 deadline。TTS 的 `CONNECT_TIMEOUT` 就是这个形状（`tts_xfyun.rs` 294 行）。ASR 应共享同一次预算的语义：超时后不再默默再开一条冷连接把时钟清零。`tts_xfyun.rs` 445–446 行已经写了这条约束。
   - `voice_connect` 自己没有总 deadline，TCP 也没有单独超时。必须由外层 `timeout` 包住整个 `connect_observed`。只换解析器、不加外层超时，黑洞 TCP 仍可长挂。
   - 系统 `lookup_host` 路径如果还留着，也必须在同一个总超时里。flag 默认关闭不能让无界 `connect_async` 继续存在。
   - 鉴权头、路径、SNI 和证书校验保持原请求，不进 `voice_connect`。

2. **空闲：为真实用户的未完成识别加一次绝对租约，不改普通 5 秒。**
   - 条件：本轮已经有 VAD `progress`（或已经向 ASR 队列送出非空 PCM），并且还没有对应 final。
   - 租约是绝对时刻，例如“最后一次 VAD progress + 同一次建连预算”，或“spawn 时开始的那一个建连 deadline”，取已经在跑的那一个，不要每次 evaluate 用 `now+预算`。
   - `activity_until` 在 deadline 不变时已经会直接返回（`business_runtime.rs` 54 行）。新 hold 必须维持这个属性。重试、1 秒轮询、静音帧、ready 重发都不能把 `until` 往后推。
   - 建连失败或租约到点：结束 hold，让原来的 5 秒空闲继续关房。
   - 没有用户语音的预连失败，保持现在的 `Unused` 关闭，不发空 `NegativeSeq`，也不因此续命。
   - ordered 首句继续用现有 Input hold。不要再叠一个会无限刷新的 Recognition 租约。

3. **不要做的事**
   - 不把 `timeout_ms=5000` 改成更大的全局值。
   - 不把心跳、ready、静音、空预连当成业务进展。
   - 不在本次修复里改端点、热词、TTS 主机门闩或设备协议。

未提交草稿如果只加 10 秒建连超时、不加上述绝对租约，仍然盖不住这次失败：spawn 后 9.143 秒已被空闲关掉，10 秒超时会落在关房之后。本评审没有验收该草稿。

## 4. 防丢首句、取消泄漏、反复重试、无穷续命，以及必须先红后绿的测试

机制约束：

- **首句。** 单次 10 秒建连期间，25.6 秒队列装得下普通一句；`try_send` 满了丢的是新段，不是已入队的头。仍要在 VAD 结束时冲刷不足 3200 样本的尾段，否则句尾不到 200 毫秒永远留在 `stt_buf`。建连未完成时不要先 `drop` 发送端。取消时丢掉的是任务，不是只丢掉队列头部。
- **取消泄漏。** 超时和事件消费者消失都必须丢掉 `connect` future。`voice_connect` 的 JoinSet 随 future 丢弃而中止。禁止 `tokio::spawn` 出一条不受这次 deadline 管辖的重试。`OwnedTask` 在 pipeline 取消时要 abort，不能在 drop 之后继续握手。
- **反复重试。** 这次挂死没有进入重试。现有逻辑是：返回错误才计数；存活超过 10 秒把计数清零；6 次以上放弃（`pipeline.rs` 704–710 行）。建连超时如果刚刚超过 10 秒，会被这条例误判成“长稳连接”并清零，然后无限重试。建连失败必须计为失败并结束这一 episode，不能清零。
- **无穷续命。** 新的识别租约禁止在重试、轮询或静音时改写 `until`。`>10s` 清零失败计数如果保留，也只能适用于已经真正 `asr: connected` 并且发送过音频的会话，不能刷新识别租约。旧长房那种“心跳还在就一直活”不能回来。

必须先红、后才允许说修好的测试：

1. 复现 01:08 形态：VAD 说话后静音，假握手在 6–8 秒才完成并返回一条 final。5 秒空闲不得在 final 前关房；final 和已入队 PCM 必须按序送到。提供者永不完成时，到共享 deadline 只失败一次，然后空闲关房，`user_finals` 保持 0。
2. 握手超过共享 deadline：恰好一次尝试；错误类型不得再 `connect`；`fails` 不得因 `elapsed > 10s` 被清零；进程内没有残留 TCP。
3. 事件接收端丢弃：挂起的握手在短于 500 毫秒内结束，返回不再重连，没有脱离的任务。
4. 零 PCM 预连仍不发 `NegativeSeq`，夹具仍可返回 45000002 作为负对照；320 个零样本仍当真实 PCM 发送并走原来的 final 确认。这是 b373b355 已经修过的回归。
5. 建连阻塞期间先写入约 3 秒 PCM，连接成功后按原顺序读出；VAD 结束时不足 200 毫秒的尾巴也被发送；队列满时丢掉的是最新段。
6. 缺失 AAAA 不挡住已有 A；第一个地址黑洞时，后续好地址仍能在同一个 deadline 内胜出。现有 `voice_connect` 的 r16 测试不够，还要包住 TLS/WS 总超时。
7. 连续说话超过 5 秒只靠 VAD `progress` 就保持 Keep。识别租约不是这条路径的前提。静音帧、重复 ready、重复 `activity_until` 同一 deadline 都不延长生命。
8. ordered 首句仍只使用现有 Input hold。识别租约不得在没有新的用户 VAD 时把普通空房留下。
9. 生产形态验收至少再跑一轮与 01:08 相同的普通合成 RTC，以及一轮 ordered。普通轮在修复前的失败回执保持为红。两轮都仍是合成 metadata，通过也不能写成 Android 通过。

这些测试现在都没有针对 01:08 这一轮跑过。提交说明里的 535 项是空预连修复前的回归，不覆盖无界握手。

## 5. 旧长房与这次慢响应的关系，以及仍未知的事

关系是同一类 deadline 设计的两个相反症状，不是同一个测量出来的网络根因。

- 旧房：有连接、有循环心跳、没有业务进展，服务端不回收，房间留了数小时。联合结论见 `P003_02000053_GROK_JOINT_RECONFIRM_20261107.md`。本次不重开调查。
- 这次：业务回收已经接上，而且按 5 秒执行了。它在 ASR 握手还没完成时，把已经进入 VAD 的普通 RTC 一句收掉了。
- DNS 负缓存是第三条线。它降低了 voice-hk 上 AAAA NODATA 的重复成本。openspeech 在缓存上线后仍有 6.7 秒冷解析。它解释不了旧房的数小时，也没有被证明是 01:08 那 9.7 秒的全部。

仍未知，不能补写：

- 失败这次 `connect_async` 内部的 DNS、TCP、TLS、WebSocket 各用了多少毫秒。没有同 trace 分段，也没有包捕获。
- 6723.72 毫秒里 A、AAAA、上游超时各占多少。
- 若多等几秒，队列里的 PCM 是否会被 bigmodel_async 转写成功。
- ordered 成功轮的建连分段。节选日志删掉了中间，只知道最终有 final 和音频。
- 旧房最初输入为何长时间没有有效幅度，以及后来 12 张票没有形成可观察房间。联合结论已把这两项留为断点。
- 真实 Android 的 APK、同 trace 收票、麦克风和断线。本次两轮都是合成 SN 与运维 metadata。
- 工作区里那份未提交补丁是否满足第 3、4 节。它在评审期间仍在变，而且不是已部署二进制。

## 结论

01:08 普通 RTC 失败成立：真实 VAD 之后没有 ASR 握手完成日志，5 秒 `IdleNoProgress` 关房，零字幕、零回答音频。无界 `connect_async` 和“VAD 停止后不为 pending ASR 保留有限租约”都已由该提交源码加这趟时间线确证。慢的已证层级是握手整体没有完成；DNS 是最强的旁证层级，不是这趟 trace 的定量根因。最小修复是复用 `voice_connect`、共享一次建连 deadline，并对真实用户的未完成识别做一次不会被轮询刷新的绝对等待。空预连禁止 `NegativeSeq` 的修复保持有效，但不是这次失败的原因。ordered 合成通过和 DNS 负缓存都不覆盖这次失败。不能宣布全系统或 Android 已通过。
