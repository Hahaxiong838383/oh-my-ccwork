import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import server


class FeishuDailyTest(unittest.TestCase):
    def test_feishu_response_requires_provider_success(self):
        result = server.parse_feishu_webhook_response(
            200,
            json.dumps({"StatusCode": 0, "StatusMessage": "success", "code": 0, "msg": "success"}),
        )
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["providerCode"], 0)
        legacy_result = server.parse_feishu_webhook_response(200, json.dumps({"StatusCode": 0, "StatusMessage": "success"}))
        self.assertEqual(legacy_result["providerCode"], 0)
        with self.assertRaisesRegex(RuntimeError, "feishu_http_error"):
            server.parse_feishu_webhook_response(503, json.dumps({"code": 0, "msg": "success"}))
        with self.assertRaisesRegex(RuntimeError, "feishu_rejected"):
            server.parse_feishu_webhook_response(200, json.dumps({"code": 19024, "msg": "Key Words Not Found"}))
        with self.assertRaisesRegex(RuntimeError, "feishu_invalid_response"):
            server.parse_feishu_webhook_response(200, "not-json")

    def test_missing_webhook_is_not_reported_as_sent(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "FEISHU_WEBHOOK_URL is not configured"):
                server.send_feishu_text("test")

    def test_personal_site_message_leads_with_visitor_numbers(self):
        job = {
            "ok": True,
            "taskId": "task-safe",
            "todoId": None,
            "live": {"passed": 6, "total": 6, "failedIds": []},
            "snapshot": {"ok": True, "ageHours": 0.2},
            "production": {
                "ok": True,
                "channel": "restricted_ssh",
                "radar": {"ok": True},
                "theoryRadar": {"ok": True, "latestPublicReport": "2026-08-01"},
                "analytics": {
                    "ok": True,
                    "date": "2026-08-01",
                    "yesterday": {"uv": 3, "pv": 4, "pagesPerVisitor": 1.3},
                    "sevenDays": {"uv": 18, "pv": 25},
                    "topPaths": [{"path": "/", "pv": 3}, {"path": "/radar", "pv": 1}],
                },
            },
        }
        text = server.project_daily_notification_text("chenchuan-site", job, "normal")
        lines = text.splitlines()
        self.assertEqual(lines[0], "个人站真实访客每日简报")
        self.assertIn("统计日期（前一完整自然日）：2026-08-01", lines[:6])
        self.assertIn("真实访客：3 人 / 4 PV / 人均 1.3 页", lines[:6])
        self.assertIn("近 7 日真实访客：18 人 / 25 PV", lines[:7])
        self.assertNotIn("IP", text)
        self.assertNotIn("referrer", text)


if __name__ == "__main__":
    unittest.main()
