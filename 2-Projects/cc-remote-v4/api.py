#!/usr/bin/env python3
"""cc-remote API — 按键注入 + Session 管理"""
import http.server
import json
import subprocess
import os
import signal
import time
import cgi
import tempfile
import shutil

PORT = 19100
DEVICES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'devices.json')
ALLOWED_CLIS = {'claude', 'codex', 'gemini'}
PORT_RANGE = range(19010, 19100)  # 动态端口池（7001-7003 保留给默认 session）
WRAPPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ttyd-wrapper.sh')
PROJECT_DIR = os.environ.get('CC_REMOTE_CWD', '/Users/rayman.chen/mycc')

# 活跃 session 追踪
# {session_id: {cli, port, tmux_session, pid}}
sessions = {}

# 启动时扫描已有的默认 session
for cli, port in [('claude', 19001), ('codex', 19002), ('gemini', 19003)]:
    tmux_name = f'cc-{cli}'
    result = subprocess.run(['/opt/homebrew/bin/tmux', 'has-session', '-t', tmux_name], capture_output=True)
    if result.returncode == 0:
        sessions[tmux_name] = {
            'id': tmux_name,
            'cli': cli,
            'port': port,
            'tmux_session': tmux_name,
            'pid': None,  # 由 start.sh 管理
            'default': True,
        }

# 特殊按键映射
KEY_MAP = {
    '\r': 'Enter',
    '\x03': 'C-c',
    '\t': 'Tab',
    '\x1b': 'Escape',
    '\x1b[A': 'Up',
    '\x1b[B': 'Down',
    '\x0c': 'C-l',
    '\x1a': 'C-z',
    'PPage': 'PPage',
    'NPage': 'NPage',
}


def find_free_port():
    used = {s['port'] for s in sessions.values()}
    for p in PORT_RANGE:
        if p not in used:
            return p
    return None


DEFAULT_PORTS = {'claude': 19001, 'codex': 19002, 'gemini': 19003}
DEFAULT_PATHS = {'claude': '/claude', 'codex': '/codex', 'gemini': '/gemini'}
CADDYFILE_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Caddyfile')
CADDYFILE_RUNTIME = '/tmp/cc-remote-v4-Caddyfile'

def regenerate_caddyfile():
    """根据当前 sessions 重新生成 Caddyfile 并热重载 Caddy"""
    lines = [':19443 {']
    lines.append('\thandle / {')
    lines.append(f'\t\troot * {os.path.dirname(os.path.abspath(__file__))}/panel')
    lines.append('\t\tfile_server')
    lines.append('\t}')
    lines.append('\thandle /panel/* {')
    lines.append(f'\t\troot * {os.path.dirname(os.path.abspath(__file__))}/panel')
    lines.append('\t\tfile_server')
    lines.append('\t}')
    lines.append('\thandle /api/* {')
    lines.append('\t\treverse_proxy localhost:19100')
    lines.append('\t}')

    # 收集所有需要的路由（默认 + 动态）
    seen_paths = set()
    for s in sessions.values():
        path = s.get('base_path', f'/{s["cli"]}')
        port = s['port']
        if path in seen_paths:
            continue
        seen_paths.add(path)
        lines.append(f'\thandle {path}/* {{')
        lines.append(f'\t\treverse_proxy localhost:{port} {{')
        lines.append('\t\t\ttransport http {')
        lines.append('\t\t\t\tread_timeout 0')
        lines.append('\t\t\t\twrite_timeout 0')
        lines.append('\t\t\t}')
        lines.append('\t\t}')
        lines.append('\t}')

    lines.append('}')

    with open(CADDYFILE_RUNTIME, 'w') as f:
        f.write('\n'.join(lines) + '\n')

    # 热重载 Caddy
    subprocess.run([
        'caddy', 'reload', '--config', CADDYFILE_RUNTIME, '--adapter', 'caddyfile'
    ], capture_output=True, timeout=5)


def create_session(cli):
    if cli not in ALLOWED_CLIS:
        return None, f'Unknown CLI: {cli}'

    port = find_free_port()
    if port is None:
        return None, 'No free ports'

    # 生成唯一 session ID
    idx = 1
    while True:
        session_id = f'cc-{cli}-{idx}'
        tmux_exists = subprocess.run(
            ['/opt/homebrew/bin/tmux', 'has-session', '-t', session_id],
            capture_output=True
        ).returncode == 0
        if session_id not in sessions and not tmux_exists:
            break
        idx += 1

    base_path = f'/{cli}-{idx}'

    # 创建 tmux session
    subprocess.run([
        '/opt/homebrew/bin/tmux', 'new-session', '-d', '-s', session_id, '-c', PROJECT_DIR, cli
    ], check=True)

    # 启动 ttyd
    proc = subprocess.Popen([
        WRAPPER, str(port), base_path, session_id
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    sessions[session_id] = {
        'id': session_id,
        'cli': cli,
        'port': port,
        'tmux_session': session_id,
        'pid': proc.pid,
        'default': False,
        'base_path': base_path,
    }

    # 重新生成 Caddyfile 并热重载
    regenerate_caddyfile()

    return sessions[session_id], None


def destroy_session(session_id):
    if session_id not in sessions:
        return False, 'Session not found'

    s = sessions[session_id]

    # 杀 ttyd（非默认 session 才有独立 ttyd）
    if s.get('pid'):
        try:
            os.kill(s['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass

    # 杀 tmux session
    subprocess.run(['/opt/homebrew/bin/tmux', 'kill-session', '-t', s['tmux_session']], capture_output=True)

    # 移除 Caddy 路由（非默认 session）
    if not s.get('default'):
        try:
            subprocess.run([
                'curl', '-s', '-X', 'DELETE',
                f'http://localhost:2019/id/route-{session_id}',
            ], capture_output=True, timeout=5)
        except Exception:
            pass

    del sessions[session_id]

    # 重新生成 Caddyfile 并热重载
    regenerate_caddyfile()

    return True, None


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/devices':
            try:
                with open(DEVICES_FILE) as f:
                    devices = json.load(f)
            except Exception:
                devices = []
            self.send_json(200, {'devices': devices})
            return
        elif self.path == '/api/sessions':
            self.send_json(200, {
                'sessions': [
                    {
                        'id': s['id'],
                        'cli': s['cli'],
                        'port': s['port'],
                        'path': s.get('base_path', f'/{s["cli"]}'),
                        'default': s.get('default', False),
                        'display_name': s.get('display_name', ''),
                    }
                    for s in sessions.values()
                ]
            })
        else:
            self.send_error(404)

    def do_PUT(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode()
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error(400, 'Invalid JSON')
            return

        # PUT /api/session/cc-claude-2/rename
        if '/api/session/' in self.path and self.path.endswith('/rename'):
            parts = self.path.split('/')
            session_id = parts[-2]
            new_name = data.get('name', '').strip()
            if not new_name:
                self.send_json(400, {'error': 'Empty name'})
                return
            if session_id not in sessions:
                self.send_json(404, {'error': 'Session not found'})
                return
            sessions[session_id]['display_name'] = new_name
            self.send_json(200, {'ok': True})
        else:
            self.send_error(404)

    def do_POST(self):
        # upload 必须在读 body 之前处理（multipart 需要原始 rfile）
        if self.path == '/api/upload':
            self.handle_upload()
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode()
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error(400, 'Invalid JSON')
            return

        if self.path == '/api/send':
            self.handle_send(data)
        elif self.path == '/api/session/create':
            self.handle_create(data)
        elif self.path == '/api/scroll':
            self.handle_scroll(data)
        else:
            self.send_error(404)

    def do_DELETE(self):
        # /api/session/cc-claude-2
        if self.path.startswith('/api/session/'):
            session_id = self.path.split('/')[-1]
            ok, err = destroy_session(session_id)
            if ok:
                self.send_json(200, {'ok': True})
            else:
                self.send_json(400, {'error': err})
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def handle_send(self, data):
        session = data.get('session', '')
        keys = data.get('keys', '')

        # 验证 session 存在
        valid_sessions = {s['tmux_session'] for s in sessions.values()}
        if session not in valid_sessions:
            self.send_json(403, {'error': 'Invalid session'})
            return

        if not keys:
            self.send_json(400, {'error': 'Empty keys'})
            return

        if keys in KEY_MAP:
            cmd = ['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, KEY_MAP[keys]]
        elif keys.endswith('\r'):
            text = keys[:-1]
            if text:
                subprocess.run(['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-l', text], check=True, timeout=5)
            cmd = ['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, 'Enter']
        else:
            cmd = ['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-l', keys]

        try:
            subprocess.run(cmd, check=True, timeout=5)
            self.send_json(200, {'ok': True})
        except subprocess.CalledProcessError as e:
            self.send_json(500, {'error': str(e)})

    def handle_scroll(self, data):
        session = data.get('session', '')
        direction = data.get('direction', 'up')
        lines = min(data.get('lines', 0), 50)  # 逐行滚动，最多 50 行

        valid_sessions = {s['tmux_session'] for s in sessions.values()}
        if session not in valid_sessions:
            self.send_json(403, {'error': 'Invalid session'})
            return

        try:
            if direction == 'up':
                if lines > 0:
                    # 逐行滚动：先进 copy-mode，再上滚 N 行
                    subprocess.run(['/opt/homebrew/bin/tmux', 'copy-mode', '-t', session], capture_output=True, timeout=5)
                    for _ in range(lines):
                        subprocess.run(['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-X', 'scroll-up'], capture_output=True, timeout=5)
                else:
                    # 翻页（兼容旧行为）
                    subprocess.run(['/opt/homebrew/bin/tmux', 'copy-mode', '-u', '-t', session], check=True, timeout=5)
            elif direction == 'down':
                if lines > 0:
                    for _ in range(lines):
                        subprocess.run(['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-X', 'scroll-down'], capture_output=True, timeout=5)
                else:
                    subprocess.run(['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-X', 'page-down'], check=True, timeout=5)
            elif direction == 'exit':
                subprocess.run(['/opt/homebrew/bin/tmux', 'send-keys', '-t', session, '-X', 'cancel'], check=True, timeout=5)
            self.send_json(200, {'ok': True})
        except subprocess.CalledProcessError as e:
            self.send_json(500, {'error': str(e)})

    def handle_create(self, data):
        cli = data.get('cli', '')
        try:
            session, err = create_session(cli)
        except Exception as e:
            self.send_json(500, {'error': str(e)})
            return
        if err:
            self.send_json(400, {'error': err})
        else:
            self.send_json(200, {
                'ok': True,
                'session': {
                    'id': session['id'],
                    'cli': session['cli'],
                    'port': session['port'],
                    'path': session.get('base_path', f'/{session["cli"]}'),
                }
            })

    def handle_upload(self):
        content_type = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in content_type:
            self.send_json(400, {'error': 'Expected multipart/form-data'})
            return

        # 解析 multipart
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': content_type}
        )

        file_item = form['file'] if 'file' in form else None
        if file_item is None or not hasattr(file_item, 'filename') or not file_item.filename:
            self.send_json(400, {'error': 'No file'})
            return

        # 保存到项目的 uploads 目录
        upload_dir = os.path.join(PROJECT_DIR, '.uploads')
        os.makedirs(upload_dir, exist_ok=True)

        # 安全文件名
        filename = os.path.basename(file_item.filename)
        filepath = os.path.join(upload_dir, filename)

        # 避免覆盖
        if os.path.exists(filepath):
            name, ext = os.path.splitext(filename)
            filepath = os.path.join(upload_dir, f'{name}_{int(time.time())}{ext}')
            filename = os.path.basename(filepath)

        with open(filepath, 'wb') as f:
            shutil.copyfileobj(file_item.file, f)

        self.send_json(200, {'ok': True, 'path': filepath, 'filename': filename})

    def send_json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass

if __name__ == '__main__':
    server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
    print(f'[API] cc-remote API 启动在端口 {PORT}（{len(sessions)} 个默认 session）')
    server.serve_forever()
