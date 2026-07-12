/**
 * Talk-With-My-AI 经典提问回放数据
 *
 * 5 类 × 10 条精选 demo（1.0 先发 5 条，后续补）：
 * - arch (架构冲突): 两个技术方向 / 产品路径 / 商业模型怎么选
 * - speed (极速交付): 复杂功能怎么压缩到 N 小时
 * - cognition (认知沉淀): 行业深度复盘
 * - failure (失败诊断): AI 跑偏 / 项目挫败 / 怎么纠偏
 * - crossover (跨界范式): A 行业经验降维到 B 行业
 *
 * 所有数据**人工脱敏**：无 API key / IP:port / token / 客户名 / 同事姓名。
 * 来源：mycc task-log.md + RECENT_EVENTS.md + memory/feedback_*.md 真实工作流。
 *
 * routing 是核心：访客看到 cc / codex / gemini 三引擎协同的真实节奏。
 * stage 用对访客友好的"决策链路"语言（业务逻辑定义 / 对抗审 + 决策校验 /
 * 自动化原型构建 / 战略整合 + 验收），不是技术细节。
 */

import { formatCareerExperience } from '@/lib/experience'

const careerExperience = formatCareerExperience(undefined, { spaced: true, includeDays: true })

export type DemoCategory = 'arch' | 'speed' | 'cognition' | 'failure' | 'crossover'

export interface DemoRoutingStep {
  engine: 'cc' | 'codex' | 'gemini'
  stage: string // 访客可读的"决策链路"标签
  duration_ms: number
  output_md: string // Markdown，会渲染到聊天界面
}

export interface ClassicDemo {
  id: string
  category: DemoCategory
  question: string // 访客点击的 chip 文案
  routing: DemoRoutingStep[]
  total_duration_ms: number
  featured: boolean
  quality_score: number // 0-100，前端排序用
}

export const CLASSIC_DEMOS: ClassicDemo[] = [
  // ===========================================================================
  // 1. 架构冲突案例
  // ===========================================================================
  {
    id: 'arch-01',
    category: 'arch',
    question: '做 AI 产品时，"业界流行方案"和"更适合自己的方案"怎么选？（以陈川业余项目"AI 长期记忆系统"自研路线为例）',
    routing: [
      {
        engine: 'cc',
        stage: '业务逻辑定义',
        duration_ms: 540_000,
        output_md:
          '**核心断点**：伴侣型 AI 的痛点不是"找不到历史"，是**用户关系长期沉淀不了**。模型能力在涨，但每次对话都像第一次见。\n\n两条路：\n- **向量检索路线** (mem0/Zep/LangMem)：把对话 embed 入索引，需要时召回。本质是"外部索引"，AI 自己没学。\n- **模型层学习路线**：让 AI 从对话中持续微调，把用户特征学进权重。\n\n用产品视角看：用户感受到的不是"AI 能找到我说过的话"，而是"AI 真的认识我"。这是关系型服务 vs 工具的临界点。',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 6_000,
        output_md:
          '挑刺 3 点：\n1. **CfC 在线微调可行性**：传统 LLM 微调要 GPU 集群，CfC 行不行？答：CfC（Closed-form Continuous）参数量小（百万级），消费级 GPU 几分钟训练一轮。\n2. **冷启动**：新用户怎么办？答：冷启动用通用模型，10-20 轮对话后开始增量微调。\n3. **遗忘风险**：在线微调易"灾难性遗忘"。答：用 L2 正则 + 历史 replay buffer 控。\n\n方向支持，但要 hardcode：真人验证集准确率 ≥ 85% 才算 PoC pass。',
      },
      {
        engine: 'cc',
        stage: '战略整合 + 验收',
        duration_ms: 1_200_000,
        output_md:
          '**最终判断**：选模型层学习路线，CfC + 多模态摄入 + VLM 视觉理解管线。\n\n**反向决策依据**（产品视角）：向量检索的天花板是"搜索体验"，模型层学习的天花板是"角色体验"。AI 产品的下一个跃迁是关系型服务，必须押模型层。\n\n**实测结果**：真人数据验证集准确率 **91.5%**（超过 gemini 钦定的 85% 阈值）。路线验证。',
      },
    ],
    total_duration_ms: 1_746_000,
    featured: true,
    quality_score: 95,
  },
  // ===========================================================================
  // 2. 极速交付案例
  // ===========================================================================
  {
    id: 'speed-01',
    category: 'speed',
    question: '一个用户体验 bug，4 小时内怎么从临时打补丁升级到根本解决？（以网页上的 AR HUD 交互演示卡片拖拽错位问题为例）',
    routing: [
      {
        engine: 'cc',
        stage: '业务逻辑定义',
        duration_ms: 900_000,
        output_md:
          '**根因深挖**：getBoundingClientRect 返回的是含 transform 的视觉 bbox，不是 layout rect。\n\ndragging 卡的 transform = `translate(dx,dy) scale(1.06)`，bbox.center = layout.center + (dx, dy)，含累积位移。校正 startPoint = visual_center 反复污染累积漂移。前后修了 3 个补丁（swapPending / cooldown / 反弹防护）都治不了根。\n\n**两条路**：\n- A 继续打补丁：再加一层 useLayoutEffect 校正\n- B 范式重构：deferred swap（iOS Home Screen 同款，dragging 中 layout 不变）',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 8_000,
        output_md:
          '评分 **B+**。挑出 3 真漏洞：\n1. release 无 target 时 releaseStartRect 沦为脏数据 → 下次 layout shift 误触发\n2. scale 1.06 引起 bbox.left 偏移 layoutWidth × 3% → 必须用 center-based FLIP 抵消\n3. grab 时不清 transition，上次 spring 380ms 未完成就重新 pinch 会冲突\n\n推荐方向 B（重构）。补丁路线复杂度滚雪球。',
      },
      {
        engine: 'codex',
        stage: '自动化原型构建',
        duration_ms: 180_000,
        output_md:
          '`DraggableCardWrapper.useLayoutEffect` 改造：\n- 优先消费 `store.releaseStartRect` 作 FLIP 起点（cardId 匹配时单次消费）\n- 消费后立刻 `setReleaseStartRect(null)` 防脏数据\n- 用 `centerX/centerY` 字段抵消 scale 偏移\n- fallback 到原 lastRectRef 路径\n\n禁动文件 0 触碰。tsc + build PASS。bundle +200 bytes。',
      },
      {
        engine: 'cc',
        stage: '战略整合 + 验收',
        duration_ms: 1_200_000,
        output_md:
          '**重写 use-drag-controller.ts**：删 swapPending / cooldown / 反弹防护 / useLayoutEffect 校正复杂时序，**净减 109 行**。\n\n**最终方案**：dragging 中 phudOrder 完全不变，松手才触发 onMove (splice insert 语义) + spring from 手指视觉位置 to 新 layout。\n\n部署上线 https://my.chenchuan.cc/lab/ar-hud-demo · 回退锚点 `git tag ar-hud-pre-deferred-swap`。',
      },
    ],
    total_duration_ms: 2_288_000,
    featured: true,
    quality_score: 92,
  },
  // ===========================================================================
  // 3. 认知沉淀案例
  // ===========================================================================
  {
    id: 'cog-01',
    category: 'cognition',
    question: `${careerExperience}硬科技产品（46 项专利、9 款量产产品）经验里，最关键的教训是什么？`,
    routing: [
      {
        engine: 'cc',
        stage: '业务逻辑定义',
        duration_ms: 1_500_000,
        output_md:
          '**三条主线复盘**：\n\n**1. 太阳能消费品 (2012-2015)**：阿斯顿马丁勒芒赛车 + UNHCR 路灯 + 智能集装箱。教训：技术 cool 不等于产品 work，要 **倒推用户场景**（难民营白天充电晚上照明 → 一体式防盗，不是单纯太阳能板）。\n\n**2. 智能机器人 (2015-2019)**：CES 2017 桌面助手 + SLAM 送餐机器人 + UR 机械臂冰淇淋站。教训：**具身智能的 0→1 不是算法，是商业场景**（咖啡厅老板付得起钱才有可能落地，餐饮服务比家用更稳）。\n\n**3. AR HUD (2019-)**：4 代展车 + 国内新势力 + 海外豪华品牌定点 + 46 项专利。教训：**技术降维比技术升级更值钱**（车规级光学降维到 K12 健康教育 = 第二增长曲线）。',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 7_000,
        output_md:
          '提问：三条线的共同公式是什么？\n\n回答：**「技术 × 场景倒推 × 商业闭环」三角**。任何技术都需要：\n- 场景倒推（用户真的需要 vs 工程师以为需要）\n- 商业闭环（谁付钱 / 怎么续费 / 谁推广）\n- 技术作为支撑（不是主角）\n\n反例：太阳能赛车技术 cool 但商业闭环靠勒芒赛事赞助，不可持续；机器人 CES 拿奖但量产成本卡死；只有 AR HUD 走到了三角全闭环（车厂前装定点）。',
      },
      {
        engine: 'cc',
        stage: '战略整合 + 验收',
        duration_ms: 600_000,
        output_md:
          `**一句话沉淀**：硬科技产品经理的核心是**穿越产品三角**——不是更懂技术，是同时看见技术 / 场景 / 商业三个维度，找出三者交点。\n\n**今天怎么用**：做 EvoDesk / LnMem 时不停问"这是工程师 cool 还是用户 work / 谁付钱 / 怎么续费"。\n\n下一站：AI 产品 leader 不是更会调 prompt，是把 ${careerExperience}硬科技产品三角能力迁移到 AI 原生产品。`,
      },
    ],
    total_duration_ms: 2_107_000,
    featured: true,
    quality_score: 98,
  },
  // ===========================================================================
  // 4. 失败诊断案例
  // ===========================================================================
  {
    id: 'fail-01',
    category: 'failure',
    question: '一个新产品想法，开干前怎么用"多方对抗评审"提前找到所有坑？（以你现在用的这个对话功能立项过程为例）',
    routing: [
      {
        engine: 'cc',
        stage: '业务逻辑定义',
        duration_ms: 600_000,
        output_md:
          '**方案 B 初稿**：访客 5 个经典提问 chip + 3 轮自由提问 (Gemini Flash) + 加微信引导 + ¥10/天硬熔断。\n\ncc 自己识别 10 个风险（数据质量 / 用户耐心 / 限额可绕过 / Gemini Flash 质量 / 加微信转化率 / 恶意刷量 / UI 区分 / 演化路径 / SEO 等）。\n\n但 cc 担心**有自己看不见的盲区**，派 gemini 做产品 + 商业 + 体验维度对抗审。',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 9_000,
        output_md:
          '评分 **A-**。挑出 3 个 P0 (cc 自己没看到的)：\n\n**P0-1 System Prompt 必须降维到"产品 leader"**：Gemini Flash 默认会以"AI 助手"姿态答技术琐事，访客瞬间归类为"AI 开发工程师"，定位崩塌。修复：强制"战略镜像"角色 + 拒绝教程式回答。\n\n**P0-2 预算熔断 UI 降级**：¥10 跑光后页面不能挂错误页，要切回经典回放模式保持"丰满"。\n\n**P0-3 脱敏深度检查**：mycc 日志含 proxy API key / 内部 IP / 飞书 token，必须脚本严格正则替换。',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 6_000,
        output_md:
          '继续挑 2 个 P1：\n\n**P1-1 "角色转场" 替代硬限额话术**：第 3 轮被切断 = 负面"被驱逐感"。改为 AI 主动说"通用逻辑我解释完了，深层 context 我没权限读取陈川的大脑 → 加微信继续 + 暗号 OS 访客"。\n\n**P1-2 Workflow Visualization 翻译成"决策链路"**：cc/codex/gemini 引擎名访客（猎头 / CEO）看不懂。改为"业务逻辑定义 / 对抗审 + 决策校验 / 自动化原型构建"，突出效率比不是技术细节。',
      },
      {
        engine: 'cc',
        stage: '战略整合 + 验收',
        duration_ms: 720_000,
        output_md:
          '**全部采纳 3 P0 + 2 P1**。最大学习：\n\n- **AI 自评天然过度乐观**：cc 单轮自评只识别 10 个技术风险，gemini 5 秒揭出 3 个产品 / 商业级 P0。\n- **多引擎对抗审是必修**：不是"找帮手"，是"补盲区"。CC 看技术，gemini 看产品，不同视角刚好互补。\n- **产品定位是灵魂**：System prompt 战略镜像设计是这个 demo 的灵魂，不能委托。\n\n这套对抗审范式已沉淀为 mycc feedback。',
      },
    ],
    total_duration_ms: 1_335_000,
    featured: true,
    quality_score: 96,
  },
  // ===========================================================================
  // 5. 跨界范式案例
  // ===========================================================================
  {
    id: 'cross-01',
    category: 'crossover',
    question: '车里的高端显示技术，怎么"降维"做成给孩子用的护眼产品？（FUTURUS 第二增长曲线 K12 教育硬件的来龙去脉）',
    routing: [
      {
        engine: 'cc',
        stage: '业务逻辑定义',
        duration_ms: 1_200_000,
        output_md:
          '**起点**：FUTURUS 核心是车规级 AR HUD 自由曲面光学技术，前装定点拿到国内新势力 + 海外豪华品牌。但单一汽车赛道太窄，需要找**第二增长曲线**。\n\n**降维思路**：\n- 车规级 = 安全等级最高 + 成本最贵 → 反向到消费级 = 安全等级降一档 + 成本砍 10 倍\n- AR 光学 = 把信息投到现实 → 消费级用什么场景？\n- 找用户痛点：**K12 健康教育**——孩子读书近视率 50%+，家长焦虑，但护眼硬件普遍"买了不用"\n\n**核心假设**：把 AI 能力以游戏化机制融入护眼产品，让青少年在日常使用中接触 AI、运用 AI 实现想法，从被动健康管理转为主动探索驱动。',
      },
      {
        engine: 'gemini',
        stage: '对抗审 + 决策校验',
        duration_ms: 7_000,
        output_md:
          '挑刺 3 点：\n1. **品类陌生度**：消费者认不出"AI + AR + 护眼"是什么。答：聚焦"AI 玩伴 + 护眼"双卖点，AR 隐形为支撑技术。\n2. **客单价**：K12 健康教育消费品价格带 ¥800-2000，AR 光学方案能不能压到这个区间？答：降配自由曲面参数 + 国产代工，BOM 成本可控。\n3. **依从性数据**：怎么验证"游戏化能解决买了不用"？答：原型期跑游戏化成长体系 + 双重激励留存模型 PoC。\n\n方向支持，但 PoC 必须验证"实际使用频次 > 普通护眼硬件 3x"。',
      },
      {
        engine: 'cc',
        stage: '战略整合 + 验收',
        duration_ms: 1_500_000,
        output_md:
          '**产品架构**：硬件 + AI 服务 + SaaS 数据闭环 = B2B2C\n\n- **家庭端**：硬件做日常高频使用入口\n- **专业机构侧**：累积数据形成持续干预能力 (B2B SaaS)\n- **数据复利**：硬件触达 → AI 服务 → 数据沉淀 → 反哺产品迭代\n\n**配套验证**：搭 AI 智能硬件交互原型，跑端到端语音交互链路（ASR→LLM→TTS 三段全流式，首音 ~2.1s），验证实时语音 + 游戏化留存可行性。\n\n**沉淀**：技术降维不是简化技术，是**重定位场景**——把原赛道的技术优势翻译成新赛道的产品价值。',
      },
    ],
    total_duration_ms: 2_707_000,
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
  arch: '关键决策怎么拍板',
  speed: '高压下怎么稳准狠',
  cognition: `${careerExperience}踩过的大坑`,
  failure: '立项前怎么避雷',
  crossover: '跨行业经验复用',
}
