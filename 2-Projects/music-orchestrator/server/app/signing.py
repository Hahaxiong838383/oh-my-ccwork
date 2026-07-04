"""流地址签名 token（让浏览器 `<audio>` 能鉴权取流）。

背景：浏览器 `<audio src=url>` 在 Web 标准上无法携带自定义 header，所以 stream 端点的
`X-Music-Key` header 鉴权对它不可用（裸请求 → 401）。解法：music_play 时服务端为该曲目
签一个短时 HMAC token，放进 stream_url 的 query（`?token=...&exp=...`），`<audio>` 直接用；
stream 端点验签。长期密钥 MUSIC_KEY 只做 HMAC 签名密钥，永不进 URL/日志。

token 与 (source, track_id, exp) 绑定 → 一个 token 只能取一首特定的歌、且会过期，
即使泄漏（进 nginx 日志）影响面也仅限该曲目 + TTL 窗口。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from app.config import config

# 默认 TTL：6 小时。够一次听歌 session（含暂停/续播），又限制泄漏窗口。
DEFAULT_TTL_SEC = 6 * 3600


def _sig(source: str, track_id: str, exp: int) -> str:
    msg = f"{source}:{track_id}:{exp}".encode("utf-8")
    secret = config.music_key.encode("utf-8")
    digest = hmac.new(secret, msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def sign_stream(source: str, track_id: str, ttl_sec: int = DEFAULT_TTL_SEC) -> tuple[str, int]:
    """返回 (token, exp)。exp 是绝对过期 unix 时间戳，需随 token 一起放进 URL 供验签。"""
    exp = int(time.time()) + ttl_sec
    return _sig(source, track_id, exp), exp


def verify_stream(source: str, track_id: str, exp: int, token: str) -> bool:
    """恒定时间比对 + 过期检查。任一不符返回 False。"""
    if not token or not config.music_key:
        return False
    if exp < int(time.time()):
        return False
    expected = _sig(source, track_id, exp)
    return hmac.compare_digest(expected, token)
