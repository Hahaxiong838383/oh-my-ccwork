/**
 * 从公开项目经历整理的决策示例，不是原始对话逐字回放。
 * engine 表示讲解阶段，不代表历史上实际参与的模型。
 * duration_ms 保留接口兼容；0 表示没有可公开核实的耗时，不展示为实测。
 * quality_score 仅控制展示顺序，不是项目质量评测分数。
 */
import { formatCareerExperience } from '@/lib/experience'

const careerExperience = formatCareerExperience(undefined, { spaced: true, includeDays: true })

export type DemoCategory = 'arch' | 'speed' | 'cognition' | 'failure' | 'crossover'

export interface DemoRoutingStep {
  engine: 'analysis' | 'review' | 'implementation' | 'decision'
  stage: string
  duration_ms: number
  output_md: string
}

export interface ClassicDemo {
  id: string
  category: DemoCategory
  question: string
  routing: DemoRoutingStep[]
  total_duration_ms: number
  featured: boolean
  quality_score: number
}

export const CLASSIC_DEMOS: ClassicDemo[] = [
  {
    id: 'arch-01',
    category: 'arch',
    question: '做 AI 记忆，怎样选择检索和模型学习？',
    routing: [
      {
        engine: 'analysis',
        stage: '需要记住什么',
        duration_ms: 0,
        output_md:
          '陪伴 AI 需要记住用户说过的话，也要处理兴趣和约定的变化。选型时，我把“保存事实”和“识别状态”分开看。\n\n检索方案把对话存档、建立索引，回答时找出相关内容；模型学习则尝试从随时间变化的特征中学习状态。两者的验证目标不同。',
      },
      {
        engine: 'review',
        stage: '检查验证条件',
        duration_ms: 0,
        output_md:
          '检索要检查遗漏、旧事实更新和回答依据。模型学习要检查冷启动、训练样本和遗忘风险。\n\nCfC（连续时间神经网络）适合探索时间信号，但实验中的状态识别表现，不能直接说明它已经理解用户意图。评测还需要与全量历史等基础方案对照。',
      },
      {
        engine: 'decision',
        stage: '保留研究，明确边界',
        duration_ms: 0,
        output_md:
          'LnMem 保留了模型层记忆的研究。后续检查发现，当时的数据中，纯表情不足以支持可靠的意图判断，优化方向转向补充场景信号。\n\n实际产品里的记忆仍要允许用户查看和纠正。小可围绕兴趣、称呼和约定保存来源，避免一次误解变成长期标签。',
      },
    ],
    total_duration_ms: 0,
    featured: true,
    quality_score: 95,
  },
  {
    id: 'speed-01',
    category: 'speed',
    question: '卡片拖拽总是错位，什么时候应该重写交互？',
    routing: [
      {
        engine: 'analysis',
        stage: '复现错位',
        duration_ms: 0,
        output_md:
          'AR HUD 网页演示的卡片拖拽出现累积漂移。排查发现，getBoundingClientRect 返回的是经过 transform 后的视觉位置，代码却把它继续当作布局起点。\n\n补丁叠加后，拖拽、换位和回弹之间的时序更难判断。我需要重新检查坐标来源和换位时机。',
      },
      {
        engine: 'review',
        stage: '检查边界情况',
        duration_ms: 0,
        output_md:
          '复核集中在松手后残留的起点、缩放造成的坐标偏差，以及回弹尚未结束就再次拖拽的情况。\n\n继续逐项补丁会增加状态。另一种方案是在拖动时保持布局不变，松手后再调整顺序，让视觉位移与布局更新分开。',
      },
      {
        engine: 'implementation',
        stage: '修改坐标与状态处理',
        duration_ms: 0,
        output_md:
          '实现采用中心点计算位移，释放起点只使用一次，用完即清除；动画从松手时的视觉位置过渡到新布局。\n\nFLIP（记录布局变化前后的坐标，再播放过渡）用于保持动画连续，类型检查与构建用于检查代码改动。',
      },
      {
        engine: 'decision',
        stage: '松手后再换位',
        duration_ms: 0,
        output_md:
          '最终采用 deferred swap：拖动期间不改变卡片顺序，松手后才插入目标位置。这样减少了拖动过程中的布局变化。\n\n演示保留在 https://my.chenchuan.cc/lab/ar-hud-demo 。这段示例说明排查与取舍，不把整理后的过程当作实测工时。',
      },
    ],
    total_duration_ms: 0,
    featured: true,
    quality_score: 92,
  },
  {
    id: 'cog-01',
    category: 'cognition',
    question: `${careerExperience}硬科技产品经历里，哪些判断一直在用？`,
    routing: [
      {
        engine: 'analysis',
        stage: '回看具体使用场景',
        duration_ms: 0,
        output_md:
          '做太阳能消费品时，要考虑照明、充电、防盗和维护；做服务机器人时，要看场地、工作流程和运营成本。技术方案只有放进这些条件里，才能判断是否适用。\n\n后来做 AR HUD，同样需要兼顾光学效果、驾驶交互、整车集成和量产要求。',
      },
      {
        engine: 'review',
        stage: '把付费与交付条件问清楚',
        duration_ms: 0,
        output_md:
          '原型可用之后，还要确认谁购买、谁每天使用、谁维护，以及交付成本能否接受。展会演示和实际部署的条件不同，不能只靠演示效果决定继续投入。\n\n这些问题也适用于 AI：一次回答令人满意，不代表用户会持续使用或愿意付费。',
      },
      {
        engine: 'decision',
        stage: '用到现在的产品中',
        duration_ms: 0,
        output_md:
          '做 KidsHub 时，我把孩子愿不愿意再次使用放进产品定义；做 H 平台时，关注重复解释背景、任务进度和结果送达。\n\n过去的经历帮助我提出检查项，但每个新场景仍要单独验证，不能把以前的成功当作这次的证明。',
      },
    ],
    total_duration_ms: 0,
    featured: true,
    quality_score: 98,
  },
  {
    id: 'fail-01',
    category: 'failure',
    question: '个人站里的 AI 对话，立项时要检查什么？',
    routing: [
      {
        engine: 'analysis',
        stage: '明确访客能得到什么',
        duration_ms: 0,
        output_md:
          '这个对话入口帮助访客了解陈川做过的项目，以及其中的产品判断。它是 AI 讲解，不是本人在线，也不能代表本人承诺合作或交付。\n\n页面同时保留整理后的决策示例，访客无需发起实时问答，也能阅读项目思路。',
      },
      {
        engine: 'review',
        stage: '检查内容与隐私',
        duration_ms: 0,
        output_md:
          '输入材料只使用可以公开的项目事实，去掉凭据、内部部署信息和个人资料。AI 不知道的内容应说明信息不足，不编造数字、经历或客户评价。\n\n回答从用户问题和产品取舍讲起。访客追问实现时，可以解释具体技术，不需要为了保持定位而拒绝技术问题。',
      },
      {
        engine: 'review',
        stage: '检查体验中断',
        duration_ms: 0,
        output_md:
          '实时问答受可用额度和服务状态影响。达到限制时应直接说明原因，保留示例和联系入口，不用“读取大脑的权限不足”掩盖产品限制。\n\n引导联系本人只在需要进一步沟通时出现，不把每个回答都变成推销。',
      },
      {
        engine: 'decision',
        stage: '让示例与实时回答分开',
        duration_ms: 0,
        output_md:
          '整理示例要标明来源性质，实时回答要保持 AI 身份透明。两者都应保留事实边界，不把模型语气当作本人意见。\n\n产品内容与服务降级同时纳入验收，避免只检查正常回答时的页面。',
      },
    ],
    total_duration_ms: 0,
    featured: true,
    quality_score: 96,
  },
  {
    id: 'cross-01',
    category: 'crossover',
    question: '怎样把 AR 光学经验用到儿童读写台？',
    routing: [
      {
        engine: 'analysis',
        stage: '重新检查使用条件',
        duration_ms: 0,
        output_md:
          '车载显示和儿童读写台的用户、环境、成本与安全要求不同。我从 AR 光学经验出发，重新检查读写距离、显示区域和日常交互。\n\n技术复用不能理解为降低安全要求，也不能因为车载方案可用，就认为消费产品已经成立。',
      },
      {
        engine: 'review',
        stage: '检查持续使用的理由',
        duration_ms: 0,
        output_md:
          '孩子为什么愿意继续用，是读写台需要验证的问题。KidsHub 把小可对话和生态缸养成放到同一体验里，让参与留下进度，也让兴趣和约定能在后续交流中接续。\n\n家长还需要设备绑定、使用管理和后续维护。玩法设计不等于已证明留存或护眼效果。',
      },
      {
        engine: 'decision',
        stage: '分别验证各层能力',
        duration_ms: 0,
        output_md:
          'Android/Kotlin 对接设备，Godot 呈现场景，Rust 游戏运行时管理进度与奖励。小可与 MyJavis 共用 Rust 实时双向全双工语音引擎，支持低延时交流与插话。\n\n成长玩法已有真机验证；one-shot 让唤醒词和问题连着说，已完成专项验收，仍待合包发布。持续参与效果要在实际使用中继续观察。',
      },
    ],
    total_duration_ms: 0,
    featured: true,
    quality_score: 94,
  },
]

export function getDemoById(id: string): ClassicDemo | null {
  return CLASSIC_DEMOS.find((d) => d.id === id) ?? null
}

export function getDemosByCategory(category: DemoCategory): ClassicDemo[] {
  return CLASSIC_DEMOS.filter((d) => d.category === category).sort(
    (a, b) => b.quality_score - a.quality_score,
  )
}

export function getFeaturedDemos(limit = 6): ClassicDemo[] {
  return CLASSIC_DEMOS.filter((d) => d.featured)
    .sort((a, b) => b.quality_score - a.quality_score)
    .slice(0, limit)
}

export const CATEGORY_LABELS: Record<DemoCategory, string> = {
  arch: '技术方案怎么选',
  speed: '交互问题怎么修',
  cognition: '产品经历与判断',
  failure: '立项时检查什么',
  crossover: '跨领域技术应用',
}
