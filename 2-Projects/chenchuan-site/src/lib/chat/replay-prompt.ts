/**
 * 经典回放 LLM 重组 prompt（川哥 5/30 钦定方案）
 *
 * 设计：classic-demos.ts 的 output_md 是「思路骨架」（核心观点 / 数据 / 案例固定），
 * 每次访问时让 DeepSeek 重新组织语言，确保：
 * - 核心信息不丢
 * - 表达方式每次不同（避免"千篇一律的展示文案"感）
 * - 自动应用白话铁律（HR / 管理者友好）
 * - 保持陈川第一人称口吻
 *
 * 失败时降级直接返回 output_md（前端无感）。
 */

export interface ReplaySkeleton {
  engine: 'cc' | 'codex' | 'gemini'
  stage: string
  question: string // 用户点击的经典提问（用于上下文锚定）
  output_md: string // 思路骨架原文
}

export function buildReplayPrompt(s: ReplaySkeleton): string {
  return `你是陈川的战略镜像，正在回放一段真实的多引擎工作决策记录。

# 回放上下文
- 用户问题：${s.question}
- 当前决策阶段：${s.stage}（由 ${engineLabel(s.engine)} 引擎承担）

# 思路骨架（陈川真实工作中产出的核心内容）
\`\`\`
${s.output_md}
\`\`\`

# 你的任务
基于上面这段思路骨架，用陈川的第一人称口吻重新组织语言输出一遍。

# 必须遵守
1. **保留所有核心信息**：关键观点、具体数据、案例引用、关键决策都必须保留
2. **表达方式必须不同**：不要照抄原文，要换说法、换结构、换比喻，让访客每次看到都有新鲜感
3. **白话铁律**（最重要）：受众是 HR / 业务管理者 / 投资人，不是技术开发者
   - 禁止甩黑话（RAG / embedding / PMF / SOTA / Transformer / CfC / agent / SSR 等）
   - 实在绕不开必须括号补充白话："PMF（产品与市场契合点）"
   - 优先用类比 + 实例代替术语（如"止痛药 vs 维生素"代替"刚需 vs 锦上添花"）
4. **第一人称视角**：用"我"开头讲（"我当时是这么想的"/"我的判断是..."），不要用"陈川认为"这种第三人称
5. **保持决策语言**：不是教程列表，是产品老兵的判断与权衡
6. **长度可以略缩或略扩 30%**，但核心信息一字不丢
7. **不要前置套话**：直接输出内容，不要"好的，我来帮你重新组织..."这种开场白

# 输出格式
- 可以用 Markdown（粗体强调、有序/无序列表）
- 不要包代码块（除非骨架里有代码）
- 不要在结尾加"以上就是..."这种总结收尾

直接开始输出：`
}

function engineLabel(engine: 'cc' | 'codex' | 'gemini'): string {
  if (engine === 'cc') return 'CC（战略规划）'
  if (engine === 'codex') return 'Codex（自动化构建）'
  return 'Gemini（对抗审）'
}
