"""T1 实时可视化面板：daemon 内嵌 localhost HTTP 小面板（零新依赖）。

- daemon 每帧 update() 共享状态；浏览器开 http://127.0.0.1:17860 看实时面板
- 表情 emoji 为「规则直觉版」（blendshapes 阈值），非模型预测——模型要 T6 之后才有
"""
from __future__ import annotations

import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class PanelState:
    def __init__(self):
        self._lock = threading.Lock()
        self._d: dict = {"face": False, "speaking": False}
        self.events = deque(maxlen=10)

    def update(self, **kw):
        with self._lock:
            self._d.update(kw)

    def push_event(self, ts_s: float, etype: str):
        with self._lock:
            self.events.appendleft({"t": round(ts_s, 1), "type": etype})

    def snapshot(self) -> dict:
        with self._lock:
            d = dict(self._d)
            d["events"] = list(self.events)
        return d


def rule_expr_emoji(expr: dict, face: bool) -> tuple[str, str]:
    """规则直觉版表情（诚实标注：非模型）。"""
    if not face:
        return "🫥", "无脸"
    if expr.get("jawOpen", 0) > 0.4:
        return "😮", "张嘴"
    if expr.get("smile", 0) > 0.35:
        return "😊", "微笑"
    if expr.get("browDown", 0) > 0.35:
        return "🤨", "皱眉"
    if expr.get("browInnerUp", 0) > 0.45:
        return "😲", "扬眉"
    return "😐", "平静"


_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>LnMem-fpga 采集面板</title>
<style>
body{font-family:-apple-system,sans-serif;background:#14161a;color:#e6e6e6;margin:0;padding:14px;font-size:13px}
.card{background:#1e2128;border-radius:10px;padding:10px 14px;margin-bottom:10px}
.big{font-size:30px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tag{padding:2px 8px;border-radius:6px;background:#2a2e37}.on{background:#1d4ed8}.warn{background:#b45309}
.bar{height:8px;background:#2a2e37;border-radius:4px;overflow:hidden;width:120px;display:inline-block;vertical-align:middle}
.bar>i{display:block;height:100%;background:#3b82f6}
table{width:100%;border-collapse:collapse}td{padding:2px 4px;color:#9ca3af}
.small{color:#6b7280;font-size:11px}
</style></head><body>
<div class="card row"><span class="big" id="emoji">🫥</span>
 <div><div id="exprname" style="font-size:16px">—</div><div class="small">规则直觉版 · 非模型</div></div>
 <span class="tag" id="face">脸</span><span class="tag" id="spk">说话</span>
 <span class="tag" id="ctx">ctx</span><span class="tag" id="rec">● REC</span></div>
<div class="card"><b>表情特征 top</b><table id="bs"></table></div>
<div class="card"><div class="row">
 <span>键鼠 <span class="bar"><i id="kbd" style="width:0"></i></span></span>
 <span>脸在场 <span class="bar"><i id="pres" style="width:0"></i></span></span>
 <span id="mic">🎙 –</span>
 <span id="fps">– fps</span><span id="dur">0:00</span><span id="frames">0 帧</span></div></div>
<div class="card"><b>事件流</b>（<span id="evn">0</span>）<table id="ev"></table></div>
<div class="card" id="warncard" style="display:none"><b style="color:#f59e0b">⚠ 哨兵</b><div id="warns"></div></div>
<script>
const $=id=>document.getElementById(id);
async function tick(){try{
 const s=await (await fetch('/status')).json();
 $('emoji').textContent=s.emoji;$('exprname').textContent=s.expr_name;
 $('face').className='tag'+(s.face?' on':'');$('spk').className='tag'+(s.speaking?' on':'');
 $('ctx').className='tag'+(s.ctx_valid?' on':' warn');
 $('kbd').style.width=(100*(s.kbd||0))+'%';$('pres').style.width=(100*(s.presence||0))+'%';
 $('fps').textContent=(s.fps||0).toFixed(0)+' fps';$('frames').textContent=(s.frames||0)+' 帧';
 if(s.mic_db!==undefined)$('mic').textContent=`🎙 ${s.mic_db}dB(底${s.mic_floor})`;
 const m=Math.floor((s.elapsed_s||0)/60),ss=Math.floor((s.elapsed_s||0)%60);
 $('dur').textContent=m+':'+String(ss).padStart(2,'0');
 $('bs').innerHTML=(s.bs_top||[]).map(([n,v])=>`<tr><td>${n}</td><td><span class="bar"><i style="width:${100*v}%"></i></span></td><td>${v.toFixed(2)}</td></tr>`).join('');
 $('evn').textContent=(s.events||[]).length;
 $('ev').innerHTML=(s.events||[]).map(e=>`<tr><td>${e.t}s</td><td>${e.type}</td></tr>`).join('');
 const w=s.warnings||[];$('warncard').style.display=w.length?'block':'none';
 $('warns').textContent=w.join(' · ');
}catch(e){} setTimeout(tick,1000)}
tick();
</script></body></html>"""


class PanelServer(threading.Thread):
    def __init__(self, state: PanelState, port: int = 17860):
        super().__init__(daemon=True)
        self.state = state
        self.port = port
        self.actual_port: int | None = None
        self.ready = threading.Event()
        self._srv: ThreadingHTTPServer | None = None

    def run(self):
        state = self.state

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/status":
                    body = json.dumps(state.snapshot()).encode()
                    ctype = "application/json"
                elif self.path == "/":
                    body = _HTML.encode()
                    ctype = "text/html; charset=utf-8"
                else:
                    self.send_response(404); self.end_headers(); return
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # 静默访问日志
                pass

        try:
            self._srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
            self.actual_port = self._srv.server_address[1]
            self.ready.set()
            self._srv.serve_forever(poll_interval=0.5)
        except OSError:
            self.ready.set()  # 端口被占：面板缺席不影响采集
