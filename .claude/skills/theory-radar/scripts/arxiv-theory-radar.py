#!/usr/bin/env python3
"""
AI 前沿理论雷达 - 每日 08:00 执行
监控领域: 脑科学×LLM、认知科学×AI、神经科学×计算、行为学×语言模型
数据源: arXiv API (免费，无需 API key)
输出: /tmp/theory-radar-data.json
"""
import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
ARXIV_API = "http://export.arxiv.org/api/query"
GRAPH_PATH = Path(__file__).parent.parent.parent.parent.parent / "tasks" / "theory-radar" / "graph.json"

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


def fetch_arxiv(query: str, max_results: int = 5) -> list:
    """查询 arXiv API，返回最近 3 天内的论文列表"""
    params = {
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": max_results * 2,  # 多取一些，过滤后选最优
    }
    url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "cc-theory-radar/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            xml_text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"[WARN] arXiv fetch failed ({query[:40]}): {e}", file=sys.stderr)
        return []

    root = ET.fromstring(xml_text)
    papers = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=3)

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


def deduplicate(all_papers: list) -> list:
    """按 arxiv_id 去重"""
    seen = set()
    result = []
    for p in all_papers:
        if p["arxiv_id"] not in seen:
            seen.add(p["arxiv_id"])
            result.append(p)
    return result


def main():
    now = datetime.now(BJ_TZ)
    result = {
        "date": now.strftime("%Y-%m-%d"),
        "generated_at": now.isoformat(),
        "total": 0,
        "sections": [],
    }

    all_papers_flat = []

    for section in QUERIES:
        print(f"[INFO] 搜索: {section['label']}", file=sys.stderr)
        papers = fetch_arxiv(section["query"], section["max"])
        time.sleep(3)  # arXiv 限速：建议 3s 间隔
        result["sections"].append({
            "label": section["label"],
            "papers": papers,
        })
        all_papers_flat.extend(papers)
        print(f"[INFO]   找到 {len(papers)} 篇", file=sys.stderr)

    # 去重后计算总数
    unique_papers = deduplicate(all_papers_flat)
    unique_count = len(unique_papers)
    result["total"] = unique_count

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
