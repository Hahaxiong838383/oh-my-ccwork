"""通过应用专用 Xray 入口启动原版 Grok Bot，覆盖 Chromium 与 Node 原生请求。"""

import argparse
import copy
import json
import os
import plistlib
import re
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path

APP_PATH = Path('/Applications/Grok Bot.app')
APP_EXECUTABLE = str(APP_PATH / 'Contents/MacOS/Grok Bot')
PROXY_PORT = 10809
HTTP_PROXY = f'http://127.0.0.1:{PROXY_PORT}'
SOCKS_PROXY = f'socks5://127.0.0.1:{PROXY_PORT}'
BASE_BYPASS = ('localhost', '127.0.0.1', '::1', 'smart-api.hahaxiong.top', 'cli4.hahaxiong.cc')
CHROMIUM_BYPASS = 'localhost;127.0.0.1;[::1];10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;smart-api.hahaxiong.top;cli4.hahaxiong.cc'
XRAY_DIRECTORY = Path.home() / 'xray'
PROXY_CONFIG = XRAY_DIRECTORY / 'grok-bot-proxy.json'
PROXY_LABEL = 'com.mycc.grok-bot.proxy'
PROXY_PLIST = Path.home() / 'Library/LaunchAgents' / f'{PROXY_LABEL}.plist'
PROXY_SERVICE = f'gui/{os.getuid()}/{PROXY_LABEL}'


def ensure_proxy(start=True):
    source_path = XRAY_DIRECTORY / 'config.json'
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    grok_rule = next(rule for rule in source['routing']['rules'] if 'domain:grok.com' in rule.get('domain', []))
    target_tag = grok_rule.get('outboundTag')
    if not target_tag:
        raise RuntimeError('Grok 主路由不是固定出站；请先核对均衡器，不自动猜测节点。')
    outbound = copy.deepcopy(next(item for item in source['outbounds'] if item.get('tag') == target_tag))
    if outbound.get('proxySettings') or outbound.get('streamSettings', {}).get('sockopt', {}).get('dialerProxy'):
        raise RuntimeError('Grok 节点依赖其他出站；本启动器不自动拆分链路。')
    access_path = XRAY_DIRECTORY / 'grok-bot-proxy-access.log'
    runtime_path = XRAY_DIRECTORY / 'grok-bot-proxy.log'
    for log_path in [access_path, runtime_path]:
        descriptor = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.close(descriptor)
        log_path.chmod(0o600)
    config = {
        'log': {'loglevel': 'warning', 'access': str(access_path)},
        'inbounds': [{'tag': 'grok-bot', 'listen': '127.0.0.1', 'port': PROXY_PORT, 'protocol': 'mixed', 'settings': {'auth': 'noauth', 'udp': True}}],
        'outbounds': [outbound, {'tag': 'direct', 'protocol': 'freedom', 'settings': {}}],
        'routing': {'domainStrategy': 'IPIfNonMatch', 'rules': [
            {'type': 'field', 'ip': ['geoip:private'], 'outboundTag': 'direct'},
            {'type': 'field', 'domain': ['domain:smart-api.hahaxiong.top', 'full:cli4.hahaxiong.cc'], 'outboundTag': 'direct'},
        ]},
    }
    config_bytes = (json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()
    old_config = PROXY_CONFIG.read_bytes() if PROXY_CONFIG.exists() else None
    config_changed = old_config != config_bytes
    with tempfile.NamedTemporaryFile(prefix='.grok-bot-', suffix='.json', dir=XRAY_DIRECTORY, delete=False) as candidate:
        candidate_path = Path(candidate.name)
        candidate.write(config_bytes)
        candidate.flush()
        os.fsync(candidate.fileno())
    candidate_path.chmod(0o600)
    try:
        result = subprocess.run([str(XRAY_DIRECTORY / 'xray'), 'run', '-test', '-c', str(candidate_path)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('应用专用 Xray 配置校验失败；未更改常驻配置。')
        if source_path.read_bytes() != source_bytes or (PROXY_CONFIG.read_bytes() if PROXY_CONFIG.exists() else None) != old_config:
            raise RuntimeError('检测到配置并发变化；停止写入。')
        if config_changed:
            os.replace(candidate_path, PROXY_CONFIG)
        PROXY_CONFIG.chmod(0o600)
    finally:
        candidate_path.unlink(missing_ok=True)
    plist = {
        'Label': PROXY_LABEL,
        'ProgramArguments': [str(XRAY_DIRECTORY / 'xray'), 'run', '-c', str(PROXY_CONFIG)],
        'WorkingDirectory': str(XRAY_DIRECTORY),
        'KeepAlive': True,
        'RunAtLoad': True,
        'Umask': 63,
        'StandardOutPath': str(runtime_path),
        'StandardErrorPath': str(runtime_path),
    }
    plist_bytes = plistlib.dumps(plist)
    old_plist = PROXY_PLIST.read_bytes() if PROXY_PLIST.exists() else None
    plist_changed = old_plist != plist_bytes
    if plist_changed:
        with tempfile.NamedTemporaryFile(prefix='.grok-bot-', suffix='.plist', dir=PROXY_PLIST.parent, delete=False) as candidate:
            plist_candidate = Path(candidate.name)
            candidate.write(plist_bytes)
            candidate.flush()
            os.fsync(candidate.fileno())
        plist_candidate.chmod(0o644)
        try:
            if (PROXY_PLIST.read_bytes() if PROXY_PLIST.exists() else None) != old_plist:
                raise RuntimeError('检测到 LaunchAgent 并发变化；停止写入。')
            os.replace(plist_candidate, PROXY_PLIST)
        finally:
            plist_candidate.unlink(missing_ok=True)
    print(f'应用专用代理配置已校验；出站与 Grok 主规则一致：{target_tag}。')
    if not start:
        return
    loaded = subprocess.run(['launchctl', 'print', PROXY_SERVICE], capture_output=True).returncode == 0
    if loaded and (config_changed or plist_changed):
        subprocess.run(['launchctl', 'bootout', PROXY_SERVICE], check=True, capture_output=True)
        loaded = False
    if not loaded:
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listener.bind(('127.0.0.1', PROXY_PORT))
            except OSError as error:
                raise RuntimeError('专用端口已被其他进程占用；未启动竞争代理。') from error
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PROXY_PLIST)], check=True, capture_output=True)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', PROXY_PORT), timeout=0.2):
                return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError('应用专用代理未启动；主 Xray 未修改。')


def app_pids():
    result = subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True)
    found = []
    for line in result.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[1] == APP_EXECUTABLE:
            found.append(int(fields[0]))
    return found


def process_setting(pid, key):
    command = subprocess.check_output(['ps', 'eww', '-p', str(pid), '-o', 'command='], text=True)
    match = re.search(r'(?:^|\s)' + re.escape(key) + r'=([^\s]*)', command)
    return match.group(1) if match else None


def launch(restart=False):
    if not APP_PATH.is_dir():
        raise RuntimeError('未找到已安装的 Grok Bot.app')
    with socket.create_connection(('127.0.0.1', PROXY_PORT), timeout=3):
        pass
    existing = app_pids()
    inherited_bypass = os.environ.get('no_proxy', os.environ.get('NO_PROXY', ''))
    if existing:
        inherited_bypass = process_setting(existing[0], 'no_proxy') or process_setting(existing[0], 'NO_PROXY') or inherited_bypass
        current_matches = all(
            process_setting(pid, 'NODE_USE_ENV_PROXY') == '1'
            and process_setting(pid, 'HTTP_PROXY') == HTTP_PROXY
            and process_setting(pid, 'HTTPS_PROXY') == HTTP_PROXY
            for pid in existing
        )
        if current_matches and not restart:
            print('Grok Bot 已通过应用专用代理运行；未重启。')
            return
        if not restart:
            raise RuntimeError('旧实例仍在运行；经授权后添加 --restart，才能应用启动参数。')
        for pid in existing:
            if pid in app_pids():
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 20
        while app_pids() and time.monotonic() < deadline:
            time.sleep(0.25)
        if app_pids():
            raise RuntimeError('应用没有正常退出；未强制结束，也未启动第二实例。')
    bypass = ','.join(dict.fromkeys([*BASE_BYPASS, *filter(None, inherited_bypass.split(','))]))
    settings = {
        'NODE_USE_ENV_PROXY': '1',
        'HTTP_PROXY': HTTP_PROXY,
        'HTTPS_PROXY': HTTP_PROXY,
        'http_proxy': HTTP_PROXY,
        'https_proxy': HTTP_PROXY,
        'ALL_PROXY': SOCKS_PROXY,
        'all_proxy': SOCKS_PROXY,
        'NO_PROXY': bypass,
        'no_proxy': bypass,
    }
    command = ['/usr/bin/open', '-a', str(APP_PATH)]
    for key, value in settings.items():
        command.extend(['--env', f'{key}={value}'])
    command.extend(['--args', f'--proxy-server={HTTP_PROXY}', f'--proxy-bypass-list={CHROMIUM_BYPASS}', '--disable-quic'])
    subprocess.run(command, check=True)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        running = app_pids()
        if running:
            for pid in running:
                if process_setting(pid, 'NODE_USE_ENV_PROXY') != '1' or process_setting(pid, 'HTTPS_PROXY') != HTTP_PROXY:
                    raise RuntimeError('应用启动了，但代理环境校验未通过。')
            print(f'Grok Bot 已启动，PID={running[0]}，专用入口=127.0.0.1:{PROXY_PORT}。')
            return
        time.sleep(0.25)
    raise RuntimeError('应用启动超时；未更改原 App、登录或会话存储。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart', action='store_true', help='授权维护窗口内，正常结束旧实例后重新启动')
    parser.add_argument('--prepare-only', action='store_true', help='只校验并保存专用代理配置，不启动代理或重启 App')
    arguments = parser.parse_args()
    ensure_proxy(start=not arguments.prepare_only)
    if not arguments.prepare_only:
        launch(restart=arguments.restart)
