import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "theory_radar.py"
SPEC = importlib.util.spec_from_file_location("theory_radar", MODULE_PATH)
radar = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = radar
SPEC.loader.exec_module(radar)


RSS_SAMPLE = b"""<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>
<item><title>Brain-inspired memory for language models</title>
<link>https://arxiv.org/abs/2607.12345</link>
<description>arXiv:2607.12345v1 Announce Type: new Abstract: A cognitive memory architecture for an LLM.</description>
<category>cs.CL</category><pubDate>Mon, 13 Jul 2026 00:00:00 -0400</pubDate>
<dc:creator>Alice Example</dc:creator></item></channel></rss>"""


class RadarTests(unittest.TestCase):
    def test_parse_rss(self):
        papers = radar.parse_rss(RSS_SAMPLE, "cs.CL")
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["arxiv_id"], "2607.12345")
        self.assertEqual(papers[0]["published"], "2026-07-13")
        self.assertIn("cognitive memory", papers[0]["abstract"])

    def test_select_deduplicates_and_ranks(self):
        paper = radar.parse_rss(RSS_SAMPLE, "cs.CL")[0]
        weaker = dict(paper, abstract="short")
        unrelated = dict(paper, arxiv_id="2607.99999", title="Unrelated", abstract="No matching terms", categories=["stat.ML"])
        selected = radar.select_papers([weaker, paper, unrelated], 8)
        self.assertEqual([item["arxiv_id"] for item in selected], ["2607.12345"])

    def test_select_excludes_replacements(self):
        paper = radar.parse_rss(RSS_SAMPLE, "cs.CL")[0]
        paper["announce_type"] = "replace-cross"
        self.assertEqual(radar.select_papers([paper], 8), [])

    def test_report_normalizes_reordered_ids(self):
        selected = [
            {"arxiv_id": "2607.00001", "published": "2026-07-13", "categories": ["cs.CL"]},
            {"arxiv_id": "2607.00002", "published": "2026-07-13", "categories": ["cs.AI"]},
        ]
        analysis = {
            "summary": "趋势",
            "papers": [
                {"arxivId": "2607.00002", "titleCn": "二", "score": 80, "finding": "a", "llmLink": "b", "insight": "c"},
                {"arxivId": "2607.00001", "titleCn": "一", "score": 80, "finding": "a", "llmLink": "b", "insight": "c"},
            ],
        }
        report = radar.build_report("2026-07-14", selected, analysis)
        self.assertEqual([paper["arxivId"] for paper in report["papers"]], ["2607.00001", "2607.00002"])
        self.assertEqual([paper["title"] for paper in report["papers"]], ["一", "二"])

    def test_query_429_opens_circuit(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("ARXIV_QUERY_FORCE_STATUS")
            os.environ["ARXIV_QUERY_FORCE_STATUS"] = "429"
            try:
                config = radar.Config(state_dir=Path(tmp))
                state = radar.QueryCircuit(config, radar.HttpClient(config)).probe()
            finally:
                if previous is None:
                    os.environ.pop("ARXIV_QUERY_FORCE_STATUS", None)
                else:
                    os.environ["ARXIV_QUERY_FORCE_STATUS"] = previous
            self.assertEqual(state["status"], "open")
            self.assertEqual(state["last_http_status"], 429)
            saved = json.loads((Path(tmp) / "query-circuit.json").read_text())
            self.assertEqual(saved["status"], "open")

    def test_validate_report_gate(self):
        papers = []
        for index in range(4):
            aid = f"2607.{index:05d}"
            papers.append(
                {
                    "index": index + 1,
                    "title": "标题",
                    "arxivId": aid,
                    "url": f"https://arxiv.org/abs/{aid}",
                    "finding": "发现",
                    "llmLink": "连接",
                    "insight": "启示",
                }
            )
        radar.validate_report({"date": "2026-07-14", "papers": papers}, "2026-07-14", 4)


if __name__ == "__main__":
    unittest.main()
