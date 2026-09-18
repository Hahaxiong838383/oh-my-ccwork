"""Scoped Xray Manager extension. No root web process, no generic shell endpoint."""
import json
from pathlib import Path
import secrets
import socket
import urllib.parse

SOCKET_PATH = Path.home() / 'Library/Application Support/EasyTierManager/control.sock'


def rpc(action):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(2)
            connection.connect(str(SOCKET_PATH))
            connection.sendall(json.dumps({'action': action}).encode() + b'\n')
            data = bytearray()
            while len(data) <= 262144:
                part = connection.recv(16384)
                if not part:
                    break
                data.extend(part)
                if b'\n' in part:
                    return json.loads(data.split(b'\n', 1)[0])
    except (OSError, ValueError):
        pass
    return {'ok': False, 'error': 'monitor_unavailable'}


def extend_manager(base_handler, html, rpc_call=rpc):
    token = secrets.token_urlsafe(32)
    fragment = Path(__file__).with_name('easytier-tab.html').read_text(encoding='utf-8')
    fragment = fragment.replace('__ET_TOKEN__', json.dumps(token))
    tab = '<button type="button" class="tab" style="background:none" onclick="switchTab(\'easytier\')">EasyTier 组网</button>'
    anchor = '<div class="tab" onclick="switchTab(\'logs\')">日志</div>'
    if html.count(anchor) != 1 or html.count('</body>') != 1:
        raise RuntimeError('Xray UI anchor changed; integration refused')
    html = html.replace(anchor, anchor + '\n' + tab)
    # Insert alongside the existing tab panels, not inside a modal or outside the container.
    start = html.index('  <!-- 节点管理 -->')
    html = html[:start] + fragment + '\n' + html[start:]

    class EasyTierHandler(base_handler):
        def _et_allowed(self, require_token=True):
            hosts = self.headers.get_all('Host', [])
            if len(hosts) != 1:
                return False
            host = hosts[0]
            allowed = {'127.0.0.1:%s' % self.server.server_port, 'localhost:%s' % self.server.server_port}
            if host not in allowed:
                return False
            if self.client_address[0] not in ('127.0.0.1', '::1'):
                return False
            origin = self.headers.get('Origin')
            if origin is not None and origin != 'http://' + host:
                return False
            if self.headers.get('Sec-Fetch-Site', '') == 'cross-site':
                return False
            supplied = self.headers.get('X-EasyTier-Token', '')
            return not require_token or secrets.compare_digest(supplied, token)

        def _et_reply(self, payload, status=200):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urllib.parse.urlsplit(self.path).path
            if path == '/':
                if not self._et_allowed(False):
                    return self._et_reply({'ok': False, 'error': 'origin_denied'}, 403)
                # Root contains the process-scoped CSRF token; it must not be cached.
                body = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Frame-Options', 'DENY')
                self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
                self.end_headers()
                self.wfile.write(body)
                return
            if path.startswith('/api/easytier'):
                if not self._et_allowed():
                    return self._et_reply({'ok': False, 'error': 'origin_or_token_denied'}, 403)
                if path != '/api/easytier/status':
                    return self._et_reply({'ok': False, 'error': 'not_found'}, 404)
                result = rpc_call('status')
                return self._et_reply(result, 200 if result.get('ok') else 503)
            return super().do_GET()

        def do_POST(self):
            path = urllib.parse.urlsplit(self.path).path
            if not path.startswith('/api/easytier'):
                return super().do_POST()
            if not self._et_allowed():
                return self._et_reply({'ok': False, 'error': 'origin_or_token_denied'}, 403)
            if path not in ('/api/easytier/check', '/api/easytier/restart'):
                return self._et_reply({'ok': False, 'error': 'not_found'}, 404)
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or self.headers.get('Transfer-Encoding'):
                    raise ValueError()
                length = int(lengths[0])
                if length < 0 or length > 128 or self.headers.get_content_type() != 'application/json':
                    raise ValueError()
                self.connection.settimeout(2)
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError()
                action = path.rsplit('/', 1)[-1]
                if data != ({'confirm': True} if action == 'restart' else {}):
                    raise ValueError()
                # JSON true only, not integer 1.
                if action == 'restart' and data.get('confirm') is not True:
                    raise ValueError()
            except (ValueError, OSError):
                return self._et_reply({'ok': False, 'error': 'invalid_request'}, 400)
            result = rpc_call(action)
            return self._et_reply(result, 202 if result.get('ok') else 409)

        def do_OPTIONS(self):
            if urllib.parse.urlsplit(self.path).path.startswith('/api/easytier'):
                return self._et_reply({'ok': False, 'error': 'cross_origin_not_supported'}, 403)
            return super().do_OPTIONS()

    return EasyTierHandler, html
