"""spark iat adapter 契约测试(wpgs 拼接/帧解析/上行构造,纯函数;ws 层留真机)。"""

from __future__ import annotations

import base64
import json

from voice_agent.engines.xfyun_spark_iat import (
    WpgsAssembler,
    build_iat_frame_payload,
    parse_iat_frame,
)


def _frame(status: int, inner: dict | None) -> str:
    payload = {}
    if inner is not None:
        payload = {
            "result": {"text": base64.b64encode(json.dumps(inner).encode()).decode()}
        }
    return json.dumps({"header": {"code": 0, "status": status}, "payload": payload})


def _inner(sn: int, words: list[str], pgs: str | None = None, rg: list | None = None) -> dict:
    d: dict = {"sn": sn, "ws": [{"cw": [{"w": w}]} for w in words]}
    if pgs:
        d["pgs"] = pgs
    if rg:
        d["rg"] = rg
    return d


class TestWpgsAssembler:
    def test_append_mode(self) -> None:
        a = WpgsAssembler()
        assert a.feed(1, "apd", None, "今天") == "今天"
        assert a.feed(2, "apd", None, "天气好") == "今天天气好"

    def test_replace_range(self) -> None:
        # wpgs 动态修正:rpl 作废 rg 范围旧句再放新句
        a = WpgsAssembler()
        a.feed(1, "apd", None, "今天")
        a.feed(2, "apd", None, "天期")
        assert a.feed(3, "rpl", [2, 2], "天气好") == "今天天气好"

    def test_out_of_order_sn_sorted(self) -> None:
        a = WpgsAssembler()
        a.feed(2, None, None, "世界")
        assert a.feed(1, None, None, "你好") == "你好世界"


class TestParseIatFrame:
    def test_result_frame(self) -> None:
        f = parse_iat_frame(_frame(1, _inner(3, ["你", "好"], "apd")))
        assert f.kind == "result" and f.text == "你好" and f.sn == 3 and f.pgs == "apd"
        assert f.status == 1

    def test_final_status(self) -> None:
        f = parse_iat_frame(_frame(2, _inner(5, ["再见"])))
        assert f.status == 2 and f.text == "再见"

    def test_final_without_text(self) -> None:
        # eos 收尾帧可能无 result 载荷:仍须以 result/status=2 形态返回(触发会话收尾)
        f = parse_iat_frame(_frame(2, None))
        assert f.kind == "result" and f.status == 2 and f.text == ""

    def test_error_and_garbage(self) -> None:
        err = parse_iat_frame(json.dumps({"header": {"code": 10163, "message": "invalid"}}))
        assert err.kind == "error" and "10163" in err.detail
        assert parse_iat_frame("not json").kind == "ignore"

    def test_rg_passthrough(self) -> None:
        f = parse_iat_frame(_frame(1, _inner(4, ["改"], "rpl", [2, 3])))
        assert f.rg == [2, 3]


class TestBuildIatFramePayload:
    def test_first_frame_carries_parameter_with_eos(self) -> None:
        d = build_iat_frame_payload(
            app_id="a", status=0, audio_b64="QUJD", eos_ms=700, with_parameter=True
        )
        iat = d["parameter"]["iat"]
        assert iat["eos"] == 700
        assert iat["dwa"] == "wpgs"  # 字数门生命线,必开
        assert iat["result"]["format"] == "plain"  # 生产实现实锤,非 json
        assert d["header"]["status"] == 0
        assert d["payload"]["audio"]["audio"] == "QUJD"

    def test_continue_frame_no_parameter(self) -> None:
        d = build_iat_frame_payload(
            app_id="a", status=1, audio_b64="x", eos_ms=700, with_parameter=False
        )
        assert "parameter" not in d
        assert d["header"]["status"] == 1

    def test_last_frame_empty_audio(self) -> None:
        d = build_iat_frame_payload(
            app_id="a", status=2, audio_b64="", eos_ms=700, with_parameter=False
        )
        assert d["payload"]["audio"]["status"] == 2
