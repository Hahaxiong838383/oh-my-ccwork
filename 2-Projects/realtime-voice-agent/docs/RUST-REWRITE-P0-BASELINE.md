# Rust 重写 P0 基线报告：内存分层实测 + 组件盘点 + 生态验证

> 2026-08-12 产出（测量窗口 2026-08-11 16:47–16:55 UTC，64.90.13.117 生产机，全程只读 + 一次 rtc_probe 会话，三 unit 零改动）。
> 结论供 P1 拍板重写边界用。数据标签：无标注 = 本轮实测；【推断】= 未经原型验证的估算；【历史】= 引用既往记录。

---

## 一、结论（TL;DR）

1. **重写方向成立，但收益来源必须说准**：内存大头不是「Python 代码占内存」，而是 **LiveKit Python agents 的 per-job 进程模型税**——每路并发付 289M（短会话实测）~440M（长会话【历史】峰值口径）的**进程私有内存**，其中模型权重零复用价值（模型已由 COW 共享，每路私有的是解释器堆 + COW 写分化 + 每 job 重复的运行态）。Rust 单进程 async 多路复用能把每路成本压到 ~10-40M 量级【推断，P2 骨架实测修正】，这是结构性收益，Python 内做不到（thread executor 路线 2026-07-16 已否：GIL 卡实时音频）。
2. **模型内存是地板，任何语言都省不掉，只能共享化**：v1-mini 判停 243M + VAD 34M + 声纹 66M ≈ **340M 是推理引擎/权重的驻留**，Rust 化后照样要付，但可以从「每 unit 一份」变「全机一份」。
3. **O2-2 检验（「如果大头在模型，全量重写就是错的解」）的回答**：大头**不在模型**——两 worker unit 固定底座合计 1184M 中模型段约 680M（两份重复），但**每路边际 289-440M 里模型占 0**（已共享）。并发撑不起的直接原因是每路边际 + 双 unit 重复底座，两者都是进程模型问题 → 重写解对症。
4. **生态验证三项全通过，一个硬结**：LiveKit Rust 侧 RTC 成熟 + worker 协议 protobuf 有现成生成代码；silero VAD 官方 onnx 在手 + ort 生态成熟；讯飞/火山 WS 无现成 crate 但协议规格就是我们自己的 Python 实现（翻译不是探索）。**唯一硬结 = v1-mini 判停是闭源 CPython .so**，Rust 不能直接链 → 建议 Python sidecar 共享单例（接口面仅 `predict(pcm)->float`）。
5. **建议重写边界：选项 A「全量 Rust worker + EOT 判停 sidecar」为主线**，选项 B「推理 sidecar 化（Python 保留）」可作为 Rust 完成前的止血临时件（若并发压力先到）。详见 §六。

---

## 二、内存分层实测

### 2.1 全机快照（idle，三 unit cgroup 真账口径）

| unit | memory.current | memory.peak（自上次重启） | cgroup 上限（High/Max，已验证现值） |
|---|---|---|---|
| voice-worker（主线） | **542M** | 1035M（8-03 起） | 2800M / 3200M |
| voice-worker-colleague（租户） | **642M** | 1240M（8-04 起） | 1600M / 2000M |
| voice-console | 111M | 112M | — |
| 合计 | ~1295M | | 机器 3915M 总，**无 swap**（swappiness=60 配了但 swap 分区不存在，见 §八） |

### 2.2 单 worker unit 进程构成（主线 idle，smaps_rollup）

| 进程 | RSS | 私有（Private_Dirty） | 共享底座（Shared_Dirty） |
|---|---|---|---|
| 主进程（AgentServer 编排） | 133M | 90M | 0 |
| resource_tracker | 13M | 6M | 0 |
| forkserver 模板（preload 底座宿主） | 427M | 10M | **340M（一份，COW 供所有子进程）** |
| idle job 进程（setup 已跑） | 445M | 72M | 340M（继承） |

cgroup 542M ≈ 90+6+10+340+72 + 页缓存零头，对账吻合。租户 unit 结构相同（642M；其 idle 进程私有 163M 偏大，三次采样恒定不变，成因未深究——不影响结论，记为待解释观察）。

### 2.3 底座 340M 的逐层拆解（独立进程逐层 import 实测，RSS 边际）

| 层 | 边际 | 累计 RSS | 归属 |
|---|---|---|---|
| 裸 python3.12 | — | 10M | Python |
| numpy | +15M | 26M | Python 生态 |
| av（PyAV/FFmpeg） | +17M | 43M | Python 生态 |
| openai + pydantic | +48M | 91M | Python 生态 |
| livekit.agents 框架 | +46M | 138M | Python 生态 |
| **local_inference warmup** | **+278M** | 416M | **native .so（VAD +34M，EOT v1-mini +243M）** |

- **底座 416M 中 67% 是原生推理段**（`livekit-local-inference` 0.2.5，Apache-2.0，35MB .so 内嵌权重，EOT 单例官方自述 ~108MB 权重、运行态驻留 243M）。Python 生态段合计 ~136M。
- idle 进程 setup 再加：silero plugin import +14M、**silero VAD.load +0M**（实测零边际——silero plugin 1.6.3 默认路径就是 local_inference 的 native VAD，warmup 已付；包内另带公开 `silero_vad.onnx` 2.3MB 作 legacy 路径，这是 Rust 侧行为等价的抓手）、声纹 sherpa-onnx + CAM++（28MB onnx）+66M。
- transformers 磁盘装了 105M 但运行时零 import（死重不进内存，可从 venv 清理，与本任务无关）。

### 2.4 通话态：每路真实边际

rtc_probe 打主 worker（1 轮真实对话 + 18s listen，全链正常：eou 742ms / llm ttft 660ms / tts ttfb 400-587ms，与 skill 基线吻合）：

| 时刻 | 主 unit cgroup | job 进程私有 | 说明 |
|---|---|---|---|
| idle | 542M | 72M（idle 态） | |
| 通话中 t+11s/t+21s | **841M（+299M）** | **289M（+217M）** | 另有新补位 idle 进程 +72M 私有 |
| probe 退出后 ~40s | 542.3M | 进程已退（`process exiting` 确认） | **精确回落基线，零泄漏** |

- **每路并发边际 = ~289M**（短会话实测）；【历史】2026-07-16 双路峰值口径 440M/路（长会话 COW 分化更多）。取 **289–440M/路** 为区间。
- 项目自带 `job rss` 打点 646MB 与外部采样 667M RSS 吻合（监控口径健康）。
- 289M 私有的构成【推断】：CPython 引用计数写触碰导致的 COW 分化（共享底座页被写脏转私有，这是 fork+CPython 的结构性税）+ 每 job 的 RTC FFI 运行态 + 会话对象/音频缓冲/连接。精确到条目的拆分需要 job 进程内做 tracemalloc/pagemap 分析，P0 不再深入——现有粒度已足够支撑边界决策。

### 2.5 负载画像与第二瓶颈

- 24h job 分布：**主线 2 个 vs 租户线 472 个**（room 全为 `t-colleaguedem-*`，样本生命周期 ~54s 的高频短会话）——真实并发压力全在租户线，「WORKER_MAX_JOBS=2 顶满」的痛点主体是租户业务。
- CPU：7 天内 27 次 `inference is slower than realtime` 告警（历史集中在 job 启动峰）。**Rust 化只省管线 CPU（帧搬运/序列化/编排），模型推理 CPU 一分不省**——加路仍要内存+CPU 双盯，横向加机器仍是规模化终局（注册制水平扩展半小时/台已验证）。
- 容量账（现状）：两 unit 固定底 1184M + console 111M，可分配 ~3.1G → 剩 ~1.8G ÷ 289-440M = **全机 4-6 路**（与当前 MAX_JOBS 主 2+租 2=4 的配置吻合，且无 swap 余量紧）。

---

## 三、组件清单（重写对象盘点）

| 组件 | 现实现 | 依赖形态 | Rust 侧对应（见 §四/§五） |
|---|---|---|---|
| RTC 进房/收发 | livekit(-ffi) | **底层本就是 Rust**（Python 是绑定） | livekit crate 原生 |
| worker 注册/派单 | livekit-agents worker.py | WS + protobuf（livekit_agent.proto） | livekit-protocol crate 有全套生成类型，自建状态机 |
| VAD | silero plugin → local_inference native（512样本@16k 流式，activation 0.6/min_silence 0.3/min_speech 0.15 env 化） | native .so；公开 onnx 同型号在包内 | ort + 公开 silero onnx（3 个现成 crate），阈值重标定 |
| 判停 EOT | inference.TurnDetector v1-mini（概率二档 MIN/MAX + unlikely_threshold） | **闭源 CPython .so，驻留 243M** | **硬结：sidecar / 复刻 / 换方案三选**，建议 sidecar |
| STT | volc seedasr2.0（vendored 二进制帧 WS，_volc_asr.py 277 行）；租户线 xfyun_spark_iat（381 行，eos 断句+wpgs 拼接） | 纯 WS 协议 + 解析纯函数 | 自写（tokio-tungstenite），规格=自家 Python 实现 |
| LLM | FastLLM（httpx 直发 SSE，600 行）：双路赛马、prewarm、ThinkStripper、LeadingFillerStripper、身份注入近因位、tenant user 透传 | 纯 HTTP/SSE | reqwest/eventsource 自写，逻辑平移 |
| TTS | volc emo_v2 双向流式 WS + 连接池（_volc_tts_pool 242 行，SessionFinished 才回池）；租户 xfyun 超拟人 | 纯 WS 协议 | 自写，池语义平移 |
| 切句 | StreamAdapter + blingfire min_sentence_len=6；has_speakable 静音短路；strip_stage_directions | lk_blingfire（native 分句库） | 中文标点规则切句即可等价（min_len 参数本就是自定义行为） |
| 打断门控 | 字数门/时长门/急停白名单/假打断恢复 0.7s/恢复渐起 250ms/B9 声纹门（观测）/AEC warmup 0.5s 静音替换 | 框架 AgentSession 状态机 + 自有 env 参数 | **全部自建（最大行为等价面）** |
| 投机 | S1v3 静音预检（180ms/150ms/amp250）+ preemptive_generation + B5 interim 提交（主线 poc-eou.env） | STT 事件流 + 框架投机调度 | 自建 |
| 承接音 | FillerBank 9 桶 62 clips、概率 0.9、打断轮必播、滑窗 3 防重复 | 纯逻辑 + wav 直接播帧 | 平移（wav 帧推送） |
| 声纹 | sherpa-onnx CAM++ 26MB、turn 级识别、粘滞身份注入、ring buffer、registry 每 job 热读 | sherpa-onnx（C++ 核心） | sherpa-rs / sherpa-onnx crate（SpeakerEmbedding 支持明确） |
| 哨兵挂断/speaking 事件/metrics 发布 | SentinelStripper 纯函数 + publish_data | 纯逻辑 | 平移 |
| 契约日志 | 9 类契约事件 + interrupt telemetry + poc eou telemetry + truncation-suspect + join timing + job rss + stt final/tts synth/llm stream done | logging JSON 格式 | **逐字段等价保留（判读工具链复用的前提，rtc_probe/统计脚本全套免改）** |
| 音乐工具 | function calling（MusicClient） | HTTP | 平移或首版降级（主线在用，需列入等价清单） |
| 租户凭据 | tenant.py 热读 AES-GCM 存储 | 纯逻辑 | 平移（P4 后租户线迁移时做） |
| 生命周期 | delete_room_on_close、shutdown drain、respawn nice、load_fnc job 计数、num_idle=1 | 框架 | Rust 单进程后大半消失（无进程池），job 计数门保留 |

**行为参数总账**：上表全部参数已 env 化且有生效证据日志——这是重写验收的现成基建（Rust 版打同格式日志 + 同 env 键，rtc_probe 与判读脚本零改动可用于 A/B 并跑）。

---

## 四、Rust 生态三项验证（逐项实证，非训练记忆）

1. **LiveKit Rust SDK**（[rust-sdks](https://github.com/livekit/rust-sdks)）：
   - RTC 客户端 `livekit` crate 成熟维护中（Apache-2.0，多平台，simulcast/硬编解）；**生产 Python worker 的 RTC 底层就是本仓的 livekit-ffi**——媒体面能力已被我们生产验证 2 个月。
   - **agents 框架层（AgentSession/turn-taking/编排）无 Rust 实现**，官方 agents 只有 Python 与 [Node.js](https://github.com/livekit/agents-js)。
   - **worker 协议有正式规格**：[livekit_agent.proto](https://github.com/livekit/protocol/blob/main/protobufs/livekit_agent.proto)（RegisterWorker/Availability/JobAssignment/UpdateJobStatus/Ping-Pong，~18 消息类型，WS 双向 oneof），且 [livekit-protocol crate](https://docs.rs/livekit-protocol/latest/livekit_protocol/) **已含全套生成类型**（RegisterWorkerRequest/JobAssignment/WorkerMessage/ServerMessage 均确认在册）→ Rust 自建 worker 层 = 按 proto 写 WS 状态机（Python 参照实现 worker.py 千行级），不是逆向。
2. **silero VAD Rust 推理**：[ort](https://crates.io) 生态下至少三个现成 crate——[silero-vad-rs](https://docs.rs/silero-vad-rs)、[silero-vad-rust](https://crates.io/crates/silero-vad-rust/6.2.0)（自带 onnx 权重）、[voice_activity_detector](https://crates.io/crates/voice_activity_detector)（Silero V5，512 样本@16kHz 窗口，**与生产 native VAD 输入契约一致**）。另有官方 onnx 文件在 silero plugin 包内可直接复用。**可行性：高**。
3. **讯飞/火山 WS 协议 Rust 客户端**：crates.io 检索**无现成可用实现**（[rig-volcengine](https://crates.io/crates/rig-volcengine) 是 LLM 适配非语音；[active-call](https://crates.io/crates/active-call) 支持阿里/腾讯/Azure 等但未含火山/讯飞语音）。**结论：自写**，但风险性质是「翻译」不是「探协议」——火山二进制帧（_volc_asr.py）、讯飞三套签名（xfyun_common.py 纯函数）、超拟人/spark_iat 全协议已在自家 Python 生产代码里字段级实现并踩完坑。
4. **（附加盘点）v1-mini 判停**：`livekit-local-inference` 是 CPython 专用 .so（`_native.cpython-*.so`，pyo3/cargo 特征零命中，权重内嵌），**Rust 无直接链接路径**。选项：
   - **a) Python sidecar 共享单例（建议）**：独立小进程只装 local_inference（实测全链 RSS ~290M），UDS 暴露 `EOT.predict(≤1.2s pcm)->float`（每 turn 一次调用，非帧级热路径；GIL 已在 native 侧释放）。多路共享一份 → 判停内存全机恒定 290M。IPC 延迟【推断 <1ms，P2 实测】。
   - b) 换判停方案（纯 VAD+定时+火山语义兜底）：行为等价风险大，v1-mini 语义决策窗是打断体验核心资产，不建议作为首选。
   - c) 从 .so 提取权重自跑：Apache-2.0 允许但工程黑盒，脆弱，不建议。
5. **（附加）声纹 CAM++**：[sherpa-rs](https://github.com/thewh1teagle/sherpa-rs) / [sherpa-onnx crate](https://docs.rs/sherpa-onnx) 官方+社区 binding 均含 SpeakerEmbedding，同一 onnx 模型文件直接复用。**可行性：高**。

---

## 五、重写边界选项与收益预估

### 选项 A：全量 Rust worker（单进程 async 多路）+ EOT 判停 Python sidecar —— 建议主线

- 形态：Rust 进程实现 worker 协议 + RTC + 全部管线/门控/编排；v1-mini 经 UDS sidecar；VAD/声纹在 Rust 内用 ort/sherpa-rs 跑。
- 内存模型【推断，P2/P3 实测修正】：
  - 固定底：RTC + tokio + ort VAD + 声纹 ≈ 100-200M；EOT sidecar ~300M（全机一份）
  - 每路：音频缓冲 + WS 连接 + 会话状态 ≈ **10-40M**
  - 全机 6 路 ≈ 200+300+6×40 ≈ **740M**（对比现状 6 路需 ~3.3G，已超物理内存）；4G 机内存维度可承载 **15-25 路**，届时瓶颈转移到 4 核 CPU 的模型推理（VAD 帧级 × N 路 + EOT/声纹每 turn）。
- 工作量主体：**自建 agents 编排层**（判停调度/打断状态机/投机/切句/恢复语义）≈ 现 Python 业务 6000 行 + 框架被依赖语义（AgentSession/AudioRecognition/AgentActivity 核心路径）的等价重写，Rust 版估 8-15K 行【推断】。
- 风险：行为等价验收面大（三个月真机调优的资产逐项移植）；缓解 = 契约日志逐字段等价 + rtc_probe A/B 并跑 + 分阶段人工卡点（任务 O2-6 已内置）。

### 选项 B：Python 保留 + 推理 sidecar 化（2026-07-16 杠杆②的执行）

- 把 local_inference（EOT+VAD）与声纹下沉全机共享 sidecar，两 unit 的重复底座与推理段合并。
- 收益：省 ~300-600M 固定底；**每路 289-440M 边际不变**（per-job 进程税还在）→ 全机大约多挤出 1-2 路。
- 工作量小（天级），可作为 Rust 交付前的**止血临时件**（若租户并发压力先到）；不能达成 O1「并发明显提升」。

### 选项 C：Rust 数据面 + Python 控制面（per-job 混合）

- 每 job 的音频管线归 Rust、业务编排留 Python 协程。IPC 契约复杂（帧级双向流），双语言长期维护，收益介于 A/B。**不推荐**——复杂度买不来对应收益，且打断门控这类「数据面↔控制面毫秒级互动」的逻辑恰恰最难拆。

### 语言备选论证（O1 要求「Rust 或同级系统语言，论证后定」）

- **Rust 优先**：livekit crate/livekit-protocol/ort/sherpa-rs 四个关键依赖全部 Rust 原生或一等 binding；生产 FFI 底座同源（媒体面已被自己验证）。
- Go 备选：LiveKit server 是 Go，但**客户端 SDK Go 版无官方 RTC 实现**（media track 支持弱），VAD/onnx 生态弱一档 → 不选。
- Zig/C++：生态/安全性/维护性均无优势 → 不选。

---

## 六、建议与 P1 待拍板项

**建议**：选项 A 为主线，按任务 P2-P4 分阶段：
1. **P2 骨架**：Rust worker 以 livekit-protocol + livekit crate 进房收发音频，rtc_probe 姿势 E2E；**同时实测两个数**：Rust 侧每路边际内存、EOT sidecar UDS 往返延迟（把 §五 的两个【推断】变实测）。
2. **P3 逐组件迁移**（每个与 Python 版并跑对比）：VAD(ort) → volc STT WS → 切句+volc TTS WS(+池) → FastLLM(SSE+赛马) → 判停(先 VAD+定时，后挂 EOT sidecar) → 打断门控全家桶 → filler → 声纹 → 投机/B5。
3. **P4 行为对齐验收**：契约日志逐字段 diff + 延迟四锚点不劣化（判停 0.8-1.4s/LLM 首字/TTS 首包）+ 打断遥测统计口径复算，灰度切换（Python 版保留分钟级回滚，与既有 worker 注册制天然兼容——两 worker 同名注册即灰度、stop 即回滚）。

**P1 需川哥拍板**：
1. 重写边界选 A / B / C（或 B 先行止血 + A 主线并行）；
2. EOT 判停走 sidecar（保 v1-mini 行为等价）还是换方案（省 300M 但重标定判停体验）；
3. 音乐工具（function calling）首版是否进等价范围（主 worker 在用）；
4. 目标数字确认：基于本报告提议 O1 量化为——**单路边际 ≤50M（现 289-440M）、全机固定底 ≤600M（现 ~1.3G）、同机并发 ≥10 路（现 4-6 路）、延迟四锚点与打断行为不劣化**；
5. 新目录 `rust-worker/` + 分支名（建议 `feat/rust-worker`）。

---

## 七、顺手发现的问题（不属于本任务，需另行处理）

1. 🔴 **barge_gate 生产异常（本轮 probe 实锤）**：打断声纹判定抛 `ValueError: shapes (0,) and (192,) not aligned`（[speaker_id.py:214](../src/voice_agent/engines/speaker_id.py)，registry 中存在 embedding 为空的 profile？）。fail-safe 生效（「忽略,维持打断」），**行为无损**，但 B9 观测数据在此路径上是空转。同轮 turn 级识别正常（scores probe=0.803/川哥=0.108），仅 barge_gate 路径异常——两处 profiles 加载路径可能不一致。
2. **64.90 无 swap**：swappiness=60 已配但无 swap 分区/文件（迁移时未随带 47.239 的 2G swap 配置）。无 swap + 租户线高频短会话 = 尖峰时 OOM 零缓冲（cgroup Max 会先杀 worker 保 sshd，但用户面是会话死亡）。一条命令可补：`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`。
3. venv 内 transformers 105M 磁盘死重（运行时零 import），清理可省磁盘（49G 盘不紧张，低优先）。

---

*署名：cc（Claude）| 2026-08-12*
