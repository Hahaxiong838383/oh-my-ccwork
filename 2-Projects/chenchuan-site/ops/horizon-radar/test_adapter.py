from datetime import datetime, timezone
import unittest

from adapter import build_report, normalize_item


class AdapterTest(unittest.TestCase):
    def test_normalizes_enriched_horizon_item(self):
        item = normalize_item(
            {
                "id": "rss:example:1",
                "source_type": "rss",
                "title": "English title",
                "url": "https://example.com/article",
                "author": "Example",
                "published_at": "2026-07-22T01:00:00Z",
                "ai_score": 8.5,
                "ai_summary": "Fallback summary",
                "ai_tags": ["AI", "edge"],
                "metadata": {
                    "title_zh": "中文标题",
                    "detailed_summary_zh": "中文摘要。为什么重要。核心细节一。核心细节二。",
                    "background_zh": "背景信息",
                    "feed_name": "Example Feed",
                    "category": "ai-tools",
                    "sources": [
                        {"title": "Reference", "url": "https://example.com/reference"}
                    ],
                },
            },
            0,
        )
        self.assertIsNotNone(item)
        self.assertEqual(item["title"], "中文标题")
        self.assertEqual(item["summary"], "中文摘要。")
        self.assertEqual(item["whyItMatters"], "为什么重要。")
        self.assertEqual(item["keyDetails"], "核心细节一。 核心细节二。")
        self.assertEqual(item["source"], "Example Feed")
        self.assertEqual(item["category"], "ai-products")
        self.assertEqual(item["references"][0]["url"], "https://example.com/reference")

    def test_build_report_deduplicates_urls(self):
        pipeline = {
            "run_id": "run-1",
            "fetch": {
                "raw_before_merge": 20,
                "source_counts": {"rss": 10, "hackernews": 10},
            },
        }
        base = {
            "source_type": "rss",
            "title": "Title",
            "url": "https://example.com/article",
            "ai_score": 8,
            "ai_summary": "Summary",
            "ai_tags": ["ai"],
            "metadata": {},
        }
        report = build_report(
            pipeline,
            [dict(base, id="1"), dict(base, id="2")],
            report_date="2026-07-22",
            generated_at=datetime(2026, 7, 22, tzinfo=timezone.utc),
            publish=False,
            horizon_commit="abc123",
        )
        self.assertEqual(len(report["items"]), 1)
        self.assertEqual(report["totalFetched"], 20)
        self.assertEqual(report["sourceCount"], 2)
        self.assertFalse(report["publish"])

    def test_build_report_excludes_realtime_urls(self):
        pipeline = {
            "run_id": "run-2",
            "fetch": {"raw_before_merge": 2, "source_counts": {"rss": 2}},
        }
        items = [
            {
                "id": "1",
                "source_type": "rss",
                "title": "Already live",
                "url": "https://example.com/live",
                "ai_score": 9,
                "ai_summary": "Existing realtime item",
                "ai_tags": ["ai"],
                "metadata": {},
            },
            {
                "id": "2",
                "source_type": "rss",
                "title": "Complementary item",
                "url": "https://example.com/new",
                "ai_score": 8,
                "ai_summary": "New complementary item",
                "ai_tags": ["ai"],
                "metadata": {},
            },
        ]
        report = build_report(
            pipeline,
            items,
            report_date="2026-07-22",
            generated_at=datetime(2026, 7, 22, tzinfo=timezone.utc),
            publish=False,
            horizon_commit="abc123",
            exclude_urls={"https://example.com/live"},
        )
        self.assertEqual([item["url"] for item in report["items"]], ["https://example.com/new"])
        self.assertEqual(report["realtimeDuplicateCount"], 1)
        self.assertIn("剔除 1 条", report["summary"])

    def test_build_report_filters_non_ai_items(self):
        pipeline = {
            "run_id": "run-3",
            "fetch": {"raw_before_merge": 2, "source_counts": {"hackernews": 2}},
        }
        report = build_report(
            pipeline,
            [
                {
                    "id": "math",
                    "source_type": "hackernews",
                    "title": "A pure algebra result",
                    "url": "https://example.com/math",
                    "ai_score": 9,
                    "ai_summary": "A notable result in algebraic geometry.",
                    "ai_tags": ["mathematics", "algebra"],
                    "metadata": {},
                },
                {
                    "id": "model",
                    "source_type": "hackernews",
                    "title": "A new LLM inference engine",
                    "url": "https://example.com/llm",
                    "ai_score": 8,
                    "ai_summary": "The engine improves local model inference.",
                    "ai_tags": ["LLM", "inference"],
                    "metadata": {},
                },
            ],
            report_date="2026-07-22",
            generated_at=datetime(2026, 7, 22, tzinfo=timezone.utc),
            publish=False,
            horizon_commit="abc123",
        )
        self.assertEqual([item["url"] for item in report["items"]], ["https://example.com/llm"])
        self.assertEqual(report["relevanceFilteredCount"], 1)
        self.assertIn("过滤 1 条", report["summary"])


if __name__ == "__main__":
    unittest.main()
