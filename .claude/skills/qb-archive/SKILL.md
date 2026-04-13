---
name: qb-archive
description: 把当前 Claude Code session 的记录、结论、分析、总结、讨论产出归档到飞书 Queen brain 知识库（https://futurus.feishu.cn/wiki/ENIFwz1z6iYwACkSTlDcKcSunPg）。按知识库规则自动分类写入 2-Wiki 百科实体 / 3-笔记与文章 / 1-Inbox 对话剪藏 对应子目录。自然语言触发词：归档本次会话、归档这次 session、归档当前对话、把这次讨论存到知识库、沉淀到 brain、沉淀到 Queen brain、存到飞书知识库、把结论存档、把分析归档、把总结入库、写入 Queen brain、存档 session、知识归档、这段对话值得留下、把刚才的结论保存、归档到 qb、archive to qb
layer: 执行层
authorization: B区（需用户确认目标位置再写入）
output_levels: L2（分类理由 + 写入链接）
---

# qb-archive — Queen brain 会话归档

> 把当前 Claude Code session 的产出按 Queen brain 知识库规则归档到飞书。
> 知识库入口：https://futurus.feishu.cn/wiki/ENIFwz1z6iYwACkSTlDcKcSunPg

## 触发时机

**自然语言识别以下意图**（不限于原字眼，语义等价即可）：

- "归档本次会话 / 这次 session / 当前对话"
- "把这次讨论/结论/分析/总结存到知识库"
- "沉淀到 brain / Queen brain / qb"
- "存到飞书 / 写入知识库 / 归档到飞书"
- "这段对话值得留下 / 保存这次结论"
- "入库 / 存档 / 沉淀" + 指向 session 内容的上下文
- 兼容显式命令："/qb-archive"、"qb archive"、"archive to qb"

**不要触发**（容易误判）：

- 用户说的是别的 repo 的 "归档代码" → 用 git archive
- 用户说的是 "/decision" 决策记录 → 用 decision skill
- 用户说的是发飞书群通知 → 用 tell-me skill

## 核心流程

### Step 1：分析当前 session 的产出

扫描最近的对话上下文，识别：

- **主题**：一句话能说清楚这次讨论的是什么吗？
- **产出类型**：结论 / 方法论 / 研究报告 / 概念整理 / 实体百科 / 纯讨论碎片？
- **涉及实体**：出现了哪些值得做成 Wiki 页面的概念/人物/技术？
- **完成度**：有明确结论还是开放问题？

### Step 2：按决策树选择目标节点

```
本次 session 的主要产出是……
│
├─ 完整结论 + 一篇长文的雏形（观点类/随笔）
│   └─→ 3-笔记与文章 / 长文与随笔 Essays
│       token: LtJtwcNCbiF1OIkL4BIcHo2cnPC
│
├─ 对某个主题的深度调研（多方论证 + 参考资料）★ 默认候选
│   └─→ 3-笔记与文章 / 研究整理 Research
│       token: VMciwg8OZikRRkkTanIcNmdOnug
│
├─ 对一本书的完整理解
│   └─→ 3-笔记与文章 / 读书笔记 Book Notes
│       token: EmASweCwFionZNk7xI0cRytUngf
│
├─ 对一个"概念/理论"的 llmwiki 风格实体整理
│   └─→ 2-Wiki / 概念与理论 Concepts
│       token: P5OswIpfKiyQG7k03wlcpNBrndf
│
├─ 对一个人物/组织的整理
│   └─→ 2-Wiki / 人物与组织 People & Orgs
│       token: FtbnwpOpGih0jAkjFsDcQrVOnQf
│
├─ 对一种技术/工具/方法的整理
│   └─→ 2-Wiki / 技术与方法 Tech & Methods
│       token: Kl8fwvSG7iyOnKk2INQc37bknpg
│
├─ 一段精彩但零散的对话片段（没结论，但值得留下）
│   └─→ 1-Inbox / 对话剪藏 Conversations
│       token: RLNJwyo49iAtAFkPevkcsE8Cn0g
│
└─ 一句话灵感 / 碎片想法
    └─→ 1-Inbox / 灵感速记 Ideas
        token: MHqowATTTis08GkmkwLcyynjnPb
```

### Step 3：向用户确认目标

**不要自作主张直接写入**。展示推荐并等用户一个词确认：

```
📝 准备归档本次 session：

标题：{你生成的标题}
目标：{目标节点路径}
理由：{一句话为什么选这里}

预览（前 200 字）：
{内容开头摘要}

确认？(yes / 换成 X / 取消)
```

如果用户想换节点，接受切换并重新格式化。

### Step 4：按模板格式化内容

根据目标节点选对应模板（见下方"模板库"），填充 session 内容。

**格式化原则**：
- 保留原始论证和关键细节，不过度压缩
- 提取涉及的实体，用 `[[实体名]]` 交叉引用
- 保留时间戳和来源（标注 "Claude Code session"）
- 必须附 CLAUDE.md 要求的署名

### Step 5：用 lark-cli 写入飞书

```bash
lark-cli docs +create \
  --title "{标题}" \
  --wiki-node {目标节点 token} \
  --markdown "$(cat /tmp/qb-archive-{timestamp}.md)" \
  --as user
```

**建议**：先把内容写到 `/tmp/qb-archive-{timestamp}.md`，再用 `cat` 喂给 `--markdown`，避免 shell 转义问题。

### Step 6：后续同步

根据目标节点类型执行额外动作：

| 目标 | 额外动作 |
|---|---|
| 2-Wiki/* 任何子目录 | 追加一条到 **Wiki 索引 MOC**（token: `FaQJwuaILiw8gaku4fhcmiCbn9d`）对应分类下 |
| 新实体有别名 | 追加一行到 **术语表**（token: `G5G9wsQVAitfZLkXwXEcL1DTnkb`） |
| 大任务（产出重要） | 追加到 `/Users/rayman.chen/mycc/0-System/task-log.md` |
| 任何 | 追加一行到 `/Users/rayman.chen/mycc/0-System/RECENT_EVENTS.md` |

### Step 7：返回给用户

```
✅ 已归档到 Queen brain
标题：{标题}
位置：{目标节点路径}
链接：{飞书 wiki URL}

{如果是 Wiki 实体}
已同步更新 Wiki 索引 MOC。
{如果更新了术语表}
已新增别名：{别名 → 规范名}
```

---

## 节点 token 速查表（hardcoded）

| 目标 | wiki-node token | 归档类型 |
|---|---|---|
| 3-笔记与文章/长文与随笔 | `LtJtwcNCbiF1OIkL4BIcHo2cnPC` | 观点随笔 |
| 3-笔记与文章/研究整理 ★ 默认 | `VMciwg8OZikRRkkTanIcNmdOnug` | 深度调研 |
| 3-笔记与文章/读书笔记 | `EmASweCwFionZNk7xI0cRytUngf` | 读书笔记 |
| 2-Wiki/概念与理论 | `P5OswIpfKiyQG7k03wlcpNBrndf` | 概念实体 |
| 2-Wiki/人物与组织 | `FtbnwpOpGih0jAkjFsDcQrVOnQf` | 人物实体 |
| 2-Wiki/技术与方法 | `Kl8fwvSG7iyOnKk2INQc37bknpg` | 技术实体 |
| 1-Inbox/对话剪藏 | `RLNJwyo49iAtAFkPevkcsE8Cn0g` | 碎片对话 |
| 1-Inbox/灵感速记 | `MHqowATTTis08GkmkwLcyynjnPb` | 零散想法 |
| 0-导航/Wiki 索引 MOC | `FaQJwuaILiw8gaku4fhcmiCbn9d` | 索引更新 |
| 0-导航/术语表 | `G5G9wsQVAitfZLkXwXEcL1DTnkb` | 别名更新 |

**知识库 space_id**：`7627104320944622530`
**知识库根节点**：`ENIFwz1z6iYwACkSTlDcKcSunPg`

---

## 模板库

### T1：3-笔记与文章/长文与随笔 Essays

```markdown
# {标题}

> 来源：Claude Code session · {YYYY-MM-DD}
> 归档时间：{ISO 时间}

## 摘要
{2-3 句话总结核心论点}

## 主要内容
{完整叙述，保留关键论证和案例}

## 关联实体
[[实体A]] [[实体B]]

## 延伸思考
{session 末尾的 open questions 或 TODO}

---
署名：cc（Claude claude-sonnet-4-6）| {完成时间}
```

### T2：3-笔记与文章/研究整理 Research ★ 默认

```markdown
# {研究主题}

> 来源：Claude Code session · {YYYY-MM-DD}
> 归档时间：{ISO 时间}

## 研究问题
{session 要回答的核心问题}

## 调研方法
{信息来源 / 分析过程}

## 核心发现
1. {要点 1}
2. {要点 2}
3. {要点 3}

## 详细论证
{展开每个要点的论证链}

## 结论
{最终结论}

## 参考资料
- {session 里提到的链接 / 文档}
- [[其它 Wiki 实体]]

## 延伸问题
{需要进一步研究的问题}

---
署名：cc（Claude claude-sonnet-4-6）| {完成时间}
```

### T3：2-Wiki/{子分类} — llmwiki 实体页

```markdown
# {实体名}

> 别名：[[别名1]] [[别名2]]
> 最后更新：{YYYY-MM-DD}
> 来源：Claude Code session · {简述}

## 一句话定义
{可独立理解的一句话}

## 详细说明
{连贯叙述，不限长度}

## 关键点
- {要点 1}
- {要点 2}
- {要点 3}

## 关联
[[实体A]] [[实体B]] [[实体C]]

## 来源
- Claude Code session: {简述}
- {其它来源}

---
署名：cc（Claude claude-sonnet-4-6）| {完成时间}
```

### T4：1-Inbox/对话剪藏 Conversations

```markdown
# {YYMMDD}-{对话主题}

- **对话对象**：Claude (claude-sonnet-4-6)
- **时间**：{YYMMDD}
- **平台**：Claude Code CLI

## 对话内容
{保留原对话的核心部分，多轮结构}

## 为什么保留
{一两句话说明这段的价值}

---
署名：cc（Claude claude-sonnet-4-6）| {完成时间}
```

### T5：1-Inbox/灵感速记 Ideas

```markdown
# {YYMMDD}-{一句话主题}

> 来源：Claude Code session · {ISO 时间}

{核心想法}

---
署名：cc（Claude claude-sonnet-4-6）| {完成时间}
```

---

## 铁律（不可违反）

1. **先分析再写**：必须先识别主题类型，再决定目标节点
2. **必须让用户确认**：不自作主张直接写入（除非用户明确说 "直接归档到 X"）
3. **不过度改写**：保留 session 里的原始论证和表达，不要过度压缩
4. **遵循模板**：每种目标类型有固定模板，不要自创
5. **署名规范**：按 mycc/CLAUDE.md 要求附署名（`cc（Claude claude-sonnet-4-6）| 时间`）
6. **完成后同步元数据**：重要产出要更新 task-log 和 RECENT_EVENTS
7. **Wiki 实体必须双写**：2-Wiki 实体页写完后，必须同步更新 Wiki 索引 MOC

---

## 和其它 skill 的边界

| skill | 做什么 | 和本 skill 的区别 |
|---|---|---|
| `lark-wiki` | 管理 wiki 节点（增删查改） | 原子 API，本 skill 是上层编排 |
| `lark-doc` | 创建/读取/更新飞书文档 | 原子 API，本 skill 调用它 |
| `decision` | 项目决策记录到本地 md | 本地文件，本 skill 写远程飞书 |
| `tell-me` | 发飞书群聊通知 | 群聊消息，不是知识库 |
| `brain-review` | brain 项目纲领对齐自检 | 读本地 brain 项目，本 skill 写远程知识库 |

**本 skill 是 workflow skill**，编排 `lark-doc +create` + 分类规则 + 模板 + 同步索引。

---

## 失败处理

| 失败 | 处理 |
|---|---|
| lark-cli 未授权 | 让用户跑 `lark-cli auth login --scope "wiki:wiki docx:document"` |
| 网络超时 | 把内容保存到 `/tmp/qb-archive-{timestamp}.md` 让用户手动处理 |
| 权限不足 | 提示用户确认飞书知识库编辑权限 |
| 不确定目标节点 | **必须**询问用户，不允许默认 |
| shell 转义错误 | 改用 `/tmp/*.md` + `cat $(...)` 方式 |

---

## 示例：完整一次归档

**用户**："把这次关于 brain 闭环设计的讨论归档到知识库"

**cc 响应**：

```
📝 准备归档本次 session：

标题：brain 外挂知识库的闭环复利机制设计
目标：3-笔记与文章 / 研究整理 Research
理由：涉及多角度论证（llmwiki 理论 + brain 架构 + 实施路径），属于深度调研产出

预览（前 200 字）：
> 本次 session 讨论了 mycc-brain 如何借鉴 Karpathy llmwiki 的知识复利理念，
> 设计一条从飞书知识库到 brain memory.db 的闭环管线。核心发现是原方案缺失
> "反向索引"（knowledge-gap），这是复利能否成立的关键……

涉及实体（会加交叉引用）：
[[mycc-brain]] [[llmwiki]] [[knowledge-gap]] [[entity-resolver]]

确认？(yes / 换到 2-Wiki/概念与理论 / 取消)
```

**用户**："yes"

**cc 执行**：
1. 写 `/tmp/qb-archive-{ts}.md`
2. `lark-cli docs +create --wiki-node VMciwg8OZikRRkkTanIcNmdOnug --title "..." --markdown "$(cat ...)"`
3. 成功后返回 `doc_url`
4. 追加一行到 `mycc/0-System/RECENT_EVENTS.md`
5. 追加一行到 `mycc/0-System/task-log.md`
6. 如果有未归一的新别名，更新术语表

**cc 最终回复**：

```
✅ 已归档到 Queen brain
标题：brain 外挂知识库的闭环复利机制设计
位置：3-笔记与文章 / 研究整理
链接：https://futurus.feishu.cn/wiki/xxxxxxxxx

已同步：
- RECENT_EVENTS.md +1 行
- task-log.md +1 行
```

---

署名：cc（Claude claude-sonnet-4-6）| 2026-04-10
