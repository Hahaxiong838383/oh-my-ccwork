# FPGA + 摄像头 + LNN：实时表情与意图预测

> 整理日期：2026-07-18  
> 来源：微信文《把大模型塞进FPGA后续》研读 + LNN 硬件公开证据 + 工程架构分析  
> 原则：有出处的结论才写死；意图任务需自建标签，不可吹成已验证产品

---

## 0. 先对齐：微信文在讲什么

该文**不是**液体神经网络（LNN），而是：

- 本科生将 **nanoGPT（迷你 Transformer）** 部署到 **Zynq XC7Z020**
- 共享计算核 + **KV Cache** + INT8
- 板端 vs 定点 Python：200 token **0 失配**，约 **129.5 ms/token**
- 开源：
  - https://github.com/HanxinKING/nanogpt-zynq-backups/
  - https://github.com/zcxsince2005/My_Transformer_on_fpga
- 原文：https://mp.weixin.qq.com/s/ks59AqqyomQ0JNDl_dtTyw

**它证明：小型 Transformer 可上 FPGA。**  
**不能直接推出：文中已跑过 LNN。** 但其验收文化（金标准对拍、量化诚实、PPA）可迁移。

---

## 1. FPGA 能否运行 LNN？（有证据）

### 1.1 LNN 定义（LTC / CfC）

| 模型 | 说明 | 链接 |
|---|---|---|
| **LTC** Liquid Time-Constant | 连续时间 RNN，时间常数随状态变化，前向常需 ODE 数值求解 | https://arxiv.org/abs/2006.04439 |
| 官方代码 | LTC 仓库 | https://github.com/raminmh/liquid_time_constant_networks |
| **CfC** Closed-form Continuous-time | 闭式/近似更新，**避免迭代 ODE**，更适合嵌入式/FPGA | https://www.nature.com/articles/s42256-022-00556-7 |
| 易混淆：**LSM** Liquid State Machine | 更早的 reservoir「液态」模型，≠ 2020 LTC-LNN | Schrauwen 2008 FPGA LSM |

### 1.2 硬件证据

| 证据 | 内容 | 链接 |
|---|---|---|
| **A. MERINDA** | FPGA 加速 Model Recovery；相对 **FPGA-based LTC baseline** 可达约 **6.3× 更少 cycle**；明确讨论 LTC/ODE 在硬件上串行难并行 | https://arxiv.org/abs/2512.06113 |
| **B. OST 课题** | 在 **Kria KV260** 的 FPGA fabric 实现 **CfC**；CPU ~3.49 ms vs FPGA ~**22.5 µs**（约 155×）；代价是 MSE 升高 | https://www.ost.ch/files/daten/abstracts/pdf/0fa74ec8-23c8-40be-937d-b785254a7651.pdf |
| **C. Loihi-2** | LNN 上 **神经形态 ASIC**（非 FPGA），CIFAR-10 ~91.3%、~213 µJ/frame | https://arxiv.org/abs/2407.20590 |
| **D. LSM on FPGA** | 2008 语音识别，名字 liquid 但模型不同 | https://www.sciencedirect.com/science/article/abs/pii/S0893608007002353 |

**结论：FPGA 可以运行 LNN（尤其 CfC / 定点 LTC 基线）。**  
「能跑」≠「任意板子、任意规模、端到端像素 LNN」。

---

## 2. 摄像头 + LNN 做人脸后续表情/意图？

### 2.1 总判断

| 能力 | 判断 | 说明 |
|---|---|---|
| FPGA + 摄像头实时采集 | 成熟 | MIPI/USB + ISP 常规 |
| 帧级表情 | 成熟 | 轻量 CNN / 关键点为主 |
| **时序表情动态** | LNN/CfC **适合后端** | 连续时间序列建模 |
| **意图预测** | 须先定义标签与数据 | 无公开「LNN+FPGA+摄像头→通用意图」现成系统 |

### 2.2 为什么不能「整网 LNN 吃摄像头像素」

- LTC/CfC 强在 **小状态时序**，弱在 **高维空间特征**。
- 一帧 720p 是 \(O(10^5\sim10^6)\) 维；LNN 隐状态通常 **几十～几百维**。
- 公开 LNN 硬件成功案例是 **小网络时序**，不是端到端大视觉 backbone。

**正确分工：**

```
摄像头 → 图像前端(FPGA) → 人脸检测/对齐 → 空间特征(轻量CNN/关键点)
                                              ↓ 低维序列 f_t (32~128d)
                                         LNN/CfC 时序核
                                              ↓
                              表情状态 / 短期趋势 / 意图分类头
```

- **空间（这帧是什么）**：CNN / landmark  
- **时间（怎么变、下一步可能怎样）**：LNN/CfC  
- **意图**：在 **预定义意图集** 上的分类/回归头 + 置信度，不是读心

---

## 3. 高实时指标（先锁 KPI）

| 指标 | 建议目标 | 备注 |
|---|---|---|
| 端到端时延 | **≤ 30–50 ms** | 检测+特征+LNN |
| 吞吐 | **≥ 30 fps** 单脸 | 超时丢帧 |
| 表情 | 7 类基本情绪 **或** AU / 效价-唤醒 | 连续量更贴 LNN |
| 意图 | **3–8 类离散标签** + 拒识 | 必须自建数据 |
| 功耗 | 数瓦～十几瓦（板级） | 按场景 |

**实时性主要靠流水线并行。** CfC 在 FPGA 上单次前向可到 **µs～百 µs 量级**（OST）；瓶颈常在 **ISP + 检测 + 带宽**。

---

## 4. 推荐系统架构

### 4.1 硬件

```
[Camera MIPI CSI 优先]
        │
        ▼
┌──────────────────────────────────────────┐
│  FPGA SoC（KV260 / Zynq Ultrascale+）      │
│  ISP → 检测对齐 → 特征 CNN (PL, INT8)     │
│              ↓ 低维向量                      │
│         LNN/CfC + 意图头 (PL 定点)          │
│  PS(ARM)：业务、标定、日志、策略门闩          │
└──────────────────────────────────────────┘
        │
        ▼
  显示 / 车机 / 机器人（意图不直连危险执行器）
```

| 档 | 板子 | 用途 |
|---|---|---|
| 原型 | **Kria KV260** | 已有 CfC on FPGA 先例 |
| 低成本 | XC7Z020 | demo；难上高分多人 |
| 产品 | ZCU104 等 | 更高 ISP/多人预算 |

### 4.2 算法三段

**A. 前端（固定延迟）**  
采集 → 检测 → 对齐 → 特征（landmark 几何 **或** 轻量 FER embedding）

**B. 时序核**  
- 输入 \(x_t\in\mathbb{R}^{d}\)，\(d=32\sim128\)  
- **部署优先 CfC**（相对 LTC+ODE）  
- 输出：表情 \(e_t\)、趋势 \(\Delta e\)、意图 \(i_t=\mathrm{Head}(h_t)\)

**C. 后处理**  
EMA/迟滞、置信度门限、未知类；安全策略层。

### 4.3 流水线时延预算（示意）

| 级 | 模块 | 目标 |
|---|---|---|
| S1 | ISP/缩放 | 1–3 ms |
| S2 | 检测+对齐 | 3–10 ms |
| S3 | 特征 CNN INT8 | 3–15 ms |
| S4 | CfC 更新 | ≪1 ms |
| S5 | 后处理 | <1 ms |

S1–S4 **流水重叠**。

### 4.4 为何 CfC 优先于原始 LTC

- LTC：多步数值积分，硬件串行（见 MERINDA）  
- CfC：固定算子图，定点化后像小型 RNN 核  

**训练可探索 LTC；部署导出 CfC 或固定步数 LTC。**

---

## 5. 表情 vs 意图

### 表情（相对成熟）

- 数据集：AffectNet / FER2013 / RAF-DB 等  
- 结构：单帧 CNN + CfC 吃最近 T 帧（T=8~32）  
- LNN 价值：动态（假笑→真笑、皱眉过程）比单帧稳  

### 意图（必须自建）

1. 定义 3–8 类（例：专注 / 困惑 / 准备发言 / 不耐烦 / 离开倾向）  
2. 采视频 + 标注（或行为结果：是否提问、是否离座）  
3. 多任务头：共享 CfC → 表情头 + 意图头  
4. 报告 **提前量–准确率** 曲线；低置信拒识  

无第 2 步则任何「能预测意图」均不可信。

---

## 6. 分阶段路线

| 阶段 | 内容 | 周期量级 |
|---|---|---|
| **0** | 锁 KPI、意图标签、录数据 | 1–2 周 |
| **1** | PC 真值：检测+FER+CfC，对比单帧 | 2–4 周 |
| **2** | KV260：CNN 可 ARM/DPU，**CfC 上 PL** | 3–6 周 |
| **3** | ISP+检测+CNN+CfC 尽量全进 PL；金标准对拍 | 按资源 |
| **4** | 场测：光照/侧脸/遮挡；安全策略 | 持续 |

软件参考：

- ncps：https://github.com/mlech26l/ncps  
- CfC：https://github.com/raminmh/CfC  

---

## 7. 不建议

1. 端到端全 LNN 像素→意图（无充分公开先例）  
2. 用大 Transformer 做实时表情（带宽墙；见微信文 FFN/带宽分析）  
3. 未定义意图标签就宣称读心  
4. XC7Z020 硬上高分辨率多人 + 重 CNN + 大 LNN 当产品

---

## 8. 三句收束

1. **FPGA 可跑 LNN（CfC/LTC 有公开证据）；接摄像头做实时链路可行。**  
2. **表情时序：轻量视觉前端 + CfC/LNN 后端；意图：先标签与数据，再上头。**  
3. **高实时：MIPI 流水线 + INT8 前端 + 定点 CfC + ROI/丢帧，不是单靠 LNN 名词。**

---

## 9. 参考链接汇总

- 微信文：https://mp.weixin.qq.com/s/ks59AqqyomQ0JNDl_dtTyw  
- nanoGPT FPGA：https://github.com/HanxinKING/nanogpt-zynq-backups/  
- LTC：https://arxiv.org/abs/2006.04439  
- CfC (Nature MI)：https://www.nature.com/articles/s42256-022-00556-7  
- MERINDA FPGA LTC：https://arxiv.org/abs/2512.06113  
- OST CfC on KV260：https://www.ost.ch/files/daten/abstracts/pdf/0fa74ec8-23c8-40be-937d-b785254a7651.pdf  
- Loihi-2 LNN：https://arxiv.org/abs/2407.20590  
- EmotionNet Nano（轻量表情 CNN 方向）：https://www.frontiersin.org/articles/10.3389/frai.2020.609673  
