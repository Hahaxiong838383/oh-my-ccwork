"""讯飞 STT/TTS adapter 解析层契约测试(纯函数;ws 搬运层留真机联调)。"""

from __future__ import annotations

import base64
import json

from voice_agent.engines.xfyun_stt import parse_stt_frame
from voice_agent.engines.xfyun_tts import build_tts_request, parse_tts_frame


def _st_frame(seg_type: str, words: list[str]) -> dict:
    return {
        "cn": {
            "st": {
                "type": seg_type,
                "bg": "100",
                "ed": "2000",
                "rt": [{"ws": [{"cw": [{"w": w}]} for w in words]}],
            }
        }
    }


class TestParseSttFrame:
    def test_started_frame_captures_session(self) -> None:
        f = parse_stt_frame(json.dumps({"action": "started", "sid": "abc123"}))
        assert f.kind == "started" and f.session_id == "abc123"

    def test_interim_vs_final_by_type(self) -> None:
        # 标准版信封:data 是 JSON 字符串
        interim = parse_stt_frame(json.dumps({"data": json.dumps(_st_frame("1", ["你", "好"]))}))
        assert interim.kind == "result" and interim.text == "你好" and not interim.is_final
        final = parse_stt_frame(json.dumps({"data": json.dumps(_st_frame("0", ["你", "好"]))}))
        assert final.is_final

    def test_llm_envelope_dict_data(self) -> None:
        # 大模型版信封:data 直接是对象
        f = parse_stt_frame(json.dumps({"msg_type": "result", "data": _st_frame("1", ["停"])}))
        assert f.kind == "result" and f.text == "停"

    def test_multi_rt_segments_concatenated(self) -> None:
        data = {
            "cn": {
                "st": {
                    "type": "0",
                    "rt": [
                        {"ws": [{"cw": [{"w": "今天"}]}]},
                        {"ws": [{"cw": [{"w": "天气"}]}, {"cw": [{"w": "好"}]}]},
                    ],
                }
            }
        }
        f = parse_stt_frame(json.dumps({"data": data}))
        assert f.text == "今天天气好"

    def test_error_and_garbage_tolerated(self) -> None:
        assert parse_stt_frame(json.dumps({"action": "error", "desc": "auth"})).kind == "error"
        assert parse_stt_frame(json.dumps({"code": "10110"})).kind == "error"
        assert parse_stt_frame("not json").kind == "ignore"
        assert parse_stt_frame(json.dumps({"heartbeat": 1})).kind == "ignore"
        assert parse_stt_frame(json.dumps({"data": "not-json"})).kind == "ignore"


class TestBuildTtsRequest:
    def test_text_is_base64_encoded(self) -> None:
        # 关键契约(2026-07-27 生产实现实锤,文档含糊):text 必须 base64,发明文 10009
        req = build_tts_request("你好呀", app_id="app1", vcn="x6_lingxiaoxuan_pro")
        raw = req["payload"]["text"]["text"]
        assert base64.b64decode(raw).decode("utf-8") == "你好呀"

    def test_single_shot_statuses(self) -> None:
        req = build_tts_request("测试", app_id="a", vcn="v")
        assert req["header"]["status"] == 2
        assert req["payload"]["text"]["status"] == 2
        assert req["payload"]["text"]["seq"] == 1

    def test_audio_params(self) -> None:
        req = build_tts_request("测试", app_id="a", vcn="v", sample_rate=16000)
        audio = req["parameter"]["tts"]["audio"]
        assert audio == {
            "encoding": "raw",
            "sample_rate": 16000,
            "channels": 1,
            "bit_depth": 16,
            "frame_size": 0,
        }
        assert req["parameter"]["tts"]["vcn"] == "v"


class TestParseTtsFrame:
    def test_audio_frame_decoded(self) -> None:
        pcm = b"\x01\x02\x03\x04"
        raw = json.dumps(
            {
                "header": {"code": 0},
                "payload": {"audio": {"audio": base64.b64encode(pcm).decode(), "status": 1}},
            }
        )
        kind, payload, last = parse_tts_frame(raw)
        assert (kind, payload, last) == ("audio", pcm, False)

    def test_last_frame_flag(self) -> None:
        raw = json.dumps(
            {
                "header": {"code": 0},
                "payload": {"audio": {"audio": base64.b64encode(b"x").decode(), "status": 2}},
            }
        )
        _, _, last = parse_tts_frame(raw)
        assert last is True

    def test_error_frame(self) -> None:
        kind, payload, last = parse_tts_frame(
            json.dumps({"header": {"code": 11200, "message": "licc auth failed"}})
        )
        assert kind == "error" and b"11200" in payload and last is True

    def test_empty_audio_ignored(self) -> None:
        kind, _, _ = parse_tts_frame(json.dumps({"header": {"code": 0}, "payload": {}}))
        assert kind == "ignore"
