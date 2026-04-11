#!/usr/bin/env python3
"""
知识库入库脚本 — 标准化文章归档流程

用法：
  # 从 URL 抓取并入库
  python3 ingest.py --url "https://mp.weixin.qq.com/s/xxx"

  # 从已有 Markdown 文件入库
  python3 ingest.py --file "/path/to/article.md" --title "文章标题"

  # 直接传入内容（管道模式）
  echo "文章内容" | python3 ingest.py --stdin --title "标题" --tags "AI,设计"

  # 指定额外标签
  python3 ingest.py --url "..." --tags "AI工具,UI设计,Google"

输出 JSON：
  {"ok": true, "path": "/wiki/articles/...", "chunks": 7, "title": "..."}
"""

import sys
import os
import re
import json
import subprocess
import html
from datetime import datetime
from pathlib import Path

# ─── 配置 ────────────────────────────────────────────────────

PG_URL = os.environ.get("PG_URL", "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent")
MYCC_ROOT = os.environ.get("MYCC_ROOT", str(Path(__file__).resolve().parents[4]))
FETCH_SCRIPT = os.path.join(MYCC_ROOT, ".claude/skills/read-gzh/scripts/fetch_wechat_article.py")
INBOX_DIR = os.path.join(MYCC_ROOT, "1-Inbox")

# ─── URL 抓取 ────────────────────────────────────────────────

WECHAT_UA = "Mozilla/5.0 (Linux; Android 13; V2148A) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600 WeChat/arm64 Weixin NetType/WIFI Language/zh_CN"


def fetch_wechat(url: str) -> dict:
    """微信公众号专用抓取"""
    if os.path.exists(FETCH_SCRIPT):
        result = subprocess.run(
            ["python3", FETCH_SCRIPT, url, "--json"],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return data
    raise RuntimeError("微信抓取脚本不可用")


def fetch_general(url: str) -> dict:
    """通用网页抓取（用 curl + HTML strip）"""
    result = subprocess.run(
        ["curl", "-s", "-L", "-A", WECHAT_UA, "--max-time", "15", url],
        capture_output=True, text=True, timeout=20
    )
    raw = result.stdout
    if not raw:
        raise RuntimeError(f"curl 返回空内容")

    # 提取标题
    title = ""
    m = re.search(r'<title>([^<]+)</title>', raw, re.IGNORECASE)
    if m:
        title = html.unescape(m.group(1).strip())

    # og:title 备用
    if not title:
        m = re.search(r'property="og:title" content="([^"]+)"', raw)
        if m:
            title = html.unescape(m.group(1))

    # 提取正文
    content = html_to_text(raw)

    return {"title": title, "content": content, "url": url, "images": []}


def html_to_text(raw: str) -> str:
    """HTML → 纯文本"""
    text = raw
    text = re.sub(r'<script[\s\S]*?</script>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<head[\s\S]*?</head>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<nav[\s\S]*?</nav>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<footer[\s\S]*?</footer>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</?(?:p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def fetch_url(url: str) -> dict:
    """统一入口：自动识别 URL 类型并分流抓取"""
    if "mp.weixin.qq.com" in url:
        try:
            return fetch_wechat(url)
        except Exception as e:
            print(f"[warn] 微信抓取失败: {e}，降级通用方案", file=sys.stderr)
    return fetch_general(url)


# ─── 内容分块 ────────────────────────────────────────────────

def chunk_content(content: str, max_chunk: int = 2000) -> list[dict]:
    """按章节/段落分块，返回 [{content, header_breadcrumb}]"""
    chunks = []

    # 尝试按 ## 标题分割
    sections = re.split(r'\n(?=## )', content)
    if len(sections) > 1:
        for section in sections:
            header = ""
            m = re.match(r'## (.+)', section)
            if m:
                header = m.group(1).strip()

            text = section.strip()
            if not text or len(text) < 10:
                continue

            # 如果单节过长，再按段落拆
            if len(text) > max_chunk:
                paras = text.split('\n\n')
                buf = ""
                for para in paras:
                    if len(buf) + len(para) > max_chunk and buf:
                        chunks.append({"content": buf.strip(), "header": header})
                        buf = ""
                    buf += para + "\n\n"
                if buf.strip():
                    chunks.append({"content": buf.strip(), "header": header})
            else:
                chunks.append({"content": text, "header": header})
    else:
        # 无标题结构，按段落分块
        paras = content.split('\n\n')
        buf = ""
        for para in paras:
            if len(buf) + len(para) > max_chunk and buf:
                chunks.append({"content": buf.strip(), "header": ""})
                buf = ""
            buf += para + "\n\n"
        if buf.strip():
            chunks.append({"content": buf.strip(), "header": ""})

    return chunks


# ─── PG 入库 ─────────────────────────────────────────────────

def ingest_to_pg(title: str, content: str, path: str, tags: list[str], source_type: str = "article") -> dict:
    """写入 PG 知识库（documents + document_chunks）"""
    try:
        import pg8000
        conn = pg8000.connect(
            host="127.0.0.1", port=5433,
            user="cc", password="ccagent2026", database="cc_agent"
        )
    except ImportError:
        # 降级用 psql 命令行
        return _ingest_via_psql(title, content, path, tags, source_type)

    try:
        cur = conn.cursor()

        # upsert document
        cur.execute("""
            INSERT INTO documents (path, title, content, tags, source_type, trust_level)
            VALUES (%s, %s, %s, %s, %s, 'verified')
            ON CONFLICT (path) DO UPDATE
              SET content = EXCLUDED.content, title = EXCLUDED.title,
                  tags = EXCLUDED.tags, updated_at = now()
            RETURNING id
        """, (path, title, content, tags, source_type))
        doc_id = cur.fetchone()[0]

        # 删除旧 chunks
        cur.execute("DELETE FROM document_chunks WHERE doc_id = %s", (doc_id,))

        # 分块写入
        chunks = chunk_content(content)
        for i, chunk in enumerate(chunks):
            cur.execute(
                "INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb) VALUES (%s, %s, %s, %s)",
                (doc_id, i, chunk["content"], chunk["header"] or None)
            )

        conn.commit()
        return {"ok": True, "path": path, "chunks": len(chunks), "title": title}
    except Exception as e:
        conn.rollback()
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


def _ingest_via_psql(title: str, content: str, path: str, tags: list[str], source_type: str) -> dict:
    """用 psql 命令行入库（不需要 Python PG 驱动）"""
    tags_sql = "{" + ",".join(tags) + "}"

    # 转义单引号
    title_esc = title.replace("'", "''")
    content_esc = content.replace("'", "''")
    path_esc = path.replace("'", "''")

    # 写入 document
    sql_doc = f"""
INSERT INTO documents (path, title, content, tags, source_type, trust_level)
VALUES ('{path_esc}', '{title_esc}', '{content_esc}', '{tags_sql}', '{source_type}', 'verified')
ON CONFLICT (path) DO UPDATE
  SET content = EXCLUDED.content, title = EXCLUDED.title, tags = EXCLUDED.tags, updated_at = now()
RETURNING id;
"""
    env = os.environ.copy()
    env["PGPASSWORD"] = "ccagent2026"

    result = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "cc", "-d", "cc_agent",
         "-t", "-A", "-c", sql_doc],
        capture_output=True, text=True, env=env, timeout=10
    )
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr.strip()}

    doc_id = result.stdout.strip()
    if not doc_id:
        return {"ok": False, "error": "no doc_id returned"}

    # 删除旧 chunks
    subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "cc", "-d", "cc_agent",
         "-c", f"DELETE FROM document_chunks WHERE doc_id = '{doc_id}';"],
        capture_output=True, text=True, env=env, timeout=10
    )

    # 分块写入
    chunks = chunk_content(content)
    for i, chunk in enumerate(chunks):
        c_esc = chunk["content"].replace("'", "''")
        h_esc = (chunk["header"] or "").replace("'", "''")
        h_val = f"'{h_esc}'" if chunk["header"] else "NULL"
        sql_chunk = f"INSERT INTO document_chunks (doc_id, chunk_index, content, header_breadcrumb) VALUES ('{doc_id}', {i}, '{c_esc}', {h_val});"
        subprocess.run(
            ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "cc", "-d", "cc_agent",
             "-c", sql_chunk],
            capture_output=True, text=True, env=env, timeout=10
        )

    return {"ok": True, "path": path, "chunks": len(chunks), "title": title}


# ─── Markdown 文件保存 ───────────────────────────────────────

def save_markdown(title: str, content: str, source_url: str, tags: list[str]) -> str:
    """保存到 1-Inbox 目录，返回文件路径"""
    date = datetime.now().strftime("%Y-%m-%d")
    slug = re.sub(r'[^\w\u4e00-\u9fff-]', '', title.replace(' ', '-'))[:40]
    filename = f"{date}-{slug}.md"
    filepath = os.path.join(INBOX_DIR, filename)

    md = f"""# {title}

> 来源：{source_url}
> 采集时间：{date}
> 标签：{', '.join(tags)}

---

{content}

---

*cc 自动归档 | {date}*
"""
    Path(filepath).write_text(md, encoding="utf-8")
    return filepath


# ─── 主入口 ──────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="知识库入库脚本")
    parser.add_argument("--url", help="文章 URL")
    parser.add_argument("--file", help="Markdown 文件路径")
    parser.add_argument("--stdin", action="store_true", help="从 stdin 读取内容")
    parser.add_argument("--title", help="文章标题（file/stdin 模式必填）")
    parser.add_argument("--tags", default="", help="逗号分隔的标签")
    parser.add_argument("--source-url", default="", help="原始链接（file/stdin 模式可选）")
    parser.add_argument("--no-file", action="store_true", help="不保存 Markdown 文件")
    parser.add_argument("--content", help="直接传入内容文本")
    args = parser.parse_args()

    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    # ─── 获取内容 ─────────────────────────────────────────────
    if args.url:
        data = fetch_url(args.url)
        title = args.title or data.get("title", "")
        content = data.get("content", "")
        source_url = args.url
        images = data.get("images", [])

        if not title:
            title = f"未命名文章-{datetime.now().strftime('%Y%m%d-%H%M')}"

        # 如果正文太短（可能是图片文章），标记
        if len(content) < 50 and images:
            content = f"[图片文章] 共 {len(images)} 张配图，需视觉模型阅读后补充内容。\n\n原始描述：{data.get('description', '无')}"

    elif args.file:
        if not args.title:
            print(json.dumps({"ok": False, "error": "--title required for --file mode"}))
            sys.exit(1)
        title = args.title
        content = Path(args.file).read_text(encoding="utf-8")
        source_url = args.source_url or f"file://{args.file}"

    elif args.stdin:
        if not args.title:
            print(json.dumps({"ok": False, "error": "--title required for --stdin mode"}))
            sys.exit(1)
        title = args.title
        content = sys.stdin.read()
        source_url = args.source_url or "stdin"

    elif args.content:
        if not args.title:
            print(json.dumps({"ok": False, "error": "--title required for --content mode"}))
            sys.exit(1)
        title = args.title
        content = args.content
        source_url = args.source_url or "direct"

    else:
        parser.print_help()
        sys.exit(1)

    if not content.strip():
        print(json.dumps({"ok": False, "error": "内容为空"}))
        sys.exit(1)

    # ─── 生成 wiki 路径 ──────────────────────────────────────
    date = datetime.now().strftime("%Y-%m-%d")
    slug = re.sub(r'[^\w\u4e00-\u9fff-]', '', title.replace(' ', '-').replace(':', '-'))[:40]
    wiki_path = f"/wiki/articles/{date}-{slug}"

    # ─── 入库 ────────────────────────────────────────────────
    result = ingest_to_pg(title, content, wiki_path, tags, source_type="article")

    # ─── 保存 Markdown 文件 ──────────────────────────────────
    if not args.no_file and result.get("ok"):
        try:
            md_path = save_markdown(title, content, source_url, tags)
            result["markdown_path"] = md_path
        except Exception as e:
            result["markdown_error"] = str(e)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
