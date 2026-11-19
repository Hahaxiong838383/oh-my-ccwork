# companion-kg 数据来源与许可（L_companion 陪伴域知识层）

## 来源

- **上游数据集**：Marble Skill Taxonomy (os-taxonomy) v1，2026-07-08 发布
  https://github.com/withmarbleapp/os-taxonomy
- **切片规则**：`ageRangeStart <= 8` 且 subject ∈ {Science, Personal & Social Development, Life Skills, Learning to Learn, Computing} → **376 微主题 + 594 条内部先修边**（上游 1590 主题 / 3221 边）
- **中文化管线**（2026-07-13，工具链在 mycc scratchpad os-slice/，管线脚本随本目录归档意义不大，方法论见 P003 docs）：
  grok-4.5 主翻（5 字段 + 口语触发词生成）→ codex gpt-5.5 全量对抗质检（97 处修复，含 25 处知识性错误）→
  规则校验（单字/过泛触发词黑名单清洗）→ 30 条人工抽检（川哥终审通过）
- **上游脏数据修复**：11 个主题（Learning to Learn / 元认知类）的 evidence 上游放的是文献引用而非可观察行为，
  已由 codex 按行为句式重写（超越直译，属于内容修正）
- **topics-embeddings.json**：376 主题向量，硅基流动 `BAAI/bge-large-zh-v1.5`（1024 维，归一化，passage 侧无指令前缀）。
  主题文本 = name + domain + description + triggers 拼接（≤480 字）。**换 embedding 模型必须重算此文件**（query/passage 必须同模型）。

## 许可与署名义务（⚠️ 分发/商用前必读）

| 层 | 许可 | 义务 |
|---|---|---|
| 数据库结构（主题/边/ID 体系） | ODbL 1.0 | 署名 + share-alike（衍生数据库须开放） |
| 文本内容（描述/证据/评估提问/理由） | CC BY-SA 4.0 | 署名 + share-alike |

- **本中文切片属于"衍生数据库"**：按 ODbL/CC BY-SA，若对外分发须以同等许可开放（川哥已知悉，2026-07-13 拍板可接受）。产品内使用（护栏注入 → LLM 回答）属 "produced work"，产权归我方，只需署名。
- **必须保留的署名**：
  > Contains data from the Marble Skill Taxonomy (v1) · © Generative Spark, Inc. (Marble) · https://withmarble.com · ODbL 1.0 (database) + CC BY-SA 4.0 (content). 中文译文与触发词为衍生内容，同许可开放。
- 上游 `curriculum-standards.json`（英美课标对齐，许可最杂）**未搬入**——本切片不含课标文本，无 CCSS/NGSS/IB 义务。

## 消费方

`src/companion-kg.ts`（语义 top3 + 触发词重排 + 阈值 0.47，护栏多候选交主 LLM 消歧；
K12 curriculum > AI 启蒙 > companion 三层互斥，见 prompt-orchestrator.ts）。
运行时依赖 env：`COMPANION_KG=1`（灰度开关，默认关）、`SILICONFLOW_API_KEY`（query 向量）、
`COMPANION_SIM_THRESHOLD`（默认 0.47）。
