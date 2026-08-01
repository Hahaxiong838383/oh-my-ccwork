import json
import os
import tempfile
import unittest

from policy import ToolPolicyGate


class ToolPolicyGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.temp.name, "readonly")
        self.audit = os.path.join(self.temp.name, "audit")
        self.project = os.path.join(self.root, "demo")
        os.makedirs(os.path.join(self.project, "src"))
        with open(os.path.join(self.project, "README.md"), "w", encoding="utf-8") as file:
            file.write("alpha\nbeta\ngamma\n")
        with open(os.path.join(self.project, "src", "app.py"), "w", encoding="utf-8") as file:
            file.write("print('alpha')\n")
        with open(os.path.join(self.project, "src", "sample.txt"), "w", encoding="utf-8") as file:
            file.write("api_key = super-secret-value-1234567890\n")
        self.gate = ToolPolicyGate(self.root, ["demo"], self.audit)

    def tearDown(self):
        self.temp.cleanup()

    def run_tool(self, tool, params=None, **overrides):
        request = {"taskId": "test-1", "project": "demo", "workflow": "readonly_safe", "tool": tool, "params": params or {}}
        request.update(overrides)
        return self.gate.execute(request)

    def test_read_grep_find_ls(self):
        self.assertTrue(self.run_tool("read", {"path": "README.md"})["ok"])
        self.assertTrue(self.run_tool("grep", {"path": ".", "query": "alpha"})["ok"])
        self.assertTrue(self.run_tool("find", {"path": ".", "pattern": "*.py"})["ok"])
        self.assertTrue(self.run_tool("ls", {"path": "."})["ok"])

    def test_unknown_tool_and_workflow_fail_closed(self):
        self.assertEqual(self.run_tool("write")["error"], "policy_denied")
        self.assertEqual(self.run_tool("read", {"path": "README.md"}, workflow="diagnose")["error"], "policy_denied")
        self.assertEqual(self.run_tool("read", {"path": "README.md"}, project="unknown")["error"], "policy_denied")

    def test_traversal_absolute_and_sensitive_paths_are_blocked(self):
        self.assertEqual(self.run_tool("read", {"path": "../../etc/passwd"})["error"], "policy_denied")
        self.assertEqual(self.run_tool("read", {"path": "/etc/passwd"})["error"], "policy_denied")
        self.assertEqual(self.run_tool("read", {"path": ".env"})["error"], "policy_denied")

    def test_symlink_escape_is_blocked(self):
        os.symlink("/etc/passwd", os.path.join(self.project, "escape"))
        self.assertEqual(self.run_tool("read", {"path": "escape"})["error"], "policy_denied")

    def test_project_root_symlink_is_blocked(self):
        os.makedirs(os.path.join(self.root, "other"))
        os.symlink(os.path.join(self.root, "other"), os.path.join(self.root, "alias"))
        gate = ToolPolicyGate(self.root, ["alias"], self.audit)
        result = gate.execute({"taskId": "test-2", "project": "alias", "workflow": "readonly_safe", "tool": "ls", "params": {"path": "."}})
        self.assertEqual(result["error"], "policy_denied")

    def test_invalid_types_fail_as_invalid_request(self):
        self.assertEqual(self.gate.execute([])["error"], "invalid_request")
        self.assertEqual(self.run_tool("read", {"path": "README.md", "lineCount": "many"})["error"], "invalid_request")
        self.assertEqual(self.run_tool("grep", {"path": ".", "query": "alpha", "caseSensitive": "false"})["error"], "invalid_request")

    def test_secret_like_output_is_redacted(self):
        read = self.run_tool("read", {"path": "src/sample.txt"})
        self.assertTrue(read["ok"])
        self.assertNotIn("super-secret-value", read["data"]["content"])
        self.assertGreaterEqual(read["data"]["redacted"], 1)
        grep = self.run_tool("grep", {"path": "src", "query": "api_key"})
        self.assertTrue(grep["ok"])
        self.assertNotIn("super-secret-value", json.dumps(grep, ensure_ascii=False))

    def test_audit_does_not_store_raw_grep_query(self):
        result = self.run_tool("grep", {"path": ".", "query": "sensitive-value"})
        self.assertTrue(result["ok"])
        audit_path = os.path.join(self.audit, result["recordId"] + ".json")
        with open(audit_path, encoding="utf-8") as file:
            text = file.read()
        record = json.loads(text)
        self.assertNotIn("sensitive-value", text)
        self.assertIn("queryHash", text)
        self.assertNotIn("path", record["paramsSummary"])
        self.assertNotIn("query", record["paramsSummary"])

    def test_audit_result_summary_does_not_store_raw_path(self):
        result = self.run_tool("read", {"path": "README.md"})
        self.assertTrue(result["ok"])
        audit_path = os.path.join(self.audit, result["recordId"] + ".json")
        with open(audit_path, encoding="utf-8") as file:
            record = json.load(file)
        self.assertNotIn("path", record["resultSummary"])
        self.assertEqual(record["resultSummary"]["pathLength"], len("README.md"))
        self.assertIn("pathHash", record["resultSummary"])


if __name__ == "__main__":
    unittest.main()
