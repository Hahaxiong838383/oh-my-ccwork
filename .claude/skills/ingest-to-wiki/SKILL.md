---
name: ingest-to-wiki
description: 链接/文章自动归档到知识库。收到链接→完整阅读全文→提炼核心内容和索引→归档PG知识库+Markdown。触发词："/ingest"、"归档到知识库"、"收入知识库"、"存到知识库"、"帮我归档这篇"
---

# 文章归档到知识库

收到链接或长文，完整阅读全文后提炼核心内容和索引，归档到 PG 知识库（支持全文检索）+ Markdown 文件备份。

## 触发词

精确匹配：
- `/ingest <链接>`

意图匹配：
- "归档到知识库"、"收入知识库"、"存到知识库"
- "帮我归档这篇"、"收录这个链接"、"记录这个笔记"
- 纯 URL（无其他文字）→ 自动入库
- URL + "解读/分析/总结" → 入库 + 回答

---

## 强制执行流程（所有模型必须遵守）

### Step 1: 抓取全文

**微信公众号**（mp.weixin.qq.com）：
```bash
python3 /home/hahaxiong83/mycc/.claude/skills/read-gzh/scripts/fetch_wechat_article.py "<链接>" --json
```
注意：必须用**绝对路径**，不能用相对路径（cc2wechat 编译后 dist 目录层级不同会找不到）。

**其他网页**：
1. Jina Reader（优先）：`https://r.jina.ai/<URL>`
2. 降级：直接 fetch + HTML 转文本
3. URL 抓取需要走代理（NAS 外网需要 `http_proxy=http://127.0.0.1:20171`），但 LLM API 调用不走代理
4. cc2wechat 中通过临时设置 `process.env.https_proxy` 实现（抓完恢复）

**抓取内容 <100 字时**：视为抓取失败，提示用户"抓取内容过少，请复制文章全文发送"。

### Step 2: 完整阅读（不可跳过）

- **文字文章**：阅读全文，不可只看摘要
- **图片文章**：下载所有配图，逐张阅读图片中的文字和信息
- **视频文章**：提取可用的描述和元信息
- **抓取内容 <100 字**：视为抓取失败，提示用户手动粘贴全文

### Step 3: 提炼核心内容

用 LLM 提取结构化 JSON（支持 Gemini Flash / MiniMax M2.7）：

```json
{
  "title": "文章真实标题（15字以内）",
  "summary": "核心摘要（100-200字，提炼关键观点）",
  "concepts": [{"name": "概念名", "description": "一句话解释"}],
  "key_points": ["要点1", "要点2", ...],
  "tags": ["标签1", "标签2", "标签3"]
}
```

LLM 失败时 fallback：标题从首行提取，摘要截取前 200 字。

输出结构化 Markdown：

```markdown
# {真实标题}

> 来源: [{域名}]({URL})
> 收录时间: {YYYY-MM-DD}
> 标签: {tag1}, {tag2}, {tag3}

## 核心摘要
{LLM 生成的 100-200 字摘要}

## 关键概念
- **{概念1}**: {一句话解释}
- **{概念2}**: {一句话解释}

## 原文要点
1. {要点1}
2. {要点2}
...

## 关联知识
- [{已有页面}](/wiki/xxx) — 关联说明
```

**质量标准**：
- 每个要点不是一句话概括，而是保留关键信息（数据、对比、具体功能）
- 有表格的保留表格
- 有代码/配置的保留关键片段
- 标签选择要精准，便于后续检索

### Step 4: 搜索关联知识

入库前搜索 Wiki 中已有的相关页面：
```sql
SELECT path, title FROM documents
WHERE content &@~ '关键词' AND trust_level = 'verified'
ORDER BY pgroonga_score(tableoid, ctid) DESC LIMIT 3;
```

### Step 5: 入库

**路径规则**：`/wiki/wechat-ingest/{slug}`（slug 从标题生成，中文保留，特殊字符替换为 -）

```sql
-- 1. 写入 documents
INSERT INTO documents (path, title, content, tags, source_type, trust_level)
VALUES ('/wiki/wechat-ingest/{slug}', '{标题}', '{结构化Markdown}', ARRAY['{tags}'], 'wechat_ingest', 'verified')
ON CONFLICT (path) DO UPDATE SET content=EXCLUDED.content, title=EXCLUDED.title, tags=EXCLUDED.tags, updated_at=now()
RETURNING id;

-- 2. 删除旧 chunks
DELETE FROM document_chunks WHERE doc_id = '{doc_id}';

-- 3. 分块写入（每块 ≤2000 字符，按章节拆分）
INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb)
VALUES ('{doc_id}', 0, '{块内容}', '{标题 > 章节名}');
```

**PG 连接**：`PGPASSWORD=ccagent2026 psql -h 127.0.0.1 -p 5433 -U cc -d cc_agent`

### Step 6: 保存 Markdown 备份

保存到 `1-Inbox/YYYY-MM-DD-{slug}.md`，命名规范遵守 1-Inbox/README.md。

### Step 7: 回复确认

微信友好格式（不要 Markdown）：
```
已收录到知识库

标题：{真实标题}
来源：{域名}
标签：{tag1} | {tag2} | {tag3}

摘要：{100字核心摘要}

关键概念：
1. {概念1}：{解释}
2. {概念2}：{解释}

关联已有知识：
- {关联页面标题}
```

---

## 微信通道意图分类规则

cc2wechat 的 `classifyIntent()` 按以下逻辑分发：

| 用户消息 | 意图 | 行为 |
|---------|------|------|
| 纯 URL | `ingest` | 抓取 → 入库 → 回复摘要 |
| URL + "收录/归档/记录" | `ingest` | 同上 |
| URL + "分析/总结/解读/价值" | `ingest_and_answer` | 入库 + 用知识回答问题 |
| URL + "安装/部署/帮我写" | `task` | 不入库，走任务对话 |
| `/cc` 前缀 | Claude | 直接走 Claude Code |

**注意**：URL 正则需要在中文标点 `。，！？` 处断开，否则会吃掉用户的中文指令。

---

## 分块规则

1. 按 `## 标题` 拆分（每个二级标题是一个块）
2. 单块超过 2000 字符时，按段落再拆
3. 每个块带 `header_breadcrumb`（如 `核心摘要 > 关键概念`）
4. 至少保证每个块可独立被检索理解

---

## 已知陷阱

1. **微信公众号反爬**：三种抓取方式都可能失败，只拿到空壳 HTML（40 字）
2. **URL 正则匹配中文**：`\S+` 会把中文句号后的文字也当 URL 一部分
3. **MiniMax 返回 `<think>` 标签**：需要 `content.replace(/<think>[\s\S]*?<\/think>/g, '')` 清除
4. **LLM 返回的 JSON 可能被 markdown 代码块包裹**：需要先提取 `json` 代码块内容
5. **Gemini 中转偶尔 401/500**：熔断器连续 3 次失败后跳过，5 分钟冷却

---

*创建：2026-04-11 | 更新：2026-04-11（修复意图分类 + URL 正则 + 抓取代理）*
