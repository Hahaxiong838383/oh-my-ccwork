"""本地 OTA 服务 — 让 ESP32 连接 jarvis-server"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, time

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        if length: self.rfile.read(length)
        r = json.dumps({
            "websocket": {"url": "ws://192.168.1.115:8201/", "token": "local"},
            "server_time": {"timestamp": int(time.time()*1000), "timezone_offset": 480},
            "firmware": {"version": "2.2.4", "url": ""}
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(r)
    def do_GET(self): self.do_POST()
    def log_message(self, *a): pass

if __name__ == "__main__":
    print("[OTA] → jarvis-server ws://192.168.1.115:8201", flush=True)
    HTTPServer(("0.0.0.0", 8105), H).serve_forever()
