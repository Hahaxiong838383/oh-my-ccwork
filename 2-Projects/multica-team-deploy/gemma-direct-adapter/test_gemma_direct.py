#!/usr/bin/env python3
"""
gemma-direct.py 单测 — focus on retry/health/error path (核心新逻辑).

运行: python3 -m pytest test_gemma_direct.py -v
不依赖 pytest 时: python3 test_gemma_direct.py
"""
import importlib.util
import io
import json
import os
import sys
import unittest
from unittest import mock
from urllib.error import URLError

HERE = os.path.dirname(os.path.abspath(__file__))

# gemma-direct.py 含 hyphen,不能直接 import → 用 spec 动态加载
_spec = importlib.util.spec_from_file_location("gd", os.path.join(HERE, "gemma-direct.py"))
gd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gd)


class FakeStreamResp:
    """模拟 urlopen 返回的 SSE stream resp,支持 with...as + iter."""
    def __init__(self, lines, status=200):
        self._lines = [l.encode() if isinstance(l, str) else l for l in lines]
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def __iter__(self): return iter(self._lines)
    def read(self, n=-1): return b""


def make_ollama_chunk(content):
    return "data: " + json.dumps({"choices": [{"delta": {"content": content}}]}) + "\n"


class TestHealthProbe(unittest.TestCase):
    def test_healthy(self):
        with mock.patch.object(gd.urlrequest, "urlopen", return_value=FakeStreamResp([b"{}"], status=200)):
            ok, detail = gd.probe_ollama_health(timeout=1)
            self.assertTrue(ok)
            self.assertEqual(detail, "ok")

    def test_unreachable(self):
        with mock.patch.object(gd.urlrequest, "urlopen", side_effect=URLError("Connection refused")):
            ok, detail = gd.probe_ollama_health(timeout=1)
            self.assertFalse(ok)
            self.assertIn("URLError", detail)


class TestRetry(unittest.TestCase):
    def test_succeeds_first_try(self):
        chunks = [make_ollama_chunk("你好"), make_ollama_chunk("世界"), b"data: [DONE]\n"]
        with mock.patch.object(gd.urlrequest, "urlopen", return_value=FakeStreamResp(chunks)), \
             mock.patch.object(gd.time, "sleep") as sleep_mock:
            text, attempts, err = gd.call_ollama_with_retry("test-model", "prompt")
            self.assertEqual(text, "你好世界")
            self.assertEqual(attempts, 1)
            self.assertIsNone(err)
            sleep_mock.assert_not_called()  # 首次成功不该 sleep

    def test_retries_then_succeeds(self):
        chunks_ok = [make_ollama_chunk("成功了"), b"data: [DONE]\n"]
        # 第 1 次 raise URLError,第 2 次成功
        responses = [URLError("net flaky"), FakeStreamResp(chunks_ok)]
        def urlopen_side_effect(*a, **kw):
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        with mock.patch.object(gd.urlrequest, "urlopen", side_effect=urlopen_side_effect), \
             mock.patch.object(gd.time, "sleep") as sleep_mock:
            text, attempts, err = gd.call_ollama_with_retry("m", "p")
            self.assertEqual(text, "成功了")
            self.assertEqual(attempts, 2)
            self.assertIsNone(err)
            sleep_mock.assert_called_once_with(gd.RETRY_DELAYS[0])  # 等 5s

    def test_all_attempts_fail(self):
        with mock.patch.object(gd.urlrequest, "urlopen", side_effect=URLError("dead")), \
             mock.patch.object(gd.time, "sleep"):
            text, attempts, err = gd.call_ollama_with_retry("m", "p")
            self.assertEqual(text, "")
            self.assertEqual(attempts, gd.MAX_ATTEMPTS)
            self.assertIn("URLError", err)

    def test_empty_response_triggers_retry(self):
        """Ollama 返回但 0 token (例: 模型 hang 后 yield 0 content) 应触发 retry."""
        empty_chunks = [b"data: [DONE]\n"]  # 没有 content delta
        nonempty = [make_ollama_chunk("ok"), b"data: [DONE]\n"]
        responses = [FakeStreamResp(empty_chunks), FakeStreamResp(nonempty)]
        def urlopen_side_effect(*a, **kw):
            return responses.pop(0)
        with mock.patch.object(gd.urlrequest, "urlopen", side_effect=urlopen_side_effect), \
             mock.patch.object(gd.time, "sleep"):
            text, attempts, err = gd.call_ollama_with_retry("m", "p")
            self.assertEqual(text, "ok")
            self.assertEqual(attempts, 2)
            self.assertIsNone(err)

    def test_non_retryable_exception_aborts_immediately(self):
        """非网络错误 (例 ValueError) 不该 retry."""
        with mock.patch.object(gd.urlrequest, "urlopen", side_effect=ValueError("bad model")), \
             mock.patch.object(gd.time, "sleep") as sleep_mock:
            text, attempts, err = gd.call_ollama_with_retry("m", "p")
            self.assertEqual(text, "")
            self.assertEqual(attempts, 1)
            self.assertIn("ValueError", err)
            self.assertIn("不重试", err)
            sleep_mock.assert_not_called()


class TestPromptBuilding(unittest.TestCase):
    def test_no_uuid_returns_raw(self):
        self.assertEqual(gd.build_user_prompt("just text"), "just text")

    def test_uuid_but_multica_fails_returns_raw(self):
        with mock.patch.object(gd, "multica_issue_get", return_value=None):
            raw = "do issue 12345678-1234-1234-1234-123456789abc now"
            self.assertEqual(gd.build_user_prompt(raw), raw)

    def test_uuid_with_issue_substitutes(self):
        with mock.patch.object(gd, "multica_issue_get", return_value={"title": "周报", "description": "写本周"}):
            out = gd.build_user_prompt("处理 12345678-1234-1234-1234-123456789abc")
            self.assertIn("标题: 周报", out)
            self.assertIn("详情:\n写本周", out)

    def test_strip_model_prefix(self):
        self.assertEqual(gd.strip_model_prefix("ollama/gemma4:e4b"), "gemma4:e4b")
        self.assertEqual(gd.strip_model_prefix("gemma4:e4b"), "gemma4:e4b")


class TestArgsParsing(unittest.TestCase):
    def test_model_flag(self):
        args = gd.parse_args_safely(["run", "--model", "ollama-studio/gemma4:e4b-it-q4_K_M", "some prompt"])
        self.assertEqual(args.model, "ollama-studio/gemma4:e4b-it-q4_K_M")

    def test_unknown_flags_ignored(self):
        # multica 偶尔传 --output / --recent 等未知 flag,parse_known_args 不该崩
        args = gd.parse_args_safely(["run", "--output", "json", "--recent", "5", "prompt"])
        self.assertEqual(args.subcommand, "run")


if __name__ == "__main__":
    unittest.main(verbosity=2)
