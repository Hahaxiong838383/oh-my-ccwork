"""
5 个 MCP 工具定义
工具列表：wiki_guide / wiki_search / wiki_read / wiki_write / wiki_ingest
"""

import os
import fnmatch
from typing import Any, Optional
from datetime import datetime, timezone

from db import get_pool
from chunker import chunk_text
from search import full_text_search, search_by_title

# 写入路径白名单
WIKI_PATH_PREFIX = "/wiki/"
# 导入文件白名单目录
INGEST_BASE_DIR = "/home/hahaxiong83/mycc/"
# glob 模式下总字符数上限
GLOB_CHAR_LIMIT = 120_000


# ─────────────────────────────────────────────
# 内部辅助函数
# ─────────────────────────────────────────────

async def _upsert_document(
    conn,
    path: str,
    title: str,
    content: str,
    tags: list[str],
    source_type: str,
    trust_level: str,
) -> str:
    """插入或更新 documents 表，返回 doc_id"""
    doc_id = await conn.fetchval(
        """
        INSERT INTO documents (path, title, content, tags, source_type, trust_level, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (path) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            tags = EXCLUDED.tags,
            source_type = EXCLUDED.source_type,
            trust_level = EXCLUDED.trust_level,
            updated_at = NOW()
        RETURNING id
        """,
        path, title, content, tags, source_type, trust_level,
    )
    return str(doc_id)


async def _replace_chunks(conn, doc_id: str, content: str) -> int:
    """删除旧 chunks，重新分块写入，返回 chunk 数量"""
    # 删除旧 chunks
    await conn.execute("DELETE FROM document_chunks WHERE doc_id = $1", doc_id)

    chunks = chunk_text(content)
    for chunk in chunks:
        await conn.execute(
            """
            INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb)
            VALUES ($1, $2, $3, $4)
            """,
            doc_id, chunk.chunk_index, chunk.content, chunk.header_breadcrumb,
        )
    return len(chunks)


def _extract_title_from_content(content: str, fallback_path: str) -> str:
    """从 Markdown 内容提取 h1 标题，fallback 用路径最后一段"""
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return os.path.basename(fallback_path).replace(".md", "")


# ─────────────────────────────────────────────
# 工具实现函数（由 server.py 注册为 MCP 工具）
# ─────────────────────────────────────────────

async def wiki_guide() -> dict[str, Any]:
    """
    返回知识库概览 + wiki 写作规范。
    查询 documents 表的统计信息（总页数、分类分布）。
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        total = await conn.fetchval("SELECT COUNT(*) FROM documents")
        verified = await conn.fetchval(
            "SELECT COUNT(*) FROM documents WHERE trust_level = 'verified'"
        )
        draft = await conn.fetchval(
            "SELECT COUNT(*) FROM documents WHERE trust_level = 'draft'"
        )
        # 按 source_type 统计
        source_rows = await conn.fetch(
            "SELECT source_type, COUNT(*) AS cnt FROM documents GROUP BY source_type ORDER BY cnt DESC"
        )
        # 取最近更新的 5 篇
        recent_rows = await conn.fetch(
            "SELECT path, title, updated_at FROM documents ORDER BY updated_at DESC LIMIT 5"
        )

    source_dist = {r["source_type"]: r["cnt"] for r in source_rows}
    recent_docs = [
        f"  - [{r['title']}]({r['path']})  ({r['updated_at'].strftime('%Y-%m-%d')})"
        for r in recent_rows
    ]

    guide = f"""# Wiki 知识引擎使用指南

## 统计概览
- 总文档数：{total}（verified: {verified} / draft: {draft}）
- 来源分布：{source_dist}

## 最近更新
{chr(10).join(recent_docs) if recent_docs else '  （暂无文档）'}

## 可用工具

| 工具 | 说明 |
|------|------|
| wiki_search | 全文搜索，支持中文，默认只搜 verified 文档 |
| wiki_read   | 读取单个文档（精确路径）或 glob 匹配多个 |
| wiki_write  | 写入/更新文档，支持 create/replace/append/str_replace 模式 |
| wiki_ingest | 导入本地 Markdown 文件到知识库 |

## Wiki 写作规范
1. **路径命名**：`/wiki/<分类>/<slug>`，全小写，用连字符，如 `/wiki/concepts/agent-memory`
2. **标题**：首行必须是 `# 标题`，作为文档 title
3. **标签**：描述性词语，如 `["agent", "memory", "architecture"]`
4. **信任等级**：`verified`（已验证）/ `draft`（草稿，默认搜索不可见）
5. **内容结构**：用 Markdown 标题分层，便于自动分块和检索

## 路径规则
- 写入：只允许 `/wiki/` 开头
- 导入：只允许 `/home/hahaxiong83/mycc/` 下的文件
"""
    return {"guide": guide, "stats": {"total": total, "verified": verified, "draft": draft}}


async def wiki_search(
    query: str,
    include_drafts: bool = False,
    limit: int = 10,
) -> dict[str, Any]:
    """
    PGroonga 全文搜索知识库。

    参数：
      query         搜索关键词（支持中文）
      include_drafts 是否包含草稿（draft）文档，默认 False
      limit         最多返回条数，默认 10
    """
    if not query.strip():
        return {"results": [], "count": 0, "message": "查询不能为空"}

    limit = min(max(1, limit), 50)

    # 先搜 chunk 内容，再搜标题
    chunk_results = await full_text_search(query, include_drafts=include_drafts, limit=limit)

    # 用标题搜索补充（去重）
    title_results = await search_by_title(query, include_drafts=include_drafts, limit=5)
    existing_paths = {r["path"] for r in chunk_results}
    for tr in title_results:
        if tr["path"] not in existing_paths:
            chunk_results.append(tr)
            existing_paths.add(tr["path"])

    # 截断到 limit
    results = chunk_results[:limit]

    return {
        "results": results,
        "count": len(results),
        "query": query,
        "include_drafts": include_drafts,
    }


async def wiki_read(path: str) -> dict[str, Any]:
    """
    读取单个文档（精确路径）或 glob 匹配多个文档。

    参数：
      path  精确路径如 /wiki/concepts/agent，或 glob 如 /wiki/concepts/*

    glob 模式下总字符数限制 120K。
    """
    pool = await get_pool()

    # 判断是否 glob
    is_glob = any(c in path for c in ["*", "?", "["])

    if not is_glob:
        # 精确路径查询
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT path, title, content, tags, trust_level, updated_at, source_type
                FROM documents WHERE path = $1
                """,
                path,
            )
        if row is None:
            return {"error": f"文档不存在: {path}"}
        return {
            "path": row["path"],
            "title": row["title"],
            "content": row["content"],
            "tags": list(row["tags"] or []),
            "trust_level": row["trust_level"],
            "source_type": row["source_type"],
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    else:
        # glob 模式：获取所有文档路径后在 Python 侧过滤
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT path, title, content, tags, trust_level, updated_at, source_type FROM documents ORDER BY path"
            )

        matched = []
        total_chars = 0
        for row in rows:
            if fnmatch.fnmatch(row["path"], path):
                doc_chars = len(row["content"] or "")
                if total_chars + doc_chars > GLOB_CHAR_LIMIT:
                    matched.append({
                        "path": row["path"],
                        "title": row["title"],
                        "content": "[字符数超限，已截断]",
                        "tags": list(row["tags"] or []),
                        "trust_level": row["trust_level"],
                        "source_type": row["source_type"],
                        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
                    })
                    break
                total_chars += doc_chars
                matched.append({
                    "path": row["path"],
                    "title": row["title"],
                    "content": row["content"],
                    "tags": list(row["tags"] or []),
                    "trust_level": row["trust_level"],
                    "source_type": row["source_type"],
                    "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
                })

        return {
            "documents": matched,
            "count": len(matched),
            "total_chars": total_chars,
            "pattern": path,
        }


async def wiki_write(
    path: str,
    content: str,
    title: Optional[str] = None,
    tags: Optional[list[str]] = None,
    mode: str = "create",
    old_str: Optional[str] = None,
    new_str: Optional[str] = None,
) -> dict[str, Any]:
    """
    写入或更新 wiki 文档。

    参数：
      path     文档路径，必须以 /wiki/ 开头
      content  文档内容（mode=str_replace 时为基础内容，忽略此参数用 old/new_str）
      title    文档标题，不传则从 content 首行 # 提取
      tags     标签列表
      mode     create / replace / append / str_replace
      old_str  str_replace 模式：要替换的旧文本
      new_str  str_replace 模式：替换后的新文本
    """
    # 路径白名单检查
    if not path.startswith(WIKI_PATH_PREFIX):
        return {"error": f"路径必须以 {WIKI_PATH_PREFIX} 开头，当前: {path}"}

    pool = await get_pool()

    async with pool.acquire() as conn:
        # 查询是否已存在
        existing = await conn.fetchrow(
            "SELECT id, content FROM documents WHERE path = $1", path
        )

        if mode == "create":
            if existing:
                return {"error": f"文档已存在，请用 replace/append/str_replace 模式: {path}"}
            final_content = content

        elif mode == "replace":
            final_content = content

        elif mode == "append":
            if existing:
                old_content = existing["content"] or ""
                final_content = old_content.rstrip() + "\n\n" + content
            else:
                final_content = content

        elif mode == "str_replace":
            if not existing:
                return {"error": f"str_replace 模式要求文档已存在: {path}"}
            if old_str is None or new_str is None:
                return {"error": "str_replace 模式需要提供 old_str 和 new_str"}
            base_content = existing["content"] or ""
            if old_str not in base_content:
                return {"error": f"old_str 在文档中未找到，请检查内容是否匹配"}
            final_content = base_content.replace(old_str, new_str, 1)

        else:
            return {"error": f"不支持的 mode: {mode}，可选 create/replace/append/str_replace"}

        # 自动提取标题
        resolved_title = title or _extract_title_from_content(final_content, path)
        resolved_tags = tags or []

        doc_id = await _upsert_document(
            conn,
            path=path,
            title=resolved_title,
            content=final_content,
            tags=resolved_tags,
            source_type="manual",
            trust_level="verified",
        )
        chunk_count = await _replace_chunks(conn, doc_id, final_content)

    return {
        "success": True,
        "path": path,
        "title": resolved_title,
        "mode": mode,
        "chunk_count": chunk_count,
        "doc_id": doc_id,
    }


async def wiki_ingest(file_path: str) -> dict[str, Any]:
    """
    导入本地 Markdown 文件到知识库。

    参数：
      file_path  绝对路径，必须在 /home/hahaxiong83/mycc/ 下

    文档路径规则：截取相对 mycc 目录的路径，前缀替换为 /wiki/import/
    例：/home/hahaxiong83/mycc/3-Thinking/foo.md → /wiki/import/3-Thinking/foo
    """
    # 路径白名单检查
    real_path = os.path.realpath(file_path)
    base_real = os.path.realpath(INGEST_BASE_DIR)
    if not real_path.startswith(base_real):
        return {"error": f"导入路径必须在 {INGEST_BASE_DIR} 下，当前: {file_path}"}

    if not os.path.isfile(real_path):
        return {"error": f"文件不存在: {file_path}"}

    # 读取文件内容
    try:
        with open(real_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"error": f"读取文件失败: {e}"}

    if not content.strip():
        return {"error": "文件内容为空"}

    # 生成 wiki 路径：去掉 base_real 前缀，替换为 /wiki/import/
    rel = os.path.relpath(real_path, base_real)
    # 去掉 .md 后缀
    rel_no_ext = rel[:-3] if rel.endswith(".md") else rel
    wiki_path = "/wiki/import/" + rel_no_ext.replace(os.sep, "/")

    title = _extract_title_from_content(content, wiki_path)
    tags: list[str] = []

    pool = await get_pool()
    async with pool.acquire() as conn:
        doc_id = await _upsert_document(
            conn,
            path=wiki_path,
            title=title,
            content=content,
            tags=tags,
            source_type="import",
            trust_level="verified",
        )
        chunk_count = await _replace_chunks(conn, doc_id, content)

    return {
        "success": True,
        "source_file": file_path,
        "wiki_path": wiki_path,
        "title": title,
        "chunk_count": chunk_count,
        "doc_id": doc_id,
        "content_length": len(content),
    }
