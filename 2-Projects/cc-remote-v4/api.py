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
import glob
import threading
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

PORT = 19100
DEVICES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'devices.json')
ALLOWED_CLIS = {'claude', 'codex', 'gemini'}
PORT_RANGE = range(19010, 19100)  # 动态端口池（7001-7003 保留给默认 session）
WRAPPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ttyd-wrapper.sh')
PROJECT_DIR = os.environ.get('CC_REMOTE_CWD', '/Users/rayman.chen/mycc')
TMUX = shutil.which('tmux') or '/opt/homebrew/bin/tmux'

# 活跃 session 追踪
# {session_id: {cli, port, tmux_session, pid}}
sessions = {}

# 启动时扫描已有的默认 session
for cli, port in [('claude', 19001), ('codex', 19002), ('gemini', 19003)]:
    tmux_name = f'cc-{cli}'
    result = subprocess.run([TMUX, 'has-session', '-t', tmux_name], capture_output=True)
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
            [TMUX, 'has-session', '-t', session_id],
            capture_output=True
        ).returncode == 0
        if session_id not in sessions and not tmux_exists:
            break
        idx += 1

    base_path = f'/{cli}-{idx}'

    # tmux session 由 tmux-session.sh 在用户首次连接 ttyd 时创建
    # 避免 claude 命令在非 TTY 环境下启动后立即退出导致 session 消失

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
    subprocess.run([TMUX, 'kill-session', '-t', s['tmux_session']], capture_output=True)

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


# ── History API: session 历史缓存 ──────────────────────────────
_history_cache = {'claude': None, 'codex': None}
_history_cache_ts = {'claude': 0, 'codex': 0}
_history_cache_lock = threading.Lock()
HISTORY_CACHE_TTL = 60  # 缓存 60 秒

HOME = os.path.expanduser('~')
CLAUDE_SESSIONS_DIR = os.path.join(HOME, '.claude', 'projects', '-Users-rayman-chen-mycc')
CLAUDE_STATS_FILE = os.path.join(HOME, '.claude', '.session-stats.json')
CODEX_SESSIONS_DIR = os.path.join(HOME, '.codex', 'sessions', '2026')


def _load_session_stats():
    """加载 Claude session-stats.json 用于时间戳查询"""
    try:
        with open(CLAUDE_STATS_FILE) as f:
            data = json.load(f)
        return data.get('sessions', {})
    except Exception:
        return {}


def _count_lines_fast(filepath):
    """快速计算文件行数（不读整个文件到内存）"""
    count = 0
    try:
        with open(filepath, 'rb') as f:
            for _ in f:
                count += 1
    except Exception:
        pass
    return count


def _extract_claude_first_message(filepath):
    """从 Claude JSONL 读取第一条 user 消息，返回 (sessionId, timestamp, summary, cwd) 或 None"""
    try:
        with open(filepath, 'r', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 30:  # 只扫描前 30 行
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get('type') == 'user':
                    msg = obj.get('message', {})
                    content = msg.get('content', '')
                    if isinstance(content, list):
                        # content 可能是 [{"type":"text","text":"..."}]
                        texts = [c.get('text', '') for c in content if isinstance(c, dict)]
                        content = ' '.join(texts)
                    session_id = obj.get('sessionId', '')
                    timestamp = obj.get('timestamp', '')
                    cwd = obj.get('cwd', '')
                    summary = content[:80] if content else ''
                    return session_id, timestamp, summary, cwd
    except Exception:
        pass
    return None


def _extract_codex_first_message(filepath):
    """从 Codex JSONL 读取 session_meta + 第一条 user 消息"""
    session_id = ''
    timestamp = ''
    cwd = ''
    summary = ''
    try:
        with open(filepath, 'r', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 30:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get('type') == 'session_meta':
                    payload = obj.get('payload', {})
                    session_id = payload.get('id', '')
                    timestamp = payload.get('timestamp', obj.get('timestamp', ''))
                    cwd = payload.get('cwd', '')
                elif obj.get('type') == 'response_item':
                    payload = obj.get('payload', {})
                    if payload.get('role') == 'user':
                        contents = payload.get('content', [])
                        for c in contents:
                            text = c.get('text', '')
                            # 跳过系统注入的内容（以 < 或 # 开头）
                            if text and not text.startswith('<') and not text.startswith('#'):
                                summary = text[:80]
                                break
                        if summary:
                            break
    except Exception:
        pass
    if session_id:
        return session_id, timestamp, summary, cwd
    return None


def _scan_claude_sessions(limit=50, search=''):
    """扫描 Claude session 文件，返回列表"""
    pattern = os.path.join(CLAUDE_SESSIONS_DIR, '*.jsonl')
    files = glob.glob(pattern)
    if not files:
        return []

    # 按修改时间排序（最新在前）
    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)

    # 加载 session stats
    stats = _load_session_stats()

    results = []
    for filepath in files:
        if len(results) >= limit:
            break
        try:
            extracted = _extract_claude_first_message(filepath)
            if not extracted:
                continue
            sid, ts, summary, cwd = extracted

            # 搜索过滤
            if search and search.lower() not in summary.lower():
                continue

            # 尝试从 stats 获取更精确的时间戳
            stat_info = stats.get(sid, {})
            if stat_info.get('started_at'):
                ts = datetime.fromtimestamp(stat_info['started_at'], tz=timezone.utc).isoformat()

            msg_count = _count_lines_fast(filepath)

            results.append({
                'id': sid,
                'engine': 'claude',
                'summary': summary,
                'timestamp': ts,
                'cwd': cwd,
                'message_count': msg_count,
            })
        except Exception:
            continue
    return results


def _scan_codex_sessions(limit=50, search=''):
    """扫描 Codex session 文件，返回列表"""
    pattern = os.path.join(CODEX_SESSIONS_DIR, '**', '*.jsonl')
    files = glob.glob(pattern, recursive=True)
    if not files:
        return []

    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)

    results = []
    for filepath in files:
        if len(results) >= limit:
            break
        try:
            extracted = _extract_codex_first_message(filepath)
            if not extracted:
                continue
            sid, ts, summary, cwd = extracted

            if search and search.lower() not in summary.lower():
                continue

            msg_count = _count_lines_fast(filepath)

            results.append({
                'id': sid,
                'engine': 'codex',
                'summary': summary,
                'timestamp': ts,
                'cwd': cwd,
                'message_count': msg_count,
            })
        except Exception:
            continue
    return results


def get_history_sessions(engine='claude', search='', limit=50):
    """获取历史 session 列表（带缓存）"""
    now = time.time()
    with _history_cache_lock:
        # 有搜索词时不用缓存
        if not search and _history_cache[engine] is not None and (now - _history_cache_ts[engine]) < HISTORY_CACHE_TTL:
            return _history_cache[engine][:limit]

    if engine == 'claude':
        result = _scan_claude_sessions(limit=limit, search=search)
    elif engine == 'codex':
        result = _scan_codex_sessions(limit=limit, search=search)
    else:
        return []

    # 只缓存无搜索词的结果
    if not search:
        with _history_cache_lock:
            _history_cache[engine] = result
            _history_cache_ts[engine] = now

    return result[:limit]


def resume_session(engine, session_id, tmux_session):
    """在指定 tmux session 中恢复历史会话"""
    if engine == 'claude':
        cmd = f'claude -r {session_id}'
    elif engine == 'codex':
        cmd = f'codex --resume {session_id}'
    else:
        return False, f'Unknown engine: {engine}'

    try:
        subprocess.run(
            [TMUX, 'send-keys', '-t', tmux_session, cmd, 'Enter'],
            check=True, timeout=5
        )
        return True, None
    except subprocess.CalledProcessError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)


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
        elif self.path.startswith('/api/history/sessions'):
            self.handle_history_sessions()
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
        elif self.path == '/api/history/resume':
            self.handle_history_resume(data)
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
            cmd = [TMUX, 'send-keys', '-t', session, KEY_MAP[keys]]
        elif keys.endswith('\r'):
            text = keys[:-1]
            if text:
                subprocess.run([TMUX, 'send-keys', '-t', session, '-l', text], check=True, timeout=5)
            cmd = [TMUX, 'send-keys', '-t', session, 'Enter']
        else:
            cmd = [TMUX, 'send-keys', '-t', session, '-l', keys]

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
                    subprocess.run([TMUX, 'copy-mode', '-t', session], capture_output=True, timeout=5)
                    for _ in range(lines):
                        subprocess.run([TMUX, 'send-keys', '-t', session, '-X', 'scroll-up'], capture_output=True, timeout=5)
                else:
                    # 翻页（兼容旧行为）
                    subprocess.run([TMUX, 'copy-mode', '-u', '-t', session], check=True, timeout=5)
            elif direction == 'down':
                if lines > 0:
                    for _ in range(lines):
                        subprocess.run([TMUX, 'send-keys', '-t', session, '-X', 'scroll-down'], capture_output=True, timeout=5)
                else:
                    subprocess.run([TMUX, 'send-keys', '-t', session, '-X', 'page-down'], check=True, timeout=5)
            elif direction == 'exit':
                subprocess.run([TMUX, 'send-keys', '-t', session, '-X', 'cancel'], check=True, timeout=5)
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

    def handle_history_sessions(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        engine = params.get('engine', ['claude'])[0]
        search = params.get('search', [''])[0]
        limit = min(int(params.get('limit', ['50'])[0]), 200)
        try:
            result = get_history_sessions(engine=engine, search=search, limit=limit)
            self.send_json(200, {'sessions': result})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def handle_history_resume(self, data):
        engine = data.get('engine', '')
        session_id = data.get('session_id', '')
        tmux_session = data.get('tmux_session', '')
        if not engine or not session_id or not tmux_session:
            self.send_json(400, {'error': 'Missing engine, session_id, or tmux_session'})
            return
        ok, err = resume_session(engine, session_id, tmux_session)
        if ok:
            self.send_json(200, {'ok': True})
        else:
            self.send_json(500, {'error': err})

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
