#!/usr/bin/env python3
"""Real sing-box 1.14.3 DNS persistence/optimistic-cache acceptance.

Only loopback sockets, documentation-only answer IPs and owned Popen children are
used. Artifacts go to a new /tmp directory, never beside production credentials.
This tests the Linux engine, not Android boot order, DoT, proxy health or playback.
"""
import argparse
import collections
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time


DEFAULT_BINARY = '/tmp/video-proxy/sing-box-1.14.3-linux-amd64/sing-box'


def read_name(packet, offset):
    labels = []
    resume = None
    seen = set()
    while True:
        if offset in seen:
            raise ValueError('DNS compression loop')
        seen.add(offset)
        length = packet[offset]
        if length & 0xc0 == 0xc0:
            if resume is None:
                resume = offset + 2
            offset = ((length & 0x3f) << 8) | packet[offset + 1]
        elif not length:
            return '.'.join(labels).lower(), resume or offset + 1
        else:
            offset += 1
            labels.append(packet[offset:offset + length].decode('ascii'))
            offset += length


def question(name):
    ident = int.from_bytes(os.urandom(2), 'big')
    qname = b''.join(bytes([len(label)]) + label.encode() for label in name.split('.')) + b'\0'
    return ident, struct.pack('!6H', ident, 0x0100, 1, 0, 0, 0) + qname + struct.pack('!HH', 1, 1)


def query(port, name, timeout=4):
    ident, request = question(name)
    started = time.monotonic()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(timeout)
        client.sendto(request, ('127.0.0.1', port))
        response, _ = client.recvfrom(65535)
    rx_id, flags, qd, an, _, _ = struct.unpack_from('!6H', response)
    if rx_id != ident or not flags & 0x8000:
        raise AssertionError('not a matching DNS response')
    offset = 12
    for _ in range(qd):
        _, offset = read_name(response, offset)
        offset += 4
    addresses, ttls = [], []
    for _ in range(an):
        _, offset = read_name(response, offset)
        kind, cls, ttl, size = struct.unpack_from('!HHIH', response, offset)
        offset += 10
        if (kind, cls, size) == (1, 1, 4):
            addresses.append(socket.inet_ntoa(response[offset:offset + size]))
            ttls.append(ttl)
        offset += size
    return {'addresses': addresses, 'ttls': ttls, 'rcode': flags & 15,
            'elapsed_ms': round((time.monotonic() - started) * 1000, 2)}


class Upstream(socketserver.ThreadingUDPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), UpstreamHandler)
        self.state_lock = threading.Lock()
        self.records = {}
        self.counts = collections.Counter()
        self.events = []

    def set_answer(self, name, ip, ttl, gate=None, drop=False):
        with self.state_lock:
            self.records[name] = (ip, ttl, gate, drop)

    def count(self, name):
        with self.state_lock:
            return self.counts[name]


class UpstreamHandler(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        name, end = read_name(packet, 12)
        with self.server.state_lock:
            self.server.counts[name] += 1
            record = self.server.records.get(name)
            self.server.events.append({'name': name, 'count': self.server.counts[name],
                                       'monotonic': time.monotonic()})
        if record is None:
            return
        ip, ttl, gate, drop = record
        if drop or (gate and not gate.wait(8)):
            return
        reply = (packet[:2] + struct.pack('!5H', 0x8180, 1, 1, 0, 0)
                 + packet[12:end + 4] + b'\xc0\x0c'
                 + struct.pack('!HHIH', 1, 1, ttl, 4) + socket.inet_aton(ip))
        sock.sendto(reply, self.client_address)


def wait_for(predicate, seconds=3, description='condition'):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError('timed out waiting for ' + description)
        time.sleep(0.025)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def identity(pid):
    root = Path('/proc') / str(pid)
    return {'pid': pid, 'exe': os.readlink(root / 'exe'),
            'start_ticks': (root / 'stat').read_text().rsplit(')', 1)[1].split()[19],
            'argv': (root / 'cmdline').read_bytes().split(b'\0')[:-1]}


class Harness:
    def __init__(self, binary):
        self.binary = str(Path(binary).resolve(strict=True))
        self.root = Path(tempfile.mkdtemp(prefix='singbox-dns-cache-'))
        self.root.chmod(0o700)
        self.children = []
        self.gates = []
        self.result = {'scope': 'real Linux sing-box; loopback DNS only; no device changes',
                       'artifact_directory': str(self.root), 'assertions': []}
        self.upstream = Upstream()
        self.thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.thread.start()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        self.port = free_port()

    def record(self, name, passed, **evidence):
        self.result['assertions'].append({'name': name, 'passed': bool(passed), **evidence})
        if not passed:
            raise AssertionError(name)

    def config(self, database='cache.db', optimistic='3s'):
        return {'log': {'level': 'debug', 'timestamp': True},
                'dns': {'servers': [{'type': 'udp', 'tag': 'fixture', 'server': '127.0.0.1',
                                     'server_port': self.upstream.server_address[1]}],
                        'final': 'fixture', 'strategy': 'ipv4_only', 'timeout': '1s',
                        'optimistic': {'enabled': True, 'timeout': optimistic}},
                'inbounds': [{'type': 'direct', 'tag': 'dns-in', 'listen': '127.0.0.1',
                              'listen_port': self.port}],
                'route': {'rules': [{'inbound': 'dns-in', 'action': 'hijack-dns'}]},
                'experimental': {'cache_file': {'enabled': True, 'store_dns': True,
                                                 'path': str(self.root / database)}}}

    def start(self, label, database='cache.db'):
        config = self.root / (label + '.json')
        config.write_text(json.dumps(self.config(database), indent=2) + '\n')
        config.chmod(0o600)
        checked = subprocess.run([self.binary, 'check', '-c', str(config)],
                                 capture_output=True, text=True, timeout=10)
        self.record(label + '_config_valid', checked.returncode == 0, output=checked.stderr)
        logfile = (self.root / (label + '.log')).open('wb')
        proc = subprocess.Popen([self.binary, 'run', '-c', str(config)],
                                stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT)
        child = (proc, identity(proc.pid), logfile)
        self.children.append(child)

        def ready():
            if proc.poll() is not None:
                raise AssertionError(label + ' exited before readiness')
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=0.1):
                    return True
            except OSError:
                return False

        wait_for(ready, description=label + ' listener')
        return child

    def stop(self, child, abrupt=False):
        proc, expected, logfile = child
        if proc.poll() is None:
            if identity(proc.pid) != expected:
                raise AssertionError('child identity changed; refusing to signal')
            (proc.kill if abrupt else proc.terminate)()
            proc.wait(timeout=5)
        logfile.close()
        self.record('owned_child_stopped_' + str(proc.pid), not Path('/proc', str(proc.pid)).exists(),
                    returncode=proc.returncode, abrupt=abrupt)

    def gate(self):
        gate = threading.Event()
        self.gates.append(gate)
        return gate

    def run(self):
        version = subprocess.check_output([self.binary, 'version'], text=True, timeout=5)
        self.record('engine_version_1_14_3', version.startswith('sing-box version 1.14.3\n'), version=version)
        candidate = self.root / 'production-duration-check.json'
        candidate.write_text(json.dumps(self.config(optimistic='5m')))
        checked = subprocess.run([self.binary, 'check', '-c', str(candidate)],
                                 capture_output=True, text=True, timeout=10)
        self.record('production_5m_schema_valid', checked.returncode == 0, output=checked.stderr)

        # The same query with a fresh DB is the negative control for disk reuse.
        name = 'persist.cache.test'
        self.upstream.set_answer(name, '192.0.2.11', 120)
        first = self.start('initial')
        answer = query(self.port, name)
        self.record('initial_payload_from_upstream', answer['addresses'] == ['192.0.2.11']
                    and self.upstream.count(name) == 1, answer=answer)
        answer = query(self.port, name)
        self.record('warm_cache_avoids_upstream', answer['addresses'] == ['192.0.2.11']
                    and self.upstream.count(name) == 1, answer=answer)
        # Allow the async persistent writer to run, then kill without Close().
        time.sleep(1.25)
        db = self.root / 'cache.db'
        self.record('cache_database_written_while_running', db.exists() and db.stat().st_size > 0,
                    bytes=db.stat().st_size if db.exists() else 0)
        self.stop(first, abrupt=True)
        self.upstream.set_answer(name, '192.0.2.12', 120)
        second = self.start('after-abrupt-exit')
        answer = query(self.port, name)
        self.record('cache_survives_abrupt_process_exit', answer['addresses'] == ['192.0.2.11']
                    and self.upstream.count(name) == 1, answer=answer,
                    upstream_requests=self.upstream.count(name))
        self.stop(second)
        negative = self.start('empty-database-control', 'empty.db')
        answer = query(self.port, name)
        self.record('empty_db_requires_fresh_upstream', answer['addresses'] == ['192.0.2.12']
                    and self.upstream.count(name) == 2, answer=answer)
        self.stop(negative)

        active = self.start('optimistic-runtime')
        name = 'refresh.cache.test'
        self.upstream.set_answer(name, '192.0.2.21', 1)
        answer = query(self.port, name)
        self.record('refresh_seed_payload', answer['addresses'] == ['192.0.2.21'], answer=answer)
        gate = self.gate()
        self.upstream.set_answer(name, '192.0.2.22', 30, gate=gate)
        time.sleep(1.3)
        future = self.pool.submit(query, self.port, name)
        wait_for(lambda: self.upstream.count(name) >= 2, description='background refresh request')
        # The replacement is impossible until gate.set(); the old reply must
        # arrive while that upstream exchange is still explicitly blocked.
        answer = future.result(timeout=0.5)
        self.record('stale_returned_while_refresh_blocked', not gate.is_set()
                    and answer['addresses'] == ['192.0.2.21'], answer=answer)
        gate.set()
        wait_for(lambda: query(self.port, name)['addresses'] == ['192.0.2.22'],
                 description='refreshed cache payload')
        count = self.upstream.count(name)
        answer = query(self.port, name)
        self.record('refresh_replaces_stale_cached_ip', answer['addresses'] == ['192.0.2.22']
                    and self.upstream.count(name) == count, answer=answer, upstream_requests=count)

        name = 'bounded.cache.test'
        self.upstream.set_answer(name, '192.0.2.31', 1)
        answer = query(self.port, name)
        self.record('bounded_seed_payload', answer['addresses'] == ['192.0.2.31'], answer=answer)
        gate = self.gate()
        self.upstream.set_answer(name, '192.0.2.32', 30, gate=gate)
        time.sleep(4.35)  # TTL 1s + optimistic window 3s, plus a boundary margin.
        future = self.pool.submit(query, self.port, name)
        wait_for(lambda: self.upstream.count(name) >= 2, description='expired foreground query')
        time.sleep(0.2)
        self.record('beyond_window_waits_for_upstream', not future.done() and not gate.is_set(),
                    upstream_requests=self.upstream.count(name))
        gate.set()
        answer = future.result(timeout=2)
        self.record('beyond_window_returns_new_payload', answer['addresses'] == ['192.0.2.32'], answer=answer)

        # Cached age must not reset on process restart, even though the file is
        # persistent. Also prove an unavailable upstream cannot resurrect it.
        name = 'restart-bound.cache.test'
        self.upstream.set_answer(name, '192.0.2.41', 1)
        answer = query(self.port, name)
        self.record('restart_bound_seed_payload', answer['addresses'] == ['192.0.2.41'], answer=answer)
        time.sleep(1.25)
        self.stop(active, abrupt=True)
        time.sleep(3.1)
        self.upstream.set_answer(name, '192.0.2.42', 30, drop=True)
        restarted = self.start('restart-after-window')
        try:
            answer = query(self.port, name, timeout=2)
        except TimeoutError:
            answer = {'timeout': True, 'addresses': []}
        self.record('restart_does_not_revive_expired_ip_during_outage',
                    '192.0.2.41' not in answer['addresses'] and self.upstream.count(name) >= 2,
                    answer=answer, upstream_requests=self.upstream.count(name))
        self.upstream.set_answer(name, '192.0.2.42', 30)
        answer = query(self.port, name)
        self.record('upstream_recovery_returns_new_payload', answer['addresses'] == ['192.0.2.42'], answer=answer)
        self.stop(restarted)

    def finish(self):
        for gate in self.gates:
            gate.set()
        for child in self.children:
            if child[0].poll() is None:
                self.stop(child)
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.upstream.shutdown()
        self.upstream.server_close()
        self.result['upstream_events'] = self.upstream.events
        self.result['passed'] = all(item['passed'] for item in self.result['assertions']) and 'error' not in self.result
        (self.root / 'result.json').write_text(json.dumps(self.result, indent=2) + '\n')
        print(json.dumps({'passed': self.result['passed'], 'assertions': len(self.result['assertions']),
                          'result': str(self.root / 'result.json'),
                          **({'error': self.result['error']} if 'error' in self.result else {})}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default=DEFAULT_BINARY)
    args = parser.parse_args()
    harness = Harness(args.binary)
    try:
        harness.run()
    except Exception as error:
        harness.result['error'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        harness.finish()


if __name__ == '__main__':
    main()
