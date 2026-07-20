# Feature Contract — 视觉前端 ↔ 时序核 接口契约

| 项 | 内容 |
|---|---|
| 版本 | v0.1（`contract_version = 1`） |
| 日期 | 2026-07-20 |
| 配套 | 主文档 [`fpga-lnn-camera-expression-intent-full-v2.1.md`](fpga-lnn-camera-expression-intent-full-v2.1.md) §6.3/§8/§12；[标注手册](intent_annotation_handbook.md) §2/§6 |
| 场景 | 办公会议（context schema v1）；车载预留（schema 另立，§9） |
| 铁律 | ① 契约任何变更必须升 `contract_version` + 重生成对拍向量（§10）；② **缺失禁止灌中性缺省值**——LnMem 死维事故的根因就是「缺省值假装在线」（手册 §6 R2） |

---

## 1. 契约定位

本契约是**前端（ISP / 检测 / 对齐 / 特征提取 / context 采集）与时序核（CfC）+ 任务头之间的唯一数据边界**。前端实现可替换（OpenCV → DPU → 纯 PL；F1 几何 → F2 embedding），只要本契约不变，时序核 IP、训练代码、评测 harness 零改动。

消费方（时序核 / 头 / 录制器 / 健康监控）只依赖本文件定义的语义，不依赖任何前端实现细节。

---

## 2. FeatureFrame v1 字段总表

| 字段 | 类型 | 单位 / 取值域 | 说明 | 缺失语义 |
|---|---|---|---|---|
| `contract_version` | u8 | =1 | 消费方校验，不匹配即整帧拒绝 | 不可缺 |
| `ts_ms` | u64 | ms，**单调时钟** | 帧进 ISP 时打戳；禁止 wall-clock（§5） | 不可缺 |
| `track_id` | u32 | | 人脸轨迹 ID；变化触发 soft_reset（§7） | 不可缺 |
| `face_bbox` | 4×u16 | 归一化 ×1e4 | x, y, w, h | 无脸全 0 + `valid=false` |
| `pose` | 3×i16 | 度 ×100 | yaw, pitch, roll（img2pose 类 3DoF） | 置 0 + `pose_valid` 位 |
| `pose_valid` | bool | | | — |
| `feat` | 64×f16（部署 64×i8） | 归一化（§3） | 视觉主特征，d=64 v1 锁定 | 不可缺；`valid=false` 时内容未定义 |
| `context` | 16×f16（部署 16×u8） | §4 | 会议 context schema v1 | **`context_valid=false`；禁止填 0.5/0 假装在线** |
| `context_valid` | bool | | context 采集链在线与否 | — |
| `quality` | f16 | [0,1] | 综合质量分（§6） | 不可缺 |
| `valid` | bool | | 人脸链路本帧是否可信 | — |

---

## 3. 视觉特征 `feat[64]`

1. **语义**：前端方案 F1（landmark 几何）/ F2（FER embedding）/ F3（融合）最终经线性投影统一到 d=64；**投影层属于前端**，时序核只认 64 维。
2. **归一化**：训练侧 per-dim standardize；μ/σ 随模型工件发布（`artifacts/model_quant_spec.json`），部署侧将 μ/σ 定点折叠进投影。
3. **换前端 = 换投影**：契约不变，但必须重训时序核并升 `model_version`（不升 `contract_version`）。
4. **量化**：训练 f16/f32；部署 INT8，scale/zero_point 在 quant_spec，不在本契约硬编码——但**每维 scale 变更视同模型变更**，触发对拍向量重生成（§10）。

---

## 4. context schema v1（会议场景，k=16）——本契约核心增量

| idx | 名称 | 编码 | 取值域 | 来源 |
|---|---|---|---|---|
| 0–7 | `last_event_type` | one-hot | {none, speech_start, speech_end, question_asked, screen_share_change, agenda_item_change, join_leave, mute_toggle} | 会议系统事件总线 |
| 8 | `dt_last_event` | log1p(s)/log1p(600)，clip | [0,1] | 同上 |
| 9 | `someone_speaking` | binary | {0,1} | VAD / 会议系统 |
| 10 | `self_speaking` | binary | {0,1} | 同上（I3 排除条件依赖此位，手册 §1.4） |
| 11 | `kbd_mouse_activity` | 30s 滑窗活动占比 | [0,1] | 本机键鼠钩子（**只采活动率，不采内容**） |
| 12 | `meeting_elapsed` | min(t/3600, 1) | [0,1] | 会议系统 |
| 13 | `agenda_dwell` | log1p(s)/log1p(1800)，clip | [0,1] | 议程事件推导（I2 判据依赖，手册 §1.4） |
| 14 | `hour_sin` | sin(2π·hour/24) | [−1,1] | 本地时钟 |
| 15 | `hour_cos` | cos(2π·hour/24) | [−1,1] | 同上 |

**规则**：

1. one-hot 只编码**最近一个**事件；事件本体全量流（含 `id`/`t`/`type`）单独落盘供标注与回放（手册 §2.3、§3），`context` 只是其在线摘要——**在线摘要丢了可以从事件流重建，反之不行**；
2. 任一来源链路不可用 → 整组 `context_valid=false`；**禁止部分维度静默填缺省**（LnMem：4/18 维恒 0.5 跑一个月无人发现，且死维在 kNN MI 诊断中产生正偏假信号）；
3. 意图头消费规则：`context_valid=false` ⇒ 意图输出强制 `unknown`（表情头不受影响）；
4. **per-dim 活性统计**（滚动 1h mean / var / 饱和率）由 context 生产方写健康日志，死维/饱和维告警（手册 §6 R2/R4）。

---

## 5. 时间与 dt 语义（CfC 关键）

1. **时钟源**：板端 monotonic 时钟；会议事件等外部时间统一换算到同一 monotonic 轴，换算偏移量进日志（多机 NTP 漂移会伪造 anchor 违例，手册 §4.3）。
2. **dt 计算**：`dt = ts_ms(本帧) − ts_ms(上一 valid 帧)`，由**时序核侧**计算，不在帧内传输。
3. **丢帧语义**：丢帧后 dt 自然增大并**如实喂给 CfC**——这正是选 CfC 而非 GRU 的理由（主文档 §19），**禁止插值补帧制造均匀序列**。
4. **断流**：dt > 2000ms 视为断流 → soft_reset（§7），不喂超大 dt。
5. 消费方**不得假设帧间隔均匀**（标称 30fps 仅是标称）。

---

## 6. quality 与 valid 行为矩阵

`quality` 组成（前端计算）：检测置信 × 模糊度 × 遮挡估计 × 曝光稳定性（AE 突变窗口内降分，主文档 §8.1）。

| 条件 | 时序核 | 表情头 | 意图头 |
|---|---|---|---|
| `valid` ∧ quality ≥ Q_hi | 正常更新 | 正常输出 | 正常（仍受 `context_valid` 约束） |
| `valid` ∧ Q_lo ≤ quality < Q_hi | 衰减更新（λ·h 保持） | 输出 + `degraded` 标记 | 拒识阈值收紧 |
| `valid` ∧ quality < Q_lo | 冻结 h | `stale` 上一有效值 | `unknown` |
| ¬`valid` | 冻结 h；持续 >2s 走断流 | `NO_FACE` | `unknown` |

> Q_hi=0.6 / Q_lo=0.3 为**占位初值**——按手册 §6 R4，上线前必须用实测分布（P50/P75/P90 + 饱和率）校准替换，禁止沿用拍脑袋值。

---

## 7. 状态管理

1. **soft_reset 触发**：`track_id` 变化 / 断流 >2s / PS 显式命令（换人、标定）。
2. **reset 清理范围**：h 状态 + 输出平滑器（EMA/迟滞）+ 意图告警冷却计时器——**三者必须同清**（LnMem 教训：回滚清状态不清 cooldown 会产生幽灵抑制窗口）。
3. h 掉电保存可选（BRAM→PS）；恢复时距上次有效帧 >60s 直接清零重来。

---

## 8. 传输与内存布局

1. PL 内：AXI-Stream，字段按 §2 顺序打包，64-bit 对齐，帧头 magic `0xFE47` + `contract_version`；
2. PL→PS 结果通道：AXI-Lite mmap 结构体，同样带 version 校验；
3. 字节序：little-endian；保留字段填 0 且消费方忽略（为 §9 追加预留）。

---

## 9. 版本演进与车载预留

1. **只允许尾部追加字段** + 升 `contract_version`；消费方按 version 向后兼容读取；
2. **车载 context（schema v2）**：事件集与 idx 语义**整表另立**（车速档位 / 导航事件 / 乘客交互等），不复用会议 idx 语义——引入时随 `contract_version=2` 增加 `context_schema_id` 字段区分，会议=1 / 车载=2；
3. 曝光 / ROI / 阈值等场景差异走配置 profile（主文档 §8.7），不动契约；
4. 标签体系的车载映射见手册 §1.4 末表。

---

## 10. 对拍绑定

1. `bitexact_vectors/` 目录按 `contract_v{N}_model_{hash}/` 命名；
2. 契约、量化 spec、μ/σ 任一变更 → 对拍向量**全量重生成**；
3. Python 定点金标准与 RTL cosim 消费**同一份二进制向量文件**，禁止各自造数据（主文档 §12.5 / §15）。

---

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-07-20 | 首版：FeatureFrame v1 字段总表 + 会议 context schema v1（k=16）+ 可变 dt 语义 + quality/valid 行为矩阵 + 车载 schema 预留 + 缺失禁灌缺省铁律 |
