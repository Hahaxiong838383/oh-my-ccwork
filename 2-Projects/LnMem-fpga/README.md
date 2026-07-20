# LnMem-fpga — LnMem 硬件化分支：FPGA + 摄像头 + LNN 实时表情/意图

> **定位**（川哥拍板 2026-07-20）：LnMem 的**硬件化分支路线之一**——把「摄像头 → 时序特征 → 表情/意图」链路下沉到 FPGA 边缘设备。
> **场景**（同日拍板）：先做**日常办公会议**场景；架构须保留**车载**扩展性（配置 profile 化，不改架构）。
> **状态**：方案设计阶段，阶段 0 未启动。母项目 LnMem 暂停中（重启入口 ADR-042，见 [LnMem-poc 交接](../LnMem-poc/docs/handoff/2026-07-03-project-pause-handoff.md)）。

## 文档清单

| 文件 | 说明 |
|---|---|
| [fpga-lnn-camera-expression-intent-full-v2.1.md](fpga-lnn-camera-expression-intent-full-v2.1.md) | **现行完整设计**（2026-07-20）：v2.0 基础上吸收 LnMem 实证教训 + 2026-H1 趋势刷新 |
| [intent_annotation_handbook.md](intent_annotation_handbook.md) | **意图标注手册 v0.2**：LnMem 14 条学费固化为管线红线 + §1.4 会议场景标签集 v1（I0–I5 实例化） |
| [feature_contract.md](feature_contract.md) | **接口契约 v0.1**：FeatureFrame v1 + 会议 context schema v1（k=16）+ 可变 dt 语义 + 车载 schema 预留 |
| [stage0-platform-decision.md](stage0-platform-decision.md) | **阶段 0 决策件（待拍板）**：FPGA 直上 / Orin / 软件版先行三选一，cc 推荐软件先行 + FPGA gate 后置 |
| [fpga-lnn-camera-expression-intent-full-v2.md](fpga-lnn-camera-expression-intent-full-v2.md) | v2.0 历史版（与 v2.1 diff 对照用） |
| [fpga-lnn-camera-expression-intent.md](fpga-lnn-camera-expression-intent.md) | v1 摘要版（历史；结论以 v2.1 为准） |

## 与 LnMem 的关系

- **共享科学结论**：纯脸部特征对意图信号极弱（0.086 bits 到顶）、context 是因果上游、时序增益必须 MI 门实证——详见 v2.1 §10.0 / 手册 §11 学费映射表。
- **可复用资产**：中立裁判 harness [`../LnMem-poc/scripts/diag_mutual_information.py`](../LnMem-poc/scripts/diag_mutual_information.py) / `diag_within_session.py`。
- **对齐点**：LnMem 重启入口 ADR-042（多模态输入面升级）与本分支的 context 输入面设计同向，重启时统一对齐。

## 下一步（待川哥点名启动）

- [x] 手册 §1.4 会议场景标签集 v1（I0–I5 实例化，2026-07-20）
- [x] `feature_contract.md` v0.1（会议 context schema v1，2026-07-20）
- [x] **部署平台决策：D3 软件版先行**（Mac 零采购，FPGA=阶段 2b gate 后置，2026-07-20 拍板）
- [x] **采集管线 v0**（`capture/`，真机验收 2026-07-20）：摄像头特征 + context + 事件锚 + anchor CI + 健康哨兵
- [x] **T1 实时面板**（http://127.0.0.1:17860，2026-07-20）+ **T2 自动标注**（autolabel/confirm，事件锚规则版——隐私设计不存帧故 VLM 无用武之地，事件锚本就是 v1 主力）
- [ ] **T3 数据积累**（川哥：每场会一条命令 + 会后 autolabel/confirm，目标首批 300 条干净标注）
- [ ] T5 阶段 0 收尾：KPI 表冻结（Mac 软件版口径）+ 意图标签定义签字
- [ ] T4 MI 门（首批 300 条自动触发）→ T6 训练 A/B → T7 意图 demo → T8 判决点
- [ ] KV260 阶段 2b 实施清单（gate=T8 效果达标后启动）
