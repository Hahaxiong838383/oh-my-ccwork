#!/usr/bin/env python3
"""本地认证代理：把 127.0.0.1:18999 的请求转发到生产 ai.kidshub.cn 并注入 admin cookie。
仅用于 headless Chrome 生产截图（Browser pane 隐藏时的替代通道）。用完即停，不落盘凭据。
SHOT_MODE=fit|mini 决定注入的自动驱动脚本（模拟点击真实页面元素）。
截图前把 .arch-workbench 临时 fixed 铺满视口——纯展示层调整，节点/连线/数据全是生产原样。
"""
import http.server
import os
import ssl
import sys
import urllib.request

UPSTREAM = 'https://ai.kidshub.cn'
JAR = sys.argv[1]
MODE = os.environ.get('SHOT_MODE', 'fit')

cookie = ''
for line in open(JAR):
    # curl 把 HttpOnly cookie 写成 "#HttpOnly_domain" 行——不能当注释跳过
    if (line.startswith('#') and not line.startswith('#HttpOnly_')) or not line.strip():
        continue
    parts = line.strip().split('\t')
    if len(parts) >= 7 and parts[5] == 'hadm':
        cookie = 'hadm=' + parts[6]
if not cookie:
    print('NO-COOKIE', file=sys.stderr)
    sys.exit(1)

COMMON = """
function shotExpand(cb) {
  var wb = document.querySelector('.arch-workbench');
  wb.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--surface,#fff)';
  var vp = document.getElementById('archViewport');
  vp.style.height = (window.innerHeight - 56) + 'px';
  setTimeout(cb, 300);
}
"""

DRIVER = {
    'fit': COMMON + """
window.addEventListener('load', function() {
  setTimeout(function() {
    var archBtn = [...document.querySelectorAll('button, a, .tab')].find(function(el){ return el.textContent.trim() === '系统架构'; });
    if (archBtn) archBtn.click();
    setTimeout(function() {
      shotExpand(function() {
        document.querySelector('[data-arch-action="fit"]').click();
        document.title = 'SHOT-READY';
      });
    }, 1500);
  }, 800);
});
""",
    'mini': COMMON + """
window.addEventListener('load', function() {
  setTimeout(function() {
    var archBtn = [...document.querySelectorAll('button, a, .tab')].find(function(el){ return el.textContent.trim() === '系统架构'; });
    if (archBtn) archBtn.click();
    setTimeout(function() {
      shotExpand(function() {
        var mini = document.querySelector('[data-arch-node="site:mini"]');
        if (mini) mini.click();
        document.title = 'SHOT-READY';
      });
    }, 1500);
  }, 800);
});
""",
}[MODE]


class Proxy(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if '/admin/api/architecture/events' in self.path:
            # SSE 不透传：让 EventSource 走 onerror → 页面转轮询兜底（顺带验真机断开 UI）
            self.send_response(502)
            self.end_headers()
            return
        req = urllib.request.Request(UPSTREAM + self.path, headers={'Cookie': cookie, 'User-Agent': 'shot-proxy'})
        try:
            with urllib.request.urlopen(req, timeout=15, context=ssl.create_default_context()) as up:
                body = up.read()
                ctype = up.headers.get('Content-Type', 'application/octet-stream')
        except Exception:
            self.send_response(502)
            self.end_headers()
            return
        if 'text/html' in ctype and b'</body>' in body:
            body = body.replace(b'</body>', ('<script>' + DRIVER + '</script>').encode() + b'</body>')
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 18999), Proxy).serve_forever()
