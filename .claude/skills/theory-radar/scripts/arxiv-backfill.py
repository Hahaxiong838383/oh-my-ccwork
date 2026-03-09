#!/usr/bin/env python3
"""
AI 前沿理论雷达 - 历史补录脚本
按月查询 arXiv，收集过去 N 个月的论文数据。
输出: /tmp/theory-radar-backfill.json
"""
import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ARXIV_API = "http://export.arxiv.org/api/query"
OUTPUT_FILE = "/tmp/theory-radar-backfill.json"

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}

# 复用 theory-radar 的查询策略
QUERIES = [
    {
        "label": "🧠 神经科学×语言模型",
        "query": 'cat:q-bio.NC AND (ti:language OR ti:neural OR ti:cognition OR ti:llm OR ti:transformer)',
        "max": 10,
    },
    {
        "label": "🔬 认知科学×AI理论",
        "query": 'cat:cs.AI AND (ti:cognitive OR ti:neuroscience OR ti:brain OR ti:behavior OR ti:consciousness)',
        "max": 10,
    },
    {
        "label": "💡 语言与认知计算",
        "query": 'cat:cs.CL AND (ti:cognitive OR ti:memory OR ti:reasoning OR ti:attention OR ti:behavior OR ti:neuroscience)',
        "max": 10,
    },
    {
        "label": "⚡ 神经网络×认知机制",
        "query": 'cat:cs.NE AND (ti:cognitive OR ti:memory OR ti:attention OR ti:reasoning OR ti:behavior)',
        "max": 10,
    },
    {
        "label": "🔢 前沿算法×AI理论",
        "query": 'cat:cs.LG AND (ti:algorithm OR ti:optimization OR ti:convergence OR ti:complexity OR ti:efficient OR ti:approximation OR ti:generalization)',
        "max": 10,
    },
    {
        "label": "📐 算法理论×机器学习",
        "query": 'cat:stat.ML AND (ti:algorithm OR ti:optimization OR ti:sample OR ti:bound OR ti:convergence OR ti:regret OR ti:complexity)',
        "max": 10,
    },
    {
        "label": "🤖 Agent能力评测",
        "query": 'cat:cs.AI AND (ti:benchmark OR ti:evaluation OR ti:agent OR ti:skill OR ti:capability OR ti:assessment OR ti:task)',
        "max": 10,
    },
]

RELEVANCE_KEYWORDS = [
    "cognitive", "cognition", "neuroscience", "neural", "brain", "memory",
    "attention", "reasoning", "behavior", "behaviour", "consciousness",
    "perception", "learning", "language model", "llm", "transformer",
    "reinforcement", "embodied", "intelligence",
    "algorithm", "optimization", "convergence", "complexity", "generalization",
    "approximation", "gradient", "sample efficiency", "regret", "bound",
    "benchmark", "evaluation", "agent", "skill", "capability", "assessment",
    "task", "agent skills", "llm agent",
]


def fetch_arxiv_month(query: str, year: int, month: int, max_results: int = 10) -> list:
    """查询 arXiv 指定月份的论文"""
    # 计算月份范围
    start = f"{year}{month:02d}01"
    if month == 12:
        end = f"{year + 1}0101"
    else:
        end = f"{year}{month + 1:02d}01"

    # arXiv 支持 submittedDate 范围查询
    date_filter = f"submittedDate:[{start} TO {end}]"
    full_query = f"{query} AND {date_filter}"

    params = {
        "search_query": full_query,
        "sortBy": "relevance",
        "sortOrder": "descending",
        "max_results": max_results * 2,
    }
    url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "cc-theory-radar-backfill/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            xml_text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"  [WARN] fetch failed: {e}", file=sys.stderr)
        return []

    root = ET.fromstring(xml_text)
    papers = []

    for entry in root.findall("atom:entry", NS):
        title_el = entry.find("atom:title", NS)
        summary_el = entry.find("atom:summary", NS)
        published_el = entry.find("atom:published", NS)
        id_el = entry.find("atom:id", NS)

        if not all([title_el is not None, summary_el is not None,
                    published_el is not None, id_el is not None]):
            continue

        title = title_el.text.strip().replace("\n", " ")
        abstract = summary_el.text.strip().replace("\n", " ")
        published_str = published_el.text.strip()
        arxiv_url = id_el.text.strip()
        arxiv_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else arxiv_url

        authors = [
            a.find("atom:name", NS).text
            for a in entry.findall("atom:author", NS)
            if a.find("atom:name", NS) is not None
        ]

        categories = [
            c.get("term", "")
            for c in entry.findall("atom:category", NS)
        ]

        combined = (title + " " + abstract).lower()
        if not any(kw in combined for kw in RELEVANCE_KEYWORDS):
            continue

        papers.append({
            "title": title,
            "authors": authors[:3],
            "abstract": abstract[:600],
            "arxiv_id": arxiv_id,
            "url": f"https://arxiv.org/abs/{arxiv_id}",
            "published": published_str[:10],
            "categories": categories[:3],
            "section": "",  # will be set by caller
        })

        if len(papers) >= max_results:
            break

    return papers


def deduplicate(all_papers: list) -> list:
    seen = set()
    result = []
    for p in all_papers:
        if p["arxiv_id"] not in seen:
            seen.add(p["arxiv_id"])
            result.append(p)
    return result


def main():
    # 过去 6 个月：2025-09 到 2026-02
    months = []
    for y in [2025, 2026]:
        for m in range(1, 13):
            if (y == 2025 and m >= 9) or (y == 2026 and m <= 2):
                months.append((y, m))

    print(f"[INFO] 准备抓取 {len(months)} 个月: {months}", file=sys.stderr)

    all_monthly = {}

    for year, month in months:
        month_key = f"{year}-{month:02d}"
        print(f"\n[INFO] === {month_key} ===", file=sys.stderr)
        month_papers = []

        for section in QUERIES:
            print(f"  搜索: {section['label']}", file=sys.stderr)
            papers = fetch_arxiv_month(section["query"], year, month, section["max"])
            for p in papers:
                p["section"] = section["label"]
            month_papers.extend(papers)
            print(f"    找到 {len(papers)} 篇", file=sys.stderr)
            time.sleep(3)  # arXiv 限速

        unique = deduplicate(month_papers)
        all_monthly[month_key] = unique
        print(f"  [INFO] {month_key} 去重后: {len(unique)} 篇", file=sys.stderr)

    # 汇总
    total = sum(len(v) for v in all_monthly.values())
    result = {
        "generated_at": datetime.now().isoformat(),
        "months": {k: v for k, v in all_monthly.items()},
        "total": total,
        "month_counts": {k: len(v) for k, v in all_monthly.items()},
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n[DONE] 总计 {total} 篇，已保存至 {OUTPUT_FILE}", file=sys.stderr)
    # 打印月度统计
    for k, v in result["month_counts"].items():
        print(f"  {k}: {v} 篇", file=sys.stderr)


if __name__ == "__main__":
    main()
