---
name: theory-radar
description: AI 前沿理论雷达 - 每日 08:00 从 arXiv 抓取脑科学×LLM、认知科学×AI、神经计算等交叉领域最新论文，深度分析后发飞书日报。触发词："/theory-radar"、"理论雷达"、"前沿论文"、"今日论文"
---

# AI 前沿理论雷达

监控领域：脑科学、神经科学、认知心理学、行为学 × 大模型基本原理

## 执行流程

### Step 1: 抓取论文数据

```bash
python3 .claude/skills/theory-radar/scripts/arxiv-theory-radar.py
```

输出 `/tmp/theory-radar-data.json`，结构：
```json
{
  "date": "YYYY-MM-DD",
  "total": 10,
  "sections": [
    {
      "label": "🧠 神经科学×语言模型",
      "papers": [
        {
          "title": "...",
          "authors": ["Author1", "Author2"],
          "abstract": "...",
          "arxiv_id": "2503.XXXXX",
          "url": "https://arxiv.org/abs/2503.XXXXX",
          "published": "2026-03-05",
          "categories": ["q-bio.NC", "cs.CL"]
        }
      ]
    }
  ]
}
```

### Step 2: 深度分析（方案 B）

读取 JSON 数据，对每篇论文生成深度分析。从所有 sections 中**合并去重**，选出最相关的 8-10 篇，按以下格式逐篇分析：

**单篇格式模板**（所有文字输出必须使用中文）：
```
【N】论文标题（中文精简版，≤20字）
📍 arxiv.org/abs/XXXXX | 分类：XX.XX
🔬 核心发现：[2-3句中文，论文的核心研究结论或实验发现]
🔗 与LLM的连接：[1-2句中文，该发现如何映射到大模型机制或启发AI设计]
💡 研究启示：[1-2句中文，对认知AI/类脑计算的潜在价值]
```

**选篇标准**（优先级从高到低）：
1. 直接研究 LLM 内部机制与认知/神经科学的对应关系
2. 提出新的认知计算模型，可迁移到 AI
3. 脑神经实验结论对 attention/memory/reasoning 有启发
4. 行为学/心理学实验揭示人类智能规律

**发送策略**：分 3 条消息发送（防止内容过长截断）：
- 消息 1：标题卡 + 第 1-3 篇
- 消息 2：第 4-6 篇
- 消息 3：第 7-10 篇 + 尾部汇总

### Step 3: 发飞书通知

**消息 1（开篇）**：
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 AI理论雷达 MM-DD｜今日 N 篇" \
  "━━━━━━━━━━━━━━━━\n🧬 AI前沿理论雷达\n📅 MM月DD日 | 共 N 篇精选\n🔬 脑科学 · 认知科学 · LLM理论\n━━━━━━━━━━━━━━━━\n\n【1】...\n📍 ...\n🔬 ...\n🔗 ...\n💡 ...\n\n【2】...\n...\n\n【3】..." \
  purple
```

**消息 2（中篇）**：
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 理论雷达 第2批" \
  "【4】...\n\n【5】...\n\n【6】..." \
  purple
```

**消息 3（收尾）**：

尾部采用方案C格式，融合今日总结 + 飞书存档链接 + 论文索引表链接：

```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 理论雷达 第3批 + 总结" \
  "【7】...\n\n【8】...\n\n━━━━━━━━━━━━━━━━\n📊 今日覆盖：神经科学 · 认知计算 · LLM机制\n🔥 今日亮点：[2-3个核心亮点关键词]\n\n📁 知识库存档：https://FEISHU_WIKI_URL（当日报告全文）\n🗂️ 论文索引表：https://BITABLE_URL（按领域筛选）\n⏰ 生成时间：HH:MM\n━━━━━━━━━━━━━━━━" \
  purple
```

**链接来源说明**：
- `FEISHU_WIKI_URL`：Step 4 创建 wiki 页面时，从 API 返回的 `node_token` 拼接：`https://b2kj9e7u26m.feishu.cn/wiki/{node_token}`
- `BITABLE_URL`：固定值（论文索引表），填入：`https://b2kj9e7u26m.feishu.cn/base/CzwzbwKuBadUa3s7BPHcdTDYnGg?table=tblb4S7JAqz9lVDm`

### Step 3.5: 去重过滤（归档前必做）

在 Wiki 存档和多维表格写入之前，**必须**先查询现有索引，过滤已归档论文。

**3.5a. 查询现有 arxiv_id 列表**：

使用 `list_bitable_records`（open-feishu-mcp）查询论文索引表所有记录：
- app_token: `CzwzbwKuBadUa3s7BPHcdTDYnGg`
- table_id: `tblb4S7JAqz9lVDm`
- 需分页拉取全量（page_size=500，循环直到 has_more=false）
- 从每条记录的「文档链接」字段提取 arxiv_id（link URL 格式：`https://arxiv.org/abs/{arxiv_id}`）
- 或从「论文名称」字段首部提取 arxiv_id（若标题格式为 `[arxiv_id] 标题`）

**3.5b. 过滤重复论文**：

从待归档论文列表中，移除 arxiv_id 已存在于索引表的论文：
```
待归档论文 → 过滤掉 arxiv_id 在现有索引中的 → 新论文列表
```

**3.5c. 输出去重报告**：

```
📋 去重结果：
- 本次抓取：N 篇
- 已存在（跳过）：M 篇  [列出 arxiv_id 列表]
- 新增待归档：K 篇
```

若全部重复（K=0），跳过 Step 4-5，直接结束并通知用户。

### Step 4: 飞书 Wiki 存档（每篇一页）

发送完成后，为**去重后的新论文**在对应分类目录下创建独立 Wiki 页面。

**知识库结构**（space_id: `7589885788549024719`）：

| 分类目录 | node_token | 适用论文领域 |
|---------|-----------|-------------|
| 🧠 脑科学与认知计算 | `Rnk4woVFEiJOJykuOwJclSgxnDc` | 神经科学/认知科学 |
| 💡 LLM机制与推理 | `NwOSwann4iddE3ksdMFcSaFLnQb` | LLM机制/推理机制 |
| ⚙️ 算法理论与训练优化 | `GDizwEBDrivE3IkXaS8cHlONndd` | 训练优化/算法理论 |
| 🤖 Agent评测与多模态 | `Tyx4w0QkxitQD4k23rAciubInwc` | AI评测/多模态 |
| 📊 AI产业趋势与行为研究 | `IFa1wVzeeiIy1hkrex4cH2M2n3d` | 产业趋势/使用行为/开源生态（非学术报告） |

**4a. 为每篇论文创建 Wiki 页面**：
- API：`POST /wiki/v2/spaces/7589885788549024719/nodes`
- **必须同时传 `obj_type: "docx"` 和 `node_type: "origin"`**，否则返回 99992402 错误
- 使用 `feishu_openapi_call` 工具（open-feishu-mcp，user OAuth token）
- 父节点：根据论文领域选择对应分类目录的 node_token
- 页面标题格式：`[arxiv_id] 中文精简标题`
- 记录每篇返回的 `node_token`，用于 Step 5 更新文档链接

**4b. 写入页面内容**（关键：使用 `feishu_openapi_call` 直接调 docx v1 API，**不用** `create_blocks` 工具）：

**⚠️ API 调用规范（经过验证的唯一可靠方式）**：
- 工具：`feishu_openapi_call`，method=POST
- path：`/open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children`（doc_id 即 node_token）
- body：`{"children": [...blocks...]}` — **不加 index 字段**，否则 9499 错误
- **必须顺序请求**，并发写多个 doc 会触发 9499；`create_blocks` MCP 工具不可用（参数解析错误）

**每页内容块结构**（10个 block_type:2 文本块）：
```json
{"children":[
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"📍 arXiv:XXXX | 分类：...","text_element_style":{}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"🔬 核心发现","text_element_style":{"bold":true}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"[2-3句论文核心结论]","text_element_style":{}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"🔗 与LLM的连接","text_element_style":{"bold":true}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"[1-2句映射到LLM机制]","text_element_style":{}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"💡 研究启示","text_element_style":{"bold":true}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"[1-2句对认知AI的价值]","text_element_style":{}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"📄 摘要原文（Abstract）","text_element_style":{"bold":true}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"[Abstract英文原文]","text_element_style":{}}}],"style":{}}},
  {"block_type":2,"text":{"elements":[{"text_run":{"content":"🔗 原文链接","text_element_style":{"bold":true}}},{"text_run":{"content":"  https://arxiv.org/abs/XXXX","text_element_style":{"link":{"url":"https://arxiv.org/abs/XXXX"}}}}],"style":{}}}
]}
```

**降级策略**：若 arXiv fetch 失败（abstract 为空），根据论文标题和领域知识生成摘要，在摘要块首行注明「[摘要由AI生成，fetch失败]」。

**跨 session 续跑**：若 Wiki 写入被 context 压缩中断，session 摘要中会记录「已完成/待完成 doc_id 列表」，下个 session 直接继续，无需重新查询页面列表。

**4c. 本地存档**：
- 存档路径：`/Users/rayman.chen/SharedFolder/theory-radar/YYYY-MM-DD.md`
- 格式：所有论文分析合并写入一个文件，无需分批

### Step 5: 多维表格索引更新

在多维表格（app_token: `CzwzbwKuBadUa3s7BPHcdTDYnGg`，table_id: `tblb4S7JAqz9lVDm`）中，为当日每篇论文新增一条记录：

**全部字段必须使用中文输出**（论文名称、亮点等，不使用英文原文）。

字段映射：
| 字段名 | 类型 | 内容 |
|--------|------|------|
| 论文名称 | 文本 | **中文**精简标题（≤20字），不含 arxiv_id 前缀 |
| arxiv_id | 文本 | arXiv 论文 ID（如 `2503.12345v1`） |
| 日期 | 日期 | 发布日期（Unix 毫秒时间戳） |
| 类型 | 单选 | 根据内容自动适配：`论文` / `综述` / `技术报告` / `预印本` / `视频` / `PDF` |
| 领域 | 多选 | 根据论文内容自动匹配，可选标签：神经科学 / 认知科学 / LLM机制 / 推理机制 / 记忆系统 / 训练优化 / 算法理论 / 多模态 / AI评测 / AI安全 / 产业趋势 / 使用行为 / 开源生态 |
| 亮点 | 文本 | **中文**一句话核心结论（≤50字） |
| 文档链接 | 链接 | **仅 Wiki 知识库页面链接**：`{"link": "https://b2kj9e7u26m.feishu.cn/wiki/{node_token}", "text": "Wiki · 论文简称"}`。无 Wiki 页面时**留空** |
| 原文链接 | 链接 | 论文原始链接：`{"link": "https://arxiv.org/abs/{arxiv_id}", "text": "arXiv · {arxiv_id}"}` |

**领域自动适配规则**：根据论文 abstract 和 categories 判断，每篇选 1-3 个最相关标签。不要硬编码映射，而是理解论文内容后选择。

**类型自动适配规则**：
- arXiv 论文默认为 `论文`
- 标题含 survey/review/overview → `综述`
- 标题含 technical report → `技术报告`
- 非学术来源（产业报告、白皮书等） → 根据实际类型选择

使用 `batch_create` 一次性提交**Step 3.5 过滤后的新论文**（已在 Step 3.5 完成去重，此处直接写入无需再次判断）。

## 数据源

| 来源 | 类别 | 说明 |
|------|------|------|
| arXiv q-bio.NC | 计算神经科学 | 脑×语言/认知 |
| arXiv cs.AI | 人工智能 | 认知/神经/行为相关 |
| arXiv cs.CL | 计算语言学 | 认知记忆/推理/注意力 |
| arXiv cs.NE | 神经进化计算 | 认知机制×神经网络 |
| arXiv cs.AI | Agent能力评测 | benchmark/evaluation/agent skills |

- **免费无 key**：arXiv API 完全开放
- **近3天过滤**：只取最近3天提交的论文
- **关键词过滤**：abstract/title 必须含认知/神经/LLM 相关词
- **去重机制**：按 arxiv_id 跨分区去重

## 跨引擎标准操作流程

详见 **[SOP.md](./SOP.md)**。

当 codex/gemini 通过飞书群 @mention 接到 theory-radar 任务时，mycc 后端会**自动注入 SOP.md** 到 prompt 中，确保任何引擎都按标准流程执行。

### 多引擎协作（推荐）

- **cc** 执行 Step 1→2→3（抓取 + 分析 + 飞书通知）
- **gemini** 执行 Step 3.5→4→5（去重 + Wiki 存档 + 索引更新）

### Gemini 委托方式

方式 1：在群聊中 @gemini，SOP 会自动注入
方式 2：cc 直接调 headless 模式
```bash
gemini -p "$(cat /tmp/gemini-step4-5-prompt.txt)" -y -o text > /tmp/gemini-step4-5-output.txt 2>&1 &
```

## 注意事项

- arXiv 限速：查询间隔 ≥ 3 秒，每次最多查 10 条
- 论文数量视当日不同，通常 8-15 篇；若不足 8 篇，降低过滤门槛（扩大到 7 天）
- 内容为学术参考，不代表任何观点
