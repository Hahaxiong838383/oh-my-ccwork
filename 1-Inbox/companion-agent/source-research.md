# 伴侣型 AI 智能体——"万能语法 + LNN 心智核心"激进 12/18 月实施方案

## TL;DR
- **核心判断**：12 个月做出可向 10–50 名种子用户验证的 MVP 是可行的，但前提是把 LNN 主干"窄化"到 Layer 1–2（秒级感知 + 分钟级工作记忆）+ 离线 consolidation；Layer 3–7 在前 12 月用"LLM + 万能语法槽位 + 时间感知知识图(Graphiti/Zep)"组合 mock 出来，再在 12–18 月窗口逐层替换为自研液态层。把 LNN 当成"必须自研"的整体大脑去做，时间线必败。
- **万能语法的最佳归位**：把 20 槽 schema 作为**全系统共享的"事件张量(Event Tensor)"**，同时充当 (a) 情景记忆/语义记忆的统一索引 schema，(b) 多模态信号到 LNN 的结构化输入接口，(c) 个性化的可解释表示（每用户的槽位偏好分布即"人格画像"）。它不是某一层独占，而是 Layer 2–5 的横切骨架——这一点是项目能在 12 个月内跑起来的最关键架构决策。
- **不可妥协 / 必须降级**：CLS 双系统、事件分割写入门控、槽位 schema、时间感知 KG、状态摘要+LLM 这五项保留为 v1；但 **State-offset Tuning 直接套到 LTC/CfC 的可行性为中-低**——Kang et al. ACL 2025 (arxiv 2503.03499) Limitations 段明确写道："*While we demonstrate that State-offset Tuning is effective for fine-tuning SSMs in the text domain, its applicability to other domains, such as vision or speech, remains unexplored*"，且其等价性证明 (`h' := A_{t+1}^{-1} B_{t+1} x_{t+1}`) 依赖线性 SSM 递归，LTC/CfC 的非线性门控破坏其理论基础；截至 2026 年 4 月没有任何公开工作把它移植到 LTC/CfC，连后续 S₀ Tuning (arxiv 2604.01168) 也仅扩展到混合 Mamba+Attention 的线性递归——必须降级为 LoRA-on-LLM + per-user 槽位偏好向量 + 简单 BitFit on LTC 的组合方案，作为 12 月 MVP 的个性化路径。

---

## Key Findings（与项目假设的对照）

| 已确定假设 | 调研结论 | 行动建议 |
|---|---|---|
| LTC/CfC 作为持续运行心智核心 | 工程可用：`ncps` 库（mlech26l/ncps，2.3k stars，含官方 PyTorch + Lightning tutorial）已实现；Liquid AI 已与 Brilliant Labs 签 LFM2-VL-450M 授权（Liquid AI 新闻稿 2025-09-15："*Brilliant will be licensing the current and upcoming multimodal Liquid foundation models*"），并与 Shopify 签多年合作（GlobeNewswire 2025-11-13："*first production deployment is a sub-20ms text model that enhances search*"），证明商业链路打通；Loihi-2 上端侧 15.2 ms / 帧、213 µJ/帧、CIFAR-10 准确率 91.3%（Pawlak et al. 2024, arxiv 2407.20590） | LTC/CfC 用于 Layer 1–2 OK；Layer 3+ 用 LLM mock，**不要**自己训大型 LNN 主干 |
| 国产多模态大模型作为高带宽解释器 | Qwen3-VL（2B/4B/8B/32B + MoE 30B/235B）、MiniMax M2.7、GLM-5.1（MIT 许可可自托管，744B/40B-active）、DeepSeek-V3/V4、Fun-ASR / GLM-ASR-Nano-2512（1.5B，覆盖 7 种汉语方言 + 26 种地方口音）全部可用；OpenAI-兼容 API；具体价差按 Apidog 定价指南（2026-04-23）："*V4-Pro is roughly 8.6× cheaper than GPT-5.5 and 21× cheaper than Claude Opus 4.6*" 输出 token | 主用 Qwen3-VL（视觉）+ Fun-ASR（语音）+ DeepSeek-V3 或 GLM-5.1（推理/对话）；车载离线兜底用 LFM2-1.2B 或 Qwen3-VL-2B |
| 事件分割模块 GEBD/On-GEBD | EfficientGEBD（ACMMM 2024, Ziwei-Zheng/EfficientGEBD）、On-GEBD ESTimator（CVPR 2025，启发自 Event Segmentation Theory，使用 Consistent Event Anticipator + Online Boundary Discriminator）开源可用，但都是离线/视觉；流式多模态部署需自适配 | v0：用规则+LLM 心跳判断 boundary（语义大变 / 时间间隔 / 用户主动切换）；v1：On-GEBD ESTimator 在多模态特征上重训 |
| Graphiti/Zep 作为时间感知 KG | Graphiti 开源（getzep/graphiti，Apache 2.0），Zep 论文 arxiv 2501.13956 (Rasmussen et al. Jan 2025) 报告 DMR 94.8%、"*reducing response latency by 90% compared to baseline implementations*"；bi-temporal 模型（t_valid / t_invalid）直接可用（**注意：常被引用的"P95 300ms"数字来自第三方评测如 HydraDB / Neo4j 博客，并未出现在 Zep 原论文中**） | **直接采用 Graphiti 作为 backbone**，不要自研；中文场景靠 Qwen 跑 entity extraction 即可；schema 用万能语法 20 槽 |
| State-offset Tuning 作为个性化机制 | **重大风险**：Kang et al. ACL 2025 arxiv 2503.03499 仅在线性 SSM (Mamba/Mamba-2) 上证明 `ŷ_t = y_t + C_t h'` 等价于 Iterative Suffix-Tuning（Section B：`h' := A_{t+1}^{-1} B_{t+1} x_{t+1}`）；作者明确 Limitations："*its applicability to other domains, such as vision or speech, remains unexplored*"；S₀ Tuning 后续工作 arxiv 2604.01168 (Young 2026) 仅扩展到混合 Mamba+Attention，仍是线性递归；**没有任何已发表工作把它用到 LTC/CfC 或 ncps 库**；LTC 的门控分母 `1/(1+exp(-f(x,h)))` 会非线性挤压常数 offset，破坏等价性证明；ncps 库 2.3k stars 但零 PEFT 实现 | **不能作为主路径**。降级方案：(1) LoRA on LLM 解释器（成熟）；(2) 每用户的"槽位偏好向量"作为 LNN 输入侧的可学习 embedding；(3) BitFit-on-LTC（仅训练 cell 的 bias）作为研究探索 |
| 多时间尺度 LNN 快慢耦合 | MTRNN（Yamashita & Tani 2008，PLoS Comp Bio）、Hierarchical Multiscale RNN（Chung, Ahn & Bengio 2017, arxiv 1609.01704）、CTLSTM 都验证了"慢层 τ 大、快层 τ 小"范式；LTC 的 τ 本身可学习，天然支持 | v1：两层（τ≈1s 感知层 + τ≈1min 工作记忆层）即可；v2 再加"τ≈小时"反思层 |
| CLS 海马-皮层双系统 | Howard, Skorheim & Pilly (Frontiers Sys Neuro 2022, doi 10.3389/fnsys.2022.972235) 已给出 bi-directional 计算模型；Spens & Burgess (2024) VAE+Modern Hopfield 框架（arxiv 2507.11393）；Barnett et al. (Neuron 2024 Jan 17;112(2):319-330) 实证 hippocampal-PMN offset connectivity 预测事件回忆 | 工程实现：Graphiti 当海马（fast, episodic, decay-able），LNN 慢层 + LoRA 当皮层（slow, semantic）；夜间 consolidation = 离线 replay |
| 心流 / 主动推理 / 现象学三重哲学底座 | VERSES AI 2025 多 agent 主动推理机器人栈（arxiv 2507 paper "Mobile Manipulation with Active Inference for Long-Horizon Rearrangement Tasks"）、AXIOM (sMM/iMM/tMM/rMM slot mixture model) 已经把 slot-based 世界模型与 active inference 结合；ActiveInference.jl (Heins et al. Entropy 2025, doi 10.3390/e27010062) Julia 库可用；纯哲学概念落地少 | 主动推理可作为元认知层 (Layer 6) 的形式化目标函数；时间意识/心流主要作为产品体验设计原则，不直接编码进网络 |

---

## 第一部分：万能语法整合的技术路径

### 1.1 万能语法在整体架构中的精确位置

万能语法 20 槽 schema 应被定位为**横切 Layer 2–5 的"事件张量"标准格式**——这是把抽象 7 层认知架构变成可工程化的关键一步。它不是某一层独占，而是：

```
[Layer 1 感知层 LNN τ≈秒]
        ↓ 多模态特征
[槽位填充器 = Qwen3-VL + 规则后处理]
        ↓ 部分填充的 20 槽 Event Tensor (含置信度 / 时间戳)
[Layer 2 工作记忆 LNN τ≈分钟] ←→ [Layer 3 处境理解 = LLM + 槽位补全]
        ↓ 完整化的 Event Tensor
[事件分割门控 = On-GEBD 或 LLM 规则] —boundary?→ [写入 Layer 4 自传记忆]
        ↓                                              ↓
[Layer 5 意图与共情 = LLM + Active Inference] ←→ [Graphiti KG, schema = 20 槽]
        ↓
[Layer 6 元认知 = 槽位置信度 + 心流/free-energy 监控]
        ↓
[Layer 7 共生协议 = State-offset 替代方案：LoRA + 用户槽位偏好向量]
```

**槽位优先级/权重的工程语义**：
- **P0（句子类型/主语/谓语，权重 1.00）**：必须填充，未填充 ⇒ 触发主动澄清；记忆写入门控的硬约束
- **P1（时间/地点/直宾/补语等，权重 0.75–0.85）**：作为情景记忆检索的主排序键
- **P2（时态，权重 0.60）**：作为时间感知 KG 中 t_valid/t_invalid 的辅助推理
- **P3（修饰/连接词等，权重 0.35）**：仅做向量化嵌入，不进入符号检索路径

这与 Graphiti/Zep 的"hybrid search = semantic + BM25 + graph"路径天然兼容（Neo4j 博客在介绍 Graphiti 时写道："*combines semantic embeddings, keyword (BM25) search, and direct graph*"）：P0/P1 走 graph 路径，P2/P3 走 semantic 路径。

### 1.2 与已有 7 层架构的对接方式

| 层 | 与万能语法的关系 | v0/v1 实现 |
|---|---|---|
| L1 感知 | 槽位是 LNN **输出**的目标 | LNN 输出 H 维隐状态 → linear probe → 20 槽置信度向量 |
| L2 工作记忆 | 槽位是 LNN **输入**的结构化部分 | 当前事件的 Event Tensor + 上一个事件的 Event Tensor 作为 LTC 输入 |
| L3 处境理解 | 槽位是 LLM 的 **schema-guided 提示** | LLM 接收原始多模态 + 部分填充的 Event Tensor，按 schema 补全 |
| L4 自传记忆 | 槽位是 KG **节点/边的属性** | Graphiti 节点 = 事件，属性 = 20 槽，bi-temporal 边记录时间 |
| L5 意图 | 槽位是意图的 **可解释表示** | 主语+谓语+宾语 = 意图三元组，其余槽 = 上下文 |
| L6 元认知 | 槽位 **未填充率** = 不确定性信号 | P0 未填充 ⇒ 主动询问；整体填充率 ⇒ 心流监控信号 |
| L7 共生协议 | 用户的 **槽位偏好分布** = 人格画像 | 维护 per-user 20 维偏好向量，作为 LoRA / 输入 embedding 的目标 |

### 1.3 关键技术依据

- **结构化语义表示与 LLM 结合的范式收敛**：Yao et al. arxiv 2407.04067（"Semantic Graphs for Syntactic Simplification: A Revisit from the Age of LLM"）与 SR-LLM (arxiv 2502.14352) 都指出，把 AMR/PST/FOL 直接塞进 prompt 反而损害 LLM 性能；正确做法是用结构化表示作 SLM (small language model) 的目标，再把 SLM 输出 fuse 进 LLM——这正好对应"槽位填充器 = 小模型 + LLM 后处理"的设计。万能语法相对 AMR 的优势在于**槽位数固定为 20 个**（AMR 是任意大小的图），更适合作为 LNN 的固定维度输入。
- **Schema-guided dialogue / DST 的工程成熟度**：Rastogi et al. SGD（AAAI 2020）、Zhang et al. SGP-TOD (arxiv 2305.09067)、Schema Augmentation (arxiv 2411.00150) 已经把 schema-driven slot filling 做成可量产的工程范式；GLiNER + LLM 混合架构（arxiv 2411.18980）在工业级零样本 slot filling 上达到生产级 QPS。20 槽万能语法可以直接复用这些工具链。
- **认知架构里的槽位先例**：ACT-R 的 chunk 就是 typed slots，Wu et al. 的 Cognitive LLMs (arxiv 2408.09176, AAAI/Sage 2025 doi 10.1177/29498732251377341) 与 Hybrid Personalization on ACT-R (Lex et al. UMAP 2025, arxiv 2505.05083) 都验证了"chunk slots + LLM"的可行性。万能语法可以看作"通用化的 ACT-R chunk schema"。
- **Frame-of-reference 在自传记忆里的位置**：Beyond Dialogue Time (arxiv 2601.07468, TSM) 在 LongMemEval_S 上把 GPT-4o-mini + 时间语义记忆的准确率从 62.6% 提到 74.8%（A-MEM baseline），给出了"结构化时间索引 + 自然语言事件"双轨记忆的实证基础——这正是 Graphiti + 万能语法槽位的工程对应。

### 1.4 槽位作为多子系统共享 schema 的工程优势

1. **跨模态对齐免对齐头**：视觉、语音、文本三路只要都输出 20 槽 Event Tensor，就在槽位空间天然对齐——省掉一整层 cross-modal alignment 训练。
2. **检索 schema 与写入 schema 一致**：Graphiti KG 的节点属性、向量库的 metadata、LLM prompt 的 fields 全部用同一份 20 槽，省掉 schema 转换层。
3. **可解释性免费**：槽位填充率、置信度、未填充原因都是天然的可解释信号，对车载安全场景特别重要。
4. **个性化的目标函数清晰**：per-user 20 维偏好向量是低维、可监督、可 A/B 测试的目标——比直接对 LNN 隐状态做 PEFT 容易工程化得多。

---

## 第二部分：12 个月激进时间线的实施方案

### 2.1 月度开发计划（按"v0 跑起来 → v1 完整 MVP → v1.5 用户验证"三段）

**M0–M1（第 0–4 周）：基础设施 + 万能语法 v0**
- 搭建 Python 工程（PyTorch 2.x + ncps + transformers + neo4j + Graphiti）
- **关键交付物**：`UniversalGrammarParser`——给定中/英自然语言句子，输出 20 槽 JSON。v0 实现 = Qwen3-VL-7B + 一个固定的 schema-guided prompt + 后处理规则
- 验证标准：在 50 句日程/控车/闲聊样本上，P0 三槽召回 ≥ 90%，P1 槽召回 ≥ 70%
- 同步：完成对种子用户 10 人的招募（家人/朋友/早期粉丝），收集 baseline 行为日志

**M2（第 5–8 周）：Graphiti 接入 + 时间感知记忆**
- 直接 fork getzep/graphiti，把 schema 替换为万能语法 20 槽
- 对接国产 LLM 做 entity extraction（DeepSeek-V3 主路径，GLM-5.1 自托管 fallback）
- **关键交付物**：能用自然语言问"上周三晚上和谁吃饭"并由 Graphiti 返回正确节点
- 验证：内部 LongMemEval-style 100 题测试集，准确率 ≥ 65%

**M3（第 9–12 周）：LNN Layer 1–2 雏形**
- 用 ncps 搭两层 LTC：感知层 (τ≈1s, 64 神经元) + 工作记忆层 (τ≈60s, 32 神经元)
- 输入：Qwen3-VL 视觉 token 池化 + Fun-ASR 文本 embedding + 时间戳
- 输出 → linear probe → 20 槽置信度向量
- **关键交付物**：在 1 小时多模态会话录像上，LNN 的槽位填充与 LLM-only baseline 的 IoU ≥ 0.6
- 验证：LNN 推理延迟 < 50ms（本地 RTX 4090 或 Jetson Orin）

**M4（第 13–16 周）：事件分割门控**
- v0：规则 + LLM 心跳（每 30s 让 LLM 看最近窗口判断是否 boundary）
- v0.5：把 EfficientGEBD ResNet50 backbone 接到 LNN 隐状态序列上，做二分类
- **关键交付物**：事件分割与人工标注一致率 ≥ 0.5（GEBD F1@0.5 等价指标）
- 验证：对 5 段 1 小时会话录像跑一遍，对比人工切分

**M5（第 17–20 周）：状态摘要 + LLM 解释器集成**
- 实现 probing decoder：LNN 隐状态 → 自然语言摘要（"主人最近 10 分钟在专注写代码"）
- 集成 ReAct/function-calling，让 LLM 调用：query_memory / set_reminder / control_device
- **关键交付物**：完整对话流跑通——感知 → 槽位 → 记忆 → LLM 回答 → 行动
- 验证：5 个种子用户在内部 demo 环境用 1 周

**M6（第 21–24 周）：MVP α 上线**
- 居家场景 Web/手机 App + 后端云服务
- 个性化 v0：per-user 槽位偏好向量 + LLM system prompt 注入
- **关键交付物**：10 名种子用户日均使用 ≥ 15 分钟、连续 2 周无崩溃
- 验证：周留存 ≥ 60%，主观满意度 ≥ 7/10

**M7–M8（第 25–32 周）：车载场景接入**
- 选择硬件 reference：NVIDIA DRIVE Orin Dev Kit 或 Jetson Orin Nano（**避免**自己造车机硬件）
- 复用 90% 居家场景代码栈，仅替换 ASR 路径（车载噪声 → Fun-ASR + 自训降噪前端）和 IO 通道（CAN/Android Auto VoiceInteractionService）
- 端侧推理：LFM2-1.2B 或 Qwen3-VL-2B 离线兜底，云端走 DeepSeek
- **关键交付物**：在 1–2 辆改装车上跑通通勤场景；P95 唤醒到首响 < 1.2s
- 验证：3 名车主连续 1 周通勤使用

**M9（第 33–36 周）：CLS 海马-皮层双系统离线 consolidation**
- 夜间任务：把当天 Graphiti 中高频 / 高情感强度的事件 replay 给 LNN 慢层（τ≈小时层），用 LoRA 更新 LLM 解释器
- **关键交付物**：第二天用户问"昨天我心情怎么样"时，回答质量明显高于无 consolidation baseline
- 验证：盲测 A/B，consolidation 组人工评分高 ≥ 1 个分点

**M10（第 37–40 周）：意图与共情层 + 主动推理 v0**
- 用 ActiveInference.jl 或 pymdp 包一个最小 POMDP：状态 = 用户专注/疲惫/无聊/烦躁四态，动作 = 沉默/提示/调灯光/播音乐
- 核心：让 free-energy 最小化驱动主动行为
- **关键交付物**：系统能在用户疲惫时主动建议休息，且建议被接受率 ≥ 30%

**M11（第 41–44 周）：MVP β + 25–50 用户扩围**
- 引入付费/邀请制，扩到 25–50 名种子用户
- 个性化 v1：BitFit on LTC + LoRA on LLM + 用户槽位偏好向量三件套
- **关键交付物**：周留存 ≥ 70%，周使用时长 ≥ 2 小时

**M12（第 45–52 周）：稳定性 + 长期运行测试 + 18 月架构成型铺垫**
- 实现状态持久化、断点续跑、多设备同步
- **关键交付物**：单用户连续运行 30 天无重大记忆丢失；可发布 alpha demo 视频
- 第 12 月末同步启动 Layer 6 元认知层 + Layer 7 共生协议层的 R&D，目标 18 月全栈成型

### 2.2 各子系统依赖关系图

```
[Qwen3-VL/MiniMax/DeepSeek API] ← 关键路径，无降级（必须有 API quota）
        ↓
[UniversalGrammarParser] ← 万能语法槽位填充
        ↓
[Graphiti + Neo4j] ←—————— 时间感知记忆，依赖 LLM 做 entity extraction
        ↓                            ↑
[LNN Layer 1-2 (ncps)] ————→ [Event Boundary Gate] —写入门控→
        ↓
[State Summary Probe] —摘要→ [LLM Explainer (ReAct)]
        ↓
[Active Inference POMDP] ←元认知信号←
        ↓
[Action Layer: TTS / Device Control / Memory Write]
```

**关键依赖警告**：Graphiti 是单点失败——如果它的中文 entity extraction 在我们的领域上效果差，整个记忆层崩溃。**M2 的第一周就要做闭环测试，不要等到集成时才发现问题。**

### 2.3 资源分配建议

**团队（最小 4 人，理想 6 人）**：
- 1× 架构 / 全栈 lead（你）：负责架构、LLM 集成、产品决策
- 1× LNN / ML 工程师：ncps + PyTorch + 多模态特征工程
- 1× 后端 / 数据工程师：Graphiti + Neo4j + API 网关 + 个性化向量管理
- 1× 前端 / 移动 + 车载集成：React Native + Android Automotive + 车机 SDK
- (理想) 1× 数据 / 评测工程师：构建中文 LongMemEval-style 评测集、收集种子用户日志
- (理想) 1× 产品 / 用户研究：种子用户深度访谈、心流体验设计

**算力**：
- 训练 / 实验：2–4 张 RTX 4090 或 1 张 A100 80GB（自购或云租），月成本 ≤ 3 万 RMB
- LLM 推理：OpenRouter / Vercel AI Gateway 统一接入，月 API 成本 1–3 万 RMB（依据 Apidog 2026-04 定价指南，DeepSeek-V4-Pro 输出 token 比 Claude Opus 4.6 便宜约 21×、比 GPT-5.5 便宜约 8.6×）
- 端侧目标：Jetson Orin Nano（8GB，~3000 RMB）或车机域控（依赖合作车厂）

**数据**：
- 合成数据 v0：用 LLM 自动生成"万能语法槽位填充"对话样本 1 万条
- 真实日志 v1：种子用户授权下的多模态日志（语音转写 + 事件轨迹），目标 100 小时
- 半监督 v2：把高置信槽位填充结果反过来作伪标签训 LNN

---

## 第三部分：核心子系统的"最小可行实现"方案

### 3.1 事件分割模块
- **v0（M1–M2，1 人周）**：`if (语义大变 OR 时间间隔>10min OR 用户主动切换 OR LLM心跳判断为新场景): boundary=True`
- **v1（M4，2 人周）**：On-GEBD ESTimator（CVPR 2025，Consistent Event Anticipator + Online Boundary Discriminator）或 EfficientGEBD（已开源）的 backbone 替换为 LNN 隐状态 + 简单 MLP，二分类
- **v2（M9–M12，4 人周）**：流式自训，对每个用户的 boundary 偏好做个性化（per-user threshold）
- **接口**：`detect_boundary(event_tensor_seq: List[EventTensor], llm_summary: str) -> Tuple[bool, float]`

### 3.2 时间感知知识图
- **v0（M2，1 人周）**：直接用 getzep/graphiti，schema 用 20 槽，LLM 用 DeepSeek-V3
- **v1（M5，2 人周）**：自定义 entity 类型扩展（人/地点/活动/物品），混合检索（向量 + BM25 + graph，借鉴 Zep "*reducing response latency by 90% compared to baseline implementations*" 的设计）
- **v2（M9，3 人周）**：CLS 离线 consolidation 把高强度情景 replay 给皮层（LoRA on LLM）
- **接口**：`add_episode(event_tensor, timestamp)`, `search(query, time_filter, limit) -> List[(event, score)]`

### 3.3 个性化机制（**重大降级**：用 LoRA + 槽位偏好向量替代 State-offset Tuning）
理由见 Key Findings 表格——State-offset Tuning 在 LTC/CfC 上**没有任何已发表实证**且理论基础不成立。降级矩阵：
- **v0（M6，1 人周）**：per-user 20 维槽位偏好向量（统计每个槽位的使用频率/平均权重），作为 LLM system prompt 的一部分注入
- **v1（M11，3 人周）**：LoRA on LLM 解释器（rank=8），每用户独立 adapter；BitFit on LTC（仅训 cell bias），每用户独立 bias
- **v2（M15+，研究）**：探索 Initial-State Tuning（LTC 的 h(0) 学一份 per-user 初值）+ FiLM-style 输出层 gain/bias，作为 State-offset Tuning 的 LTC 适配候选——但**不放在关键路径**
- **接口**：`load_user_adapter(user_id) -> Adapter`，全系统支持热切换

### 3.4 多时间尺度 LNN 的快速搭建
- **v0（M3，2 人周）**：两层 LTC，τ=1s 和 τ=60s，用 ncps 库直接搭，sinusoidal warmup 预训
- **v1（M5，2 人周）**：加 CfC 闭式版替换 LTC（推理快 2–3×）；引入 mixed_memory 模式
- **v2（M9，3 人周）**：加第三层 τ≈1h 反思层，用于离线 consolidation；考虑 Liquid-S4 hybrid
- **训练数据**：先在合成数据 + 种子用户日志上做 self-supervised next-event prediction；fine-tune 用槽位填充作为 auxiliary loss
- **mock 策略**：**慢层在 v0 阶段直接用 LSTM 替代是完全可以的**——LSTM/GRU 与 LTC/CfC 在工作记忆任务上差距不大，先把流水线跑通再换 LNN

### 3.5 多模态感知层的快速接入
- **v0（M1，1 人周）**：调 Qwen3-VL API（云端），输入图像/视频帧 + 音频转写文本，输出多模态 embedding
- **v1（M3，2 人周）**：本地化 Qwen3-VL-2B 或 Qwen2-VL-7B（量化版），抽取 vision tokens 作 LNN 输入
- **车载 v2（M7–M8）**：LFM2-VL（350M/1.2B）作为端侧兜底；ASR 用 Fun-ASR（Tongyi Lab 端到端，覆盖 7 种汉语方言 + 26 种地方口音 + 31 种语言）或 Paraformer-realtime（阿里云）
- **接口**：`encode_multimodal(audio, video, text) -> torch.Tensor[B, T, D]`

### 3.6 接口标准化设计

```python
@dataclass
class EventTensor:
    slots: Dict[int, SlotValue]  # 1..20, 每个有 value, confidence, position
    timestamp: datetime
    valid_until: Optional[datetime]
    user_id: str
    raw_modalities: Dict[str, bytes]  # 原始音视频 reference
    embedding: torch.Tensor  # 用于向量检索

class Layer(Protocol):
    def forward(self, x: EventTensor, context: AgentContext) -> EventTensor: ...
    def get_state_summary(self) -> str: ...  # probing decoder 输出
```

所有 7 层都实现这个 Protocol，可独立单元测试，可热插拔。

---

## 第四部分：风险与退路

### 4.1 关键风险点（按严重度排序）

1. **【最高】LLM API 成本/合规/降速**：DeepSeek V4 已经因 NVIDIA → Huawei Ascend 训练框架迁移延迟数月（36Kr 报道："*The reasons behind [V4's] belated arrival are related to migrating its training framework from NVIDIA to Huawei Ascend*"），国产 API 不稳定性是真实存在的。
   - 退路：双 provider 灰度（DeepSeek + GLM-5.1 自托管）；本地 LFM2 / Qwen3-VL-2B 兜底；车载离线模式必备
2. **【高】Graphiti 中文 entity extraction 质量**：Zep 数据集是英文，中文（特别是混合方言、口语化）效果未知。
   - 退路：M2 第一周就跑闭环测试；准备 fallback 方案——退化为纯向量检索 + 关键词索引（牺牲时间推理能力）
3. **【高】LNN 在多模态上的训练稳定性**：ncps 文档与社区讨论显示 LTC 容易梯度爆炸；多模态高维输入下 ODE solver 选择敏感（Emergent Mind 综述："*sensitivity to ODE solver selection (for stiff regimes), increased compute and memory burden for vanilla LTC/BPTT relative to discrete RNNs, immature software/tooling ecosystem*"）。
   - 退路：CfC 替代 LTC（已规划）；最差情况整个 Layer 1–2 用 GRU/LSTM mock，"LNN 心智核心"在 12 月时不强求名实相符
4. **【中】State-offset Tuning 路线失败**（已在 Key Findings 标注）：本调研已确认其在 LTC/CfC 上理论基础不成立。
   - 退路：已经规划好替代方案（LoRA + 槽位偏好向量 + BitFit），属于"已知失败、已设计降级"
5. **【中】事件分割对长尾对话不鲁棒**：On-GEBD 训练分布与真实居家/车载会话差异大。
   - 退路：M4 同时做 LLM 规则法（v0）和神经法（v0.5），按月度评测决定主路径
6. **【中】车载场景集成成本被低估**：Android Automotive / QNX SDK 学习曲线陡，需要 OEM 合作或自购改装车（参考：NIO 在 NIO IN 2024 公布的 Shenji NX9031 是 5nm 自研芯片、ET9 双 Shenji 提供 ~2,000 TOPS；XPeng G7 三个 Turing 芯片提供 ~2,200 TOPS；Li Auto VLA 模型超过 4B 参数——这种规模初创无法独立复制）。
   - 退路：M7 之前不要承诺车载真正落地——可以做 Jetson Orin + 普通车机 USB 投屏的 demo，先验证算法不验证集成
7. **【低】单用户深度个性化 vs 隐私合规**：长期连续运行的多模态记录在中国隐私法规下需要明确授权和本地优先存储。
   - 退路：默认本地存储 + 端到端加密的云备份（零知识架构）

### 4.2 技术决策的 Plan B 矩阵

| 主路径 | 失败信号 | Plan B | Plan C |
|---|---|---|---|
| LTC/CfC 主干 | 12 月 ncps 仍训不稳 / 推理延迟 >100ms | CfC + Liquid-S4 hybrid | 纯 GRU/LSTM 快层 + Mamba 慢层 |
| Graphiti 时间 KG | 中文实体抽取 F1 <0.6 | 自研轻量 schema-driven 提取 + 向量库 | 退化到 Mem0 + 时间过滤 |
| State-offset Tuning | （**已确认失败**） | LoRA on LLM + per-user 偏好向量 | 加 BitFit on LTC |
| On-GEBD 流式 | F1 <0.4 | 纯 LLM 规则 + 启发式 | 滑动窗口 + 余弦相似度 |
| Qwen3-VL 端侧 | 7B 跑不动 / 太慢 | Qwen3-VL-2B + LFM2-VL 350M | 仅文本+ASR，无视觉 |
| 主动推理 POMDP | pymdp 状态空间爆炸 | 简单 MDP + Q-learning | 规则系统 |

### 4.3 不可妥协的核心创新

**这五项必须在 18 月内做出来，否则项目失去差异化**：
1. **万能语法 20 槽作为全系统共享 schema**——这是 IP，是技术护城河
2. **多时间尺度 LNN 心智核心（哪怕只有两层）**——区分于纯 LLM agent 的关键
3. **CLS 双系统的离线 consolidation 流程**——"数年长期连续运行"的工程基础
4. **per-user 槽位偏好向量 + LoRA 的个性化栈**——"特别懂主人"的算法基础
5. **车载 + 居家双场景的统一架构**——市场定位的核心

**可以妥协的**：
- 主动推理在 12 月 MVP 中可以是规则化的，不必跑真实 free-energy 最小化
- 心流监控可以是简单启发式（专注时长、切换频率），不必上 Csikszentmihalyi 完整模型
- 现象学时间意识在工程上就是"多时间尺度 + 事件分割"，不必强解释为胡塞尔/海德格尔

---

## 第五部分：核心建议清单（按优先级）

### 第 1 周必做
1. **【P0】立即用 Qwen3-VL + DeepSeek-V3 把 UniversalGrammarParser v0 做出来**——这是项目的"hello world"，验证万能语法槽位填充在真实中文对话上 P0 槽召回率能否过 90%。如果 1 周做不出来，整个时间线作废重估。技术依据：Qwen3-VL-Embedding-8B 在 MMEB-V2 上 77.8 分，截至 2026 年 1 月 8 日排名第一（Qwen3-VL-Embedding 技术报告："*Qwen3-VL-Embedding-8B attains an overall score of 77.8 on MMEB-V2, ranking first among all models (as of January 8, 2025)*"，原文笔误为 2025）；schema-guided LLM prompting (SGP-TOD, SGD) 已是成熟范式。

2. **【P0】fork getzep/graphiti 跑通中文最小闭环**：写 50 个中文事件，能问"上周三晚上和谁吃饭"——验证 Graphiti 在中文场景的可用性。这是整个记忆层的命门。技术依据：Zep 论文 arxiv 2501.13956 报告 DMR 94.8%（vs MemGPT 93.4%）以及"*reducing response latency by 90% compared to baseline implementations*"。

3. **【P0】招募首批 10 名种子用户，签授权协议**：没有用户的 12 月 MVP 没意义。这一步的拖延比技术风险更致命。

### 第 1 个月必做
4. **【P0】跑通 ncps 库的 LTC/CfC 最小例子，建立训练-评估循环**：用合成正弦数据复现作者的 demo，确认你的开发环境、调参流水线、推理延迟测量都能 work。技术依据：ncps 库（mlech26l/ncps）有官方 PyTorch + Lightning tutorial（"*we will use the pytorch-lightning high-level API*"），LTC 类签名 `LTC(input_size, units, return_sequences=True, batch_first=True, mixed_memory=False, ode_unfolds=6)` 直接可用。

5. **【P1】决定是否把 Layer 6/7 完全 mock 掉**：建议 12 月 MVP **不要**做主动推理 POMDP 的真实实现，用规则代替；元认知层用槽位填充率 + 简单启发式。把研发资源集中在 Layer 1–4。这与 Liquid AI 自己的产品路线一致——LFM2 商业化产品（LFM2 技术报告 arxiv 2511.23404）是混合架构（"*16 blocks: 10 double-gated short-range convolution blocks and 6 blocks of grouped query attention*"），而非完整主动推理。

6. **【P0】放弃 State-offset Tuning 作为关键路径**：本调研已确认它在 LTC/CfC 上既无理论基础也无工程先例（Kang et al. ACL 2025 的等价性证明依赖线性 SSM 递归 `h' := A_{t+1}^{-1} B_{t+1} x_{t+1}`；2026 年 4 月的 S₀ Tuning 后续工作 arxiv 2604.01168 仍局限在线性混合递归；ncps 库 2.3k stars 但零 PEFT 实现）。改用 LoRA + 槽位偏好向量 + BitFit 的成熟组合。这是**整个调研最重要的单条建议**——一旦把 12 月里程碑押在 State-offset Tuning 上，项目大概率延期 6–12 月。

### 前 3 个月战略决策
7. **【P0】把"LNN 心智核心"窄化为 Layer 1–2**：12 月内不要试图把 Layer 3–7 都搬到 LNN 上跑。Layer 3 用 LLM、Layer 4 用 Graphiti、Layer 5 用 LLM+槽位、Layer 6/7 用规则——这是激进时间线的唯一路径。技术依据：Liquid AI 自己的 LFM2 也是混合架构（arxiv 2511.23404："*16 blocks: 10 double-gated short-range convolution blocks and 6 blocks of grouped query attention*"），不是纯 LNN。

8. **【P1】车载场景在 M7 之前不投入硬件集成成本**：用 Jetson Orin Nano + 普通车机 USB 投屏先做算法验证。Android Automotive VoiceInteractionService API、QNX SDK、CAN bus 集成是车厂级工作量，初创不应自己做。等 M11–M12 找一家车厂或 Tier-1 合作。技术依据：CnEVPost 报道 NIO 在 2026-01 内部讲话中称"*more than 11,000 R&D personnel*"——车载 AI 团队规模都是上千人级别。

9. **【P1】数据策略：合成 → 种子用户日志 → 半监督**：v0 用 LLM 自生成 1 万条万能语法槽位样本；v1 用种子用户授权日志 100 小时；v2 把 LLM 高置信预测当伪标签反过来训 LNN。技术依据：Liquid AI 在 LFM2 技术报告 arxiv 2511.23404 中说明："*we leverage LFM1-7B as a teacher model in a knowledge distillation framework... The released dense LFM2 model checkpoints are pre-trained for 10T tokens*"——小团队没有这个量级，必须靠合成 + 半监督。

10. **【P2】部署策略：双 LLM provider 灰度 + 本地端侧兜底**：DeepSeek + GLM-5.1（MIT 自托管）双路；车载/隐私场景用 LFM2-1.2B 离线。技术依据：DeepSeek V4 因芯片切换延迟（36Kr 内部消息源："*at that time, DeepSeek was facing the problem of re-adapting to the chips*"）、Z.ai/Zhipu 与 MiniMax 港股上市等说明 2026 年中国 LLM 生态在变动中，不能押单一供应商。

---

## Caveats（局限性与不确定性）

- **State-offset Tuning 评估的不确定性**：本调研基于截至 2026 年 4 月的公开论文与代码库；如果未来 6 个月内有把它扩展到 LTC/CfC 的工作发表，本报告的降级建议应重新评估。但基于 Kang et al. ACL 2025 的理论推导（Section B 的 Iterative Suffix-Tuning 等价性依赖 `h' := A_{t+1}^{-1} B_{t+1} x_{t+1}` 的线性求逆），即便有移植工作，效果也很可能弱于 SSM 上的结果。
- **"P95 300ms" 等高频引用数字的来源**：Graphiti 的"P95 300ms"延迟数字常见于 Neo4j 博客等三方文章，**未出现在 Zep 原论文 arxiv 2501.13956**——原论文的具体表述是"reducing response latency by 90% compared to baseline implementations"。在工程估算时应以原论文数字为准并自己测量复现。
- **GEBD/On-GEBD 在多模态流式上的可用性**：Kinetics-GEBD 与 TAPOS 都是离线视频数据集，On-GEBD ESTimator (CVPR 2025) 是流式但仅视觉。对话/居家场景的多模态流式 boundary detection **没有公开 benchmark**，需要自己构建评测集，存在不可知风险。
- **车载场景的法规与硬件不确定性**：中国车载 AI 数据合规、车规级芯片国产化（NIO Shenji NX9031、Xpeng Turing、Li Auto M100）都在 2025–2026 年高速变动中。本报告假设初创公司不自研车规芯片、靠合作 OEM 落地，这一前提如不成立则时间线另算。
- **种子用户深度个性化的样本量**：10–50 个种子用户在统计上无法支撑严格的 PEFT 评估，主要依赖主观留存与满意度。这是激进时间线的代价。
- **国产多模态 LLM 的可获得性**：Qwen3-VL、MiniMax M2.7、DeepSeek-V3/V4 的 API 限流、价格与功能在 2026 年仍在快速变动；DeepSeek V4 多模态生成被推迟（36Kr："*the decision to postpone the training strategy for multimodal generation is mainly due to constraints in computing power and cash*"）意味着不能假设特定能力一定可用。
- **Liquid AI 商业 LFM2 vs 自训 LNN 的边界**：LFM2 是闭源后训练 + 开源权重（Hugging Face 上 LFM2-2.6B 等检查点的许可条款写明"*above this threshold [10M USD revenue], you should contact us (sales@liquid.ai) to obtain a commercial license*"），如果项目规模扩大需要付费授权——这一点要在合同与架构设计层面预留替换空间。Brilliant Labs Halo 是授权（"*Brilliant will be licensing the current and upcoming multimodal Liquid foundation models*"）而非购买；Shopify 是多年合作部署"sub-20ms text model that enhances search"——两者都是商业 partner 模式，不是单次授权买断。
- **本报告未深入调研的领域**：(a) 隐私合规细节（GDPR/PIPL 在长期连续记录场景的具体合规路径）；(b) 心流监控的客观生理信号采集（HRV / 眼动 / EEG）的硬件方案；(c) 18–24 月之外的长期路线（如自研芯片、SoC 集成）。这些应在 MVP 验证之后再深入。