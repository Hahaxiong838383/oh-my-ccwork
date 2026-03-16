# FUTURUS AI 知识库索引

> **用途**：Gemini 等 Agent 查询知识库前先读此文件，快速定位目标目录/文档，避免从头遍历。
> **更新时机**：每次归档新文档后更新对应目录的文档列表。
> **最后更新**：2026-03-12

---

## 知识库基本信息

| 字段 | 值 |
|------|-----|
| 飞书 Space ID | `7589885788549024719` |
| 根节点 node_token | `CiDwwr4cIiZI9Aksyc1cVjjyndf` |
| 索引 Bitable app_token | `CzwzbwKuBadUa3s7BPHcdTDYnGg` |
| 索引 Bitable table_id | `tblb4S7JAqz9lVDm` |

索引表字段：论文名称（主键）/ 类型（SingleSelect：论文/视频/报告）/ 领域（MultiSelect）/ 发表日期 / 文档链接 / 原文链接 / 亮点 / 篇数

---

## 六大目录

| 目录 | node_token | 内容主题 | 典型领域 |
|------|-----------|---------|---------|
| 🧠 神经科学×AI | `Rnk4woVFEiJOJykuOwJclSgxnDc` | 脑科学 × LLM、神经计算、认知科学 | 神经科学/认知科学/LLM机制 |
| 💡 AI理论前沿 | `NwOSwann4iddE3ksdMFcSaFLnQb` | 推理机制、记忆系统、训练优化 | 推理机制/记忆系统/训练优化/算法理论 |
| ⚙️ 工程与系统 | `GDizwEBDrivE3IkXaS8cHlONndd` | 多模态、AI安全、技术实现 | 多模态/AI安全/开源生态 |
| 🤖 Agent评测与多模态 | `Tyx4w0QkxitQD4k23rAciubInwc` | Agent 系统、评测、仿真、视频内容 | 使用行为/AI评测/产业趋势 |
| 📊 产业与趋势 | `IFa1wVzeeiIy1hkrex4cH2M2n3d` | 产业分析、使用行为、市场趋势 | 产业趋势/使用行为 |
| 📦 资源与工具 | `BSWpwY6PMiPd2PkP6IRcta5gnAf` | 开源工具、框架、数据集 | 开源生态 |

---

## 已归档文档（按目录）

### 🤖 Agent评测与多模态（`Tyx4w0QkxitQD4k23rAciubInwc`）

| 文档名称 | doc_id | 类型 | 归档日期 |
|---------|--------|------|---------|
| 《仿真：AI的下一个边界》 | `DiBldXP5DohWQ6xuMpLcecXJnib` | 报告 | 2026-03-11 |
| 《使用 Agent Skills 做知识库检索是什么体验？》 | （见索引表） | 视频 | 2026-03-12 |

### 🧠 神经科学×AI（`Rnk4woVFEiJOJykuOwJclSgxnDc`）

| 文档名称 | doc_id | 类型 | 归档日期 |
|---------|--------|------|---------|
| （2026-03-07 批次 8篇论文+1篇报告，共 11 个 Wiki 页面） | — | 论文 | 2026-03-07 |

---

## 查询策略（渐进式检索）

```
Step 1: 确定领域方向
  → 看"六大目录"表，匹配用户问题的领域关键词
  → 选定 1-2 个目标目录

Step 2: 获取目录下的文档列表
  → 用 feishu MCP: get_wiki_node(node_token=目标目录token)
  → 或直接查 Bitable 索引表过滤领域字段

Step 3: 打开目标文档
  → get_document(doc_id) 获取具体内容
  → 如需全文搜索，用 list_document_blocks

Step 4: 更新索引（归档新内容后）
  → 在此文件"已归档文档"表中追加一行
  → 同时更新 Bitable 索引表
```

---

## 领域关键词映射

| 用户问题关键词 | 目标目录 |
|-------------|---------|
| 脑科学/神经/认知/意识/记忆 | 🧠 神经科学×AI |
| 推理/思维链/CoT/记忆系统/RAG | 💡 AI理论前沿 |
| 安全/对齐/多模态/视觉/音频 | ⚙️ 工程与系统 |
| Agent/仿真/评测/视频/Skills | 🤖 Agent评测与多模态 |
| 产业/趋势/市场/用户/行为 | 📊 产业与趋势 |
| 工具/框架/开源/数据集 | 📦 资源与工具 |
