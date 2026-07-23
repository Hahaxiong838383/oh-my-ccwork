# AI 前沿理论雷达 — 标准操作流程 (SOP)

> 本文件是跨引擎标准流程，任何 AI（cc/codex/gemini）均可独立执行。
> 每一步都有明确的输入、操作、输出，禁止跳步或自由发挥。

> **生产覆盖规则（2026-07-23）**：每日生产报告只由韩国 `RSS/OpenAlex + Grok 4.5` 产线生成并发布。飞书任务必须读取 `https://my.chenchuan.cc/api/radar/report?date=YYYY-MM-DD`，不得再次运行本 SOP 的 arXiv Query API、重新分析或调用个人站 webhook。`needs_refresh` 不是授权失效，须以 sidecar 绑定状态和真实发送结果判定。以下步骤仅用于川哥明确授权的人工回溯、Wiki 补档或灾难恢复。

---

## 任务概述

从 arXiv 抓取脑科学×LLM、认知科学×AI 交叉领域最新论文，深度分析后：
1. 发飞书群消息（3条分批）
2. 去重过滤（与已有索引比对）
3. 创建飞书 Wiki 页面（每篇一页）
4. 更新多维表格索引

---

## Step 1: 抓取论文数据

**操作**：运行 Python 脚本
```bash
python3 /Users/rayman.chen/mycc/.claude/skills/theory-radar/scripts/arxiv-theory-radar.py
```

**输出**：`/tmp/theory-radar-data.json`

**验证**：检查 JSON 中 `total` 字段 > 0。若为 0，扩大时间范围到 7 天重试。

---

## Step 2: 深度分析

**输入**：`/tmp/theory-radar-data.json`

**操作**：
1. 读取 JSON，合并所有 sections 的论文
2. 按 arxiv_id 去重
3. 按以下优先级选出 8-10 篇：
   - P1: 直接研究 LLM 内部机制与认知/神经科学的对应关系
   - P2: 提出新的认知计算模型，可迁移到 AI
   - P3: 脑神经实验结论对 attention/memory/reasoning 有启发
   - P4: 行为学/心理学实验揭示人类智能规律
4. 对每篇生成分析（严格使用以下模板，不得修改格式）：

```
【N】论文标题（精简中文版，20字以内）
📍 arxiv.org/abs/XXXXX | 分类：XX.XX
🔬 核心发现：[2-3句，论文的核心研究结论或实验发现]
🔗 与LLM的连接：[1-2句，该发现如何映射到大模型机制或启发AI设计]
💡 研究启示：[1-2句，对认知AI/类脑计算的潜在价值]
```

**输出**：8-10 篇格式化分析文本

---

## Step 3: 发飞书通知（3条消息）

**工具**：`node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js`
**参数**：`<标题> <内容> purple`

### 消息 1（开篇 + 第1-3篇）
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 AI理论雷达 MM-DD｜今日 N 篇" \
  "━━━━━━━━━━━━━━━━\n🧬 AI前沿理论雷达\n📅 MM月DD日 | 共 N 篇精选\n🔬 脑科学 · 认知科学 · LLM理论\n━━━━━━━━━━━━━━━━\n\n【1】...\n\n【2】...\n\n【3】..." \
  purple
```

### 消息 2（第4-6篇）
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 理论雷达 第2批" \
  "【4】...\n\n【5】...\n\n【6】..." \
  purple
```

### 消息 3（第7-10篇 + 总结）
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "🧬 理论雷达 第3批 + 总结" \
  "【7】...\n\n【8】...\n\n━━━━━━━━━━━━━━━━\n📊 今日覆盖：神经科学 · 认知计算 · LLM机制\n🔥 今日亮点：[2-3个核心亮点关键词]\n📁 知识库存档：稍后同步\n🗂️ 论文索引表：https://b2kj9e7u26m.feishu.cn/base/CzwzbwKuBadUa3s7BPHcdTDYnGg?table=tblb4S7JAqz9lVDm\n⏰ 生成时间：HH:MM\n━━━━━━━━━━━━━━━━" \
  purple
```

---

## Step 3.5: 去重过滤（归档前必做）

**目的**：避免重复写入已存在的论文。

### 3.5a 查询现有索引

使用飞书 MCP 工具 `list_bitable_records`：
- app_token: `CzwzbwKuBadUa3s7BPHcdTDYnGg`
- table_id: `tblb4S7JAqz9lVDm`
- page_size: 500，循环直到 has_more=false
- 从「文档链接」字段提取已有 arxiv_id

### 3.5b 过滤

从 Step 2 的论文列表中，移除 arxiv_id 已存在于索引表的论文。

### 3.5c 输出去重报告

```
📋 去重结果：
- 本次抓取：N 篇
- 已存在（跳过）：M 篇 [列出 arxiv_id]
- 新增待归档：K 篇
```

**若 K=0（全部重复）**：跳过 Step 4-5，任务结束。

---

## Step 4: 飞书 Wiki 存档（每篇一页）

**知识库 space_id**：`7589885788549024719`

### 分类目录对照表

| 分类 | node_token | 适用领域 |
|------|-----------|---------|
| 🧠 脑科学与认知计算 | `Rnk4woVFEiJOJykuOwJclSgxnDc` | 神经科学/认知科学 |
| 💡 LLM机制与推理 | `NwOSwann4iddE3ksdMFcSaFLnQb` | LLM机制/推理机制 |
| ⚙️ 算法理论与训练优化 | `GDizwEBDrivE3IkXaS8cHlONndd` | 训练优化/算法理论 |
| 🤖 Agent评测与多模态 | `Tyx4w0QkxitQD4k23rAciubInwc` | AI评测/多模态 |
| 📊 AI产业趋势与行为研究 | `IFa1wVzeeiIy1hkrex4cH2M2n3d` | 产业趋势/行为/开源 |

### 4a 创建页面

对每篇新论文，使用 `feishu_openapi_call`（open-feishu-mcp）：
- method: POST
- path: `/open-apis/wiki/v2/spaces/7589885788549024719/nodes`
- body:
```json
{
  "obj_type": "docx",
  "node_type": "origin",
  "parent_node_token": "<对应分类的 node_token>",
  "title": "[arxiv_id] 中文精简标题"
}
```
- **记录返回的 `obj_token`**（即 doc_id，用于写入内容和索引链接）

### 4b 写入页面内容

**必须逐篇顺序执行，禁止并发**（否则触发 9499 错误）。

工具：`feishu_openapi_call`
- method: POST
- path: `/open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children`
- body（**不加 index 字段**）:

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

### 4c 本地存档

将所有论文分析写入：`/Users/rayman.chen/SharedFolder/theory-radar/YYYY-MM-DD.md`

---

## Step 5: 多维表格索引更新

对 Step 3.5 过滤后的新论文，使用 `create_bitable_record`（open-feishu-mcp）写入索引。

- app_token: `CzwzbwKuBadUa3s7BPHcdTDYnGg`
- table_id: `tblb4S7JAqz9lVDm`

### 字段映射

| 字段名 | 内容 | 格式说明 |
|--------|------|---------|
| 论文名称 | 精简中文标题（≤20字） | 纯文本 |
| 日期 | 发布日期 | Unix 毫秒时间戳 |
| 领域 | 分类标签 | 多选（神经科学/LLM机制/AI安全/推理机制/认知科学/多模态/训练优化/记忆系统/AI评测） |
| 文档链接 | Wiki 页面链接 | `{"link": "https://b2kj9e7u26m.feishu.cn/wiki/{node_token}", "text": "Wiki · 论文简称"}` |
| 亮点 | 一句话核心结论（≤50字） | 纯文本 |

---

## 常见错误与避坑

| 错误 | 原因 | 解决 |
|------|------|------|
| Wiki 创建 400 | 缺少 `node_type: "origin"` | body 必须包含 |
| 内容写入 9499 | 并发写多个 doc | 必须顺序执行 |
| 内容写入 9499 | body 中带 `index` 字段 | 删掉 index |
| `create_blocks` 工具失败 | MCP 工具参数解析错误 | 改用 `feishu_openapi_call` |
| abstract 为空 | arXiv fetch 失败 | 用 AI 根据标题生成摘要，注明「[AI生成]」 |

---

## 执行模式

### 单引擎全流程
任何一个引擎独立执行 Step 1→2→3→3.5→4→5。

### 双引擎协作（推荐，已自动化）
- **cc**（每3天 08:15）执行 Step 1→2→3（抓取 + 分析 + 飞书通知）
- **codex**（每3天 08:45）执行 Step 3.5→4→5（去重 + Wiki 存档 + 索引更新）

两个任务在 tasks.md 中独立配置，间隔 30 分钟自动串联。
codex 的输入数据来自 `/tmp/theory-radar-data.json`（Step 1 的输出）。

**⚠️ codex 归档任务要点**：
- 你只需要执行 Step 3.5→4→5，Step 1-3 已由 cc 完成
- 论文数据在 `/tmp/theory-radar-data.json`
- 必须先做去重（Step 3.5），再归档

---

## 注意事项

- arXiv 限速：查询间隔 ≥ 3 秒
- 论文通常 8-15 篇/天，不足 8 篇时扩大到 7 天
- Wiki 写入必须顺序，每篇之间等 1 秒
- 所有飞书 API 通过 `open-feishu-mcp` MCP 服务调用
