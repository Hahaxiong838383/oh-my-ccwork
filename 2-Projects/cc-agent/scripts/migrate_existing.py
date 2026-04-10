#!/usr/bin/env python3
"""
migrate_existing.py — 存量知识迁移脚本
将 mycc 现有知识导入到 PostgreSQL 知识库（cc_agent）

迁移数据源：
  1. 0-System/memory-items.md   → /wiki/facts/{namespace-slug}.md
  2. 3-Thinking/*.md            → /wiki/concepts/methodology/{filename}
  3. 0-System/about-me/*.md     → /wiki/entities/chenchuan/{filename}

运行方式：
  python3 scripts/migrate_existing.py

特性：
  - 幂等：重复运行不会重复插入（ON CONFLICT DO UPDATE）
  - 运行前先验证数据库连接
  - 输出迁移统计
"""

import asyncio
import re
import sys
from pathlib import Path
from typing import Generator

import asyncpg

# ── 路径常量 ────────────────────────────────────────────────────────────────
MYCC_ROOT = Path("/home/hahaxiong83/mycc")
MEMORY_ITEMS_PATH = MYCC_ROOT / "0-System" / "memory-items.md"
THINKING_DIR = MYCC_ROOT / "3-Thinking"
ABOUT_ME_DIR = MYCC_ROOT / "0-System" / "about-me"

# ── 数据库连接 ───────────────────────────────────────────────────────────────
PG_URL = "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent"

# ── 分块参数 ─────────────────────────────────────────────────────────────────
MAX_CHUNK_CHARS = 2000


# ════════════════════════════════════════════════════════════════════════════
# 工具函数
# ════════════════════════════════════════════════════════════════════════════

def slugify(text: str) -> str:
    """将命名空间路径转换为合法文件名 slug。
    例：'project/技术-飞书' → 'project-技术-飞书'
    """
    # 将 '/' 替换为 '-'，去除特殊字符
    slug = text.replace("/", "-")
    slug = re.sub(r"[^\w\u4e00-\u9fff\-]", "-", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug


def extract_current_header(lines: list[str], current_idx: int) -> str:
    """向上扫描提取当前行所属的 Markdown 标题路径（breadcrumb）。"""
    headers: list[tuple[int, str]] = []  # (level, text)
    for i in range(current_idx, -1, -1):
        line = lines[i]
        m = re.match(r"^(#{1,6})\s+(.+)", line)
        if m:
            level = len(m.group(1))
            text = m.group(2).strip()
            # 只保留更高层级的标题（避免重复）
            while headers and headers[-1][0] >= level:
                headers.pop()
            headers.append((level, text))
    # 逆序恢复层级顺序
    headers.reverse()
    return " > ".join(h for _, h in headers) if headers else ""


def chunk_markdown(content: str) -> list[tuple[int, str, str]]:
    """
    将 Markdown 文本按段落（双换行）分块，每块不超过 MAX_CHUNK_CHARS。
    返回 [(chunk_index, content, header_breadcrumb), ...]
    """
    lines = content.split("\n")
    paragraphs: list[tuple[str, str]] = []  # (paragraph_text, breadcrumb)

    current_paras: list[str] = []
    current_start_idx = 0

    for i, line in enumerate(lines):
        # 遇到空行 → 段落结束
        if not line.strip():
            if current_paras:
                para_text = "\n".join(current_paras).strip()
                if para_text:
                    breadcrumb = extract_current_header(lines, current_start_idx)
                    paragraphs.append((para_text, breadcrumb))
                current_paras = []
        else:
            if not current_paras:
                current_start_idx = i
            current_paras.append(line)

    # 处理末尾未结束的段落
    if current_paras:
        para_text = "\n".join(current_paras).strip()
        if para_text:
            breadcrumb = extract_current_header(lines, current_start_idx)
            paragraphs.append((para_text, breadcrumb))

    # 合并小段落 / 拆分超大段落
    chunks: list[tuple[int, str, str]] = []
    idx = 0
    buf = ""
    buf_breadcrumb = ""

    for para_text, breadcrumb in paragraphs:
        # 如果单段落已超限 → 硬切
        if len(para_text) > MAX_CHUNK_CHARS:
            if buf.strip():
                chunks.append((idx, buf.strip(), buf_breadcrumb))
                idx += 1
                buf = ""
            for start in range(0, len(para_text), MAX_CHUNK_CHARS):
                chunks.append((idx, para_text[start: start + MAX_CHUNK_CHARS], breadcrumb))
                idx += 1
            continue

        # 合并到缓冲区
        candidate = (buf + "\n\n" + para_text).strip() if buf else para_text
        if len(candidate) > MAX_CHUNK_CHARS and buf.strip():
            chunks.append((idx, buf.strip(), buf_breadcrumb))
            idx += 1
            buf = para_text
            buf_breadcrumb = breadcrumb
        else:
            buf = candidate
            if not buf_breadcrumb:
                buf_breadcrumb = breadcrumb

    if buf.strip():
        chunks.append((idx, buf.strip(), buf_breadcrumb))

    return chunks


# ════════════════════════════════════════════════════════════════════════════
# 解析 memory-items.md
# ════════════════════════════════════════════════════════════════════════════

def parse_memory_items(filepath: Path) -> Generator[tuple[str, str, str], None, None]:
    """
    解析 memory-items.md，按命名空间分组。
    每个命名空间生成 (wiki_path, title, content)：
      wiki_path = /wiki/facts/{namespace-slug}.md
      title     = [namespace]
      content   = 该命名空间下的所有条目（Markdown 列表）
    """
    if not filepath.exists():
        print(f"  [WARN] 文件不存在，跳过: {filepath}")
        return

    raw = filepath.read_text(encoding="utf-8")
    lines = raw.split("\n")

    current_ns: str | None = None
    current_lines: list[str] = []

    def flush() -> tuple[str, str, str] | None:
        if current_ns is None or not current_lines:
            return None
        content = "\n".join(current_lines).strip()
        if not content:
            return None
        slug = slugify(current_ns)
        wiki_path = f"/wiki/facts/{slug}.md"
        title = f"记忆事实：{current_ns}"
        # 加入命名空间标题
        full_content = f"# {title}\n\n> 来源：memory-items.md [{current_ns}]\n\n{content}"
        return wiki_path, title, full_content

    for line in lines:
        # 匹配命名空间标题：## [namespace]
        ns_match = re.match(r"^##\s+\[(.+?)\]", line)
        if ns_match:
            result = flush()
            if result:
                yield result
            current_ns = ns_match.group(1)
            current_lines = []
            continue

        # 跳过顶部注释区（> 开头的引用块，在第一个命名空间前）
        if current_ns is None:
            continue

        current_lines.append(line)

    # 最后一个命名空间
    result = flush()
    if result:
        yield result


# ════════════════════════════════════════════════════════════════════════════
# 解析 3-Thinking / about-me 目录
# ════════════════════════════════════════════════════════════════════════════

def iter_markdown_dir(
    source_dir: Path, wiki_base_path: str
) -> Generator[tuple[str, str, str], None, None]:
    """
    遍历目录下的 .md 文件（排除 README.md）。
    每个文件生成 (wiki_path, title, content)。
    """
    if not source_dir.exists():
        print(f"  [WARN] 目录不存在，跳过: {source_dir}")
        return

    for md_file in sorted(source_dir.glob("*.md")):
        if md_file.name.lower() == "readme.md":
            continue

        content = md_file.read_text(encoding="utf-8")
        if not content.strip():
            continue

        # 从文件内容提取 H1 标题作为 title，否则用文件名
        title_match = re.search(r"^#\s+(.+)", content, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else md_file.stem

        wiki_path = f"{wiki_base_path}/{md_file.name}"
        yield wiki_path, title, content


# ════════════════════════════════════════════════════════════════════════════
# 数据库操作
# ════════════════════════════════════════════════════════════════════════════

async def check_connection(pool: asyncpg.Pool) -> None:
    """验证数据库连接及必要表是否存在。"""
    async with pool.acquire() as conn:
        # 检查 documents 表
        exists = await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'documents')"
        )
        if not exists:
            raise RuntimeError(
                "表 documents 不存在，请先执行 init.sql 初始化数据库 Schema。"
            )
        # 检查 document_chunks 表
        exists = await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'document_chunks')"
        )
        if not exists:
            raise RuntimeError(
                "表 document_chunks 不存在，请先执行 init.sql 初始化数据库 Schema。"
            )
    print("  ✓ 数据库连接正常，表结构就绪")


async def upsert_document(
    conn: asyncpg.Connection,
    path: str,
    title: str,
    content: str,
    tags: list[str],
) -> tuple[str, bool]:
    """
    插入或更新文档（幂等）。
    返回 (doc_id, is_new)。
    """
    result = await conn.fetchrow(
        """
        INSERT INTO documents (path, title, content, tags, source_type, trust_level)
        VALUES ($1, $2, $3, $4, 'import', 'verified')
        ON CONFLICT (path) DO UPDATE SET
            title      = EXCLUDED.title,
            content    = EXCLUDED.content,
            tags       = EXCLUDED.tags,
            updated_at = now()
        RETURNING id, (xmax = 0) AS is_new
        """,
        path, title, content, tags,
    )
    return str(result["id"]), bool(result["is_new"])


async def upsert_chunks(
    conn: asyncpg.Connection,
    doc_id: str,
    chunks: list[tuple[int, str, str]],
) -> None:
    """
    先删除该文档的旧分块，再批量插入新分块（幂等处理）。
    """
    await conn.execute("DELETE FROM document_chunks WHERE doc_id = $1::uuid", doc_id)
    if not chunks:
        return
    await conn.executemany(
        """
        INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb)
        VALUES ($1::uuid, $2, $3, $4)
        """,
        [(doc_id, idx, text, breadcrumb) for idx, text, breadcrumb in chunks],
    )


# ════════════════════════════════════════════════════════════════════════════
# 主迁移逻辑
# ════════════════════════════════════════════════════════════════════════════

async def migrate_source(
    pool: asyncpg.Pool,
    source_name: str,
    documents: Generator[tuple[str, str, str], None, None],
    tags: list[str],
) -> tuple[int, int, int]:
    """
    执行单个数据源的迁移。
    返回 (doc_count, new_count, chunk_count)。
    """
    doc_count = 0
    new_count = 0
    chunk_count = 0

    async with pool.acquire() as conn:
        async with conn.transaction():
            for wiki_path, title, content in documents:
                doc_id, is_new = await upsert_document(conn, wiki_path, title, content, tags)
                chunks = chunk_markdown(content)
                await upsert_chunks(conn, doc_id, chunks)

                doc_count += 1
                chunk_count += len(chunks)
                if is_new:
                    new_count += 1

                status = "NEW" if is_new else "UPD"
                print(f"    [{status}] {wiki_path}  ({len(chunks)} 块)")

    return doc_count, new_count, chunk_count


async def main() -> None:
    print("=" * 60)
    print("cc-agent 存量知识迁移脚本")
    print("=" * 60)

    # 1. 建立连接池
    print(f"\n[连接] {PG_URL}")
    try:
        pool = await asyncpg.create_pool(PG_URL, min_size=1, max_size=3, timeout=10)
    except Exception as e:
        print(f"  ✗ 无法连接数据库: {e}")
        sys.exit(1)

    # 2. 验证连接 & 表结构
    try:
        await check_connection(pool)
    except RuntimeError as e:
        print(f"  ✗ {e}")
        await pool.close()
        sys.exit(1)

    total_docs = 0
    total_new = 0
    total_chunks = 0

    # ── 数据源 1：memory-items.md ──────────────────────────────────────────
    print("\n[1/3] 迁移 memory-items.md → /wiki/facts/")
    docs1, new1, chunks1 = await migrate_source(
        pool,
        source_name="memory-items",
        documents=parse_memory_items(MEMORY_ITEMS_PATH),
        tags=["memory", "facts", "imported"],
    )
    print(f"  小计：{docs1} 个文档（{new1} 新增），{chunks1} 个分块")
    total_docs += docs1
    total_new += new1
    total_chunks += chunks1

    # ── 数据源 2：3-Thinking/ ──────────────────────────────────────────────
    print("\n[2/3] 迁移 3-Thinking/ → /wiki/concepts/methodology/")
    docs2, new2, chunks2 = await migrate_source(
        pool,
        source_name="3-Thinking",
        documents=iter_markdown_dir(THINKING_DIR, "/wiki/concepts/methodology"),
        tags=["methodology", "concepts", "imported"],
    )
    print(f"  小计：{docs2} 个文档（{new2} 新增），{chunks2} 个分块")
    total_docs += docs2
    total_new += new2
    total_chunks += chunks2

    # ── 数据源 3：0-System/about-me/ ──────────────────────────────────────
    print("\n[3/3] 迁移 0-System/about-me/ → /wiki/entities/chenchuan/")
    docs3, new3, chunks3 = await migrate_source(
        pool,
        source_name="about-me",
        documents=iter_markdown_dir(ABOUT_ME_DIR, "/wiki/entities/chenchuan"),
        tags=["profile", "personal", "imported"],
    )
    print(f"  小计：{docs3} 个文档（{new3} 新增），{chunks3} 个分块")
    total_docs += docs3
    total_new += new3
    total_chunks += chunks3

    # ── 汇总 ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("迁移完成，统计汇总：")
    print(f"  总文档数  : {total_docs}（其中新增 {total_new}，更新 {total_docs - total_new}）")
    print(f"  总分块数  : {total_chunks}")
    print("=" * 60)

    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
