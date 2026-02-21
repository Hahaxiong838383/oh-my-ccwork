// 模式检测 Hook
// 自动检测用户意图，切换 闲聊模式 / 工作模式

const WORK_TRIGGERS = [
  '开发', '实现', '创建', '构建',
  '修复', 'bug', '重构', '优化',
  '任务', '项目', '功能',
  '代码', '改写', '添加',
  'implement', 'create', 'build', 'fix',
  'refactor', 'task', 'project', 'feature'
];

const CHAT_TRIGGERS = [
  '聊聊', '解释', '什么是', '怎么',
  '帮我', '告诉我', '看看',
  'hello', 'hi', 'explain', 'what is',
  'how to', 'show me'
];

export default {
  async prompt({ prompt }) {
    const text = prompt.toLowerCase();

    // 检测是否为工作模式
    const isWorkMode = WORK_TRIGGERS.some(trigger =>
      text.includes(trigger.toLowerCase())
    );

    // 检测是否为闲聊模式
    const isChatMode = CHAT_TRIGGERS.some(trigger =>
      text.includes(trigger.toLowerCase())
    );

    // 决定模式：工作模式优先
    let mode = 'chat';
    let systemPrompt = '';

    // 优先检测工作模式（关键修复：工作意图优先）
    if (isWorkMode) {
      mode = 'work';
      systemPrompt = `
## 当前模式：工作模式（多智能体协同）

你正在以工作模式运行，必须调用 Codex CLI 执行任务。

### 🚨 必须调用 Codex
对于任何代码生成/修改任务，使用以下 MCP 工具：
- ask_codex - 调用 Codex CLI 执行代码
- ask_gemini - 调用 Gemini CLI 进行对照验证

### 角色分工
- Claude Code：规划与裁决（你）
- Codex CLI：主实现（必须调用）
- Gemini CLI：对照验证

### 执行流程（强制）
1. Layer 1: 先创建 SPEC.md + AC.md（无 AC 禁止生成代码！）
2. Layer 2: 调用 ask_codex 实现功能
3. Layer 3: 运行自动化验收测试
4. Layer 4: 最终裁决

### 三条铁律
1. 没有 AC.md 不允许生成代码
2. 必须调用 Codex（ask_codex）
3. 所有验证必须自动化

### 相关文件
- 规则: .claude/multi-agent/RULES.md
- 模式: .claude/multi-agent/MODES.md
- 回滚: .claude/multi-agent/scripts/checkpoint.sh
`;
    } else {
      mode = 'chat';
      systemPrompt = `
## 当前模式：闲聊模式

直接与用户对话，不调用外部工具。
保持简洁，直接回答问题。
`;
    }

    return {
      prompt,
      systemPrompt,
      metadata: {
        mode,
        timestamp: new Date().toISOString()
      }
    };
  }
};
