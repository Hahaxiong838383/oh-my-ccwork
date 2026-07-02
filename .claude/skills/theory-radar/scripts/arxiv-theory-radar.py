#!/usr/bin/env python3
"""
AI 前沿理论雷达 - 每日 08:00 执行
监控领域: 脑科学×LLM、认知科学×AI、神经科学×计算、行为学×语言模型
数据源: arXiv API (免费，无需 API key)
输出: /tmp/theory-radar-data.json
"""
import json
import os
import random
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# 加载 graph_builder（与本脚本同目录）
sys.path.insert(0, str(Path(__file__).parent))
try:
    from graph_builder import TheoryGraphBuilder
    _GRAPH_ENABLED = True
except ImportError:
    _GRAPH_ENABLED = False
    print("[WARN] graph_builder 未找到，跳过知识图谱功能", file=sys.stderr)

BJ_TZ = timezone(timedelta(hours=8))
OUTPUT_FILE = "/tmp/theory-radar-data.json"
ARXIV_API_ENDPOINTS = [
    endpoint.strip().rstrip("/")
    for endpoint in os.getenv(
        "THEORY_RADAR_ARXIV_ENDPOINTS",
        "https://export.arxiv.org/api/query,http://export.arxiv.org/api/query",
    ).split(",")
    if endpoint.strip()
]
ARXIV_USER_AGENT = os.getenv(
    "THEORY_RADAR_USER_AGENT",
    "cc-theory-radar/1.1 (+https://multica.cli4.hahaxiong.cc/settings)",
)
ARXIV_TIMEOUT = float(os.getenv("THEORY_RADAR_ARXIV_TIMEOUT", "25"))
ARXIV_MAX_ATTEMPTS = int(os.getenv("THEORY_RADAR_ARXIV_MAX_ATTEMPTS", "3"))
ARXIV_REQUEST_INTERVAL = float(os.getenv("THEORY_RADAR_ARXIV_INTERVAL", "5"))
ARXIV_RETRY_BASE_DELAY = float(os.getenv("THEORY_RADAR_ARXIV_RETRY_BASE_DELAY", "8"))
RECENT_DAYS = int(os.getenv("THEORY_RADAR_DAYS", "3"))
FALLBACK_DAYS = int(os.getenv("THEORY_RADAR_FALLBACK_DAYS", "7"))
GRAPH_PATH = Path(__file__).parent.parent.parent.parent.parent / "tasks" / "theory-radar" / "graph.json"
FETCH_ERRORS = []

# arXiv XML 命名空间
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}

# 搜索策略：多维度覆盖脑科学/认知/行为 × LLM 交叉领域
QUERIES = [
    {
        "label": "🧠 神经科学×语言模型",
        "query": 'cat:q-bio.NC AND (ti:language OR ti:neural OR ti:cognition OR ti:llm OR ti:transformer)',
        "max": 5,
    },
    {
        "label": "🔬 认知科学×AI理论",
        "query": 'cat:cs.AI AND (ti:cognitive OR ti:neuroscience OR ti:brain OR ti:behavior OR ti:consciousness)',
        "max": 5,
    },
    {
        "label": "💡 语言与认知计算",
        "query": 'cat:cs.CL AND (ti:cognitive OR ti:memory OR ti:reasoning OR ti:attention OR ti:behavior OR ti:neuroscience)',
        "max": 5,
    },
    {
        "label": "⚡ 神经网络×认知机制",
        "query": 'cat:cs.NE AND (ti:cognitive OR ti:memory OR ti:attention OR ti:reasoning OR ti:behavior)',
        "max": 5,
    },
    {
        "label": "🔢 前沿算法×AI理论",
        "query": 'cat:cs.LG AND (ti:algorithm OR ti:optimization OR ti:convergence OR ti:complexity OR ti:efficient OR ti:approximation OR ti:generalization)',
        "max": 5,
    },
    {
        "label": "📐 算法理论×机器学习",
        "query": 'cat:stat.ML AND (ti:algorithm OR ti:optimization OR ti:sample OR ti:bound OR ti:convergence OR ti:regret OR ti:complexity)',
        "max": 5,
    },
    {
        "label": "🤖 Agent能力评测",
        "query": 'cat:cs.AI AND (ti:benchmark OR ti:evaluation OR ti:agent OR ti:skill OR ti:capability OR ti:assessment OR ti:task)',
        "max": 5,
    },
]

# ── 专家追踪列表 ──────────────────────────────────────────────────────────────
# 按作者搜索（arXiv au: 字段），不受 RELEVANCE_KEYWORDS 过滤
EXPERT_QUERIES = [
    {
        "label": "👤 专家追踪",
        "authors": [
            ("Fei-Fei Li", "李飞飞"),
            ("Yann LeCun", "杨立昆"),
            ("Geoffrey Hinton", "辛顿"),
            ("Yoshua Bengio", "本吉奥"),
            ("Demis Hassabis", "哈萨比斯"),
            ("Ilya Sutskever", "Ilya"),
        ],
        "days": 180,  # 回溯 6 个月
        "max_per_author": 5,
    },
]

# 关键词过滤：abstract 中必须包含至少一个（提升相关性）
RELEVANCE_KEYWORDS = [
    "cognitive", "cognition", "neuroscience", "neural", "brain", "memory",
    "attention", "reasoning", "behavior", "behaviour", "consciousness",
    "perception", "learning", "language model", "llm", "transformer",
    "reinforcement", "embodied", "intelligence",
    # 前沿算法相关
    "algorithm", "optimization", "convergence", "complexity", "generalization",
    "approximation", "gradient", "sample efficiency", "regret", "bound",
    # Agent能力评测相关
    "benchmark", "evaluation", "agent", "skill", "capability", "assessment",
    "task", "agent skills", "llm agent",
]


def _retry_delay(exc, attempt: int) -> float:
    retry_after = None
    if isinstance(exc, urllib.error.HTTPError):
        retry_after = exc.headers.get("Retry-After")
    if retry_after:
        try:
            return min(float(retry_after), 90.0)
        except ValueError:
            pass
    return min(ARXIV_RETRY_BASE_DELAY * (2 ** (attempt - 1)), 60.0) + random.uniform(0.5, 2.5)


def _is_retryable(exc) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in {429, 500, 502, 503, 504}
    return isinstance(exc, (urllib.error.URLError, TimeoutError, socket.timeout))


def fetch_arxiv_xml(params: dict, label: str) -> Optional[str]:
    """Fetch arXiv Atom XML with HTTPS-first endpoint fallback and bounded backoff."""
    query = urllib.parse.urlencode(params)
    last_error = None
    for endpoint in ARXIV_API_ENDPOINTS:
        url = f"{endpoint}?{query}"
        for attempt in range(1, max(1, ARXIV_MAX_ATTEMPTS) + 1):
            req = urllib.request.Request(url, headers={"User-Agent": ARXIV_USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=ARXIV_TIMEOUT) as resp:
                    return resp.read().decode("utf-8")
            except Exception as exc:
                last_error = exc
                err_text = f"{type(exc).__name__}: {exc}"
                if isinstance(exc, urllib.error.HTTPError):
                    err_text = f"HTTP {exc.code}: {exc.reason}"
                print(
                    f"[WARN] arXiv fetch failed ({label}, endpoint={endpoint}, attempt={attempt}/{ARXIV_MAX_ATTEMPTS}): {err_text}",
                    file=sys.stderr,
                )
                if attempt < ARXIV_MAX_ATTEMPTS and _is_retryable(exc):
                    time.sleep(_retry_delay(exc, attempt))
                    continue
                break

    FETCH_ERRORS.append({
        "label": label,
        "params": params,
        "error": str(last_error) if last_error else "unknown",
    })
    return None


def fetch_arxiv(query: str, max_results: int = 5, days: int = RECENT_DAYS) -> list:
    """查询 arXiv API，返回最近 3 天内的论文列表"""
    params = {
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": max_results * 2,  # 多取一些，过滤后选最优
    }
    xml_text = fetch_arxiv_xml(params, query[:80])
    if not xml_text:
        return []

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        FETCH_ERRORS.append({"label": query[:80], "params": params, "error": f"XML parse: {e}"})
        print(f"[WARN] arXiv XML parse failed ({query[:40]}): {e}", file=sys.stderr)
        return []
    papers = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    for entry in root.findall("atom:entry", NS):
        title_el = entry.find("atom:title", NS)
        summary_el = entry.find("atom:summary", NS)
        published_el = entry.find("atom:published", NS)
        id_el = entry.find("atom:id", NS)

        if not all([title_el is not None, summary_el is not None, published_el is not None, id_el is not None]):
            continue

        title = title_el.text.strip().replace("\n", " ")
        abstract = summary_el.text.strip().replace("\n", " ")
        published_str = published_el.text.strip()
        arxiv_url = id_el.text.strip()
        arxiv_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else arxiv_url

        # 日期过滤：只取近 3 天
        try:
            published_dt = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
            if published_dt < cutoff:
                continue
        except ValueError:
            pass

        # 作者
        authors = [
            a.find("atom:name", NS).text
            for a in entry.findall("atom:author", NS)
            if a.find("atom:name", NS) is not None
        ]

        # 分类
        categories = [
            c.get("term", "")
            for c in entry.findall("atom:category", NS)
        ]

        # 相关性过滤：title 或 abstract 必须包含关键词
        combined = (title + " " + abstract).lower()
        if not any(kw in combined for kw in RELEVANCE_KEYWORDS):
            continue

        papers.append({
            "title": title,
            "authors": authors[:3],  # 最多3位作者
            "abstract": abstract[:600],  # 截取前600字
            "arxiv_id": arxiv_id,
            "url": f"https://arxiv.org/abs/{arxiv_id}",
            "published": published_str[:10],
            "categories": categories[:3],
        })

        if len(papers) >= max_results:
            break

    return papers


def fetch_arxiv_by_author(author_en: str, author_cn: str, max_results: int = 5, days: int = 180) -> list:
    """按作者名查询 arXiv，返回最近 N 天内的论文列表（不受关键词过滤）"""
    query = f'au:"{author_en}"'
    params = {
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": max_results * 3,
    }
    xml_text = fetch_arxiv_xml(params, f"author:{author_en}")
    if not xml_text:
        return []

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        FETCH_ERRORS.append({"label": f"author:{author_en}", "params": params, "error": f"XML parse: {e}"})
        print(f"[WARN] arXiv author XML parse failed ({author_en}): {e}", file=sys.stderr)
        return []
    papers = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    for entry in root.findall("atom:entry", NS):
        title_el = entry.find("atom:title", NS)
        summary_el = entry.find("atom:summary", NS)
        published_el = entry.find("atom:published", NS)
        id_el = entry.find("atom:id", NS)

        if not all([title_el is not None, summary_el is not None, published_el is not None, id_el is not None]):
            continue

        title = title_el.text.strip().replace("\n", " ")
        abstract = summary_el.text.strip().replace("\n", " ")
        published_str = published_el.text.strip()
        arxiv_url = id_el.text.strip()
        arxiv_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else arxiv_url

        try:
            published_dt = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
            if published_dt < cutoff:
                continue
        except ValueError:
            pass

        authors = [
            a.find("atom:name", NS).text
            for a in entry.findall("atom:author", NS)
            if a.find("atom:name", NS) is not None
        ]

        categories = [
            c.get("term", "")
            for c in entry.findall("atom:category", NS)
        ]

        papers.append({
            "title": title,
            "authors": authors[:5],
            "abstract": abstract[:600],
            "arxiv_id": arxiv_id,
            "url": f"https://arxiv.org/abs/{arxiv_id}",
            "published": published_str[:10],
            "categories": categories[:3],
            "tracked_expert": f"{author_cn} ({author_en})",
        })

        if len(papers) >= max_results:
            break

    return papers


def deduplicate(all_papers: list) -> list:
    """按 arxiv_id 去重"""
    seen = set()
    result = []
    for p in all_papers:
        if p["arxiv_id"] not in seen:
            seen.add(p["arxiv_id"])
            result.append(p)
    return result


def collect_papers(days: int) -> tuple[list, list]:
    sections = []
    all_papers_flat = []

    for section in QUERIES:
        print(f"[INFO] 搜索: {section['label']}", file=sys.stderr)
        papers = fetch_arxiv(section["query"], section["max"], days=days)
        time.sleep(ARXIV_REQUEST_INTERVAL)  # arXiv 限速：官方建议至少 3s 间隔
        sections.append({
            "label": section["label"],
            "papers": papers,
        })
        all_papers_flat.extend(papers)
        print(f"[INFO]   找到 {len(papers)} 篇", file=sys.stderr)

    # ── 专家追踪 ──────────────────────────────────────────────────────────────
    for expert_section in EXPERT_QUERIES:
        for author_en, author_cn in expert_section["authors"]:
            print(f"[INFO] 专家追踪: {author_cn} ({author_en})", file=sys.stderr)
            papers = fetch_arxiv_by_author(
                author_en, author_cn,
                max_results=expert_section["max_per_author"],
                days=expert_section["days"],
            )
            time.sleep(ARXIV_REQUEST_INTERVAL)
            if papers:
                sections.append({
                    "label": f"👤 {author_cn}",
                    "papers": papers,
                })
                all_papers_flat.extend(papers)
                print(f"[INFO]   找到 {len(papers)} 篇", file=sys.stderr)
            else:
                print(f"[INFO]   无近期论文", file=sys.stderr)

    return sections, all_papers_flat


def main():
    now = datetime.now(BJ_TZ)
    result = {
        "date": now.strftime("%Y-%m-%d"),
        "generated_at": now.isoformat(),
        "total": 0,
        "sections": [],
        "arxiv": {
            "endpoints": ARXIV_API_ENDPOINTS,
            "days": RECENT_DAYS,
            "request_interval_seconds": ARXIV_REQUEST_INTERVAL,
            "max_attempts": ARXIV_MAX_ATTEMPTS,
            "fetch_errors": [],
        },
    }

    sections, all_papers_flat = collect_papers(RECENT_DAYS)

    # 去重后计算总数
    unique_papers = deduplicate(all_papers_flat)
    if not unique_papers and FALLBACK_DAYS > RECENT_DAYS:
        print(f"[WARN] 近 {RECENT_DAYS} 天抓取为 0，扩大到 {FALLBACK_DAYS} 天重试", file=sys.stderr)
        sections, all_papers_flat = collect_papers(FALLBACK_DAYS)
        unique_papers = deduplicate(all_papers_flat)
        result["arxiv"]["days"] = FALLBACK_DAYS

    unique_count = len(unique_papers)
    result["total"] = unique_count
    result["sections"] = sections
    result["arxiv"]["fetch_errors"] = FETCH_ERRORS

    # ── 知识图谱构建（增量） ───────────────────────────────────────────────────
    graph_data = {"enabled": False, "hot_clusters": [], "key_authors": [], "total_nodes": 0, "total_edges": 0}
    if _GRAPH_ENABLED:
        try:
            print("[INFO] 构建知识图谱...", file=sys.stderr)
            graph = TheoryGraphBuilder(graph_path=GRAPH_PATH)
            graph.load()
            for paper in unique_papers:
                graph.add_paper(paper)
            graph.save()
            hot_clusters = graph.get_hot_clusters(top_n=3)
            key_authors = graph.get_key_authors(top_n=5)
            graph_data = {
                "enabled": True,
                "hot_clusters": hot_clusters,
                "key_authors": key_authors,
                "total_nodes": graph.graph.number_of_nodes(),
                "total_edges": graph.graph.number_of_edges(),
            }
            print(f"[INFO] 图谱更新完成：{graph_data['total_nodes']} 节点，{graph_data['total_edges']} 边，{len(hot_clusters)} 个热点簇", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] 知识图谱构建失败：{e}", file=sys.stderr)

    result["graph"] = graph_data

    with open(OUTPUT_FILE, "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n[INFO] 共找到 {unique_count} 篇不重复论文，已保存至 {OUTPUT_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
