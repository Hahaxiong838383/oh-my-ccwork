# 08 · LLM 冷启动 —— 轻量 SFT 方法论

> 提炼自 1-Inbox/2026-04-05-AESL论文分析-mycc借鉴.md，日期 2026-06-17
> **出处**：*Getting Your LLMs Ready for Reinforcement Learning with Lightweight SFT*（AESL，ICLR 2026，Xinran Li 等）
> [OpenReview](https://openreview.net/forum?id=yezWGJmODg) ｜ [GitHub](https://github.com/LXXXXR/AESL)
> **一句话定位**：把"SFT 冷启动该练到什么程度"从凭感觉变成"盯多样性指标早停"。

---

## 一、一句话核心洞察

**不要追求 SFT 阶段的「最好」，追求 SFT 阶段的「刚好」。**

SFT 表现最好的 checkpoint，往往不是 RL 阶段效果最好的起点。原因是 **distributional forgetting（分布遗忘）**：模型在 SFT 中过拟合训练数据的分布模式，偏离了 base model 原有的多样性分布——而 RL 恰恰需要探索能力和多样性。比喻：SFT 让模型"学会了一种正确回答方式"，代价是"忘了还有很多种正确回答方式"。

关键的反直觉点：这个分布遗忘**比传统过拟合更早发生、更隐蔽**，在 eval loss / accuracy 还看不出过拟合时就已经在丢多样性了。所以传统的"按 eval loss 选 checkpoint"会系统性选错。

---

## 二、关键机制（提炼，非照抄）

### 2.1 判据切换：多样性 > 准确率（这是方法论的命门）

选 checkpoint 不看 eval loss / accuracy，改看 **entropy / self-BLEU 等多样性指标**。论文实验：多样性峰值出现在 SFT 较早阶段，此后单调下降；在多样性峰值附近的 checkpoint 做 RL，效果显著优于"准确率最高"的 checkpoint。

### 2.2 AESL（Adaptive Early-Stop Loss）：让"已经会的别再练"

核心是自适应加权的 cross-entropy，在两个粒度操作：
- **Token 级**：某 token 已学得很好（loss 低）→ 降低其 loss 权重，防止继续朝过度确定方向优化；没学好的 token 保持正常 loss。
- **Subsequence 级**：对模型已掌握的推理子模式降权，把训练资源留给还不熟悉的模式。

一句话：**已经会的就别再练了，避免从"会"变成"只会这一种"。**

### 2.3 关键超参数与配置（论文给出的值）

| 项 | 值 | 作用 |
|----|----|----|
| Temperature | T=5.0 | 控制 loss 调节激进程度。太小→学不到新模式；太大→base 分布遗忘严重 |
| 训练数据量 | < RL 数据量的 1/10 | "轻量级"的含义——少量数据轻触 |
| 训练周期 | 10 epochs | 但核心是靠多样性指标决定 early stop，不是跑满 |

### 2.4 与传统 SFT→RLHF 的对照

| 维度 | 传统做法 | AESL |
|------|---------|------|
| 选 checkpoint | eval loss / accuracy | entropy / self-BLEU（多样性） |
| SFT 目标 | 输出尽量接近标准答案 | 学会新模式但保持分布多样性 |
| 数据量 | 大量 SFT 数据 | <1/10 RL 数据量 |
| Loss | 标准 cross-entropy | 自适应加权（token + subsequence） |
| 理念 | 模型"学好了"才能做 RL | 模型"刚好学到一点"时做 RL 最好 |

---

## 三、对 mycc / cc 的可迁移借鉴点

> 以下是从源文件"mycc 借鉴"段提炼出的**可执行判断**，不是论文结论本身。源文件作者已把它和 mycc 现状（Faithfulness 3.05 未达标、P5 SFT 挂起等）做了映射；这些映射属于**推断**，未经实验验证，落地前需 sanity check。

### 借鉴 1：Faithfulness 问题换个归因——可能不是数据不够，而是分布丢了

mycc 的痛点是 Faithfulness 3.05 未达标。AESL 给的新视角（推断）：**问题可能不在 SFT 数据太少，而在 SFT 过程让模型丢失了"基于检索内容回答"的忠实分布**。若在"编造看似合理答案"的模式上过度训练，模型会越来越倾向创造性回答而非忠实回答。
→ **可执行判断**：先别急着堆数据，先怀疑"是不是练过头把引用式回答模式练没了"，用少量高质量数据轻触 + 严格盯多样性。

### 借鉴 2：现成的 reward signal 已经在手，无需额外标注

| 信号源 | mycc 现有组件 | 用法（源文件建议） |
|--------|------|------|
| prediction hit/miss | prediction-engine.ts | hit→reward +1；高置信 miss→-1；低置信 miss→0（不惩罚） |
| faithfulness 评分 | eval 框架 | reward ∝ score |
| valence/arousal | GAP4 情感标注 | 转成 preference pair：高 valence response 为 preferred，相似 query 低 valence 为 rejected |

→ **可执行判断**：reward 来源是现成的，落地点是"在经验流记录追加 reward 字段，由 P2 @04:00 巩固任务回填 prediction 验证 + reward"。

### 借鉴 3：SFT 训练加"多样性健康度监控"（最重要的工程启示）

在 P5 SFT 脚本中，每 epoch 后记录三指标联合早停：
1. **Response Entropy**：eval set 上的 token 级熵，下降 >20% 触发 early stop
2. **Self-BLEU**：同类 query 多回复的 self-BLEU，上升 >15% 触发 early stop
3. **Faithfulness on eval**：38 条用例分数；**若 Faithfulness 提升但 entropy 明显下降，优先保护 entropy**

### 借鉴 4：P5 SFT 启动条件——质量 + 多样性，不是凑数量

源文件建议把触发条件从"经验 >= 1000"调整为质量导向（建议值，未验证）：

| 条件 | 原计划 | 建议调整 |
|------|--------|---------|
| 经验条数 | >=1000 | >=500（有 faithfulness 标注的） |
| 数据质量 | 无 | faithfulness >=4.0 占比 >30% |
| 覆盖度 | 无 | 覆盖 >=80% 记忆命名空间 |
| 多样性基线 | 无 | 先测 base model 的 entropy 基线 |

配套三阶段递进：① 轻量 SFT（AESL loss，200-500 条 faithfulness>=4.0 样本，entropy 降到基线 80% 即停）→ ② 可选 reward model（valence/arousal 构 preference pair，>=200 对）→ ③ RL（若阶段 1 够好可跳过；KL 系数设小如 0.001 防偏离 checkpoint）。

### 借鉴 5：抽象到 cc 自身的判断准则

把"刚好而非最好"上升为通用直觉：**任何微调/规则收敛/行为塑形，都要警惕"为了某个指标更好而牺牲了灵活性/多样性"。** 优化单一指标到极致 = 分布坍缩。盯一个"多样性护栏指标"配合主指标，比单看主指标更安全。

---

## 四、适用边界 / 不适用场景

> 以下风险点源文件已明确列出。

1. **小模型更脆弱**：AESL 用 7B+ 模型。mycc 的 4B intake 模型多样性空间本就有限，temperature 可能要调高（源文件建议 T=7-10，属推断值），early stop 要更激进。
2. **场景迁移有不确定性**：AESL 实验在**数学推理 benchmark** 上做。mycc 的"记忆检索 + 忠实回答"场景可能需要调整 diversity 指标权重——论文未覆盖此场景，迁移属推断。
3. **小数据量高度依赖质量**：200-500 条做 SFT，效果强依赖数据质量。建议先在 eval 框架 38 条用例上做 sanity check 再放量。
4. **reward hacking**：只用 prediction hit/miss 当 reward，模型可能学会永远预测最高频 intent（如"build"）。需加 diversity bonus。

**整体定位边界**：本方法论解决的是"SFT 冷启动该练到什么火候 + 怎么早停"，前提是你有 base model、要接 RL/RLHF、且关心 RL 后效果。如果不接 RL、或目标就是把模型压到单一确定行为（如纯分类器），多样性优先的逻辑不成立。

---

## 五、未验证标注汇总

为遵守 no-guessing，明确区分论文事实 vs 源文件对 mycc 的推断：

- **论文事实（出处可查）**：distributional forgetting 现象、多样性峰值在早期、AESL token/subsequence 双粒度加权、T=5.0、<1/10 RL 数据量、按多样性早停优于按 accuracy。
- **源文件对 mycc 的推断（未经实验验证）**：Faithfulness 归因于分布丢失、prediction/valence 作 reward 的具体阈值、P5 启动条件建议值、4B 模型 T=7-10、三阶段方案、各早停百分比阈值（20%/15%/80%）。这些是**落地假设**，需在 mycc 上实测校准，不可当结论直接采纳。

---

参考资料：
- [OpenReview 论文页面](https://openreview.net/forum?id=yezWGJmODg)
- [AESL GitHub 代码库](https://github.com/LXXXXR/AESL)
- [SPOT Workshop @ ICLR 2026](https://spoticlr.github.io/)
