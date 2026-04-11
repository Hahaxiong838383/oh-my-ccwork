"""
每日知识采集管线 v1
RSS 源 → 抓取 → LLM 摘要 → 存入 Wiki（trust=draft）

用法：
  python3 scripts/daily_ingest.py              # 运行采集
  python3 scripts/daily_ingest.py --dry-run    # 只看不写

环境变量：
  GEMINI_API_KEY      - Gemini API Key
  GEMINI_BASE_URL     - Gemini Gateway Base URL（默认 http://23.226.135.149:4000/v1）
  MINIMAX_API_KEY     - MiniMax API Key（优先用，直连更稳定）
  PG_URL              - PostgreSQL 连接串（有默认值）
  LLM_MODEL           - 指定模型（可选，有默认值）
"""

import asyncio
import asyncpg
import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, date
from pathlib import Path
import xml.etree.ElementTree as ET

try:
    import httpx
except ImportError:
    print("[fatal] 缺少 httpx，请先：pip install httpx asyncpg pyyaml")
    sys.exit(1)

try:
    import yaml
except ImportError:
    yaml = None  # 降级到内置列表

# ============================================================
# 配置
# ============================================================

PG_URL = os.environ.get("PG_URL", "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent")

# LLM 优先级：MiniMax 直连 > Gemini Gateway
_MINIMAX_KEY = os.environ.get("MINIMAX_API_KEY", "")
_GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
_GEMINI_BASE = os.environ.get("GEMINI_BASE_URL", "http://23.226.135.149:4000/v1")

if _MINIMAX_KEY:
    LLM_BASE_URL = "https://api.minimaxi.com/v1"
    LLM_API_KEY = _MINIMAX_KEY
    LLM_MODEL = os.environ.get("LLM_MODEL", "MiniMax-Text-01")
elif _GEMINI_KEY:
    LLM_BASE_URL = _GEMINI_BASE
    LLM_API_KEY = _GEMINI_KEY
    LLM_MODEL = os.environ.get("LLM_MODEL", "gemini-2.5-flash")
else:
    LLM_BASE_URL = ""
    LLM_API_KEY = ""
    LLM_MODEL = ""

# 安全检查：禁止通过明文 HTTP 发送 API Key（本机除外）
if LLM_BASE_URL and LLM_API_KEY:
    from urllib.parse import urlparse as _urlparse
    _parsed = _urlparse(LLM_BASE_URL)
    if _parsed.scheme == "http" and _parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        if not os.environ.get("ALLOW_INSECURE_LLM_GATEWAY"):
            print(f"[安全] 拒绝通过明文 HTTP 发送 API Key: {LLM_BASE_URL}")
            print("[安全] 设置 ALLOW_INSECURE_LLM_GATEWAY=1 可跳过此检查")
            LLM_BASE_URL = ""
            LLM_API_KEY = ""

# 内置 RSS 源（feeds.yml 不存在时的 fallback）
BUILTIN_FEEDS = [
    {"name": "Simon Willison", "url": "https://simonwillison.net/atom/everything/", "tags": ["ai", "blog"]},
    {"name": "Lilian Weng", "url": "https://lilianweng.github.io/index.xml", "tags": ["ai", "research"]},
]

# 每日限制
MAX_ITEMS_PER_DAY = 30
MAX_ITEMS_PER_FEED = 10    # 每个源最多处理条数
MAX_CONTENT_BYTES = 50_000  # 单条摘要上限 50KB
MAX_DAILY_BYTES = 2_000_000  # 每日总增量 2MB

# 抓取超时
HTTP_TIMEOUT = 15  # 秒

# ============================================================
# RSS 源加载
# ============================================================

def load_feeds() -> list[dict]:
    """优先从 feeds.yml 加载，fallback 到内置列表"""
    feeds_path = Path(__file__).parent / "feeds.yml"
    if feeds_path.exists() and yaml is not None:
        try:
            with open(feeds_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            feeds = data.get("feeds", [])
            print(f"[config] 从 feeds.yml 加载 {len(feeds)} 个源")
            return feeds
        except Exception as e:
            print(f"[warn] feeds.yml 解析失败，使用内置列表: {e}")
    elif feeds_path.exists() and yaml is None:
        print("[warn] 未安装 pyyaml，使用内置列表（pip install pyyaml 可启用 feeds.yml）")
    return BUILTIN_FEEDS


# ============================================================
# RSS/Atom 抓取与解析
# ============================================================

def _parse_ns(tag: str) -> str:
    """去掉 XML 命名空间前缀"""
    return tag.split("}")[-1] if "}" in tag else tag


def _extract_text(el) -> str:
    """提取元素的完整文本（包括 XHTML 子节点），处理 type=html/xhtml"""
    if el is None:
        return ""
    # 先尝试 itertext（覆盖 XHTML 子节点）
    full = "".join(el.itertext()).strip()
    if full:
        return full
    # fallback 到 .text
    return (el.text or "").strip()

def _text(elem, *tags) -> str:
    """在元素中找第一个匹配标签，返回文本（支持 XHTML）"""
    for tag in tags:
        child = elem.find(tag)
        if child is not None:
            t = _extract_text(child)
            if t:
                return t
        # 带命名空间的搜索
        for child in elem:
            if _parse_ns(child.tag) == tag:
                t = _extract_text(child)
                if t:
                    return t
    return ""


async def fetch_rss(url: str) -> list[dict]:
    """
    抓取 RSS/Atom 源，返回 [{title, link, description, pub_date}]
    支持 RSS 2.0 / Atom 1.0 格式
    """
    loop = asyncio.get_event_loop()

    def _fetch_sync():
        req = urllib.request.Request(url, headers={"User-Agent": "cc-agent/1.0 RSS reader"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="replace")

    try:
        xml_text = await loop.run_in_executor(None, _fetch_sync)
    except Exception as e:
        raise RuntimeError(f"抓取失败 {url}: {e}")

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise RuntimeError(f"XML 解析失败 {url}: {e}")

    items = []
    root_tag = _parse_ns(root.tag)

    if root_tag == "rss":
        # RSS 2.0 格式
        channel = root.find("channel")
        if channel is None:
            return []
        for item in channel.findall("item"):
            title = _text(item, "title") or "（无标题）"
            link = _text(item, "link") or ""
            desc = _text(item, "description") or ""
            pub = _text(item, "pubDate") or ""
            items.append({"title": title, "link": link, "description": desc, "pub_date": pub})

    elif root_tag == "feed":
        # Atom 1.0 格式 — 使用 Clark 记号匹配（兼容带/不带命名空间两种情况）
        # 从根标签推断命名空间
        atom_ns = ""
        if "}" in root.tag:
            atom_ns = root.tag.split("}")[0].lstrip("{")  # e.g. "http://www.w3.org/2005/Atom"

        def _atom(local: str) -> str:
            """返回带命名空间的 Clark 记号或裸标签"""
            return f"{{{atom_ns}}}{local}" if atom_ns else local

        for entry in root.findall(_atom("entry")):
            # 标题
            title_el = entry.find(_atom("title"))
            title = (title_el.text or "（无标题）").strip() if title_el is not None else "（无标题）"

            # 链接（优先 alternate 或 href 非空）
            link = ""
            for link_el in entry.findall(_atom("link")):
                href = link_el.get("href", "")
                if href:
                    rel = link_el.get("rel", "alternate")
                    link = href
                    if rel == "alternate":
                        break

            # 摘要或正文（只取前 2000 字）
            summary_el = (entry.find(_atom("summary"))
                          or entry.find(_atom("content")))
            desc = ""
            if summary_el is not None:
                desc = _extract_text(summary_el)[:2000]

            pub_el = (entry.find(_atom("updated"))
                      or entry.find(_atom("published")))
            pub = (pub_el.text or "").strip() if pub_el is not None else ""

            items.append({"title": title, "link": link, "description": desc, "pub_date": pub})
    else:
        raise RuntimeError(f"不支持的 XML 格式，根标签：{root_tag}")

    return items


# ============================================================
# LLM 摘要生成
# ============================================================

def _strip_think_tags(text: str) -> str:
    """去掉 MiniMax / 部分模型返回的 <think>...</think> 标签"""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


async def generate_summary(title: str, description: str) -> str:
    """
    调用 LLM 生成中文摘要（100 字以内）。
    失败时 fallback 到 description 前 200 字。
    """
    fallback = (description[:200] or title)[:200]

    if not LLM_API_KEY or not LLM_BASE_URL:
        print("  [warn] 无 LLM API Key，使用原文 fallback")
        return fallback

    prompt = f"""请用中文对以下内容生成一句话摘要，不超过100字，不要解释，直接输出摘要文字：

标题：{title}
内容：{description[:800]}"""

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{LLM_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 200,
                    "temperature": 0.3,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            summary = data["choices"][0]["message"]["content"].strip()
            summary = _strip_think_tags(summary)
            return summary if summary else fallback
    except Exception as e:
        print(f"  [warn] LLM 调用失败（{e}），使用原文 fallback")
        return fallback


# ============================================================
# 分块
# ============================================================

def simple_chunk(content: str, max_chars: int = 2000) -> list[str]:
    """
    按段落分块，每块不超过 max_chars 字符。
    遇到连续空行（段落边界）时拆分，超长段落强制切断。
    """
    paragraphs = re.split(r"\n{2,}", content.strip())
    chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        # 单个段落超长，强制切断
        while len(para) > max_chars:
            chunks.append(para[:max_chars])
            para = para[max_chars:]
        # 尝试合并到当前块
        if len(current) + len(para) + 2 <= max_chars:
            current = (current + "\n\n" + para).strip()
        else:
            if current:
                chunks.append(current)
            current = para

    if current:
        chunks.append(current)

    return chunks or [content[:max_chars]]


# ============================================================
# 写入 PG
# ============================================================

async def write_to_wiki(pool, path: str, title: str, content: str,
                        tags: list[str], content_hash: str) -> None:
    """
    写入 documents + document_chunks。
    documents.source_type='rss', trust_level='draft'
    """
    async with pool.acquire() as conn:
        # upsert document（path UNIQUE，理论上不会冲突，防守性处理）
        doc_id = await conn.fetchval("""
            INSERT INTO documents (path, title, content, tags, source_type, trust_level)
            VALUES ($1, $2, $3, $4, 'rss', 'draft')
            ON CONFLICT (path) DO UPDATE
              SET title = EXCLUDED.title,
                  content = EXCLUDED.content,
                  updated_at = now()
            RETURNING id
        """, path, title, content, tags)

        # 先删旧 chunks（upsert 场景）
        await conn.execute("DELETE FROM document_chunks WHERE doc_id = $1", doc_id)

        # 插入新 chunks
        chunks = simple_chunk(content)
        for idx, chunk_text in enumerate(chunks):
            await conn.execute("""
                INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb)
                VALUES ($1, $2, $3, $4)
            """, doc_id, idx, chunk_text, title)


# ============================================================
# 主流程
# ============================================================

async def run_ingest(dry_run: bool = False) -> dict:
    pool = await asyncpg.create_pool(PG_URL, min_size=1, max_size=3)
    feeds = load_feeds()

    today = date.today().isoformat()
    stats = {
        "fetched": 0,
        "new": 0,
        "skipped_dup": 0,
        "skipped_size": 0,
        "errors": 0,
    }
    daily_bytes = 0

    for feed in feeds:
        feed_name = feed.get("name", feed["url"])
        feed_tags = feed.get("tags", [])
        print(f"\n[feed] {feed_name} → {feed['url']}")

        try:
            items = await fetch_rss(feed["url"])
            print(f"  拿到 {len(items)} 条，处理前 {MAX_ITEMS_PER_FEED} 条")
        except Exception as e:
            print(f"  [error] 抓取失败: {e}")
            stats["errors"] += 1
            continue

        for item in items[:MAX_ITEMS_PER_FEED]:
            if stats["new"] >= MAX_ITEMS_PER_DAY:
                print("  [limit] 已达每日上限，停止")
                break
            if daily_bytes >= MAX_DAILY_BYTES:
                print("  [limit] 已达每日字节上限，停止")
                break

            stats["fetched"] += 1
            item_title = item["title"]

            # 1. 用 URL 做内容哈希去重（链接唯一）
            content_hash = hashlib.md5(item["link"].encode()).hexdigest()
            wiki_path = f"/wiki/auto/rss/{content_hash}"

            try:
                exists = await pool.fetchval(
                    "SELECT 1 FROM documents WHERE path = $1",
                    wiki_path
                )
            except Exception as e:
                print(f"  [error] 查重失败 ({item_title}): {e}")
                stats["errors"] += 1
                continue

            if exists:
                print(f"  [dup]  跳过（已存在）: {item_title[:50]}")
                stats["skipped_dup"] += 1
                continue

            # 2. LLM 摘要
            print(f"  [llm]  生成摘要: {item_title[:50]}")
            try:
                summary = await generate_summary(item_title, item.get("description", ""))
            except Exception as e:
                print(f"  [error] LLM 失败 ({item_title}): {e}")
                summary = (item.get("description", "") or item_title)[:200]

            # 3. 组装 wiki 页（只存摘要+元数据，不存原文）
            wiki_content = f"""# {item_title}

> 来源: [{feed_name}]({item["link"]})
> 采集时间: {today}
> 原文链接: {item["link"]}
> 内容哈希: {content_hash}
> 发布时间: {item.get("pub_date", "")}

## 摘要

{summary}
"""

            # 4. 容量检查
            content_size = len(wiki_content.encode())
            if content_size > MAX_CONTENT_BYTES:
                print(f"  [size] 跳过（单条超限 {content_size} bytes）: {item_title[:50]}")
                stats["skipped_size"] += 1
                continue

            if dry_run:
                print(f"  [dry-run] 会写入: {wiki_path}")
                print(f"            标题: {item_title[:60]}")
                print(f"            摘要: {summary[:80]}...")
                stats["new"] += 1
                daily_bytes += content_size
                continue

            # 5. 写入 PG
            try:
                await write_to_wiki(pool, wiki_path, item_title, wiki_content, feed_tags, content_hash)
                daily_bytes += content_size
                stats["new"] += 1
                print(f"  [ok]   已写入: {item_title[:50]}")
            except Exception as e:
                print(f"  [error] 写入失败 ({item_title}): {e}")
                stats["errors"] += 1

    # 6. 写入 daily digest
    if stats["new"] > 0 and not dry_run:
        digest_path = f"/wiki/auto/daily-digest-{today}"
        digest_content = (
            f"# 每日采集 {today}\n\n"
            f"- 新增: {stats['new']} 条\n"
            f"- 跳过重复: {stats['skipped_dup']} 条\n"
            f"- 跳过超限: {stats['skipped_size']} 条\n"
            f"- 错误: {stats['errors']} 条\n"
            f"- 总增量: {daily_bytes / 1024:.1f} KB\n"
        )
        try:
            await write_to_wiki(pool, digest_path, f"每日采集 {today}", digest_content, ["digest"], "")
            print(f"\n[digest] 已写入 {digest_path}")
        except Exception as e:
            print(f"\n[warn] digest 写入失败: {e}")

        # 7. 写入 agent_outbox 通知（不依赖飞书，由 outbox_worker 转发微信）
        try:
            await pool.execute(
                "INSERT INTO agent_outbox (event_type, payload) VALUES ($1, $2::jsonb)",
                "daily_ingest_completed",
                json.dumps(
                    {"date": today, "daily_bytes": daily_bytes, **stats},
                    ensure_ascii=False
                ),
            )
            print("[outbox] 通知已入队")
        except Exception as e:
            print(f"[warn] outbox 写入失败: {e}")

    await pool.close()
    return stats


# ============================================================
# 入口
# ============================================================

def main():
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("=" * 50)
        print("  [dry-run 模式] 只预览，不写入 PG")
        print("=" * 50)
    else:
        print("=" * 50)
        print("  每日知识采集管线 v1 开始运行")
        print("=" * 50)

    stats = asyncio.run(run_ingest(dry_run=dry_run))

    print("\n" + "=" * 50)
    print("  采集完成统计：")
    for k, v in stats.items():
        print(f"    {k}: {v}")
    print("=" * 50)

    # 有错误但也有成功 → 退出码 0（部分成功）
    # 全失败（new=0 且 errors>0）→ 退出码 1
    if stats["errors"] > 0 and stats["new"] == 0 and stats["fetched"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
