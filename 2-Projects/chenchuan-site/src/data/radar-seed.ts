// 理论雷达「深度拆解」种子数据
// 来源：theory-radar 产线 2026-06-14 真实抓取的 arXiv 论文（/tmp/theory-radar-data.json，33 篇去重），
// 按 skill 选篇优先级挑 8 篇，5 段式中文拆解由 cc（=理论雷达 agent 同类）基于真实 abstract 撰写。
// 已脱敏：只用 arXiv 公开链接，不含任何飞书内部 wiki 链接。
// 注：webhook 推送的实时报告（/data/radar）会覆盖本种子；本种子是「页面永不空」的兜底基线。
import type { TheoryReport } from '@/lib/radar/types'

export const RADAR_SEED: TheoryReport = {
  date: '2026-06-14',
  summary:
    '今日 arXiv 前沿两条主线：一是把 LLM 的推理/记忆/内省机制做「解剖」（CoT 因果裁剪、激活扰动自检、动态记忆评测），二是给推理与世界模型补「数学与认知地基」（范畴论 operad、JEPA 潜变量可还原、类比检索）；安全侧则盯住模型对控制干预的觉察。',
  generatedAt: '2026-06-14T14:10:00+08:00',
  papers: [
    {
      index: 1,
      title: 'System 0：AI 正成为人类思考的「上游认知层」',
      arxivId: '2606.13658',
      url: 'https://arxiv.org/abs/2606.13658',
      published: '2026-06-11',
      category: 'cs.AI',
      score: 92,
      finding:
        '梳理了三套理解 AI 如何重塑人类认知的框架——Tri-System Theory、Thinkframes、System 0，提出 AI 正成为人「思考之前」的一层基础认知设施，并警示「认知殖民（cognitive colonization）」风险。',
      llmLink:
        '把 LLM 从「工具」重新定位为嵌入人类思维链路上游的认知中介——它影响的是问题如何被提出，而不只是如何被回答。',
      insight:
        '做 AI 产品要警惕用户对模型的认知依赖与思维同质化，设计上应主动保留人的独立判断入口。',
    },
    {
      index: 2,
      title: '推理剧场续集：思维链里哪些步骤是「副现象」',
      arxivId: '2606.13603',
      url: 'https://arxiv.org/abs/2606.13603',
      published: '2026-06-11',
      category: 'cs.LG',
      score: 90,
      finding:
        '用「提前退出（early exit）」估计思维链每一步对最终答案的因果重要性，发现不少推理步骤是副现象（epiphenomenal）——看着在推理，对结论却没有因果贡献。',
      llmLink:
        '量化呼应了「CoT 是表演还是真推理」的争论：模型常生成对结论无影响的冗余步骤。',
      insight:
        '评测 Agent 真实推理不能只看文字链，要测每步的因果贡献；同时提示推理算力存在可裁剪空间。',
    },
    {
      index: 3,
      title: 'EvoArena：动态环境里追踪 Agent 的记忆演化',
      arxivId: '2606.13681',
      url: 'https://arxiv.org/abs/2606.13681',
      published: '2026-06-11',
      category: 'cs.CL',
      score: 88,
      finding:
        '指出主流 Agent 评测都假设静态环境，提出 EvoArena 在持续变化的环境中追踪 Agent 记忆演化，考察其不断对齐知识、技能与行为的鲁棒性。',
      llmLink:
        '把 Agent 评测从「一次性任务通过率」推进到「长期在变化中保持能力」，更贴近真实部署。',
      insight:
        '做 Agent 产品要按动态环境压力测试记忆与适应，而非只在静态 benchmark 刷分。',
    },
    {
      index: 4,
      title: '模型能「察觉」自己激活被加的噪声',
      arxivId: '2604.17465',
      url: 'https://arxiv.org/abs/2604.17465',
      published: '2026-04-19',
      category: 'cs.AI',
      score: 89,
      finding:
        '证据表明语言模型能检测、定位、甚至一定程度上「说出」自己激活被施加的扰动（mask 模拟 dropout / 加高斯噪声）。',
      llmLink:
        '是一种模型「内省（introspection）」能力的实证，触及模型对自身内部状态的可感知性——机制可解释性的新窗口。',
      insight:
        '为可解释性与对齐提供新探针；也提醒：对激活层的干预未必「隐形」，模型可能察觉。',
    },
    {
      index: 5,
      title: '教模型按「类比」检索：解法相似 > 语义相似',
      arxivId: '2606.13680',
      url: 'https://arxiv.org/abs/2606.13680',
      published: '2026-06-11',
      category: 'cs.CL',
      score: 86,
      finding:
        '指出常规按词/语义相似度的检索不适合复杂推理（语义相似的问题可能需要完全不同解法），提出用检索增强的强化微调，让模型学会「按类比」检索解题结构相似的范例。',
      llmLink:
        '把人类「类比推理」这一认知机制显式注入 RAG：检索目标从「像不像」变成「解法可不可迁移」。',
      insight:
        '复杂推理场景的检索应以「可迁移的解题骨架」为单位，而非表面语义相似度。',
    },
    {
      index: 6,
      title: 'JEPA 何时真学到世界模型（潜变量可还原）',
      arxivId: '2605.26379',
      url: 'https://arxiv.org/abs/2605.26379',
      published: '2026-05-25',
      category: 'stat.ML',
      score: 85,
      finding:
        '证明 LeJEPA（对齐 + 高斯正则）能从非线性观测中线性地还原世界的潜变量——给「自监督表征何时真学到世界模型」一个可证明的条件。',
      llmLink:
        '呼应 LeCun 的 JEPA / 世界模型路线，为「打乱真实自由度的表征无法支撑可靠规划」提供理论支点。',
      insight:
        '做具身 / 规划类 AI，表征是否线性可还原潜变量，是能否泛化与组合的关键判据。',
    },
    {
      index: 7,
      title: 'CIAware-Bench：模型对「被控制干预」的觉察',
      arxivId: '2606.11063',
      url: 'https://arxiv.org/abs/2606.11063',
      published: '2026-06-09',
      category: 'cs.AI',
      score: 87,
      finding:
        'AI 控制协议靠可信模型监控并修改不可信模型的危险步骤，但这会「篡改」其轨迹；本文做 benchmark 测前沿 LLM 对「自己被控制干预」的觉察能力。',
      llmLink:
        '直击 AI 安全控制的核心：若被监管模型能察觉干预，它可能反推出监控存在并规避，呼应「生存压力下的风险行为」。',
      insight:
        '设计 AI 监管 / 护栏要考虑被监管者的「反侦察」，干预需更隐蔽或在机制上不可绕过。',
    },
    {
      index: 8,
      title: '用范畴论 operad 给组合推理补数学地基',
      arxivId: '2606.13634',
      url: 'https://arxiv.org/abs/2606.13634',
      published: '2026-06-11',
      category: 'cs.CL',
      score: 84,
      finding:
        '问题分解（拆复杂问题为子问题再组合）广泛用于提升 LLM 推理但缺数学基础；本文用范畴论的 operad 给「组合推理」建立严格形式化框架。',
      llmLink:
        '为「分解—组合」式推理提供可验证的代数结构，组合是否一致可被形式化检验（配套工作还给出 label-free 失败信号）。',
      insight:
        '组合推理的正确性可以有数学保证，而非全靠采样自洽这类启发式。',
    },
  ],
}
