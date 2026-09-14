export interface Article {
  slug: string
  title: string
  excerpt: string
  date: string
  tags: string[]
  content: string
}

export const articles: Article[] = [
  {
    slug: 'memory-systems-benchmark-findings',
    title: '评测开源记忆系统：怎样分清记忆和模型的贡献',
    excerpt:
      '为儿童 AI 产品选择记忆方案时，我把几种开源系统放进同一套评测。更换答题模型、加入全量聊天记录作为对照，让一些原本好看的分数有了不同的解释。',
    date: '2026-07',
    tags: ['AI 记忆', '评测方法', 'Benchmark'],
    content: `做儿童陪伴 AI 时，我希望它能记住孩子的兴趣、约定和后来改变的想法。如果孩子已经说了不喜欢某样东西，AI 还反复提起，记忆反而会损害交流。

我把 mem0、letta、cognee、hindsight 等开源方案接到统一的题库和判分流程里，检查它们能否为这个场景提供可靠的记忆。

#### 怎么出题和判分

题目覆盖对话内记忆、跨对话推理、时间顺序、旧信息更新、不确定时拒绝编造，以及持续遵循用户偏好。例如，孩子上个月说想养狗，这个月说怕狗了，回答应该反映这次变化。

评测通过提问检查答案和事实依据，由独立判分层判断。系统声称“已经记住”不作为通过证据。

#### 换一个答题模型，结果就变了

保持记忆系统和题目不变，我把答题模型换成能力较弱的本地模型。依赖模型深度加工记忆的部分方案表现下降，偏重检索的方案变化较小，有的反而略有提升。

这提示我，原来的分数混合了记忆处理与答题模型的能力。个别方案在弱模型下运行不稳定，也可能影响结果，不能把全部变化都归因于记忆设计。

选型时值得补上这组对照。除了看总分，还要确认方案对模型能力的依赖，以及更换模型后是否仍能正常工作。

#### 把全部聊天记录交给模型，也是必要的对照

我设置了不提供历史、提供全部历史、提前提供相关答案依据等对照。在这轮题库与配置下，被测记忆方案尚未稳定超过全量历史的回答表现。

这个结果不能推导出“记忆系统没有用”。全量历史会增加成本，也受上下文长度限制；记忆系统需要在信息保留、检索成本和回答质量之间取舍。但如果只报一个准确率，不说明它与全量历史的差距，就很难判断省下了什么、又丢掉了什么。

我会继续保留这些对照，扩大题库，并把运行异常和回答错误分开记录。这些结果用于当前产品选型，不代表对所有模型、场景和版本的排名。`,
  },
  {
    slug: 'ai-native-workflow-2026',
    title: '一个人做产品，我怎样用 AI 协作',
    excerpt:
      '从 2025 年底开始，我逐步把 AI 用在研究、开发、测试和服务巡检中。独立软件仍由我一个人完成，分工方式在变，产品判断和验收责任没有交出去。',
    date: '2026-07',
    tags: ['AI Native', 'Vibe Coding', '多引擎协作'],
    content: `2025 年底，我开始把 AI 编码纳入日常工作。现在，研究、原型、开发、测试和服务巡检都有 AI 参与。独立软件项目由我一个人 vibe coding 完成，没有团队，AI 是我的手脚。

我负责产品定义、技术取舍和验收。公司产品的硬件、供应链与量产工作，则由真实的跨职能团队共同推进。

#### 按任务安排引擎

目前我用 Claude 做规划与任务拆解，Codex 做主要实现，Grok 参与研究和复核。具体分工会根据任务调整，不把某个模型当作所有问题的固定答案。

重要方案会交给另一个引擎检查。我会给出用户场景、约束和验收条件，让复核具体到输入处理、权限、失败恢复等问题。这样的检查曾发现实现里的注入风险，但多一个模型并不保证不会漏错，仍要通过测试和实际使用验证。

#### 规则按需读取

早期我把大量规则都放在每次必读的上下文里，日常任务也要带着无关内容。后来只保留常用约束，其余整理成索引，遇到相应场景再读。

现在新增规则时，我会判断它是否需要每次出现。项目知识、操作步骤和长期约束分开存放，也便于修改和查找。

#### 巡检可以自动做，风险操作要有边界

个人网站、数据服务和语音服务接入了自动巡检。检查包括公网访问、日志和运行状态，发现异常后留下待办和诊断线索。

只读检查可以自动执行。涉及高风险变更时，仍需确认目标、授权和回滚路径，不能因为 AI 判断“应该这样修”就直接执行。

#### 读论文时，我保留问题清单

研究连续时间因果发现时，我让 AI 按问题清单整理文献，再对照各篇论文的实验条件和结论。比较不同评测基准后，我把方案里负责“证明因果”的组件收窄为检查和排除不成立的方向。

AI 可以帮助整理证据，我需要判断这些证据够不够支持下一步。个人站和这里的独立项目也沿用这套方式：AI 协助实现与测试，我试用、检查结果，并决定是否交付。`,
  },
  {
    slug: 'voice-agent-latency-ledger',
    title: 'AI 为什么迟迟不开口：实时语音的延迟排查',
    excerpt:
      '等待来自判停、模型响应、语音合成和播放链路。我把这些环节分开检查，也区分“已经发出承接声”和“真正开始回答”，避免用一个首响数字掩盖体验问题。',
    date: '2026-07',
    tags: ['实时语音', '延迟优化', 'Voice Agent'],
    content: `语音对话里，等待会直接影响交流。用户说完话后没有回应，很难判断系统是在思考、没有听清，还是已经断开。

排查自己的语音系统时，我把耗时拆到判停、模型首字、合成首音和实际播放。只看端到端总耗时，很容易改错环节。

#### 确认用户说完，也需要时间

系统通常会等待一段静音，再提交用户的话。窗口过长会拖慢回答，过短又可能截断句子。我调整静音窗口，并加入语义判停，根据句子是否完整辅助判断。

这项取舍要结合实际说话方式验证。孩子的停顿、重复和半句改口，都可能让一个看似更快的配置变得难用。

#### 模型响应要看慢的时候

模型首字时间会随网络和服务负载变化。我尝试了模型赛马：并发请求候选模型，采用先返回的可用响应，取消其他请求。它能降低对单一路径的依赖，也增加请求成本和取消处理的复杂度。

思考模式也会影响开口时间。即时闲聊需要较快接话，复杂分析可以允许更长等待；选型时应分别测试，不能照搬写代码时的配置。

#### 连接和音频处理也会吃掉开头

语音合成前临时建连，会增加一次等待。连接复用可以减少这部分开销，但要处理失效连接和重连。回声消除的冷启动也可能影响首句，需要从采集、传输到播放逐段检查。

目前 MyJavis 与小可共用基于 Rust 重写的实时双向全双工语音引擎。Tokio 管理异步任务，LiveKit/WebRTC 传输音频，语音识别、模型生成和语音合成流式衔接，并处理判停与打断。低延时需要这些环节共同优化，采用 Rust 本身不能证明性能提升。

#### 承接语不能冒充答案

完整回答尚未就绪时，可以根据用户话语播放一句自然的承接，减少没有反馈的空白。承接内容要合适，也要与正文衔接；垫一句之后继续冷场，仍然是体验问题。

因此我把承接首响和正文首响分开看，同时检查首句是否完整、用户能否插话、打断后有没有旧回答继续播放。本文保留优化方法，不把不同设备、网络和版本的历史测量合并成一个性能承诺。`,
  },
  {
    slug: 'ai-memory-three-routes',
    title: 'AI 记忆研究：检索、模型学习与场景信号',
    excerpt:
      '我尝试让轻量模型从相处数据中学习用户特征，也重新检查了输入信号能支持什么判断。阶段性实验提示：仅靠表情推断意图不够，后续需要补充场景信息。',
    date: '2026-07',
    tags: ['AI 记忆', 'CfC', '因果发现'],
    content: `做陪伴型 AI，我关心下次打开时，交流能不能接着上次继续。为此研究过外部检索、模型层学习，以及场景与因果信号。这些方向解决的问题不同，不能用一个“记住了”概括。

#### 检索适合保存事实

mem0、Zep 等方案把对话存档、建立索引，在需要时提供给模型。它们不必修改模型权重，能够让回答参考用户说过的话。

这种方式需要解决检索遗漏、旧事实更新和上下文长度问题。在我做的那轮评测中，被测系统尚未稳定超过全量历史对照；结论受题库、模型和版本限制，不能直接推广到所有产品。

#### 用轻量模型学习状态

我也尝试了 CfC（连续时间神经网络），让模型从随时间变化的多模态特征中学习用户状态。阶段性实验支持继续探索这条路线，但状态识别通过实验，并不等于模型已经理解一个人，更不等于能可靠判断他的意图。

为了检查这个差距，我又用信息论方法估计输入信号与目标的关联。这类分析同样受样本和估计方法限制，作用是帮助判断下一步值得补什么数据。

#### 表情提供的信息不够

在当时的数据和设置下，仅靠表情推断意图的证据不足；加入一段表情变化序列，也没有带来原先期待的改善。加入会议、休息等场景信息后，表现有所改善。

我把它作为阶段性结论归档，后续方向转向补充场景与情境信号。继续调模型之前，需要确认输入是否包含目标所需的信息。

#### 继续研究因果，但收窄结论

接下来我用 AI 辅助阅读连续时间因果发现的论文，对比实验条件和结论。不同评测基准之间存在不一致，部分领先方法缺乏直接对照，不能把各自的结果拼成统一排名。

这些检查让我收窄了方案中“因果验证器”的职责：用于检查、排除部分不成立的方向，不把它当作已经证明因果关系的工具。

会议场景的研究分支仍在积累数据。视觉链路以提取特征为主，不保存原始画面；这是一项数据处理选择，不代表所有隐私风险都已解决。

当前的分工是：检索保留事实，轻量模型学习状态变化，场景研究补充判断依据。相关研究保留在作品页的 LnMem 项目中。

#### 参考文献

以下保留此次阅读的文献，按研究问题分组。

**连续时间系统的因果定义**

1. From Ordinary Differential Equations to Structural Causal Models: the deterministic case — https://arxiv.org/abs/1304.7920

2. Causal interpretation of stochastic differential equations — https://arxiv.org/abs/1304.0217

3. Causal models for dynamical systems — https://arxiv.org/abs/2001.06208

**结构学习算法**

4. Neural graphical modelling in continuous-time: consistency guarantees and algorithms — https://arxiv.org/abs/2105.02522

5. Neural Structure Learning with Stochastic Differential Equations — https://arxiv.org/abs/2311.03309

6. Deep Koopman operator framework for causal discovery in nonlinear dynamical systems — https://arxiv.org/abs/2505.14828

7. Causal Structure Learning for Dynamical Systems with Theoretical Score Analysis — https://arxiv.org/abs/2512.14361

**打分与检验方法**

8. Tangent Space Causal Inference: Leveraging Vector Fields for Causal Discovery in Dynamical Systems — https://arxiv.org/abs/2410.23499

9. Signature Kernel Conditional Independence Tests in Causal Discovery for Stochastic Processes — https://arxiv.org/abs/2402.18477

10. Distinguishing Cause from Effect with Causal Velocity Models — https://arxiv.org/abs/2502.05122

**适用条件与评测基准**

11. Causality and independence in perfectly adapted dynamical systems — https://arxiv.org/abs/2101.11885

12. Disentangling Continuous-Time Latent Dynamics: Identifiability of Latent SDEs via Diffusion Shifts — https://arxiv.org/abs/2606.28228

13. Causal Discovery from Heteroscedastic Stochastic Dynamical Systems under Imperfect Physical Models — https://arxiv.org/abs/2602.04907

14. Hybrid² Neural ODE Causal Modeling and an Application to Glycemic Response — https://arxiv.org/abs/2402.17233

15. CausalDynamics: A large-scale benchmark for structural discovery of dynamical causal models — https://arxiv.org/abs/2505.16620`,
  },
]
