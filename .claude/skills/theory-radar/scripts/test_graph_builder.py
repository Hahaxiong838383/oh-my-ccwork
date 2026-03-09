#!/usr/bin/env python3
"""
TheoryGraphBuilder 验收测试（适配 Codex 实现版本）
运行：python test_graph_builder.py
不依赖 pytest，纯 stdlib + networkx。
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from graph_builder import TheoryGraphBuilder

PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
_failures = []


def check(name, condition, detail=""):
    if condition:
        print(f"  {PASS} {name}")
    else:
        msg = f"  {FAIL} {name}"
        if detail:
            msg += f" — {detail}"
        print(msg)
        _failures.append(name)


# ── 测试嵌入向量（直接放进 paper dict，跳过 OpenAI 调用）────────────────────
# A/B 语义相似：cosine ≈ 0.999  > 0.75
# A/D 语义不同：cosine = 0.0    < 0.5
EMBED_MEM  = [1.0, 1.0, 0.0, 0.0]   # A / B 类论文
EMBED_FIN  = [0.0, 0.0, 1.0, 1.0]   # D 类论文（正交）

PAPER_A = {
    "arxiv_id": "2401.00001",
    "title": "Cognitive Memory in Large Language Models",
    "authors": ["Alice Wang", "Bob Chen"],
    "abstract": "cognitive memory mechanisms in large language models transformer hippocampal memory consolidation episodic semantic memory neuroscience",
    "published": "2026-03-08",
    "categories": ["cs.AI"],
    "url": "https://arxiv.org/abs/2401.00001",
    "embedding": EMBED_MEM,
}

PAPER_B = {
    "arxiv_id": "2401.00002",
    "title": "Memory Consolidation in Neural Language Models",
    "authors": ["Alice Wang", "Carol Li"],   # 共同作者 Alice Wang
    "abstract": "neural language models memory consolidation cognitive neuroscience transformer episodic memory semantic knowledge hippocampal systems",
    "published": "2026-03-08",
    "categories": ["cs.CL"],
    "url": "https://arxiv.org/abs/2401.00002",
    "embedding": [0.95, 1.0, 0.0, 0.0],   # cosine(A,B) ≈ 0.999 > 0.75
}

PAPER_D = {
    "arxiv_id": "2401.00004",
    "title": "Financial Time Series Forecasting with ARIMA",
    "authors": ["Eve Johnson"],
    "abstract": "ARIMA stock market prediction statistical price series seasonal autoregressive integrated moving average financial forecasting",
    "published": "2026-03-08",
    "categories": ["q-fin.ST"],
    "url": "https://arxiv.org/abs/2401.00004",
    "embedding": EMBED_FIN,               # cosine(A,D) = 0.0 < 0.5
}

PAPER_REF = {   # 显式引用 PAPER_A
    "arxiv_id": "2401.00005",
    "title": "Survey on Memory Systems",
    "authors": ["Frank Lee"],
    "abstract": "Survey of memory systems in AI",
    "published": "2026-03-08",
    "categories": ["cs.AI"],
    "url": "https://arxiv.org/abs/2401.00005",
    "references": ["2401.00001"],         # citation edge
    "embedding": [0.1, 0.1, 0.1, 0.1],
}


# ── 测试 ─────────────────────────────────────────────────────────────────────

def test_empty_graph():
    """验收条件 5：空图不报错，返回 []"""
    print("\n[Test] 空图行为")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        check("空图 get_hot_clusters 返回 []", g.get_hot_clusters() == [])
        check("空图 get_key_authors 返回 []", g.get_key_authors() == [])
        check("空图节点数 = 0", g.graph.number_of_nodes() == 0)


def test_single_node_save_load():
    """验收条件 1：单节点 save/load JSON roundtrip"""
    print("\n[Test] 单节点 save/load roundtrip")
    with tempfile.TemporaryDirectory() as tmp:
        path = f"{tmp}/graph.json"
        g = TheoryGraphBuilder(graph_path=path)
        result = g.add_paper(PAPER_A)

        check("add_paper 返回 dict", isinstance(result, dict))
        check("返回 paper_id 字段", result.get("paper_id") == "2401.00001")
        check("节点已入图", g.graph.has_node("2401.00001"))
        g.save()

        check("JSON 文件已创建", Path(path).exists())
        data = json.loads(Path(path).read_text())
        check("version = 1", data.get("version") == 1)
        check("graph 字段存在", "graph" in data)

        # load 验证
        g2 = TheoryGraphBuilder(graph_path=path)
        g2.load()
        check("load 后节点数 = 1", g2.graph.number_of_nodes() == 1, f"got {g2.graph.number_of_nodes()}")
        node = g2.graph.nodes.get("2401.00001", {})
        check("title 完整保留", node.get("title") == PAPER_A["title"])
        check("authors 完整保留", node.get("authors") == PAPER_A["authors"])
        check("published 完整保留", node.get("published") == PAPER_A["published"])

        # 重复添加
        result2 = g2.add_paper(PAPER_A)
        check("重复 add_paper 节点数不变", g2.graph.number_of_nodes() == 1)


def test_high_similarity_edge():
    """验收条件 2：两篇高相似论文（cosine > 0.75）自动建边"""
    print("\n[Test] 高相似度 + 共同作者 → 建边")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        g.add_paper(PAPER_A)
        g.add_paper(PAPER_B)

        has_edge = g.graph.has_edge("2401.00001", "2401.00002")
        check("A↔B 建边（cosine≈0.999 > 0.75 且共同作者 Alice Wang）", has_edge,
              f"edges: {list(g.graph.edges())}")

        if has_edge:
            meta = g.graph.edges["2401.00001", "2401.00002"]
            check("边有 weight 属性", "weight" in meta)
            check("weight > 0", meta["weight"] > 0, f"weight={meta.get('weight')}")
            check("relation_types 非空", bool(meta.get("relation_types")), str(meta.get("relation_types")))


def test_low_similarity_no_edge():
    """验收条件 3：两篇低相似论文（cosine=0 < 0.5）且无共同作者 → 不建边"""
    print("\n[Test] 低相似度 + 无共同作者 → 不建边")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        g.add_paper(PAPER_A)
        g.add_paper(PAPER_D)

        # 验证相似度
        from graph_builder import TheoryGraphBuilder as TGB
        sim = TGB._cosine_similarity(EMBED_MEM, EMBED_FIN)
        check(f"A↔D cosine = {sim:.3f} < 0.5", (sim is not None and sim < 0.5), f"sim={sim}")

        has_edge = g.graph.has_edge("2401.00001", "2401.00004")
        check("A↔D 无共同作者且低相似 → 不建边", not has_edge,
              f"edges: {list(g.graph.edges())}")


def test_hot_clusters_format():
    """验收条件 4：get_hot_clusters 返回 [{topic, papers, growth_rate}]"""
    print("\n[Test] get_hot_clusters 返回格式")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        g.add_paper(PAPER_A)
        g.add_paper(PAPER_B)
        g.add_paper(PAPER_D)

        clusters = g.get_hot_clusters(top_n=5)
        check("返回 list", isinstance(clusters, list))

        if clusters:
            c = clusters[0]
            check("cluster 有 topic 字段", "topic" in c, str(c))
            check("cluster 有 papers 字段（list）", isinstance(c.get("papers"), list))
            check("cluster 有 growth_rate 字段", "growth_rate" in c)
            check("growth_rate >= 0", c["growth_rate"] >= 0, str(c.get("growth_rate")))
        else:
            print("  ⚠ 无簇（A/B 今日新增各自是独立连通分量，需 ≥2 成员且含今日论文才成簇）")

        clusters_n1 = g.get_hot_clusters(top_n=1)
        check("top_n=1 限制生效", len(clusters_n1) <= 1, f"got {len(clusters_n1)}")

        clusters_zero = g.get_hot_clusters(top_n=0)
        check("top_n=0 返回 []", clusters_zero == [], str(clusters_zero))


def test_key_authors():
    """get_key_authors 返回 [{author, papers, connections}]"""
    print("\n[Test] get_key_authors")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        g.add_paper(PAPER_A)
        g.add_paper(PAPER_B)
        g.add_paper(PAPER_D)

        authors = g.get_key_authors(top_n=3)
        check("返回 list", isinstance(authors, list))

        if authors:
            a = authors[0]
            check("有 author 字段", "author" in a, str(a))
            check("有 papers 字段", "papers" in a, str(a))
            check("有 connections 字段", "connections" in a, str(a))

            names = [x["author"] for x in authors]
            # Alice Wang 参与 A 和 B 两篇，且 A↔B 有边，connections 应该最高
            check("Alice Wang 排名靠前（参与2篇有边论文）",
                  "Alice Wang" in names, str(names))

        authors_zero = g.get_key_authors(top_n=0)
        check("top_n=0 返回 []", authors_zero == [], str(authors_zero))


def test_citation_edge():
    """引用关系 → citation 边"""
    print("\n[Test] 引用关系建边")
    with tempfile.TemporaryDirectory() as tmp:
        g = TheoryGraphBuilder(graph_path=f"{tmp}/graph.json")
        g.add_paper(PAPER_A)
        g.add_paper(PAPER_REF)  # PAPER_REF references 2401.00001

        has_edge = g.graph.has_edge("2401.00001", "2401.00005")
        check("引用关系建 citation 边", has_edge, f"edges: {list(g.graph.edges())}")
        if has_edge:
            meta = g.graph.edges["2401.00001", "2401.00005"]
            check("relation_types 包含 citation", "citation" in meta.get("relation_types", []),
                  str(meta.get("relation_types")))


def test_cosine_similarity_static():
    """内部 cosine 函数正确性"""
    print("\n[Test] 静态 cosine_similarity")
    from graph_builder import TheoryGraphBuilder as TGB

    v = [1.0, 0.0, 0.0]
    check("自身 cosine = 1.0", abs(TGB._cosine_similarity(v, v) - 1.0) < 1e-9)
    check("正交向量 cosine = 0.0", TGB._cosine_similarity([1, 0], [0, 1]) == 0.0)
    check("维度不匹配返回 None", TGB._cosine_similarity([1, 0], [1, 0, 0]) is None)
    check("空向量返回 None", TGB._cosine_similarity([], []) is None)


# ── 主程序 ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 55)
    print("  TheoryGraphBuilder 验收测试（Codex 实现版）")
    print("=" * 55)
    test_empty_graph()
    test_single_node_save_load()
    test_high_similarity_edge()
    test_low_similarity_no_edge()
    test_hot_clusters_format()
    test_key_authors()
    test_citation_edge()
    test_cosine_similarity_static()

    print("\n" + "=" * 55)
    if not _failures:
        print(f"  {PASS} 全部通过！")
    else:
        print(f"  {FAIL} 失败 {len(_failures)} 项：")
        for f in _failures:
            print(f"    - {f}")
    print("=" * 55)
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
