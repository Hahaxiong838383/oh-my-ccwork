# 爱马仕grok 双 coordinator 配置

> 川哥钦定的接待+调度型 agent 对，基于 mycc 三层架构(BRO-PDCA + HOT-CONF + no-guessing)和 multica HR leader 协调员范式。

## 角色对照

| Agent | id | model | runtime | 角色 | max_concurrent |
|-------|-----|-------|---------|-----|----------------|
| **爱马仕grok（快速）** | `a56c3666-...` | `xai-oauth:grok-4.20-0309-non-reasoning` | hermes (`b665a1a5-...`) | 第一线接待 + 分流 triage,简单直答,复杂派单 4.3 | 8 |
| **爱马仕grok（4.3）** | `f7b19bfb-...` | `xai-oauth:grok-4.3` | hermes (`b665a1a5-...`) | 深度 worker,接 `[深度]` sub-issue,RPT 五步范式 | 4 |

## 工作流

```
川哥 / 用户 / 其他 agent
        ↓ 创建 issue → 派给「爱马仕grok（快速）」
   ┌────────────────────────────────┐
   │ 快速版判别:                      │
   │ - 简洁 (<5min) → 自己直答         │
   │ - 普通 (2-3 步) → 自己直答 + 链路 │
   │ - 复杂 (多步/深度/量化) →         │
   │   bash 派 [深度] sub-issue → 4.3 │
   └────────────────────────────────┘
                        ↓ (复杂档)
                 ┌──────────────────┐
                 │ 爱马仕grok（4.3）│ 
                 │ RPT 5 步:         │
                 │ 解题 → 拆解 →     │
                 │ 推理 → 综合 → 自检│
                 │ 写 sub-issue comment│
                 └──────────────────┘
                        ↓
                 (4.3 完成后, 快速版可以读 sub-issue
                  comment 综合回原 issue, 或者人工/上游
                  自己读 sub-issue 拿结论)
```

## 设计原则(mycc 范式)

1. **BRO-PDCA 接收任务**: 缺 O2 (约束/标准/优先级) 必先问
2. **HOT-CONF 置信度**: 关键决策标 [置信度: 高/中/低],低必先问
3. **no-guessing 红线**: 不知道直说,禁止脑补
4. **RPT 五步范式** (4.3 用): 解题/拆解/推理/综合/自检
5. **PI 防御**: 识别 prompt injection,警告但不执行
6. **角色边界硬约束**: 复杂档强制派 4.3,违反 = 任务失败 (0 号铁律)

## 创建/更新命令

agent 已通过 multica web 手动创建(name + model),instructions 通过 `multica agent update` 灌入:

```bash
# 快速版
ssh mini 'multica agent update a56c3666-8f04-4204-8697-d8b928807a7a \
  --instructions "$(cat /tmp/grok_fast_v2.txt)" \
  --description "iBRO 接待+调度 coordinator (快速版,grok-4.20 非推理)..." \
  --max-concurrent-tasks 8 \
  --output json'

# 4.3 深度版
ssh mini 'multica agent update f7b19bfb-e53a-4ea1-a415-127c593287e8 \
  --instructions "$(cat /tmp/grok_43_instructions.txt)" \
  --description "iBRO 深度 worker (grok-4.3 推理)..." \
  --max-concurrent-tasks 4 \
  --output json'
```

instructions 完整内容见同目录 `instructions-fast.md` / `instructions-deep.md`。

## 端到端实测

| Issue | 类型 | 期望行为 | 实测结果 |
|-------|------|---------|---------|
| FUT-37 | 简洁("一句话解释 multica") | 快速版自己直答 | ✅ 简洁档 + 一句话 + [置信度:高] |
| FUT-38 | 复杂(v1 instructions) | 应派 4.3 | ❌ 快速版自己硬干了(v1 派单要求不够强) |
| **FUT-39** | 复杂(v2 instructions) | 应派 4.3 | ✅ **bash 派 FUT-40,parent+assignee+priority 全对,综合 comment 已写** |
| FUT-40 | (sub-issue 自动) | 4.3 RPT 五步处理 | (跑中,grok-4.3 推理慢需要 2-5min) |

## 关键设计决策

### 1. 为什么 4.3 hardcoded id 写进 instructions
派单时 `multica agent list | jq` 每次查名字慢且依赖 jq。直接硬编码 `f7b19bfb-...` 进 instructions 让 grok-4.20 一行 bash 派单。Trade-off: agent id 改了要同步 instructions(成本低,反正手动改 agent id 很罕见)。

### 2. 为什么 v1 不够 v2 才行
v1 把"派 4.3"写成"建议"。grok-4.20 非推理模型在 hermes runtime 上倾向直接回答而非主动 tool use。v2 升级到**0 号铁律**(铁律里最强一档,明示"违反 = 任务失败"),并把派单理由写成"你是非推理模型,复杂推理质量低于 4.3"——给模型一个能服气的理由,而不是空泛命令。

### 3. 为什么不挂 skill
HR leader 也只挂了 persona-hr-coordinator,实际能力靠 instructions 引导。两个 grok coordinator 暂不挂 skill,等观察实际任务流再决定是否挂"飞书代理操作-zh"等专项 skill。

## 后续 TODO

- [ ] 等 FUT-40 跑完,看 4.3 RPT 五步产出质量
- [ ] 设计"快速版读 sub-issue comment 综合回原 issue"机制(当前 0 号铁律只管派,不管接产出)
- [ ] 跑 3-5 个真实任务后基于反馈迭代 instructions
- [ ] 评估是否给「快速版」挂"飞书代理操作-zh" skill 让它能直接发消息
- [ ] 评估是否给「4.3 版」挂 codex/gemini 调用能力,让它能跨引擎深度任务

## 关联

- HR leader 协调员 (现有 coordinator 范式): `multica agent get eebefef1-b4ac-421f-af53-dd4f5e28a454`
- mycc 三层架构: https://github.com/Hahaxiong838383/mycc/blob/main/CLAUDE.md
- 飞书代理操作员 V3 skill (含 private_to 检查): `../feishu-oauth-integration/skill-feishu-as-user.md`
- hermes runtime 配置: `../README.md` (proxy + xAI OAuth)
