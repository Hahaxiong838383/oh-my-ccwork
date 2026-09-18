#!/usr/bin/env python3
"""Read-only Air health monitor; manual restart only. Python 3.9+, stdlib."""
import concurrent.futures
import copy
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import signal
import socket
import socketserver
import stat
import subprocess
import threading
import time

STATE_DIR = Path.home() / 'Library/Application Support/EasyTierManager'
CLI = '/usr/local/bin/easytier-cli'
HELPER = '/Library/PrivilegedHelperTools/cn.easytier.manager-restart'
TARGETS = [('10.10.10.12', 'Studio'), ('10.10.10.23', '家里开发机'), ('10.10.10.13', 'dev198')]
NAMES = dict(TARGETS + [('10.10.10.11', 'Mini'), ('10.10.10.1', '香港中继'), ('10.10.10.22', '飞牛 NAS'), ('10.10.10.24', 'Windows 开发机'), ('10.10.10.14', 'NIO 开发机')])
INTERVAL = 30
COOLDOWN = 600


def command(argv, timeout=5):
    """Never return stderr: tool parse errors can contain secret-bearing config."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                           env={'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(Path.home()), 'LANG': 'en_US.UTF-8'})
        return r.returncode, r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return -1, ''


def probe(ip, timeout=4):
    """Fixed caller-side IP allowlist; bounded SSH identification, not authentication."""
    started = time.monotonic()
    result = {'ip': ip, 'ok': False, 'tcp': False, 'code': 'tcp_timeout', 'ms': None}
    try:
        with socket.create_connection((ip, 22), timeout=min(2, timeout)) as sock:
            result['tcp'] = True
            result['code'] = 'banner_timeout'
            sock.sendall(b'SSH-2.0-EasyTierHealth_1\r\n')
            data = b''
            while len(data) < 1024:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    break
                sock.settimeout(remaining)
                block = sock.recv(min(256, 1024 - len(data)))
                if not block:
                    result['code'] = 'closed'
                    break
                data += block
                if any(line.startswith(b'SSH-2.0-') and line.endswith(b'\r') for line in data.split(b'\n')[:-1]):
                    result.update(ok=True, code='ssh_response')
                    break
    except ConnectionRefusedError:
        result['code'] = 'refused'
    except socket.timeout:
        pass
    except OSError:
        result['code'] = 'connection_error'
    result['ms'] = round((time.monotonic() - started) * 1000)
    return result


def safe_peers(raw):
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError('not a peer list')
    peers = []
    for entry in parsed[:256]:
        if not isinstance(entry, dict):
            continue
        ip = str(entry.get('ipv4', ''))
        try:
            if ipaddress.ip_address(ip) not in ipaddress.ip_network('10.10.10.0/24'):
                continue
        except ValueError:
            continue
        peers.append({key: str(entry.get(key, ''))[:100] for key in
                      ['ipv4', 'hostname', 'cost', 'lat_ms', 'tunnel_proto', 'version']})
    return peers


def system_info():
    _, launch = command(['/bin/launchctl', 'print', 'system/cn.easytier.mesh'])
    pid_match = re.search(r'^\s*pid = (\d+)$', launch, re.M)
    running = bool(pid_match and re.search(r'^\s*state = running$', launch, re.M))
    pid = int(pid_match.group(1)) if pid_match else None
    uptime = ''
    if pid:
        _, uptime = command(['/bin/ps', '-p', str(pid), '-o', 'etime='])
    _, route = command(['/sbin/route', '-n', 'get', 'default'])
    interface_match = re.search(r'interface:\s*([a-z]+\d+)', route)
    gateway_match = re.search(r'gateway:\s*([0-9.]+)', route)
    interface = interface_match.group(1) if interface_match else ''
    address = ''
    if interface:
        _, address = command(['/usr/sbin/ipconfig', 'getifaddr', interface])
    address = address.strip()
    try:
        address = str(ipaddress.IPv4Address(address))
    except ValueError:
        address = ''
    return {'running': running, 'pid': pid, 'uptime': uptime.strip()[:40],
            'interface': interface, 'physical_ip': address,
            'gateway': gateway_match.group(1) if gateway_match else '',
            'virtual_ip': '10.10.10.31', 'version': ''}


def health(info, probes, rpc_ok):
    if not info.get('interface') or not info.get('physical_ip'):
        return 'offline'
    if not info.get('running'):
        return 'stopped'
    if not rpc_ok:
        return 'unknown'
    return 'healthy' if len(probes) == len(TARGETS) and all(p.get('ok') for p in probes) else 'degraded'


class Monitor:
    def __init__(self, state_dir=STATE_DIR, runner=command, prober=probe, info_fn=system_info):
        self.directory = Path(state_dir)
        self.runner, self.prober, self.info_fn = runner, prober, info_fn
        self.lock = threading.RLock()
        self.jobs = queue.Queue(maxsize=2)
        self.stop = threading.Event()
        self.restart_pending = False
        self.check_pending = False
        self.last_request = 0
        self.state = {'schema': 1, 'health': 'checking', 'last_checked': None, 'local': {},
                      'nodes': [], 'probes': [], 'events': [], 'auto_recovery': False,
                      'restart': {'phase': 'idle', 'last_success': 0, 'cooldown_seconds': COOLDOWN},
                      'poll_seconds': INTERVAL}
        try:
            previous = json.loads((self.directory / 'status.json').read_text())
            self.state['events'] = previous.get('events', [])[-50:]
            self.state['restart']['last_success'] = float(previous.get('restart', {}).get('last_success', 0))
            if previous.get('restart', {}).get('phase') in ('queued', 'restarting', 'verifying'):
                self.state['restart']['phase'] = 'interrupted'
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        self.event('info', '观察模式已启动；不会自动重启 EasyTier')

    def event(self, level, message):
        with self.lock:
            self.state['events'].insert(0, {'at': time.time(), 'level': level, 'message': message})
            del self.state['events'][50:]

    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.state)
        now = time.time()
        result['server_time'] = now
        result['stale'] = result['last_checked'] is None or now - result['last_checked'] > 90
        if result['stale'] and result['health'] not in ('checking', 'recovering'):
            result['health'] = 'unknown'
        result['restart']['cooldown_remaining'] = max(0, int(COOLDOWN - (now - result['restart']['last_success'])))
        return result

    def persist(self):
        payload = self.snapshot()
        tmp = self.directory / ('status.%s.tmp' % os.getpid())
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                os.chmod(tmp, 0o600)
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, self.directory / 'status.json')
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass

    def sample(self):
        info = self.info_fn()
        code, text = self.runner([CLI, '-p', '127.0.0.1:15888', '-o', 'json', 'peer'])
        try:
            peers = safe_peers(text) if code == 0 else []
            rpc_ok = code == 0
        except (ValueError, TypeError):
            peers, rpc_ok = [], False
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            probes = list(pool.map(self.prober, [ip for ip, _ in TARGETS]))
        by_ip = {p['ip']: p for p in probes}
        own = next((p for p in peers if p['ipv4'] == '10.10.10.31'), {})
        info['version'] = own.get('version', '')
        rows = []
        for p in peers:
            if p['ipv4'] == '10.10.10.31':
                continue
            rows.append(dict(p, name=NAMES.get(p['ipv4'], p['hostname']), probe=by_ip.get(p['ipv4']), observed=True))
        for ip, name in TARGETS:
            if not any(p['ipv4'] == ip for p in rows):
                rows.append({'ipv4': ip, 'name': name, 'hostname': name, 'cost': '', 'lat_ms': '',
                             'tunnel_proto': '', 'probe': by_ip[ip], 'observed': False})
        order = {ip: n for n, (ip, _) in enumerate(TARGETS)}
        rows.sort(key=lambda p: (order.get(p['ipv4'], 99), p['ipv4']))
        current_health = health(info, probes, rpc_ok)
        signature = tuple(info.get(k) for k in ('interface', 'physical_ip', 'gateway'))
        with self.lock:
            old = self.state.get('network_signature')
            if old is not None and tuple(old) != signature:
                self.event('info', '物理网络发生变化；仅检测，不自动重启')
            old_health = self.state.get('observed_health')
            if old_health != current_health:
                messages = {'healthy': '3 个关键目标 SSH 服务均有响应', 'degraded': '部分关键目标 SSH 服务探测未通过',
                            'offline': '物理网络未就绪', 'stopped': '本机 EasyTier 未运行', 'unknown': '无法读取 EasyTier 路径状态'}
                self.event('success' if current_health == 'healthy' else 'warning', messages[current_health])
            self.state.update(local=info, nodes=rows, probes=probes, rpc_ok=rpc_ok,
                              last_checked=time.time(), network_signature=list(signature), observed_health=current_health)
            if not self.restart_pending:
                self.state['health'] = current_health
        self.persist()
        return current_health

    def request(self, action):
        if action == 'status':
            return {'ok': True, 'status': self.snapshot()}
        if action not in ('check', 'restart'):
            return {'ok': False, 'error': 'unsupported_action'}
        with self.lock:
            if self.restart_pending:
                return {'ok': False, 'error': 'restart_in_progress'}
            if action == 'check':
                if self.check_pending or time.time() - self.last_request < 3:
                    return {'ok': True, 'accepted': False, 'message': '已有检测正在执行'}
                self.check_pending = True
            else:
                if time.time() - self.state['restart']['last_success'] < COOLDOWN:
                    return {'ok': False, 'error': 'cooldown'}
                self.restart_pending = True
                self.state['restart']['phase'] = 'queued'
                self.state['health'] = 'recovering'
            try:
                self.jobs.put_nowait(action)
            except queue.Full:
                if action == 'check':
                    self.check_pending = False
                else:
                    self.restart_pending = False
                    self.state['restart']['phase'] = 'idle'
                    self.state['health'] = self.state.get('observed_health', 'unknown')
                return {'ok': False, 'error': 'busy'}
            self.last_request = time.time()
        return {'ok': True, 'accepted': True, 'action': action}

    def restart(self):
        old_pid = self.info_fn().get('pid')
        with self.lock:
            self.state['restart']['phase'] = 'restarting'
            self.state['restart']['requested_at'] = time.time()
        self.event('warning', '用户请求重启本机 EasyTier；不操作 Xray 或远端节点')
        self.persist()
        code, _ = self.runner(['/usr/bin/sudo', '-n', HELPER], timeout=25)
        if code != 0:
            with self.lock:
                self.restart_pending = False
                self.state['restart']['phase'] = 'failed'
                self.state['restart']['error'] = 'cooldown' if code == 75 else 'authorization_or_restart_failed'
                self.state['health'] = 'unknown'
            self.event('warning', '重启未执行：冷却限制、授权未就绪或服务命令失败；请查看状态')
            self.persist()
            return
        with self.lock:
            self.state['restart'].update(phase='verifying', last_success=time.time(), error=None)
        self.persist()
        deadline = time.monotonic() + 60
        recovered = False
        while not self.stop.is_set() and time.monotonic() < deadline:
            self.sample()
            with self.lock:
                new_pid = self.state['local'].get('pid')
                recovered = self.state.get('observed_health') == 'healthy' and bool(new_pid) and new_pid != old_pid
            if recovered:
                break
            self.stop.wait(5)
        with self.lock:
            self.restart_pending = False
            self.state['restart']['phase'] = 'recovered' if recovered else 'verification_failed'
            self.state['health'] = self.state.get('observed_health', 'unknown') if recovered else 'degraded'
        self.event('success' if recovered else 'warning',
                   '恢复确认：新进程已运行，3 个关键目标 SSH 服务有响应' if recovered else '重启已执行，但 60 秒内未通过恢复验证；不会自动重试')
        self.persist()

    def worker(self):
        while not self.stop.is_set():
            action = 'check'
            try:
                if self.state['last_checked'] is not None:
                    action = self.jobs.get(timeout=INTERVAL)
                if action == 'restart':
                    self.restart()
                else:
                    self.sample()
            except queue.Empty:
                try:
                    self.sample()
                except Exception:
                    self.fail_sample()
            except Exception:
                self.fail_sample()
                if action == 'restart':
                    with self.lock:
                        self.restart_pending = False
                        self.state['restart']['phase'] = 'failed'
            finally:
                if action == 'check':
                    with self.lock:
                        self.check_pending = False
            # Avoid spinning if the first sampling attempt fails.
            if self.state['last_checked'] is None:
                self.stop.wait(3)

    def fail_sample(self):
        with self.lock:
            self.state['health'] = 'unknown'
        self.event('warning', '监控采样失败；保留上次数据并标记为未知')
        self.persist()


def main():
    os.umask(0o077)
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE_DIR, 0o700)
    lockfile = open(STATE_DIR / 'monitor.lock', 'a')
    try:
        fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('monitor already running')
    path = STATE_DIR / 'control.sock'
    if path.exists() or path.is_symlink():
        st = path.lstat()
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
            raise SystemExit('unexpected socket path')
        path.unlink()
    monitor = Monitor()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(2)
            try:
                line = self.rfile.readline(1025)
                if len(line) > 1024:
                    return
                request = json.loads(line)
                if not isinstance(request, dict) or set(request) != {'action'}:
                    response = {'ok': False, 'error': 'invalid_request'}
                else:
                    response = monitor.request(request['action'])
                self.wfile.write(json.dumps(response, ensure_ascii=False).encode() + b'\n')
            except (OSError, ValueError, TypeError):
                return

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    thread = threading.Thread(target=monitor.worker, daemon=True)
    thread.start()

    def stop_handler(_signum, _frame):
        monitor.stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    try:
        server.serve_forever(poll_interval=.3)
    finally:
        monitor.stop.set()
        server.server_close()
        path.unlink(missing_ok=True)
        lockfile.close()


if __name__ == '__main__':
    main()
