#!/usr/bin/env python3
"""Loopback-only two-hop SOCKS TCP/UDP acceptance; owns only its Popen children."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
BINARY = Path('/tmp/video-proxy/sing-box-1.14.3-linux-amd64/sing-box').resolve()
RESULT = {'scope': 'loopback SOCKS protocol only; no HY2/public network/television',
          'assertions': [], 'owned_processes': [], 'cleanup': []}
CHILDREN = []


def record(name, condition, **evidence):
    RESULT['assertions'].append({'name': name, 'passed': bool(condition), **evidence})
    if not condition:
        raise AssertionError(name)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def recv_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        part = sock.recv(count - len(data))
        if not part:
            raise EOFError('socket closed before complete payload')
        data.extend(part)
    return bytes(data)


def free_tcp_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def proc_identity(pid):
    p = Path('/proc') / str(pid)
    stat = (p / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'start_ticks': stat[19],
            'exe': os.readlink(p / 'exe'),
            'argv': (p / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')}


def stop_owned(child):
    proc, identity, logfile = child
    if proc.poll() is None:
        current = proc_identity(proc.pid)
        if current != identity:
            raise RuntimeError('ownership mismatch; refusing to signal process')
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if proc_identity(proc.pid) != identity:
                raise RuntimeError('ownership mismatch before kill')
            proc.kill()
            proc.wait(timeout=3)
    logfile.close()
    RESULT['cleanup'].append({'pid': proc.pid, 'returncode': proc.returncode,
                              'proc_path_absent': not Path('/proc', str(proc.pid)).exists()})


def start_box(name, config, port):
    path = ROOT / (name + '.json')
    path.write_text(json.dumps(config, indent=2) + '\n')
    path.chmod(0o600)
    check = subprocess.run([str(BINARY), 'check', '-c', str(path)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
    (ROOT / (name + '-check.log')).write_bytes(check.stdout)
    record(name + '_config_check', check.returncode == 0)
    logfile = (ROOT / (name + '.log')).open('wb')
    proc = subprocess.Popen([str(BINARY), 'run', '-c', str(path)],
                            stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT)
    child = (proc, proc_identity(proc.pid), logfile)
    CHILDREN.append(child)
    RESULT['owned_processes'].append(child[1])
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(name + ' exited before listening')
        try:
            with socket.create_connection(('127.0.0.1', port), 0.2):
                return child
        except OSError:
            time.sleep(0.04)
    raise TimeoutError(name + ' did not listen')


class SocksReplyError(OSError):
    pass


def socks_command(port, command, target_port=0):
    sock = socket.create_connection(('127.0.0.1', port), 3)
    sock.settimeout(3)
    try:
        sock.sendall(b'\x05\x01\x00')
        if recv_exact(sock, 2) != b'\x05\x00':
            raise SocksReplyError('unexpected authentication response')
        addr = b'\x7f\x00\x00\x01' if command == 1 else b'\0' * 4
        sock.sendall(bytes([5, command, 0, 1]) + addr + struct.pack('!H', target_port))
        version, reply, reserved, atyp = recv_exact(sock, 4)
        if (version, reserved) != (5, 0) or reply != 0:
            raise SocksReplyError('SOCKS command rejected, reply=' + str(reply))
        if atyp == 1:
            host = socket.inet_ntop(socket.AF_INET, recv_exact(sock, 4))
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, recv_exact(sock, 16))
        else:
            raise SocksReplyError('unexpected non-IP relay address')
        relay_port = struct.unpack('!H', recv_exact(sock, 2))[0]
        if command == 3:
            ip = ipaddress.ip_address(host)
            if not (ip.is_loopback or ip.is_unspecified):
                raise SocksReplyError('non-loopback relay refused')
            if ip.is_unspecified:
                host = '127.0.0.1'
        return sock, (host, relay_port)
    except BaseException:
        sock.close()
        raise


class EchoHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            while True:
                data = self.request.recv(65536)
                if not data:
                    return
                self.request.sendall(data)
        except (OSError, TimeoutError):
            return


class EchoServer(socketserver.ThreadingTCPServer):
    daemon_threads = True


def tcp_roundtrip(proxy_port, echo_port, payload):
    sock, _ = socks_command(proxy_port, 1, echo_port)
    with sock:
        sock.sendall(payload)
        return recv_exact(sock, len(payload))


def udp_roundtrip(proxy_port, echo_port, payload):
    control, relay = socks_command(proxy_port, 3)
    with control, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.bind(('127.0.0.1', 0))
        udp.settimeout(3)
        udp.sendto(b'\0\0\0\x01\x7f\0\0\x01' + struct.pack('!H', echo_port) + payload, relay)
        packet, sender = udp.recvfrom(65535)
        if not ipaddress.ip_address(sender[0]).is_loopback:
            raise SocksReplyError('non-loopback UDP sender')
        if packet[:4] != b'\0\0\0\x01':
            raise SocksReplyError('unexpected UDP response header')
        source = (socket.inet_ntop(socket.AF_INET, packet[4:8]), struct.unpack('!H', packet[8:10])[0])
        if source != ('127.0.0.1', echo_port):
            raise SocksReplyError('UDP echo source mismatch')
        return packet[10:]


def main():
    tcp_echo = EchoServer(('127.0.0.1', 0), EchoHandler)
    tcp_thread = threading.Thread(target=tcp_echo.serve_forever, daemon=True)
    tcp_thread.start()
    udp_echo = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp_echo.bind(('127.0.0.1', 0))
    udp_echo.settimeout(0.2)
    stop_udp = threading.Event()
    udp_seen = []

    def udp_loop():
        while not stop_udp.is_set():
            try:
                data, addr = udp_echo.recvfrom(65535)
                udp_seen.append(digest(data))
                udp_echo.sendto(data, addr)
            except socket.timeout:
                continue
            except OSError:
                return

    threading.Thread(target=udp_loop, daemon=True).start()
    tcp_port, udp_port = tcp_echo.server_address[1], udp_echo.getsockname()[1]
    worker_port = free_tcp_port()
    main_port = free_tcp_port()
    record('ports_loopback_non_dns', len({tcp_port, udp_port, worker_port, main_port}) == 4
           and all(p != 53 for p in [tcp_port, udp_port, worker_port, main_port]),
           tcp_echo=tcp_port, udp_echo=udp_port, main_socks=main_port, worker_socks=worker_port)
    worker_config = {'log': {'level': 'info', 'timestamp': True},
        'inbounds': [{'type': 'socks', 'tag': 'worker-socks', 'listen': '127.0.0.1', 'listen_port': worker_port}],
        'outbounds': [{'type': 'direct', 'tag': 'echo-direct'}], 'route': {'final': 'echo-direct'}}
    main_config = {'log': {'level': 'info', 'timestamp': True},
        'inbounds': [{'type': 'socks', 'tag': 'fixed-yt-probe', 'listen': '127.0.0.1', 'listen_port': main_port}],
        'outbounds': [{'type': 'socks', 'tag': 'yt-rack-hy2', 'server': '127.0.0.1',
            'server_port': worker_port, 'version': '5', 'network': ['tcp', 'udp']}],
        'route': {'final': 'yt-rack-hy2'}}
    try:
        worker = start_box('worker', worker_config, worker_port)
        main_box = start_box('main', main_config, main_port)
        tcp_payload = bytes(range(256)) * 1024
        record('two_hop_tcp_complete_payload', tcp_roundtrip(main_port, tcp_port, tcp_payload) == tcp_payload,
               bytes=len(tcp_payload), sha256=digest(tcp_payload))
        udp_payloads = [b'SOCKS-UDP-POSITIVE-' + bytes(range(256)) * n for n in [1, 4, 32]]
        for i, payload in enumerate(udp_payloads):
            record('two_hop_udp_complete_payload_' + str(i), udp_roundtrip(main_port, udp_port, payload) == payload,
                   bytes=len(payload), sha256=digest(payload))
        record('udp_reached_echo_server', all(digest(x) in udp_seen for x in udp_payloads))
        stop_owned(worker)
        record('worker_stopped_main_alive', worker[0].poll() is not None and main_box[0].poll() is None)
        try:
            tcp_roundtrip(main_port, tcp_port, b'SHOULD-NOT-PASS-TCP')
            tcp_failure = None
        except (SocksReplyError, OSError, EOFError, TimeoutError) as error:
            tcp_failure = type(error).__name__
        record('worker_down_tcp_fails', tcp_failure is not None, error_class=tcp_failure)
        negative_udp = b'SHOULD-NOT-PASS-UDP'
        try:
            udp_roundtrip(main_port, udp_port, negative_udp)
            udp_failure = None
        except (SocksReplyError, OSError, EOFError, TimeoutError) as error:
            udp_failure = type(error).__name__
        record('worker_down_udp_fails', udp_failure is not None, error_class=udp_failure)
        record('worker_down_udp_not_at_echo', digest(negative_udp) not in udp_seen)
        # Positive controls after worker failure distinguish proxy failure from dead echo servers.
        with socket.create_connection(('127.0.0.1', tcp_port), 3) as sock:
            sock.sendall(b'DIRECT-TCP-CONTROL')
            record('tcp_echo_still_healthy', recv_exact(sock, 18) == b'DIRECT-TCP-CONTROL')
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(3)
            sock.sendto(b'DIRECT-UDP-CONTROL', ('127.0.0.1', udp_port))
            record('udp_echo_still_healthy', sock.recvfrom(100)[0] == b'DIRECT-UDP-CONTROL')
        record('main_still_alive_after_negative_anchors', main_box[0].poll() is None)
        RESULT['passed'] = True
    finally:
        for child in reversed(CHILDREN):
            if not child[2].closed:
                stop_owned(child)
        stop_udp.set()
        udp_echo.close()
        tcp_echo.shutdown()
        tcp_echo.server_close()
        RESULT['echo_servers_closed'] = True


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        RESULT['passed'] = False
        RESULT['failure'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        RESULT['all_owned_processes_reaped'] = all(child[0].poll() is not None for child in CHILDREN)
        (ROOT / 'result.json').write_text(json.dumps(RESULT, indent=2) + '\n')
        print(json.dumps(RESULT, indent=2))
