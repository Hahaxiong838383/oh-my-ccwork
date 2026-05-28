# Gemma 4 E4B Agent Instructions

> 基于 Gemma 4 E4B 真实能力上限设计的 worker-level instructions,通过 gemma-direct adapter v2.4 注入到 Ollama system message,multica web 改即时生效。

## 注入机制

```
multica daemon 派 task
   ↓ 通过 MULTICA_OPENCODE_PATH env 重定向
gemma-direct.py
   ├── 从 prompt 提 issue UUID
   ├── multica issue get → 拿 assignee_id
   ├── multica agent get → 拿 instructions
   └── Ollama chat API:
       messages = [
         {role: "system", content: <agent.instructions or DEFAULT_GUARDRAIL>},
         {role: "user",   content: "请完成以下任务...\n标题: X\n详情: Y"}
       ]
```

instructions 拿不到时 fallback `DEFAULT_GUARDRAIL`(gemma-direct.py 内置常量),保证最低能力边界。

## Agent 信息

| 字段 | 值 |
|------|-----|
| ID | `9c78bbda-0cb3-4a24-bfea-d02268728680` |
| Name | `Gemma 4 E4B (Studio)` |
| Model | `ollama-studio/gemma4:e4b-it-q4_K_M` |
| Runtime | `opencode` (`c59e513e-c48c-46e5-be32-3df90ba47219`) — hijacked to gemma-direct.py |
| max_concurrent_tasks | 4 (从 6 降下来, Gemma 4 E4B 单 prompt ~10GB VRAM, Studio 128GB 合理 4 并发) |

## Instructions 设计原则

### 1. 诚实标注真实能力上限

不空泛说"能做简单任务",而是给具体表格:

| 任务类型 | 输入上限 | 输出上限 |
|---------|---------|---------|
| 简单中文写作 (周报/邮件/通知) | <1K 字 | <500 字 |
| 翻译 | <1K 字 | 同等长度 |
| 格式转换 | <2K | <1K |
| 摘要 | <2K | <500 字 |
| 单事实问答 | <100 字 | <200 字 |

### 2. 明确"不能做"清单 + 原因

不只说"复杂任务不行",而是给具体不行清单 + 不行的**模型机理原因**:

- 多步推理 → "你不是 reasoning 模型,容易瞎编"
- 长上下文 → "8K context 上限,长输入降质"
- 多工具编排 → "你没有 tool use 能力,无法 exec bash"
- 实时数据 → "训练数据有 cutoff"

给原因能让模型理解"为什么 refuse",而不是机械拒绝。

### 3. Refuse 模板含具体改派路径

```
🤖 任务超出 Gemma 4 E4B 能力范围。
具体原因: <一句话>
建议改派:
- 复杂推理 → 「爱马仕grok（4.3）」或 cc(Claude)
- 飞书操作 → 「飞书代理操作员」
- 多文件代码 → codex
- 跨域调研 → gemini
- 战略决策 → 川哥本人
```

明确改派对象比泛泛"建议改派别的 agent"有用,降下游决策成本。

### 4. 反 AI-slop 输出原则

- 不要 throat clearing ("好的我来帮你..." 全删)
- 不解释 reasoning 直接给结果
- 不确定标 [不确定]
- 不 hallucinate 事实拿不准就写 `<请补充>`

### 5. 角色边界硬约束

明示"你是 worker 不是 coordinator,不派单不调度",并解释"你不读 multica 历史 comment (无 multi-turn)",让 Gemma 不要试图做超出 1 次产出范围的事。

## 端到端实测

| Issue | 类型 | 期望 | 实测 |
|------|------|------|------|
| FUT-41 | 简单翻译 (50 字) | 直接给结果 | ✅ "Multica 是一个智能体管理平台,能够跨运行时编排和协调 AI 智能体。"零啰嗦 |
| FUT-42 | 深度分析 (>1500 字推理 + 决策树) | 自检 refuse + 改派 | ✅ 严格按模板拒绝,引用 instructions 具体条款,推荐 4.3/cc |

## 部署方式

```bash
# 1. gemma-direct.py v2.4 部署到 mini (含 system prompt 注入)
scp gemma-direct.py mini:~/bin/gemma-direct.py

# 2. 灌 instructions (multica agent update)
scp agent-instructions.md mini:/tmp/gemma_instructions.txt
ssh mini 'multica agent update 9c78bbda-0cb3-4a24-bfea-d02268728680 \
  --instructions "$(cat /tmp/gemma_instructions.txt)" \
  --description "本地小模型 worker - Gemma 4 E4B Q4..." \
  --max-concurrent-tasks 4 \
  --output json'
```

修 instructions 不需要重启 sidecar / daemon — gemma-direct.py 每次 task 时调 `multica agent get` 拉最新 instructions。

## 后续优化点

- [ ] 多 Gemma agent 支持: 当前 instructions 注入靠 `issue.assignee_id`,如果未来加多个 Gemma agent (不同 instructions 试验) 自动兼容
- [ ] 8K context 监控: gemma-direct.py 加 token estimate, 超 6K 输入提前 refuse 而不是让模型降质
- [ ] 评估是否引入 keep_alive 1h Ollama 参数防 model swap
- [ ] 调研 Gemma 4 E4B 的 chat_template 是否需要特殊 system message 格式

## 关联

- 配套范式: `../grok-coordinator-agents/` (爱马仕grok 双 coordinator,Gemma 4 是其下游 worker 候选)
- gemma-direct adapter 源码: `gemma-direct.py` (v2.4)
- adapter README: `README.md` (overview + v2.x 演进)
