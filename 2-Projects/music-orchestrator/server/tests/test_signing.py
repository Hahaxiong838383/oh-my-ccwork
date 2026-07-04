"""签名 token 鉴权测试（安全相关，覆盖签发/验证/过期/篡改/双路鉴权）。"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _music_key(monkeypatch):
    monkeypatch.setenv("MUSIC_KEY", "testkey")
    monkeypatch.setenv("MUSIC_ADMIN_KEY", "adminkey")
    # config 是 import 时求值的单例，测试里直接改它的字段
    from app.config import config

    monkeypatch.setattr(config, "music_key", "testkey", raising=False)
    monkeypatch.setattr(config, "music_admin_key", "adminkey", raising=False)
    yield


def test_sign_then_verify_ok():
    from app.signing import sign_stream, verify_stream

    token, exp = sign_stream("bilibili", "BV123")
    assert verify_stream("bilibili", "BV123", exp, token) is True


def test_verify_rejects_wrong_track():
    from app.signing import sign_stream, verify_stream

    token, exp = sign_stream("bilibili", "BV123")
    # 同一 token 不能取另一首歌（token 与 track 绑定）
    assert verify_stream("bilibili", "BV999", exp, token) is False


def test_verify_rejects_expired():
    from app.signing import _sig, verify_stream

    past = int(time.time()) - 10
    token = _sig("bilibili", "BV123", past)
    assert verify_stream("bilibili", "BV123", past, token) is False


def test_verify_rejects_tampered_token():
    from app.signing import sign_stream, verify_stream

    token, exp = sign_stream("bilibili", "BV123")
    assert verify_stream("bilibili", "BV123", exp, token + "x") is False


def test_verify_rejects_tampered_exp():
    from app.signing import sign_stream, verify_stream

    token, exp = sign_stream("bilibili", "BV123")
    # 篡改 exp（想延长有效期）→ 签名不匹配
    assert verify_stream("bilibili", "BV123", exp + 999999, token) is False


def test_stream_endpoint_token_path_and_header_path():
    """stream 端点：签名 token（浏览器 <audio>）和 X-Music-Key header（服务端）两路都放行，裸请求 401。"""
    from app.main import app
    from app.signing import sign_stream

    client = TestClient(app)

    # 裸请求（模拟 <audio> 无 header 无 token）→ 401
    r_bare = client.get("/stream/bilibili/BVtest", follow_redirects=False)
    assert r_bare.status_code == 401

    # 错误 token → 401
    r_bad = client.get("/stream/bilibili/BVtest?token=bad&exp=99999999999", follow_redirects=False)
    assert r_bad.status_code == 401

    # 合法签名 token → 通过鉴权（会进入 resolve/下载，源不存在时可能 404/502，但不是 401）
    token, exp = sign_stream("bilibili", "BVtest")
    r_tok = client.get(f"/stream/bilibili/BVtest?token={token}&exp={exp}", follow_redirects=False)
    assert r_tok.status_code != 401

    # header 路（voice-agent 服务端）→ 通过鉴权
    r_hdr = client.get("/stream/bilibili/BVtest", headers={"X-Music-Key": "testkey"}, follow_redirects=False)
    assert r_hdr.status_code != 401
