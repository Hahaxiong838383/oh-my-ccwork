#!/usr/bin/env python3

import argparse
import concurrent.futures
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile


XRAY = '/usr/local/bin/xray'
CURL = '/usr/bin/curl'
BALANCER = 'lisa-direct-then-dmit'
TARGETS = {
    'primary': '新美宅-Claude-GPT',
    'secondary': '美宅-Claude-GPT_mychenchuan',
    'direct_zgo': 'Gemini专用-US2-VLESS-Reality-IP',
}
DEFAULT_STATE = Path('/var/lib/xray-lisa-failover/state.json')
DEFAULT_URL = 'http://cp.cloudflare.com/generate_204'


def initial_state():
    return {
        'version': 1,
        'selected': 'primary',
        'health': {
            name: {'healthy': True, 'successes': 0, 'failures': 0}
            for name in ('primary', 'secondary')
        },
    }


def read_state(path):
    if not path.exists():
        return initial_state()
    state = json.loads(path.read_text())
    if state.get('version') != 1 or state.get('selected') not in TARGETS:
        raise ValueError('Invalid failover state version or selected route')
    for name in ('primary', 'secondary'):
        entry = state['health'][name]
        if not isinstance(entry['healthy'], bool) or not all(
            isinstance(entry[field], int) and entry[field] >= 0
            for field in ('successes', 'failures')
        ):
            raise ValueError(f'Invalid health state for {name}')
    return state


def advance_health(entry, succeeded, threshold):
    if succeeded:
        entry['successes'] = min(threshold, entry['successes'] + 1)
        entry['failures'] = 0
        if entry['successes'] >= threshold:
            entry['healthy'] = True
    else:
        entry['failures'] = min(threshold, entry['failures'] + 1)
        entry['successes'] = 0
        if entry['failures'] >= threshold:
            entry['healthy'] = False


def select_route(state):
    if state['health']['primary']['healthy']:
        return 'primary'
    if state['health']['secondary']['healthy']:
        return 'secondary'
    return 'direct_zgo'


def run_command(arguments, timeout):
    return subprocess.run(
        arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )


def probe(port, url):
    try:
        result = run_command(
            [CURL, '-q', '--proxy', f'socks5h://127.0.0.1:{port}', '--noproxy', '',
             '--head', '--silent', '--show-error', '--output', '/dev/null',
             '--write-out', '%{http_code}', '--connect-timeout', '5', '--max-time', '8', url],
            timeout=10,
        )
        return result.returncode == 0 and result.stdout.strip() == '204'
    except subprocess.TimeoutExpired:
        return False


def write_state(path, state):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix='state-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(state, output, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--api', default='127.0.0.1:14990')
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--url', default=DEFAULT_URL)
    parser.add_argument('--primary-port', type=int, default=14881)
    parser.add_argument('--secondary-port', type=int, default=14882)
    parser.add_argument('--direct-port', type=int, default=14883)
    parser.add_argument('--threshold', type=int, default=2)
    args = parser.parse_args()
    if args.threshold < 1:
        parser.error('threshold must be positive')

    args.state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.state.parent / 'controller.lock').open('a+') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = run_command([XRAY, 'api', 'bi', f'--server={args.api}', BALANCER], timeout=5)
        if status.returncode != 0:
            raise RuntimeError('Xray routing API is unavailable; leaving route unchanged')

        state = read_state(args.state)
        ports = {
            'primary': args.primary_port,
            'secondary': args.secondary_port,
            'direct_zgo': args.direct_port,
        }
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = {name: executor.submit(probe, port, args.url) for name, port in ports.items()}
            results = {name: future.result() for name, future in futures.items()}

        for name in ('primary', 'secondary'):
            advance_health(state['health'][name], results[name], args.threshold)
        selected = select_route(state)
        override = run_command(
            [XRAY, 'api', 'bo', f'--server={args.api}', '-b', BALANCER, TARGETS[selected]],
            timeout=5,
        )
        if override.returncode != 0:
            raise RuntimeError('Xray balancer override failed; leaving stored state unchanged')

        state['selected'] = selected
        state['updated_at'] = datetime.now(timezone.utc).isoformat()
        write_state(args.state, state)
        print(
            f"selected={selected} primary={results['primary']} "
            f"secondary={results['secondary']} direct_zgo={results['direct_zgo']} "
            f"primary_failures={state['health']['primary']['failures']} "
            f"secondary_failures={state['health']['secondary']['failures']}"
        )


if __name__ == '__main__':
    main()
