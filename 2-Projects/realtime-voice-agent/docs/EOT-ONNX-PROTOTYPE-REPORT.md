# EOT ONNX 迁移原型报告（step 0–4 实测收口）

> 任务书：`docs/EOT-ONNX-MIGRATION-BRIEF.md`（main 分支，commit `76df558f2`）。
> 本轮产出：结论与原型，**未部署、未合并、未动生产**。
> 代码：分支 `feat/eot-onnx-prototype`（基线 `24bcc3b3b` = feat/rust-worker 部署基线）。
> 执行：cc（Claude）| 2026-08-15 | 实测环境：Mac（开发）+ 64.90.13.117（Xeon Gold 6248, 4 核, 生产三 unit 共存）

---

## 〇、TL;DR 与建议

**建议：条件 go。** 方向性证据支持迁移（判停分离度 AUC 0.952 vs 现役 0.671，思考停顿误打断
20% vs 98%，均在对话风格评测集上），三绿全部实测达标；但**两个上线前置**未清：
① 用自家真实对话音频重标定阈值（现有两个评测集一个是 TTS 合成、一个是朗读，都不是我们用户的分布）；
② 声纹侧 sherpa 与 ORT 1.28 的统一实证（本轮已证 sherpa venv 现有 1.24.4 **不可用**于单 ORT 方案，
需换形态，见 §一）。**wavekat zh fine-tune 不建议采用**（两个集上 AUC 均低于官方原版）。

| 三绿验收（任务书 §十 step 4） | 结果 |
|---|---|
| ① 单 ORT 下 silero 回归逐样本一致 + smart-turn 出概率 | ✅（行为级一致：max Δ 8.9e-7，门控零翻转；位一致跨 build 不成立，见 §一） |
| ② mel 数值对拍与 Pipecat 官方 numpy 逐元素一致 | ✅（6 case 里 5 个位一致，最差 3.9e-6，门 1e-4；Mac 与 64.90 同数） |
| ③ 本机延迟 T < 200ms（官方版与 zh 版各测） | ✅ p50/p95 达标（127/153ms），⚠️ 余量比转述值薄一半，max 偶发超线（§四） |

---

## 一、step 0：单 ORT 兼容验证——原始形态被证伪，修正形态成立

**原始方案（任务书 §六）**：`ort` 开 `load-dynamic`，`ORT_DYLIB_PATH` 指向 sherpa venv 自带的
`libonnxruntime.so`（SONAME 1.24.4）。

**实测（64.90）**：`ort 2.0.0-rc.13` **显式拒绝**加载：

```
Failed to load ONNX Runtime dylib: BadVersion { version_str: "1.24.4",
  path: "/root/voice-venv/.../sherpa_onnx/lib/libonnxruntime.so" }
```

**机制（rc.13 源码 `src/lib.rs:150-162`，本地 registry 实读）**：加载时调 `GetVersionString()`，
minor `< MINOR_VERSION` 硬拒绝，`>` 仅警告。`MINOR_VERSION = ort_sys::ORT_API_VERSION` = **28**
（rc.13 bundled 即 ORT 1.28.0，pyke dist 实证）。即 **rc.13 只接受 ORT ≥ 1.28**，低版本没有兼容模式。

**修正形态（本轮实测通过）**：方向反过来——**统一到 1.28**，sherpa 侧换 so 而非 ort 侧迁就：
64.90 直拉 MS 官方 `onnxruntime-linux-x64-1.28.0.tgz`，`eotbench-dynamic` 经 `ORT_DYLIB_PATH`
加载成功（`/proc/self/maps` 实证映射该 so）。对拍数据：

| silero 对拍（bundled=pyke 1.28.0 静态 vs dynamic=MS 1.28.0 dlopen，581 帧） | 值 |
|---|---|
| 位一致帧 | 185/581（**396 帧有位差**——同版本不同 build 的 SIMD/kernel 差异） |
| 最大绝对差 | **8.9e-7** |
| 门控行为（θ=0.6）翻转 | **0/581**（两侧 active 均 20 帧；全序列距阈值最近 0.002，余量 2000 倍） |

**结论与判据修正**：「逐样本一致」的**位一致版跨 build 不成立**（这是客观物理，不是缺陷），
行为级一致（数值差 ≪ 门控余量、事件序列相同）成立。附带发现：int8 量化图对**纯静音**这种
边界输入在不同 build 间有 1.7e-3 漂移（真实语音 case 全部位一致）——评测/回归判据一律行为级。

**sherpa 侧后续（落地前置 ②）**：venv 那份 1.24.4 的 so 在单 ORT 方案里**出局**。路径：
sherpa-onnx 从源码构建链 ORT 1.28（其 master 的 `cmake/onnxruntime.cmake` 已有 1.26+ 适配注释），
或等官方发新 ORT 版预编译包；声纹 fbank 是 sherpa 自己的 C++ 代码、与 ORT 版本无关，
但换 ORT 后 embedding 数值需与 registry.json 向量做相似度回归（旧向量是 1.24.4 算的）。
**回退方案（若 sherpa×1.28 不成）**：bundled 静态 1.28 + sherpa 私有 1.24.4 并存——
静态符号不进动态导出表，冲突面比两个动态 so 小；本轮未实测（无 sherpa FFI），下一轮验。

## 二、step 1：模型元数据核对——通过，一处名实不符已核清

| 项 | official v3.2 | wavekat zh |
|---|---|---|
| 输入 | `input_features` `[batch,80,800]` f32 ✅ 与 §五一致 | 同 ✅ |
| 输出 | `logits` `[batch,1]` f32 | 同 |
| 大小/sha256 | 8,679,182 B / `2bb026...67e4f`（完整值见 §附录） | 8,779,817 B / `5493e6...d31f` |

⚠️ **输出名叫 `logits` 但语义是 sigmoid 概率**——以官方推理代码为准
（pipecat `local_smart_turn_v3.py` 注释 "ONNX model returns sigmoid probabilities"，
输出直接与 0.5 比较，无 sigmoid 后处理）。名字是导出遗留。**未停下**（任务书判据是「与 §五 不符即停」，
§五 的语义描述正确，仅名字维度有出入且已用官方代码闭环）。

**意外收获**：wavekat 仓里有 `zh/results.json`——F1=0.840 转述的**出处坐实**：
他自己的测试集 n=256、F1 0.8405（CI95 [0.789,0.886]）、int8 导出后 0.8413，
**工作阈值 0.67**（不是 0.5）。仍不是我们数据上的成绩（见 §三，两个集上它都不行）。

## 三、step 2：中文对照评测——双集 × 三模型（本轮最重的数据）

### 设计

| 集 | 来源 | 形态 | 用途 |
|---|---|---|---|
| **官方口径集** n=929 | `pipecat-ai/smart-turn-data-v3.2-test` zho 全量（**全部 chirp3 TTS 合成对话**，正 473/负 456，负类均带 mid/endfiller 填充词标注） | 音频原样 pad/trunc 8s，零加工 | **锚**：复现官方自报数字→钉死评测管线；三方公平比 |
| **FLEURS 集** n=300 | google/fleurs cmn_hans test，真人朗读 150 句 | trim 尾静音 → 正类=全句 / 负类=40–70% 截断，各 +200ms 静音（生产静音触发点形态） | 真人语音 + 生产调用形态 |

旧模型按生产口径取尾 1.2s（`eot.rs` `EOT_MAX_SAMPLES`），新模型 8s 窗，各用各的生产口径=公平。
构造参数、随机种子、逐条 sha256 在各集 `meta.json`（数据不入库，脚本可全量复现）。

**管线锚定（先于一切结论）**：官方 v3.2 在官方口径集上实测 acc **86.44%** / P 0.897 / R 0.829 /
F1 0.862 vs 官方自报 85.79 / 0.894 / 0.818 / 0.854——**四指标全部 ±1pp 内复现**。
（官方表格的 "FPR 4.95%" 列与其 P/R 不自洽，反推破案：那一列口径是 FP/全样本=4.94%，
按标准定义 FP/负类=10.1%，与我实测 9.87% 吻合——锚牢固。）

### 结果

**官方口径集（chirp3 合成对话，n=929）——主决策依据**：

| 模型 | 工作阈值 θ | 漏判 miss（正类<θ→多等 MAX） | 误触发 false（负类≥θ→易抢话） | **AUC** | bestF1@θ* |
|---|---|---|---|---|---|
| 旧 v1-mini（现役） | 0.18 | 0.2%（1/473） | **97.4%**（444/456） | **0.671** | 0.700@0.51 |
| **官方 v3.2** | 0.50 | 17.1%（81/473） | **9.9%**（45/456） | **0.952** | 0.899@0.18 |
| wavekat zh | 0.67 | 19.0% | 48.7% | 0.729 | 0.720@0.40 |

**思考停顿分层（midfiller 负类=句中带「嗯/那个」类填充词，生产最痛的误打断场景，n=224）**：
旧模型误触发 **98%** → 官方 v3.2 **20%**（θ 各自工作点）——**5 倍改善**。

**FLEURS 集（真人朗读+触发点形态，n=300）**：三方全烂——旧 0.728 / 官方 0.766 / zh 0.636（AUC），
误触发全在 67% 以上。**朗读句截断分布偏出所有模型的训练域**（词中硬截断的子集误判率也 87%），
此集不能作模型优劣判别器，但它证明：**分布一换结论就翻，自家真实对话数据的重标定不可省**。

### 解读（含对现状的重新认识）

1. 旧模型 false@0.18=97.4% 与生产基线**互证自洽**：线上 77 样本仅 7.8% 低于 0.18（任务书 §八）——
   现役 EOT 几乎从不触发「再等等」，判停体验主要由 MIN/MAX endpointing delay 兜底，
   **模型贡献的信息量本来就低**。这是「换模型值得试」的最硬依据。
2. 官方 v3.2 的 0.952 分离度 + bestF1 阈值恰为 0.18 纯属巧合但好记；它在自家测试集的
   FNR 17% 表示**正类漏判换来了负类防守**——上线权衡是「响应略慢一点 vs 少抢话」，
   方向与当前用户痛点（被打断）一致。
3. **wavekat zh 出局**：两个集都不如官方原版（他的 2154 条 fine-tune 过拟合自家场景分布）。
   官方 v3.2 本身已含中文训练数据（benchmark 表 zh 929 样本）。
4. 所有评测数据都不是「我们用户的真实对话」——**生产不存通话录音（64.90 实查确认，
   无 recordings 目录）**，这条数据债是重标定的第一障碍（见 §六）。

## 四、step 3 + 时序：控制策略决策与延迟实测（三绿③）

**决策：保留「每停顿一次」高频策略 + 环境变量开关切「说话结束后单次」做 A/B**（任务书默认，无翻案证据）。
理由：高频策略的价值=停顿 200ms 时刻就预判（走 MIN 还是 MAX），改单次会把判停时点推迟到
VAD SpeechEnd（+300ms 静音门），实际上抬高所有 turn 的底线延迟——与迁移目的相反。

**成本重估（64.90 实测，nice -19、intra_op=1、生产三 unit 共存、空载窗口 load 0.01→0.67）**：

| 模型 | 形态 | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| official v3.2 | bundled | mel 28.1 + infer 98.8 = **127.0ms** | 153.0 | 155.4 | 162.5 |
| wavekat zh | bundled | **116.3ms** | 133.1 | 146.4 | 156.9 |
| official v3.2 | dynamic(MS 1.28) | 125.0ms | 163.9 | 180.4 | 184.7 |
| wavekat zh | dynamic | 118.0ms | 146.1 | 152.6 | **258.1**（mel 毛刺 143ms 一次） |
| 旧 v1-mini（对照，venv 直调同机同 nice） | in-process | **66.8ms** | — | — | —（eval 逐样本计时口径） |

- **T<200ms：p50/p95 过线**，p99 貼线（155–180），max 偶发超（258ms 一次）。
- ⚠️ 任务书转述的 65ms 实为本机 **127ms**——预算余量从「3 倍」修正为 **1.6 倍（p50）/1.3 倍（p95）**。
- 新模型是旧模型的 **1.9 倍**（127 vs 67ms，同机同 nice 同口径对照；历史口径「12ms」在本机不成立）。
- 高频策略总成本：每 turn 3–8 次 × 127ms CPU；当前并发峰值 2（任务书 §七），单核占用可承受，
  但 **6 路满载时（0.34 核/路 × 6 已近 4 核）判停会与 ASR/TTS 抢核**——上线前需在并发 ≥4 的
  压测下复测 T（本轮未做：空载窗口实测是任务书口径，满载是下一轮）。
- 优化余量（未做，量化过的候选）：mel 28ms 占 22%（f64 全程是对拍需要，生产可切 f32 或增量 mel）；
  ORT session 复用已做（每 job 一次加载 8.3MB 模型的成本待摊——原型每次 predict 复用 session ✓）。

## 五、step 4：最小原型与 mel 对拍（三绿①②）

原型 = `bench/` 独立 crate（`eotbench`，六个子命令：info/silero-parity/mel-parity/infer/bench/eval），
**不接生产链路**，主 crate `Cargo.toml` 零改动。构建走 GitHub Actions `eotbench-build.yml`
（push 触发——workflow_dispatch 对不在默认分支注册的 workflow 不可用，实测 `gh workflow run` 报
not found；push 触发读本分支定义，不污染 main）。ubuntu-24.04 构建，glibc ≤2.39 门 + bundled
不外链 onnxruntime 检查均过。

**mel 实现决策（对任务书 §八「用 mel-spec crate」的有据偏离)**：实读 `wavey-ai/mel-spec` 源码——
流式 f32 设计、无波形 zero-mean/unit-var 归一化、后处理是自家 max 归一化而非 Whisper 的
`(log+4)/4`、无 reflect-center-pad——「配置对」达不到 reference 口径，反而每处都要绕。
改为 **`realfft`(f64) + 逐行移植 pipecat vendored `_whisper_features.py`**（176 行全透明数学）：
periodic hann、reflect pad、Slaney mel+面积归一化、log10→drop 尾帧→clamp(max-8)→(x+4)/4，
f64 全程最后转 f32。**风险控制的本体从来是数值对拍而不是选哪个 crate**，对拍结果：

| mel-parity（6 case：3 真实中文 TTS 语音 + 噪声 + 纯静音 + 8.5s 正弦截断） | Mac bundled | 64.90 bundled | 64.90 dynamic(1.28) |
|---|---|---|---|
| mel 最大逐元素差（vs Pipecat numpy reference，f32） | 3.9e-6（5/6 位一致） | 同值 | 同值 |
| 概率差（vs python onnxruntime 1.28，两模型 × 6 case） | **全部位一致** | 全部位一致 | 11/12 位一致，1 个 1.7e-3（纯静音×zh int8，跨 build kernel 差异，见 §一） |

Slaney≠HTK、reflect pad、drop 尾帧、波形归一化时机（pad 之后、f32 层）这些静默失效点全部被对拍闭环关掉。

## 六、工作量与风险排序（上线视角，重标定置顶）

1. **🔴 重标定 401ms 判停链（必做，最大工作量）**：0.18 是旧模型概率分布的左尾标定值，
   新模型分布完全不同（官方集上 bestF1@0.18 只是巧合，FLEURS 形态下 @0.97 才最优——阈值随分布剧烈漂移）。
   需要：①采集自家真实对话音频（**当前生产不存录音，先建采集/脱敏管道**，或用 rtc_probe 场景库半仿真）；
   ②在生产触发点形态（停顿 200ms 快照）下标定阈值与 MIN/MAX delay 联动；③灰度 A/B 观测打断率/响应延迟。
   估计 2–3 个工作日（数据管道占大头），无真实数据则不可上线。
2. **sherpa×ORT 1.28 统一**（§一 前置②）：源码构建 sherpa-onnx 链 1.28 + 声纹 embedding 与
   registry.json 旧向量的相似度回归。约 1 个工作日；失败则走并存回退（+半天验证）。
3. **满载时序复测**：并发 ≥4 压测下 T 与 ASR/TTS 抢核情况（§四）。半天。
4. **生产化移植**：mel+推理进主 crate（`turn.rs`/`eot.rs` 改造，保留 UDS 声纹旁路直到 sherpa FFI 就位）、
   高频/单次开关、模型资产部署（「一个目录」形态：二进制+libonnxruntime.so.1.28+onnx×2）。1–2 个工作日。

## 七、退出条件（「万一新模型不如旧的」）

灰度期任一触发即回退旧 sidecar（保留原状即可回退，sidecar 代码本轮零改动）：
- 真实对话标定集上新模型 AUC < 旧模型（合成集 0.952 vs 0.671 的优势在真实分布上翻车）；
- 满载 T p95 > 200ms（判停赶不上 MIN delay，白算）；
- 灰度 A/B 打断投诉率/平均响应延迟任一显著劣化；
- sherpa 1.28 统一与并存回退**双双**失败（声纹功能性回退不可接受）。

## 八、资产指纹（仓外资产防分叉，任务书红线）

| 资产 | URL | sha256 |
|---|---|---|
| `smart-turn-v3.2-cpu.onnx` | `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx` | `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` |
| `smart-turn-zh-cpu.onnx`（wavekat） | `https://huggingface.co/wavekat/smart-turn-ONNX/resolve/main/zh/smart-turn-cpu.onnx` | `5493e67a58bd7c0439b43e34eeaf3f08e998310cfba42480ca94815b553ed31f` |
| ORT 1.28.0 Linux so（step 0 用） | `https://github.com/microsoft/onnxruntime/releases/download/v1.28.0/onnxruntime-linux-x64-1.28.0.tgz` | 未记（一次性验证件，已随 bench 目录清理；落地时重下并记指纹） |
| 评测集 | 脚本 `bench/build_evalset*.py` 全量可复现（源数据 HF 公开集，构造参数+逐条 sha256 在 meta.json） | — |
| Pipecat reference | `pipecat-ai/pipecat` main `src/pipecat/audio/turn/smart_turn/_whisper_features.py` + `local_smart_turn_v3.py` | 对拍靶生成脚本 `bench/gen_parity_refs.py` |

bench 实测时负载：uptime 前 `load 0.01,0.04,0.00` → 后 `0.67,0.24,0.08`（全程 nice -19，
生产三 unit 空载共存，rust 线近 10 分钟 job=0）。64.90 bench 目录已按约清理（跑完删）。

## 九、方法附注（本轮踩到/验证的）

- `gh workflow run` 无法 dispatch 只存在于 feature 分支的 workflow（GitHub 只注册默认分支定义）→ push 触发绕过。
- FLEURS 的 `id` 列非唯一键（同句多说话人），裸用作文件名 150 条里撞了 19 个——复合行号后 300/300 对齐。
- 官方 benchmark 表的 FPR/FNR 列口径是 FP/全样本，与标准定义差一倍——对不上先算自洽性再怀疑自己。
- 跨 build 位一致不成立（同 ORT 版本亦然）：回归判据一律行为级（数值差 vs 决策余量 + 事件序列）。
