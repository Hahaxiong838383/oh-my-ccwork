#!/usr/bin/env python3
"""词途 OCR HTTP 服务 —— 家里 RapidOCR，给小程序用

POST /ocr        body=原始图片字节（Content-Type: image/*）→ {"ok":true,"lines":[...],"text":"..."}
GET  /health     → {"ok":true,"engine":"rapidocr","ready":true}

为什么放家里：微信 VisionKit 的 runOCR 在真机上一直不返回（实测卡在「识别中」），
改成上传到家里识别。RapidOCR（PP-OCRv4 ONNX）对课本印刷体单词几乎 100% 准，
实测一张 900x700 的单词表 0.5s、6 个英文词全对。
"""
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 8 * 1024 * 1024   # 单张图上限 8MB
PORT = int(os.environ.get("WORDPATH_OCR_PORT", "8791"))

_engine = None
_engine_lock = threading.Lock()


def get_engine():
    """RapidOCR 单例；模型内置，首次构造 ~0.1s"""
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR
            _engine = RapidOCR()
    return _engine


def run_ocr(data: bytes):
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(data)).convert("RGB")
    # 限制最长边 1600，避免超大图拖慢（课本拍照一般 3000px 宽）
    w, h = img.size
    if max(w, h) > 1600:
        scale = 1600.0 / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    arr = np.array(img)
    res, _ = get_engine()(arr)
    lines = []
    if res:
        for item in res:
            # item = [box, text, score]
            text = (item[1] or "").strip()
            score = float(item[2]) if len(item) > 2 else 0.0
            if text:
                lines.append({"text": text, "confidence": round(score, 3)})
    return lines


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
        if self.path.startswith("/health"):
            return self._json({"ok": True, "engine": "rapidocr", "ready": True})
        return self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/ocr"):
            return self._json({"ok": False, "error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return self._json({"ok": False, "error": "empty body"}, 400)
        if n > MAX_BYTES:
            return self._json({"ok": False, "error": "too large"}, 413)

        data = self.rfile.read(n)
        try:
            lines = run_ocr(data)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)[:200]}, 500)

        return self._json({
            "ok": True,
            "count": len(lines),
            "lines": lines,
            "text": "\n".join(l["text"] for l in lines),
        })


if __name__ == "__main__":
    print(f"wordpath-ocr listening on 0.0.0.0:{PORT}", flush=True)
    # 预热，避免第一个请求等模型加载
    try:
        get_engine()
        print("engine preloaded", flush=True)
    except Exception as e:
        print(f"preload failed: {e}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
