"""
PGroonga 搜索封装
- 支持中文全文搜索
- 返回匹配片段 + 文档路径 + 标题 + header_breadcrumb
- trust_level 过滤：默认只搜 verified
- 按相关度排序，限制返回数量
"""

from typing import Any
from db import get_pool


async def full_text_search(
    query: str,
    include_drafts: bool = False,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """
    使用 PGroonga &@~ 操作符做全文搜索。

    返回列表，每项包含：
      path, title, snippet, score, trust_level, header_breadcrumb
    """
    pool = await get_pool()

    # trust_level 过滤条件
    trust_filter = "" if include_drafts else "AND d.trust_level = 'verified'"

    # 用 pgroonga_score() 排序；snippet 取 chunk 内容截断
    sql = f"""
        SELECT
            d.path,
            d.title,
            LEFT(c.content, 400) AS snippet,
            pgroonga_score(c.tableoid, c.ctid) AS score,
            d.trust_level,
            c.header_breadcrumb
        FROM document_chunks c
        JOIN documents d ON d.id = c.doc_id
        WHERE c.content &@~ $1
          {trust_filter}
        ORDER BY score DESC
        LIMIT $2
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, query, limit)

    results = []
    seen_paths = set()
    for row in rows:
        # 同一文档只取最高分的那条 chunk（去重）
        path = row["path"]
        if path in seen_paths:
            continue
        seen_paths.add(path)
        results.append({
            "path": path,
            "title": row["title"],
            "snippet": row["snippet"],
            "score": float(row["score"]),
            "trust_level": row["trust_level"],
            "header_breadcrumb": row["header_breadcrumb"] or "",
        })

    return results


async def search_by_title(
    query: str,
    include_drafts: bool = False,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """
    在文档标题上做 PGroonga 全文搜索（补充 chunk 搜索用）。
    """
    pool = await get_pool()
    trust_filter = "" if include_drafts else "AND trust_level = 'verified'"

    sql = f"""
        SELECT
            path,
            title,
            LEFT(content, 400) AS snippet,
            pgroonga_score(tableoid, ctid) AS score,
            trust_level
        FROM documents
        WHERE title &@~ $1
          {trust_filter}
        ORDER BY score DESC
        LIMIT $2
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, query, limit)

    return [
        {
            "path": row["path"],
            "title": row["title"],
            "snippet": row["snippet"],
            "score": float(row["score"]),
            "trust_level": row["trust_level"],
            "header_breadcrumb": "",
        }
        for row in rows
    ]
