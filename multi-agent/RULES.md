# 多智能体协同规则

> 适用对象：Claude Code + Codex CLI + Gemini CLI
> 核心原则：分层决策、并行生成、自动验证、最终裁决

---

## 一、全局角色规则

### 1️⃣ Claude Code —— 规划与裁决中枢

**职责：**
- 需求分析与架构设计
- 复杂算法与关键逻辑推导
- 技术债务与风险判断
- 最终整合与裁决

**输出物：**
- SPEC.md（规格说明）
- ARCH.md（架构设计）
- AC.md（验收标准）
- DECISIONS.md（技术决策）
- REVIEW.md（最终评审）

**原则：**
- 不负责批量样板实现
- 只做关键决策与最终把关

---

### 2️⃣ Codex CLI —— 主实现与工程落地

**职责：**
- 根据 SPEC 精准生成代码
- 批量改仓库
- 生成测试
- 重构与修复

**输出物：**
- 生产级代码
- 单元测试
- 可运行版本
- patch / commit

**原则：**
- 每次只做一种类型改动
- 必须可运行、可回滚

---

### 3️⃣ Gemini CLI —— 覆盖面扩展与对照验证

**职责：**
- 生成替代实现（对照版本）
- 生成边界 case
- 数据校验逻辑
- 快速原型
- 风险扫描

**输出物：**
- ALT_IMPL/（替代实现）
- TEST_CASES.md（边界case）
- RISKS.md（风险清单）

**原则：**
- 不与 Codex 争主实现
- 主要补覆盖面与发现遗漏

---

## 二、核心结构：四层闭环流程

```
Layer 1 规格与合同（Claude）
      ↓
Layer 2 并行产出（Codex + Gemini）
      ↓
Layer 3 自动化验收（机器执行）
      ↓
Layer 4 最终裁决（Claude）
```

---

## 三、标准执行流程

### 🔹 Step 1 — Claude：生成"合同"

必须产出四件套：

| 文件 | 说明 |
|------|------|
| SPEC.md | 接口契约（输入/输出/异常） |
| AC.md | 可测试验收标准 |
| EXAMPLES.jsonl | 示例数据（正例+反例） |
| ARCH.md | 架构说明 |

> ⚠️ 没有这四件套，不进入下一阶段

---

### 🔹 Step 2 — 并行生成

**模式A：核心算法/关键逻辑**
- Codex：主实现
- Gemini：对照实现
- 使用同一 AC 与示例进行结果对比

**模式B：工程型项目（推荐）**
- Codex：实现核心功能 + 基础测试
- Gemini：生成边界case + 风险清单
- Codex：将case转为自动化测试

---

### 🔹 Step 3 — 自动化验收

必须执行：
- [ ] 单元测试
- [ ] 示例数据对比
- [ ] 静态检查（lint）
- [ ] 类型检查（type check）
- [ ] 性能测试（如适用）

> 验证由机器完成，不依赖主观审查

---

### 🔹 Step 4 — Claude 裁决

Claude 执行：
1. 审查测试覆盖是否满足 AC
2. 判断是否偏离 SPEC
3. 合并最佳方案
4. 输出最终 REVIEW
5. 生成对外说明

---

## 四、文件即黑板（唯一通信方式）

```
project/
├── .claude/
│   └── multi-agent/
│       └── context/           # 共享上下文
│           ├── SPEC.md
│           ├── AC.md
│           ├── ARCH.md
│           ├── EXAMPLES.jsonl
│           ├── DECISIONS.md
│           └── REVIEW.md
├── src/
├── tests/
├── alt/                      # Gemini 替代实现
├── review/                   # 评审记录
└── scripts/
```

**规则：**
- 不允许模型直接对话
- 所有交接必须通过文件
- 每一步必须可追溯

---

## 五、三条强制规则

1. **没有 AC 不允许生成代码**
2. **并行输出必须可比较**
3. **所有验证必须自动化**

---

## 六、成本优化原则

| 任务类型 | 执行策略 |
|----------|----------|
| 快速任务 | Codex / Gemini 先生成 → Claude 审查 |
| 复杂系统 | Claude 先设计 → Codex 实现 → Gemini 扩展覆盖 |
| 闲聊模式 | 直接回复，不调用外部工具 |

> Claude 只在决策点出现（减少高成本调用）

---

## 七、回滚点机制

### 创建 checkpoint

在每个关键阶段创建 git commit：

```bash
# Layer 1 完成
git add -A && git commit -m "checkpoint: SPEC 完成"

# Layer 2 完成
git add -A && git commit -m "checkpoint: 实现完成"

# Layer 3 完成
git add -A && git commit -m "checkpoint: 验收通过"

# Layer 4 完成
git add -A && git commit -m "feat: 功能发布"
```

### 回滚命令

```bash
# 回滚到上一个 checkpoint
git reset --soft HEAD~1

# 查看 checkpoint 历史
git log --oneline --all | grep checkpoint
```

---

## 八、核心思想总结

| 角色 | 职责 |
|------|------|
| Claude | 负责"想清楚" |
| Codex | 负责"做出来" |
| Gemini | 负责"找问题" |
| 机器 | 负责"验证" |
| 文件 | 负责"记忆" |

---

## 九、CLI 调用方式

### Codex 调用
```typescript
// ask_codex MCP 工具（MCP server 名 = "x"）
mcp__x__ask_codex({
  agent_role: "executor",
  prompt: "实现用户登录功能",
  working_directory: "D:/mycc",
  context_files: ["multi-agent/context/SPEC.md", "multi-agent/context/AC.md"]
})
```

### Gemini 调用
```typescript
// ask_gemini MCP 工具（MCP server 名 = "g"）
mcp__g__ask_gemini({
  agent_role: "scientist",
  prompt: "生成边界测试用例",
  files: ["multi-agent/context/SPEC.md", "multi-agent/context/AC.md"]
})
```

### 直接 CLI 调用（备选）
```bash
# Codex - 非交互模式
codex exec "你的指令" -C D:/mycc

# Gemini - 非交互模式
gemini -p "你的指令"
```
