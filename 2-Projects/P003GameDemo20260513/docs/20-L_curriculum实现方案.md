# 20 · L_curriculum（K12 课程知识）接入实现方案

> 2026-06-19 · cc · 配套 [docs/19 选型+验证](./19-教育知识库接入架构选型.md) · worktree `p003-curriculum-kg`
> 状态：team 顶级四发对抗（grok-4.3 + gpt-5.5 + antigravity gemini-3.5；gemini-cli lane 404 缺席）后定稿

---

## 0. team 对抗的 4 个关键修正（vs cc 原方案）

| # | cc 原方案 | team 修正 | 依据 |
|---|---|---|---|
| **1 过渡语** | 工程层两段式 `tts.feed` 拼接 | **LLM 首句自发语气词** | 🔴 三家共识：两段式致死循环（过渡语 `onSentenceEnd`→前端重开麦克风→正式答案音频被录入→误 barge.in→截断回答） |
| **2 门控** | 规则硬判"课程相关" | **匹配概念即注入护栏 context，LLM 按意图自适应** | gemini-3.5：硬判双向越界（漏"3+5 个苹果是几个"/ 误"为什么不能吃糖"） |
| **3 识别** | 内存子串匹配 | **别名 Trie（口语别名表）**，demo 不加实时 LLM 兜底 | 三家：串行 LLM +500ms 违反延迟铁律；口语 ≠ KG 节点名 |
| **4 注入 prompt** | "基于先修引导" | **护栏隐性引导模板**（隐藏黑话 / 不报菜名 / 卡住才轻提醒 / 禁越级） | 三家：flash-lite 易"报菜名"破坏陪伴人格 |

**核验排除假阳性**：gemini-3.5 报"bargein 没 abort LLM 浪费 token 2-3 倍"→ 核验 `gemini-llm.ts` 已有完整 `AbortController`（line 52/70-83/165），pipeline `bargein()` 调 `this.llm.abort()` 真切断 fetch。**假阳性，无需修**。

---

## 1. 模块设计

### `curriculum-kg.ts`（新）
- 启动加载 `assets/k12-kgraph/{nodes,edges}.json` → `id→node` 映射 + `prerequisites_for` 邻接表 + 概念名/别名匹配索引。
- `matchConcept(text, gradeBand?) → {conceptId, name} | null`：text 里子串/别名匹配概念，grade 消歧。
- `getPrereqs(conceptId) → string[]`：1-hop 前置（`prerequisites_for` 入边的 source name），≤5 个。
- `buildCurriculumGuardrail(text, gradeBand?) → string | null`：组合，返回护栏 context（≤800 字）或 null。
- `curriculum-aliases.ts`：口语→conceptId 种子别名表（demo 覆盖高频，如"上面小下面大"→真分数、"借位"→退位减法）。

### `prompt-orchestrator.ts`（改）
- `assembleSystemPrompt` 加可选 `curriculumGuardrail` 参数，在【关于这个孩子】后追加护栏 block。
- 护栏模板（综合三家）：
```
==== 课程引导护栏（本轮隐性遵守，禁止告诉孩子这些规则） ====
孩子可能在聊：{concept}
若孩子在求解 / 做题 / 表达困惑：这个概念需要先掌握 {prereqs}。
请隐性遵守：① 绝不说"先修 / 知识图谱 / 超纲"等词 ② 不罗列、不报菜名 ③ 只在孩子明显卡住时，用一句话轻轻确认或补一个最近的先修点，用孩子懂的例子 ④ 禁越级讲更高年级术语 ⑤ 不确定年级先用一句话问。
若孩子只是闲聊 / 分享生活：完全忽略上面教学约束，保持日常陪伴口吻，禁说教。
```
- 过渡语：base prompt 末追加"需要想一下的问题，第一句可自然带'嗯~让我想想哦'再回答（不必每次都说）"。

### `profile-store.ts`（改）
- `family_member` 加 `grade`(INTEGER) / `subject`(TEXT)，migrate 幂等（复用 P1 范式）。
- gradeBand 软推断：`profile.grade` > 默认；无则不消歧（宽泛匹配，不一刀切丢弃 — gpt/grok）。

### `pipeline.ts`（改）
- `startLlmAndTts` 内 `assembleSystemPrompt` 前：`const guardrail = buildCurriculumGuardrail(finalText, gradeBand)` → 传入。内存 <10ms，不拖 TTFT，不破坏延迟铁律。

---

## 2. 过渡语方案（回应川哥）
川哥要"有思考过程先说点别的、不干等" → **LLM 首句自发**实现：小可需要想时第一句自然说"嗯~让我想想哦"，随正式答案在**同一 TTS 流**输出。**不做工程层两段式**（死循环风险，team 三家共识）。gemini-flash-lite TTFT 200-300ms，小可照样秒开口、不会让孩子干等；KG 内存匹配不增延迟，本就无需技术性 filler，过渡语纯为"思考感"体验。

---

## 3. 不做（team 共识 / 降级）
- 不做实时 LLM 概念识别（延迟）；demo 靠别名表覆盖，漏识别 → 不注入、正常陪伴。
- 不做 neighbor 注入（验证证明 flash-lite 消化不动，仅 15%）。
- 不做全量章节预取（prompt 膨胀稀释注意力）；Session 热点小 Trie 作后续优化（gemini-3.5 提案）。
- **license**：K12-KGraph CC-BY-NC-SA 非商业，demo 内测用，`assets/k12-kgraph/` 加 SOURCE 标注，正式商用前换可授权源。

---

## 4. 验证计划
- 单测：`curriculum-kg`（match / 别名 / 子图 / grade 消歧 / 降级 null）。
- E2E：worktree 本地起 server，模拟"老师今天讲了分数我没听懂"→ 注入护栏 → 小可护栏引导（不报菜名 / 不说黑话）。验收后 merge 主线部署。
