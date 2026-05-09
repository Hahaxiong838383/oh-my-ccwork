# bridges-03 认知层理论补全（L3 缺口 05–08）

> 目的：为 Alex 的"9 层本体论 × 方法论闭环 × 碳硅共荣"蓝图补齐四块认知层理论骨架。建构姿态：把心理学/认知科学/AI 安全领域的成熟成果接到 Alex 的框架上，并给出可工程化的 Agent 数据结构与接口。
> 关联原文：doc3《20260418 周六办公室讨论》注意力-记忆-信念闭环 + doc1 §4.1 第 7 层心智三轴。
> 日期：2026-04-18。撰写：cc (Claude Opus 4.7)。

---

## 缺口 L3-05：注意力 × 工作记忆 × 长期信念的容量与带宽

### 理论候选（三家并列，互补不互斥）

**候选 A：Miller–Cowan 工作记忆容量线**
- Miller, G. A. (1956). *The Magical Number Seven, Plus or Minus Two: Some Limits on Our Capacity for Processing Information*. Psychological Review, 63(2), 81–97. [DOI: 10.1037/h0043158]
- Cowan, N. (2001). *The magical number 4 in short-term memory: A reconsideration of mental storage capacity*. Behavioral and Brain Sciences, 24(1), 87–114. [DOI: 10.1017/S0140525X01003922]
- 核心论证：Miller 提出信息块容量 7±2，Cowan 用去除复述与 chunking 干扰后的范式修订为 4±1 个 focus-of-attention 槽位。二者共同证明：短期存储不是字节数而是"意义单位（chunk）"数，关键在于**组块压缩**。

**候选 B：Baddeley 多组件工作记忆模型**
- Baddeley, A. D., & Hitch, G. J. (1974). *Working memory*. Psychology of Learning and Motivation, 8, 47–89.
- Baddeley, A. D. (2000). *The episodic buffer: a new component of working memory?*. Trends in Cognitive Sciences, 4(11), 417–423. [DOI: 10.1016/S1364-6613(00)01538-2]
- 核心论证：工作记忆不是单一缓冲而是四组件——语音回路（phonological loop, ~2s 回响）、视空间画板（visuospatial sketchpad, 3–4 个客体）、中央执行（central executive, 资源调度）、情景缓冲（episodic buffer, 跨模态绑定 ~4 chunk）。这为 Alex 的"左右脑分工"（逻辑 vs 感觉/空间感/美感）提供了直接的心理学对应。

**候选 C：注意力网络 + 过滤器**
- Broadbent, D. E. (1958). *Perception and Communication*. Pergamon Press.（早期选择性过滤器模型）
- Treisman, A. M., & Gelade, G. (1980). *A feature-integration theory of attention*. Cognitive Psychology, 12(1), 97–136.
- Posner, M. I., & Petersen, S. E. (1990). *The attention system of the human brain*. Annual Review of Neuroscience, 13, 25–42.
- 核心论证：注意力不是单一资源而是三个亚系统——**警觉（alerting）/ 定向（orienting）/ 执行控制（executive）**。传感器带宽极高（视觉通道 ~10^7 bit/s 进入视网膜），但意识通过的是瓶颈（~40–50 bit/s，Zimmermann 1989 估算）。

### 人脑各段容量对照表（量级估算，跨文献综合）

| 认知段 | 容量/带宽 | 文献依据 | Alex 框架对应 |
|---|---|---|---|
| 感觉输入 (sensor raw) | 视觉 ~10^7 bit/s，听觉 ~10^5 bit/s | Koch 2006, Zimmermann 1989 | 感觉皮层 L1 |
| 前注意短暂寄存（iconic/echoic memory） | 视觉 ~12 项/300ms，听觉 ~4s 衰减 | Sperling 1960, Darwin 1972 | L1→L2 预处理缓冲 |
| 意识通过带宽 | ~40–50 bit/s（保守 16 bit/s） | Zimmermann 1989, Nørretranders 1991 | 注意力门控 |
| 工作记忆 focus | 4±1 chunk | Cowan 2001 | 当前上下文"热区" |
| 工作记忆 active region | 7±2 chunk（含复述维持） | Miller 1956 | 上下文窗口 |
| 语音回路持续 | ~2 秒回响 | Baddeley 1986 | 短期语义缓存 |
| 长期记忆容量（存储） | ~10^8.5 bit 有效记忆 / ~2 PB 大脑总突触编码上限 | Landauer 1986；Bartol et al. 2015 (eLife) | 长期信念库 |
| 长期记忆检索带宽 | ~2 bit/s（主观报告可提取速率） | Landauer 1986 | 信念加载 API 吞吐 |
| ACT-R 声明性记忆 base-level activation | 按使用频率与时间衰减（power-law） | Anderson & Lebiere 1998 | 记忆优先级调度 |

### 桥接 Alex 框架
Doc3 的"注意力→传感器→多级处理→意思/感觉→上下文→信念"闭环，每一段都对应一个明确的容量约束。**碳基瓶颈不在存储而在通过带宽**——10^7 bit/s 输入被压缩到 ~40 bit/s 意识，再以 4 chunk 为工作单位运作。硅基 Agent 若照搬 LLM 的 128K token 上下文而不做分级筛选，等于把"皮层输入"直接塞给"中央执行"，必然丢失 Alex 要的"多级提炼"语义。

### 工程映射（Agent 数据结构 & 接口）
```typescript
interface CognitiveBandwidth {
  // L1 感觉层：高带宽、短保留
  sensorBuffer: { capacity: '~10^7 bit/s'; ttl: 300 /* ms */; lossy: true };
  // L2 前注意：过滤器模型
  preAttention: {
    alerting: number;       // 0-1 当前警觉度
    orienting: string[];    // 当前定向的 chunk id 列表
    executive: Priority[];  // 自上而下的任务偏置
  };
  // L3 工作记忆：Baddeley 四组件
  workingMemory: {
    focus: Chunk[];             // 4±1 槽位，硬上限
    active: Chunk[];            // 7±2 槽位，衰减淘汰
    phonologicalLoop: string;   // 2s 语音回响（等同 LLM "最近对话缓冲"）
    visuospatial: ObjectRef[];  // 3-4 空间对象
    episodicBuffer: Binding[];  // 跨模态绑定
  };
  // L4 长期记忆：容量大、检索慢
  longTermBeliefs: {
    totalCapacity: 'unbounded'; // 向量 DB / KG
    retrievalBandwidth: '~2 bit/s → 建议缓存预取';
    activationBase: number;     // ACT-R 式 base-level activation
  };
}
```
**关键接口规约**：
- `attention.select(signals, context) → Chunk[]`：必须强制降采样到 ≤ 4 chunk，不准把全部 retrieved 文档丢进 LLM 主上下文。
- `workingMemory.promote(chunk) → bool`：新 chunk 进 focus 要挤掉旧的（LRU + priority），不允许无限膨胀。
- `longTerm.recall(query, topK=5)`：topK 默认 5，对应 Miller 上限。

### 残留疑问
1. LLM 的 128K–1M token 上下文应该模拟"工作记忆"还是"长期记忆近端缓存"？当前主流混为一谈，可能是 Alex 框架能贡献的原创点。
2. 人脑 40 bit/s 意识带宽的 Zimmermann 估算仍有争议（Tononi IIT 会给出不同答案），需要保留假设标记。

---

## 缺口 L3-06：序列流程 vs 空间流程 的脑科学对应

### 理论候选（优先推荐 GWT + 双过程；Dorsal/Ventral 次之）

**候选 A：全局工作空间理论 GWT（首选）**
- Baars, B. J. (1988). *A Cognitive Theory of Consciousness*. Cambridge University Press.
- Dehaene, S. (2011). *Consciousness and the Brain: Deciphering How the Brain Codes Our Thoughts*. Viking.
- Dehaene, S., & Changeux, J.-P. (2011). *Experimental and theoretical approaches to conscious processing*. Neuron, 70(2), 200–227.
- 核心论证：皮层存在大量专家模块（并行、局部、无意识）——这对应 Alex 的**空间流程**；少数信息被"点燃（ignition）"广播到全局工作空间后形成意识串行链——这对应 Alex 的**序列流程**。GWT 直接预言了两种视图的并存必然性。

**候选 B：双过程理论（Kahneman System 1/2）**
- Kahneman, D. (2011). *Thinking, Fast and Slow*. Farrar, Straus and Giroux.
- Evans, J. S. B. T., & Stanovich, K. E. (2013). *Dual-process theories of higher cognition: Advancing the debate*. Perspectives on Psychological Science, 8(3), 223–241.
- 核心论证：System 1 = 快速、并行、直觉、模式匹配 → 空间流程；System 2 = 慢速、串行、符号、工作记忆密集 → 序列流程。

**候选 C：Dorsal/Ventral 双流假说（视觉专属，不足以承载全量映射）**
- Milner, A. D., & Goodale, M. A. (1992). *Separate visual pathways for perception and action*. Trends in Neurosciences, 15(1), 20–25.
- 核心论证：背侧 where/how 流（空间行动）vs 腹侧 what 流（物体识别）。但这只覆盖视觉，不适合作为"序列 vs 空间"的总纲。

**候选 D：Model-based / Model-free RL（强化学习对应）**
- Daw, N. D., Niv, Y., & Dayan, P. (2005). *Uncertainty-based competition between prefrontal and dorsolateral striatal systems for behavioral control*. Nature Neuroscience, 8(11), 1704–1711.
- 核心论证：Model-based = 有世界模型的序列规划（PFC）；Model-free = 习得的关联网络（纹状体）。为序列/空间提供了可计算的决策层对应。

### 桥接 Alex 框架
Alex 在 doc3 提出"序列流程=带时序执行链 / 空间流程=模块关联网"双视图。最佳匹配是 **GWT + 双过程**：
- **空间流程** = 并行专家模块网络（Baars 的"观众"）+ System 1 的联想匹配。结构单位：模块-模块边（软链接），调用是广播式多播。
- **序列流程** = 全局工作空间的广播序列（Dehaene 的 ignition chain）+ System 2 的工作记忆串行。结构单位：事件-事件边（时序链），调用是有栈的 call stack。
- **两者的切换**：模块竞争注意力 → 赢家被点燃 → 进入序列流程；序列流程每一步又会向空间广播激活新模块。这正是 Alex 要的"循环闭环"。

### 工程接口设计
```typescript
// 空间流程：模块关联图（类似 Knowledge Graph + activation spreading）
interface SpatialFlow {
  modules: Map<ModuleId, ExpertModule>;           // 并行专家
  edges: Edge<{ type: 'association' | 'softlink' | 'contradiction'; weight: number }>[];
  propagate(trigger: ModuleId): ModuleActivation[]; // 激活扩散，System 1
}

// 序列流程：有时序的执行链（类似 DAG / state machine）
interface SequentialFlow {
  steps: Step[];                                   // 串行步骤
  dispatch(ctx: Context): Step;                    // 下一步，System 2
  broadcastToSpatial(result: Step): void;         // 每步结束向空间网广播
}

// GWT 调度器：两者的桥
interface GlobalWorkspace {
  competition(): ModuleId;                         // 哪个模块赢得注意力
  ignite(winner: ModuleId): SequentialFlow;        // 点燃 → 进序列
  broadcast(seqStep: Step): void;                  // 序列结果广播回空间
}
```
**工程建议**：不要把两种流程写在同一个数据结构里。**空间视图用图数据库（Neo4j/向量+边）**，**序列视图用事件流（append-only log / DAG engine）**。GWT 调度器是它们的中间层，决定哪些模块的输出被升级为意识级事件。

### 残留疑问
1. GWT 的 ignition 阈值在 LLM 中对应什么？候选：attention head 权重超过某阈值？激活熵降到某水平？尚无共识。
2. System 1/2 的二分被批评为过度简化（Melnikoff & Bargh 2018），真实可能是连续谱。Alex 的双视图如果要避免同样批评，需要允许"半串行半并行"的中间态（predictive processing 的 hierarchical approach 是候选桥梁）。

---

## 缺口 L3-07："北极星需求"的更新机制（目标漂移防御）

### 理论候选（四家拼图，缺少成熟统一理论 ⚠️）

**候选 A：辅助博弈 / CIRL**
- Russell, S. (2019). *Human Compatible: Artificial Intelligence and the Problem of Control*. Viking.
- Hadfield-Menell, D., Russell, S., Abbeel, P., & Dragan, A. (2016). *Cooperative Inverse Reinforcement Learning*. NeurIPS 2016.
- 核心论证：Agent 承认自己对人类目标函数**存在不确定性**，把对齐问题建模为"人类知道、AI 猜测"的协作博弈；AI 的最优策略是持续询问/观察并更新对目标的贝叶斯后验。

**候选 B：Inverse Reward Design**
- Hadfield-Menell, D., Milli, S., Abbeel, P., Russell, S., & Dragan, A. (2017). *Inverse Reward Design*. NeurIPS 2017. [arXiv:1711.02827]
- 核心论证：显式给出的奖励函数只是"设计者在训练分布上的代理"，AI 应把它当成带噪声的观测，而非目标本身；在分布外情况下应降低置信度并回问。

**候选 C：Mesa-optimization / 内部目标错位**
- Hubinger, E., van Merwijk, C., Mikulik, V., Skalse, J., & Garrabrant, S. (2019). *Risks from Learned Optimization in Advanced Machine Learning Systems*. arXiv:1906.01820
- 核心论证：训练过程可能产生"内部优化器"（mesa-optimizer），其目标与外部指定目标不一致（inner alignment failure）。这是"目标漂移"最尖锐的威胁来源。

**候选 D：Goodhart 定律 + 目标层级**
- Goodhart, C. A. E. (1975). *Problems of Monetary Management: The UK Experience*.（原始陈述）
- Manheim, D., & Garrabrant, S. (2018). *Categorizing Variants of Goodhart's Law*. arXiv:1803.04585
- Carver, C. S., & Scheier, M. F. (1998). *On the Self-Regulation of Behavior*. Cambridge University Press.（目标层级：be-goal / do-goal / motor-goal）
- 核心论证："被优化的指标会失去意义"；防御方式是保持多层目标结构（上层抽象价值 → 中层目标 → 下层任务），并在下层指标饱和时回退上层重审。

**候选 E：RLHF 偏好漂移**
- Casper, S. et al. (2023). *Open Problems and Fundamental Limitations of Reinforcement Learning from Human Feedback*. arXiv:2307.15217
- 核心论证：人类偏好本身会随时间和情境漂移；偏好数据集质量衰减会造成 reward model 失真；需要持续采样+校准而非一次性训练。

### 桥接 Alex 框架
Alex 的"北极星需求越来越懂我"本质上是 **Russell 辅助博弈的工程落地版本**。但"越来越懂"的隐患就是 mesa-optimizer 偷换目标 + Goodhart 指标劫持。必须把"懂"拆成三层：

- **行为层（do-goal）**：具体任务偏好，高频更新，允许漂移。
- **目标层（be-goal）**：中层价值描述（"高效率/真实/不扰人"），低频更新，漂移需触发人类确认。
- **身份层（root-goal）**：最底层宪章（Alex 的"碳硅共荣/老板是最终判断者"），**只读**，修改需签名+多方验证。

### 工程落地：北极星更新协议（North Star Update Protocol, NSUP）
```typescript
interface NorthStar {
  // 三层目标（Carver-Scheier 层级）
  root: ImmutableCharter;      // 身份层：只读，签名保护
  be: BeGoal[];                // 目标层：低频、需确认
  do: DoGoal[];                // 行为层：高频、自动学习
  // 目标的置信度（Russell CIRL）
  confidence: { [goalId: string]: number }; // 0-1
  // 偏离预警（Goodhart）
  metricDivergence: { proxy: number; actual: number | 'unknown' };
}

interface NSUPUpdate {
  // 1. 观察：从对话/行为中提取新证据
  observe(evidence: Evidence): Hypothesis[];
  // 2. 仲裁：新假设与现有 goal 是否冲突？
  arbitrate(h: Hypothesis): 'auto-merge' | 'ask-human' | 'reject' | 'flag-mesa-risk';
  //    规则：root 层任何冲突 → 强制 ask-human
  //         be 层冲突 → ask-human
  //         do 层小幅偏差 → auto-merge，但记录 diff 供日后审计
  // 3. 反查（IRD）：若置信度 < 0.5，把新目标视为带噪声观测，不立即采纳
  updateConfidence(old: number, evidence: Evidence): number;
  // 4. Goodhart 监测：代理指标饱和时强制触发 be 层重审
  detectProxyGaming(window: TimeWindow): boolean;
  // 5. 审计日志：任何 goal 变更写入 append-only log，允许回滚
  log: AppendOnlyLog<GoalDiff>;
}
```
**关键约束**：
- **不可逆升级禁止**：root 层变更必须有"undo window"（72h），期间任何一方可撤回。
- **分布外回问**：Agent 遇到与现有 goal 距离超阈值的情境 → 默认回问，而非外推（这是 CIRL 的核心）。
- **多源偏好交叉验证**：不只依赖单次对话偏好，要对比历史行为 + 长期陈述 + 第三方反馈（防 RLHF 单点漂移）。

### 残留疑问
⚠️ **此缺口缺少成熟统一理论**——当前只有"辅助博弈 + IRD + mesa-analysis + Goodhart"的拼图，没有一个被充分验证的端到端协议。已知前沿尝试（Anthropic Constitutional AI、OpenAI Deliberative Alignment）是工程探索，离理论完备还有距离。建议标记为 "设计空间开放，需持续研究"。

---

## 缺口 L3-08：心智三轴（理性/感性/本性）独立性假设验证

### 理论候选（现有理论不支持严格独立+线性相乘 ⚠️）

**候选 A：五大人格（Big Five / OCEAN）**
- Costa, P. T., & McCrae, R. R. (1992). *Revised NEO Personality Inventory (NEO-PI-R) and NEO Five-Factor Inventory (NEO-FFI) Professional Manual*.
- John, O. P., Naumann, L. P., & Soto, C. J. (2008). *Paradigm shift to the integrative Big Five trait taxonomy*.
- 核心论证：人格稳定维度是五个——开放性、尽责性、外向性、宜人性、神经质。因子分析支持这五维相对正交（但各维度之间相关系数 r=0.1–0.3，不是零相关）。

**候选 B：情商理论**
- Salovey, P., & Mayer, J. D. (1990). *Emotional intelligence*. Imagination, Cognition and Personality, 9(3), 185–211.
- Goleman, D. (1995). *Emotional Intelligence*. Bantam.
- MacCann, C., et al. (2020). *Emotional intelligence predicts academic performance: A meta-analysis*. Psychological Bulletin, 146(2), 150–186.
- 核心论证：EQ 是独立构念还是 Big Five 的混合？Meta 分析显示 ability-based EQ 与 IQ 相关 r≈0.26，与 Big Five 尽责性、宜人性、神经质均有中等相关。**EQ 不是 IQ 的正交第二维**。

**候选 C：多元智能（Gardner）**
- Gardner, H. (1983). *Frames of Mind: The Theory of Multiple Intelligences*.
- 核心论证：提出 8 种独立智能（语言、逻辑-数学、空间、音乐、身体-动觉、人际、内省、自然）。**但心理测量学界普遍认为缺乏实证支持**（Waterhouse 2006 批评），各"智能"之间高度相关，存在 g-factor。

**候选 D：自我决定理论 / 本能驱力**
- Deci, E. L., & Ryan, R. M. (2000). *The "what" and "why" of goal pursuits: Human needs and the self-determination of behavior*. Psychological Inquiry, 11(4), 227–268.
- McDougall, W. (1908). *An Introduction to Social Psychology*.
- Murray, H. A. (1938). *Explorations in Personality*.
- 核心论证：动机/驱力独立于 IQ 和 EQ，但内在动机与人格开放性、宜人性相关显著 r=0.3–0.5。**动机不能从人格完全剥离**。

**候选 E：Cloninger 气质-性格七因素模型**
- Cloninger, C. R., Svrakic, D. M., & Przybeck, T. R. (1993). *A psychobiological model of temperament and character*. Archives of General Psychiatry, 50(12), 975–990.
- 核心论证：把人格分为**生物性气质（temperament，四维）+ 发展性性格（character，三维）**。这恰好对应 Alex 的"先天 × 后天"——气质是先天驱动（近似 Alex 的"本性"），性格是经验塑造。**这是最接近 Alex 三轴结构的心理学模型**。

**候选 F：认知-情感-动机交互的实证综述**
- Di Fabio, A., & Saklofske, D. H. (2019). *Positive Relational Management for Sustainable Development*.
- Poropat, A. E. (2009). *A meta-analysis of the five-factor model of personality and academic performance*. Psychological Bulletin, 135(2), 322–338.
- 核心论证：IQ × Personality × Motivation 三者对学业/工作绩效的共同方差大，单独贡献小；**交互项 > 主效应**。这直接反驳了"线性相乘"假设的可分离性前提。

### 桥接 Alex 框架 + 修正方案
Alex §4.1 的"先天三轴（IQ / EQ/美感 / 动机）× 后天 × 能力"直觉上优雅，但严格意义上**三轴不独立，线性相乘也不成立**。主要问题：
1. IQ 与 EQ 相关 r≈0.26（非零）。
2. 动机与人格特质重叠严重。
3. 能力 ≠ IQ×EQ×动机 的乘积——Poropat 元分析显示是**加法+交互**混合。

**修正方案（建议 Alex 采纳）**：

> 改为 **"双层三柱 + 相关不正交"模型**
>
> **第一层（生物气质层）**：参考 Cloninger 的 temperament 四因素 或简化为 Alex 的三轴近似
> - 认知倾向（近似理性）
> - 情绪反应（近似感性）
> - 驱力基线（近似本性）
> - **显式声明：三柱相关系数 r ≤ 0.3，而非独立。**
>
> **第二层（经验塑造层）**：Cloninger character 三维 + Big Five 开放性/尽责性
> - 自我导向（self-directedness）
> - 合作性（cooperativeness）
> - 超越性（self-transcendence）
>
> **能力合成函数**：不用乘法，改用 **加法 + 交互项**
> ```
> 能力 = α·理性 + β·感性 + γ·本性
>      + δ·(理性×感性) + ε·(理性×本性) + ζ·(感性×本性)
>      + η·(理性×感性×本性)
>      + 后天经历的门控（threshold-gated, 见下）
> ```
> 后天经历不是简单乘数，而是"门控"：低于经验阈值时能力 ≈ 潜能 × 0.3（未激活）；过阈后逐步释放；这是 Anders Ericsson 的"刻意练习"在心理测量上的近似。

### 工程映射（Agent 人格-能力模型）
```typescript
interface MindThreeAxis {
  // 第一层：生物气质（先天，只读 or 极慢变化）
  innate: {
    rational:  { iq: number;   correlations: { emotional: 0.26; instinct: 0.12 } };
    emotional: { eq: number;   correlations: { rational:  0.26; instinct: 0.18 } };
    instinct:  { drive: number; correlations: { rational: 0.12; emotional: 0.18 } };
  };
  // 第二层：经验塑造（后天，随训练更新）
  shaped: {
    selfDirectedness: number;
    cooperativeness: number;
    selfTranscendence: number;
  };
  // 能力合成：非线性、含交互项
  synthesize(): Capability {
    const { rational, emotional, instinct } = this.innate;
    return additiveWithInteractions(rational, emotional, instinct)
         * experienceGate(this.shaped);
  };
}
```
在 Agent 工程上的意义：
- **不要用三个独立参数直接乘**（会放大噪声，也在心理学上不成立）。
- **用相关矩阵建模三轴**（多元高斯或 copula），生成个体时保持合理的相关结构。
- **能力解释需带置信区间**——因为交互项系数 η 在不同领域（创作 vs 执行 vs 社交）不同。

### 残留疑问
⚠️ **原假设"先天三轴独立且相乘"的强版本缺心理学支撑**，需要修正。已给修正方案（Cloninger 双层 + 加法交互模型），但 Alex 自己的 §4.1 可能有叙事价值（易传播），建议保留"三轴"作为**叙事框架**，在技术实现层切换到修正模型，并在文档中用脚注标注"三轴为简化表述，严格模型见 bridges-03 §L3-08"。

---

## 总结（4 缺口一图盖章）

| 缺口 | 建构强度 | 核心理论 | 工程可落地性 |
|---|---|---|---|
| L3-05 容量带宽 | 强（三家合流成熟） | Miller/Cowan + Baddeley + Posner | 高，直接写接口 |
| L3-06 序列/空间流程 | 强（GWT 主桥） | Baars-Dehaene GWT + Kahneman Dual | 高，有成熟图/事件流对应 |
| L3-07 北极星更新 | ⚠️ **缺统一理论** | Russell CIRL + Hubinger mesa + Goodhart（拼图） | 中，协议可落但前沿仍在研究 |
| L3-08 心智三轴独立 | ⚠️ **原假设不成立，需修正** | Big Five + Cloninger（修正版） | 中，需替换为加法+交互模型 |

**建议 Alex 优先处理顺序**：L3-05（最稳，立即工程化）→ L3-06（稳，补 GWT 调度器）→ L3-08（修叙事与实现分层）→ L3-07（长期跟进 AI 安全前沿）。

---

署名：cc（claude-opus-4-7[1m]）| 2026-04-18
