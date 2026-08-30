# 新 session prompt：用 Smart Turn v3 替掉闭源 EOT，目标是整个干掉 Python sidecar

调研 + 可行性验证任务。**这一轮不要改生产，产出是结论和原型，不是部署。**

---

## 一、任务

判断能否把 `voice-worker-rust` 依赖的 Python 推理 sidecar **整个删除**，方式是：
① 用 Pipecat Smart Turn v3（公开 ONNX）在 Rust 进程内做 EOT 判停；
② 声纹走 sherpa C API（路线分叉已解，见 §六——单 ORT 方案，Route B 已关闭）。

> 2026-08-15 可行性核验结论：**Go 原型**。生态承重引用已逐一实测（见 §五-b），
> 双 ORT 分叉已有干净解（§六），验收线是「原型三绿」（§十 step 0/5）。

> 🔴 **2026-08-30 终态更新：D3 标定判 NO-GO，迁移线暂停待真实用户数据。**
> 两周真机采集（2086 触发点，川哥开发测试流量）弱标签评测：v3.2 自家分布 AUC **0.705**
> vs 现役 0.683（领先 0.022 < 红线 0.10），miss≤10% 下误触发 72% 比旧模型还高；
> chirp3 上的 0.952 到真实自由对话塌陷——**FLEURS 教训二次应验，这次轮到 chirp3 自己**。
> 关键认知：**两个模型在自由对话分布上都接近无信息，当前判停体验由 MIN/MAX delay
> (0.40/0.8s) 与 VAD 静音门兜底——换纯音频 EOT 模型不是体验杠杆**；若真实用户分布
> 仍自由对话形态，判停正道是 ASR/语义融合（turn.rs on_final 锚），另行立项。
> 不作废资产：采集口照跑、评测管线（真实数据到量零成本重测，D4 重启条件
> ≥500 真实触发点且 AUC ≥0.80）、sherpa×1.28（部署形态收益独立成立）。
> 详见 `docs/EOT-D3-CALIBRATION-REPORT.md`（feat/eot-onnx-prototype `5380adb9d`）。
> ——以下 8-15 原型结论保留作历史（其「条件 go」的前置正是 D3，现已落锤）：

> ✅ **2026-08-15 原型已完成，三绿全过，结论：条件 go。**
> 报告（step 0–4 全部实测数+原始 tsv）：分支 `feat/eot-onnx-prototype` 的
> `docs/EOT-ONNX-PROTOTYPE-REPORT.md`（commit `9fc1fbef4`，未合并未部署）。要点：
> - **判停质量是真理由**：官方口径中文集（929 条，官方数字 ±1pp 复现锚定）上，
>   现役 v1-mini AUC **0.671**（生产阈值 0.18 下负类 97.4% 放行，与线上 7.8% 触发率互证
>   ——现役 EOT 几乎不贡献信息）；官方 v3.2 AUC **0.952**，思考停顿误打断 98%→20%。
> - **wavekat zh 出局**（两集 AUC 0.636/0.729 均低于官方原版，不采用）。
> - **§六 单 ORT 定案已修正**：ort rc.13 版本门拒绝 1.24.4，改「统一 1.28」形态（见 §六 修正块）。
> - **延迟**：64.90 实测 p50=127ms / p95=153ms（<200ms 过线；转述 65ms 不成立，
>   余量 1.3–1.6 倍；旧模型同口径 67ms）。
> - **两个上线前置已立项**：`tasks/voice-eot-上线前置.md`（真实对话重标定 + sherpa×1.28 统一）。

**这是一个「两半都成才有意义」的任务。** 只搬一半，Python 解释器 + numpy + 33.4MB 闭源 `.so`
还得留着，收益只剩约 11%，还多一份 FFI 代码要维护。

## 二、系统背景

- 项目：`~/mycc/2-Projects/realtime-voice-agent`，分支 `feat/rust-worker`
- 部署：`64.90.13.117`，unit `voice-worker-rust`，二进制 `/root/rust-worker/voice-rust-worker`，
  env `/root/rust-worker/rust-worker.env`
- 同机另有三个 **Python 生产 unit**（`voice-worker` / `voice-worker-colleague` / `voice-console`），
  在服务真实用户
- 机器：**4 核 / 3915MB / swap=0**，cgroup 上限总和已超配（6500M > 3915M）

### sidecar 现状（`rust-worker/sidecar/eot_sidecar.py`，142 行）

独立 Python 进程，UDS 长度前缀二进制协议，两个 op：

| op | 功能 | 入参 → 出参 | 频率 |
|---|---|---|---|
| 1 | EOT 判停 | i16le PCM 16k mono **≤19200 样本（1.2s）** → f32 概率 | 热路径，**每次停顿一次**（见 §四） |
| 2 | 声纹 embedding | i16le PCM ≤20s → 维度 + L2 归一 f32 向量 | 旁路，数百 ms |

Rust 侧调用点：`rust-worker/src/eot.rs` 的 `EotClient::predict()` / `SpeakerEmbedClient::embed()`。

## 三、已验证的事实（2026-08-15 实测；部署形态会变，用前复核）

**资源**（三个 worker 当时都空载 0 job）：

| 项 | 值 |
|---|---|
| Rust 本体 RSS | **90.1 MB** |
| Python sidecar RSS | **441.7 MB**（本体的 4.9 倍） |
| cgroup / 上限 / 并发 | 433M / `MemoryMax=1300M` / `WORKER_MAX_JOBS=6` |
| 每路 CPU | 0.34 核（72s CPU ÷ 210s 通话，16 job 全配对） |
| sidecar 可归因映射 | EOT .so 33.4 + OpenBLAS 23.1 + onnxruntime 18.5 + numpy 9.7 + sherpa 5.9，余约 340MB 是堆 |

**EOT 闭源 .so 的封闭程度**（Python 手解 ELF，libc 锚 = 2868 函数，解析器已验可信）：
33.4MB、**stripped**；`.dynsym` 270 条里已定义函数只有 **6 个**；唯一入口 `PyInit__native`；
**纯 C 名字 0 个**；`ldd` 不链 onnxruntime → 引擎与权重焊死在 `.so` 内，无可提取模型。
⚠️ 那台机器上 **`nm`/`readelf`/`objdump` 全没装**，直接跑会得到「0 个符号」的假阴性。

**Rust 侧已有能力**：`Cargo.toml` 有 `ort = "2.0.0-rc.13"`；`src/vad.rs` 有跑通的 ONNX 骨架
（`Session::builder()` / `Tensor::from_array` / `session.run(ort::inputs![...])`）；
`assets/silero_vad.onnx` 2.22MB 在跑。**加一个 ONNX 模型的边际成本很低，此前提已核实。**

**声纹侧**：`libsherpa-onnx-c-api.so` 导出 **176 个纯 C 函数**（35 个 Speaker 相关），
模型是外部文件 CAM++ 27MB。

## 四、🔴 最重要的一条：EOT 不是每 turn 跑一次，是每次停顿跑一次

源码实证 `rust-worker/src/pipeline.rs:562`：

```rust
if !active_frame && !self.eot_requested && gate.silence_dur_s() >= 0.2 {
    // 静音累积 ≥200ms:拿最近 1.2s 跑 EOT(每静音窗一次)
```

用户一恢复说话，`eot_gap_gen += 1` 且 `eot_requested` 重置，**下次停顿会再触发一次**。
说话带思考、带磕巴的用户，**一个 turn 里可能跑 3–8 次**。

**这带来一个比「换模型」大得多的问题：控制策略不同。**

- **Pipecat 的用法**：VAD 判定说话结束后跑**一次** Smart Turn，决定是否真的 end-of-turn。
- **我们的用法**：每个 200ms 停顿都跑一次，用概率决定走 MIN 还是 MAX endpointing delay。
  （语义：概率 < `unlikely_threshold` → 走 MAX；否则 MIN。
  概率含义是 P(complete)，**与 Smart Turn 输出方向一致**，这点是有利的。）

  🔴 **阈值真值是 `0.18`，不是代码默认的 `0.3550`。** 代码常量 `UNLIKELY_THRESHOLD_ZH=0.3550`
  被 `/root/realtime-voice-agent/poc-eou.env` 里的 `POC_EOU_UNLIKELY_THRESHOLD=0.18` 覆盖了。
  **别拿源码里的常量当运行时真值**——这个错我犯过一次，见下方基线数据。

现在每次只喂 1.2s、模型极小，所以高频调用无所谓。换成 Smart Turn v3 后每次要做
**800 帧 mel STFT + Whisper Tiny encoder，且在重叠音频上从头重算**。
**必须先决定：是保留我们的高频策略，还是改成 Pipecat 的单次策略。** 这是架构决策，不是调参。

## 五、Smart Turn v3 的已知参数（川哥调研，⚠️ 仍需对着实际下载的文件复核）

| 项 | 值 |
|---|---|
| 输入名 / 形状 | `input_features` / `[1, 80, 800]` float32 |
| 输出 | `[1, 1]` float32，**已是 sigmoid 概率**（P(complete)），常用阈值 0.5 |
| 音频 | 16kHz mono float32，**固定 8 秒窗口**（128000 样本；不足左 pad 零，超过取最后 8s） |
| 模型 | `smart-turn-v3.2-cpu.onnx`，实测下载 **8.28 MB** |
| 预处理（**不在 ONNX 图内**） | 截断/左 pad 到 8s → Whisper 风格 log-mel（`n_fft=400`、`hop=160`、**80 Slaney mel**、归一化）→ 加 batch 维 |
| 参考实现 | Pipecat 有纯 numpy 的 `compute_whisper_log_mel_features`（vendored，运行时不依赖 transformers） |

算术自洽性已核：128000 / 160 = 800 帧，与 `[1,80,800]` 对得上。

⚠️ **版本一致性**：签名是从 `smart-turn-v3` 的 `inference.py` 读的，文件是 **v3.2**。
**第一步就对着实际下载的 `.onnx` 读元数据确认形状与名字**，别跨版本推断。

⚠️ **Slaney mel ≠ HTK mel**。这两种 mel 刻度算出来的特征不同，而且**错了不会报错，
只会给出看似合理但标定错位的概率**——与声纹 fbank 是同一类静默失效。移植时必须与官方
实现做数值对拍（同一段音频，逐元素比对 mel 矩阵），不能只看「模型跑起来了」。

**许可证**：川哥 2026-08-15 拍板**不查**，理由是个人 demo。
📌 记准口径：这是**「决定不查」，不是「查过没问题」**。若将来这套进同事线或对外分发，需回补。

## 五-b、生态承重引用核验（2026-08-15 实测，探针配正向锚 `ort`=200 已过）

| 引用 | 核验结果 | 用法判定 |
|---|---|---|
| `pipecat-ai/smart-turn-v3` @ HF | ✅ 存在，5 个 onnx 齐（含 `v3.2-cpu`） | 主模型 |
| 中文 fine-tune | ✅ 在 **HF** `wavekat/smart-turn-ONNX` 的 `zh/smart-turn-cpu.onnx`（**GitHub 同名地址是 404**，家在 HF）；F1=0.840 出处已坐实（仓内 `zh/results.json`：自家测试集 n=256、工作阈值 **0.67** 非 0.5） | ❌ **2026-08-15 并测完成，出局**：官方口径集 AUC 0.729 / FLEURS 0.636，两集均低于官方原版（2154 条小样本 fine-tune 不泛化） |
| `mel-spec` crate | ✅ v0.4.0，**147 万下载** | **真横梁**：Whisper 兼容 log-mel 直接用它，mel 移植从「自己写」降为「配置对」 |
| `sherpa-rs` crate | ✅ v0.6.8，8 万下载 | Route A 不用手写 bindgen；也解决 so 的来源问题（见 §六） |
| `wavekat-turn` crate | ⚠️ 存在但 **总下载 462 / 近 90 天 140 / 仓库 9 stars / 主语言 TypeScript** | **「生产级」不成立。只抄读，不进 Cargo.toml**——判停热路径不押在无人使用的库上；它做的事抄读后自己写就一两百行 |
| `smart-turn-rs` crate | ⚠️ v0.1.0，**93 下载** | 同上，只当参考 |

## 六、双 onnxruntime 分叉：已解——单 ORT 方案（2026-08-15 定案）

> ⚠️ **2026-08-15 原型实测修正：本节「让 ort 加载 sherpa 那份 1.24.4」的形态已被证伪。**
> `ort 2.0.0-rc.13` 有显式版本门（`MINOR_VERSION=ORT_API_VERSION=28`，minor <28 直接
> `BadVersion` 拒载，源码 `lib.rs:150-162` 实读）——**rc.13 只接受 ORT ≥1.28，无兼容模式**。
> 单 ORT 方案本身仍成立，但方向反过来：**统一到 1.28**（sherpa 侧换 so，不是 ort 侧迁就）。
> 已实测：dynamic 加载 MS 官方 1.28.0 → silero 对拍 max Δ 8.9e-7、门控 0/581 翻转（行为级一致；
> 位一致跨 build 不成立，回归判据一律行为级）。sherpa 链 1.28 的构建+声纹向量回归见
> `tasks/voice-eot-上线前置.md` 前置②；失败则回退「静态 bundled 1.28 + sherpa 私有 1.24.4 并存」。

原始问题：`ort` crate 自带一份 onnxruntime，`libsherpa-onnx-c-api.so` 链**它自己那份**
`libonnxruntime.so`。两份进同一个进程 = 符号冲突风险 + 重复运行时/线程池。

**解法（实测支撑）**：sherpa 自带的 ORT **SONAME 实测为 `libonnxruntime.so.1.24.4`**。
`ort` crate 有 `load-dynamic` feature（运行时经 `ORT_DYLIB_PATH` 指定 so）——
**让 ort 直接加载 sherpa 那份 1.24.4** → 全进程一份 ORT，无冲突、无重复，
且 sherpa 的 fbank 逐位一致原样保住。

⚠️ 一个待验证前提（= §十 step 0）：`ort 2.0.0-rc.13` 的 API 绑定与 ORT **1.24.4** 兼容。
验法便宜：load-dynamic 模式跑现有 silero VAD，输出与 bundled 模式**逐样本一致**即过。

**Route B（ort 直跑 CAM++）关闭**，两个理由：
- CAM++ 要的是 **Kaldi fbank**（dither / preemphasis / povey window），不是 Whisper mel——
  `mel-spec` 帮不上它，复刻 Kaldi fbank 正是当初的拦路石；
- 「注册只有 2 人、重注册便宜」曾是 B 的理由，但**重注册便宜 ≠ fbank 好写**；
  单 ORT 方案已把 B 的唯一优势（单运行时）拿走，B 只剩成本没剩收益。

**部署细节（调研漏掉的）**：那些 `.so` 现在**住在 Python venv 里**
（`/root/voice-venv/.../sherpa_onnx/lib/`），删 venv 就删了它们。落地时把 sherpa 的 lib
拷到 `/root/rust-worker/lib/` 带 rpath，或用 `sherpa-rs` 从源码构建。
所以「自包含」的现实定义是**「一个目录」不是「一个文件」**：
二进制 + 2 个 so + 3 个 onnx。Python 解释器 / numpy / 33.4MB 闭源 `.so` 全消失——
静默降级故障类与部署负担已解决；真·单文件（sherpa 静态链接）以后做，不挡路。

## 七、🔴 资源收益已被证伪——不要以「省内存」立项

我先前算过：删掉 sidecar 能把 cgroup 底噪从 433M 降到约 190M（模型要搬进 Rust 进程，
省不到全部 442MB），每路预算从 `(1300−433)/6 ≈ 144MB` 提到 `(1300−190)/6 ≈ 185MB`。
**算术没错，但它算的是一个不存在的问题**——那是两个*配置值*相除，没有一个*观测值*。

去查运行时，四项一致指向「从未顶到过」<实测 2026-08-15>：

| 检查 | 实测 |
|---|---|
| cgroup `memory.events` | `max 0` / `oom 0` / `high 0`——**内存上限一次都没触发** |
| `memory.peak` ÷ 上限 | 437M / 1300M = **34%**（同事线 59%，`voice-worker` 27%） |
| CPU PSI `full total` | **0**——全机从未有任务因等 CPU 完全停顿 |
| 实际并发峰值 | 近 7 天 126 个 job，**同时在跑最多 2 路**（上限 6） |

**放宽一个从未顶到过的约束，收益是零。** 别把「+28%」写进立项理由。

### 真正成立的理由只有三条，都与省资源无关

1. **删掉一整类静默故障。** `rust-worker/src/eot.rs` 文件头记着：sidecar 那套
   「进程级单例 + 连接自愈」的由来，是**灰度线曾静默降级近两天**——判停永久退化成
   `min_delay`、声纹旁路永久关闭，对话照常，只有两条 WARN，**没有任何红灯**；
   而且 `systemctl restart` 自身就会造出这个状态。进程内加载失败会在**启动时确定性失败**，
   而不是运行两天后悄悄断连。**这条建议作为主要立项理由。**
2. **部署形态。** 现在部署 Rust worker 还得配一个装了 `livekit.local_inference` +
   `sherpa` + `numpy` 的 Python venv——**「一个二进制」目前是假的**。
   若目标是自包含、可交付他人运行，这条是实打实的。
3. **判停质量可能更好。** 唯一能改善用户体验的维度，但这是**实验**不是优化，可能更差。

⚠️ 如果这三条你都没有实感，**这个方案就该往后排**——按当前数据，sidecar 没有造成
任何可测量的伤害。

## 八、成本与风险排序（已按 §四 重排）

1. **最高**：在真实中文对话数据上重新标定阈值 + 重新验证 401ms 级判停与打断行为。
   **现有生产阈值是 `0.18`**（不是源码常量 0.3550），是旧模型专属的标定值，换模型直接作废。

   **旧模型的概率分布基线**（77 个样本，2026-08-15 08:59 起，`RUST_LOG` 含 `voice_rust_worker=debug`
   才能看到这些 `eot prediction` 行）：

   | 统计量 | 值 |
   |---|---|
   | min / p25 / 中位 / max | 0.085 / 0.400 / 0.613 / 0.813 |
   | **低于 0.18（触发「再等等」）** | **6/77 = 7.8%** |
   | 若用 0.3550 | 14/77 = 18.2% |

   ⚠️ **拿 0.3550 当基线会把「再等等」的触发率高估 10.4 个百分点（两倍多）**，
   新旧模型对照会整体错位。基线用 **0.18 / 7.8%**。
2. **次高（原先低估了）**：控制策略抉择——保留「每停顿一次」还是改成「说话结束后一次」；
   以及音频缓冲从 1.2s 窗口改成全 turn ≤8s（内存增量小：128000×2B ≈ 256KB/job，
   6 路约 1.5MB，可忽略；**贵的是重复计算，不是存储**）。
3. **中等（已降险）**：Whisper log-mel——用 `mel-spec`（147 万下载）而非自己写，
   风险从「实现错」降为「配置错」；与 Pipecat 官方 numpy 实现的数值对拍照做（Slaney/HTK 陷阱见 §五）。
4. **较低**：加载 8.3MB ONNX + ort 推理（已有 silero 经验）。

### 时序预算——比「12ms 快不快」更硬的验收线

真正的约束链：静音累积 200ms 触发 → 推理耗时 **T** → 概率必须在 MIN endpointing
delay（~401ms）生效前到达，否则这次推理白跑。**T 的预算 ≈ 200ms。**
转述的 65ms（普通云实例）有 3 倍余量；本机 CPU 实测为
**Xeon Gold 6248（Cascade Lake，AVX-512 全套）**，int8 条件很好——
但 T 必须**在本机、生产三 unit 共存的条件下**实测，不在开发机上测。
高频策略总成本 = 每 turn 3–8 次 × T，当前并发峰值 2 的量级下可忽略；
**保留高频先行 + 留单次开关做 A/B**。

## 九、约束红线

- **不许碰** `voice-worker` / `voice-worker-colleague` / `voice-console`——在服务真实用户。
  本任务只在 `voice-worker-rust` 上做，**且这一轮不部署**。
- 重启 `voice-worker-rust`：`stop` → 确认 EOT sidecar / 活跃 job 清零 → `start`，
  **禁止 `systemctl restart`**（EOT sidecar 新旧实例竞态，正是 §七 那次事故的成因）。
- 凭据：讯飞 / 火山 / LiveKit key 一律 env 注入，不硬编码、不进 git、不出服务器。
  **绝不要往 `/root/realtime-voice-agent/.env` 写任何东西**（与 Python 生产线共享）。
- 判停行为若有变更，列变更清单交川哥拍板，不要自行决定「差不多就行」。

## 十、执行顺序（按证伪成本从低到高；路线已定 = 原 step 3 删除）

0. **单 ORT 兼容验证（§六 的待验前提）**：`ort` 开 `load-dynamic`，`ORT_DYLIB_PATH`
   指向 sherpa 的 `libonnxruntime.so.1.24.4`，跑现有 silero VAD——
   输出与 bundled 模式**逐样本一致**即过。不过则回退「两份 ORT 并存」再评估。
1. **对着实际下载的 `smart-turn-v3.2-cpu.onnx` 读元数据**，确认输入名、形状、输出形状。
   与 §五 表格不符就先停下报告。（10 分钟）
2. **造中文对照评测集** ——**这是真正的第一个工程任务，也是最容易被跳过的一步。**
   跳过它，整件事无法验收：你将无法区分「新判停更好」和「新判停不同」。
   至少要能算出：同一批真实音频上新旧模型的判停时刻差、误触发率（用户思考/换气被打断）、
   漏判率（说完了不接话）。**没有这个对照集就别往下走。**
   评测集**同时测官方 v3.2 与 zh fine-tune**（后者 F1=0.840 是转述，正好用它验）。
3. **决定 §四 的控制策略**（每停顿一次 vs 说话结束后一次；默认保留高频 + 开关）。
4. **最小原型**：`ort`(load-dynamic) + `mel-spec` + 官方 onnx，喂真实音频打印概率。
   **不接生产链路。** 验收「原型三绿」：
   - ① 单 ORT 下 silero 回归逐样本一致 + smart-turn 出概率
   - ② mel 数值对拍：与 Pipecat 官方 numpy 实现逐元素一致（Slaney 陷阱在此关掉）
   - ③ 本机延迟实测 **T < 200ms**（官方版与 zh 版各测，见 §八 时序预算）

## 十一、期望产出

- 上述 0–4 每步的结论与证据（可核验，不要转述）
- 工作量与风险评估，**必须包含重新标定 401ms 这一项**
- 「万一新模型不如旧的」的退出条件
- 明确的 go / no-go 建议，附理由

## 十二、几条方法纪律（本项目踩过的）

- **阴性结果先怀疑自己**：工具没装、参数写错、grep 模式对不上日志格式，
  产生的信号与「功能不存在」完全一样。期望零命中的检查必须配一个期望非零的锚。
- **别在空载态测内存**：上面所有内存数都是 0 job 时量的，**单 job 内存至今无实测依据**。
- **验收判据要行为级**，不能是「ONNX 加载成功」「单测全绿」。
- **仓库不是运行时资产的真源**：本项目已出现过仓内资产与线上资产分叉（同名文件不同内容）。
  取件地址以线上生效的 env 为准。
