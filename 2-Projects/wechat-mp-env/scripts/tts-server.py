#!/usr/bin/env python3
"""词途 TTS HTTP 服务 —— 家里按需合成，给小程序用

GET /tts?w=<word>&v=<voice>[&fmt=wav]
  voice: hfc | amy | joe | lessac | ryan   （默认 hfc，和 Android 端一致）
  返回: audio/wav（22050Hz mono 16bit）
  缓存: /data/home-studio/wordpath-tts-cache/<voice>/<sha1(word)>.wav

GET /health  -> {"ok":true,"voices":[...],"cached":N}
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PIPER = os.path.expanduser("~/local/piper/bin/piper")
MODELS = {
    "hfc":    os.path.expanduser("~/local/piper/en_US-hfc_female-medium.onnx"),
    "amy":    os.path.expanduser("~/local/piper/en_US-amy-medium.onnx"),
    "joe":    os.path.expanduser("~/local/piper/en_US-joe-medium.onnx"),
    "lessac": os.path.expanduser("~/local/piper/en_US-lessac-medium.onnx"),
    "ryan":   os.path.expanduser("~/local/piper/en_US-ryan-high.onnx"),
}
CACHE = os.environ.get("WORDPATH_TTS_CACHE", "/data/home-studio/wordpath-tts-cache")
PORT = int(os.environ.get("WORDPATH_TTS_PORT", "8790"))
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\- ]{0,60}$")

_lock = threading.Lock()
_inflight = {}


def cache_path(voice: str, word: str) -> str:
    h = hashlib.sha1(word.lower().encode()).hexdigest()[:16]
    d = os.path.join(CACHE, voice)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{h}.wav")


def synthesize(voice: str, word: str) -> str:
    path = cache_path(voice, word)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    model = MODELS.get(voice)
    if not model or not os.path.exists(model):
        raise RuntimeError(f"voice {voice} model missing")
    # 同一词并发只合成一次
    key = (voice, word.lower())
    with _lock:
        if key in _inflight:
            ev = _inflight[key]
        else:
            ev = _inflight[key] = threading.Event()
            owner = True
    if not owner:
        ev.wait(timeout=30)
        return path
    try:
        tmp = path + ".tmp"
        p = subprocess.run(
            [PIPER, "--model", model, "--output_file", tmp],
            input=word + "\n", text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        )
        if p.returncode != 0 or not os.path.exists(tmp):
            raise RuntimeError(f"piper failed: {p.stderr[:200]}")
        os.replace(tmp, path)
        return path
    finally:
        with _lock:
            _inflight.pop(key, None)
        ev.set()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/health":
            cached = 0
            for v in MODELS:
                d = os.path.join(CACHE, v)
                if os.path.isdir(d):
                    cached += len([f for f in os.listdir(d) if f.endswith(".wav")])
            return self._json({"ok": True, "voices": list(MODELS), "cached": cached})

        if u.path != "/tts":
            return self._json({"ok": False, "error": "not found"}, 404)

        word = (q.get("w") or [""])[0].strip()
        voice = (q.get("v") or ["hfc"])[0].strip().lower()
        if voice not in MODELS:
            return self._json({"ok": False, "error": f"unknown voice {voice}"}, 400)
        if not WORD_RE.match(word):
            return self._json({"ok": False, "error": "bad word"}, 400)

        try:
            path = synthesize(voice, word)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=604800")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    print(f"wordpath-tts listening on 0.0.0.0:{PORT}  cache={CACHE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
