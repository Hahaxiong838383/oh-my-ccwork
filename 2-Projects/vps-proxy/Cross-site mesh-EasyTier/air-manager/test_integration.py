import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import easytier_manager as bridge
import easytier_monitor as monitor
import integrate


class TestHealth(unittest.TestCase):
    def setUp(self):
        self.info = {'running': True, 'pid': 123, 'interface': 'en0', 'physical_ip': '10.8.1.171', 'gateway': '10.8.1.254'}
        self.good = [{'ip': ip, 'ok': True, 'tcp': True, 'code': 'ssh_response', 'ms': 42} for ip, _ in monitor.TARGETS]

    def test_all_three_required(self):
        self.assertEqual(monitor.health(self.info, self.good, True), 'healthy')
        self.assertEqual(monitor.health(self.info, self.good[:2], True), 'degraded')

    def test_tcp_alone_is_not_healthy(self):
        self.good[0]['ok'] = False
        self.assertEqual(monitor.health(self.info, self.good, True), 'degraded')

    def test_offline_stopped_rpc_unknown(self):
        self.assertEqual(monitor.health(dict(self.info, physical_ip=''), self.good, True), 'offline')
        self.assertEqual(monitor.health(dict(self.info, running=False), self.good, True), 'stopped')
        self.assertEqual(monitor.health(self.info, self.good, False), 'unknown')

    def test_allowlisted_peer_schema(self):
        raw = json.dumps([{'ipv4': '10.10.10.12', 'hostname': 'studio', 'config': 'MUST_NOT_LEAK', 'network_secret': 'MUST_NOT_LEAK'}, {'ipv4': '1.2.3.4'}])
        rows = monitor.safe_peers(raw)
        self.assertEqual(len(rows), 1)
        self.assertNotIn('MUST_NOT_LEAK', json.dumps(rows))

    def test_invalid_peer_schema(self):
        with self.assertRaises(ValueError):
            monitor.safe_peers('{}')

    def make_monitor(self, directory, fail=False):
        data = dict(self.info)
        def runner(argv, timeout=5):
            if argv[0] == '/usr/bin/sudo':
                self.assertEqual(argv, ['/usr/bin/sudo', '-n', monitor.HELPER])
                if fail:
                    return 75, ''
                data['pid'] = 456
                return 0, ''
            return 0, json.dumps([{'ipv4': '10.10.10.31', 'hostname': 'air', 'version': '2.6.4'}])
        return monitor.Monitor(directory, runner=runner, prober=lambda ip: next(p for p in self.good if p['ip'] == ip), info_fn=lambda: dict(data))

    def test_sample_persists_no_secrets_no_auto(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            self.assertEqual(m.sample(), 'healthy')
            s = m.snapshot()
            self.assertFalse(s['auto_recovery'])
            self.assertEqual(len(s['nodes']), 3)
            self.assertEqual(s['restart']['last_success'], 0)
            self.assertEqual(Path(d, 'status.json').stat().st_mode & 0o777, 0o600)

    def test_stale_never_green(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            m.sample()
            m.state['last_checked'] = time.time() - 100
            self.assertEqual(m.snapshot()['health'], 'unknown')

    def test_restart_queue_deduplicates(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            self.assertTrue(m.request('restart')['accepted'])
            self.assertEqual(m.request('restart')['error'], 'restart_in_progress')
            self.assertEqual(m.request('check')['error'], 'restart_in_progress')
            self.assertEqual(m.snapshot()['restart']['phase'], 'queued')

    def test_restart_needs_new_pid_and_actual_probes(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            m.request('restart')
            m.restart()
            s = m.snapshot()
            self.assertEqual(s['restart']['phase'], 'recovered')
            self.assertEqual(s['local']['pid'], 456)
            self.assertEqual(m.request('restart')['error'], 'cooldown')

    def test_restart_permission_error_not_success(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d, fail=True)
            m.request('restart'); m.restart()
            self.assertEqual(m.snapshot()['restart']['phase'], 'failed')
            self.assertEqual(m.snapshot()['restart']['error'], 'cooldown')
            self.assertFalse(m.restart_pending)

    def test_failed_probe_never_claims_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            self.good[0]['ok'] = False
            m.request('restart')
            with patch.object(m.stop, 'wait', side_effect=lambda _: m.stop.set()):
                m.restart()
            self.assertEqual(m.snapshot()['restart']['phase'], 'verification_failed')
            self.assertEqual(m.snapshot()['health'], 'degraded')
            self.assertFalse(m.restart_pending)

    def test_same_pid_never_claims_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            original = m.runner
            m.runner = lambda argv, timeout=5: (0, '') if argv[0] == '/usr/bin/sudo' else original(argv, timeout)
            m.request('restart')
            with patch.object(m.stop, 'wait', side_effect=lambda _: m.stop.set()):
                m.restart()
            self.assertEqual(m.snapshot()['restart']['phase'], 'verification_failed')

    def test_config_commands_never_used(self):
        source = Path(monitor.__file__).read_text()
        self.assertNotIn("'node', 'info'", source)
        self.assertNotIn("'node', 'config'", source)

    def test_fixed_targets_only(self):
        self.assertEqual([ip for ip, _ in monitor.TARGETS], ['10.10.10.12', '10.10.10.23', '10.10.10.13'])

    def test_no_automatic_restarts_on_network_change(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.make_monitor(d)
            m.sample(); m.state['network_signature'] = ['en0', '192.168.1.2', '192.168.1.1']
            self.good[0]['ok'] = False
            m.sample()
            self.assertEqual(m.snapshot()['health'], 'degraded')
            self.assertFalse(m.restart_pending)
            self.assertTrue(m.jobs.empty())


class TestProbe(unittest.TestCase):
    def fake_socket(self, chunks):
        class Fake:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def sendall(self, _): pass
            def settimeout(self, _): pass
            def recv(self, _):
                value = chunks.pop(0)
                if isinstance(value, Exception): raise value
                return value
        return Fake()

    def test_split_banner(self):
        with patch('socket.create_connection', return_value=self.fake_socket([b'notice\r\nSSH-2.', b'0-OpenSSH\r\n'])):
            self.assertTrue(monitor.probe('10.10.10.12')['ok'])

    def test_tcp_timeout_not_ssh(self):
        with patch('socket.create_connection', return_value=self.fake_socket([socket.timeout()])):
            r = monitor.probe('10.10.10.12')
            self.assertTrue(r['tcp']); self.assertFalse(r['ok']); self.assertEqual(r['code'], 'banner_timeout')

    def test_wrong_banner(self):
        with patch('socket.create_connection', return_value=self.fake_socket([b'HTTP/1.1 200 OK\r\n', b''])):
            self.assertFalse(monitor.probe('10.10.10.12')['ok'])


class TestHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.actions = []
        class Base(BaseHTTPRequestHandler):
            def do_GET(self): self.send_response(204); self.end_headers()
            def do_POST(self): self.send_response(204); self.end_headers()
            def do_OPTIONS(self): self.send_response(204); self.end_headers()
            def log_message(self, *_): pass
        def call(action):
            cls.actions.append(action)
            return {'ok': True, 'status': {'health': 'healthy'}} if action == 'status' else {'ok': True, 'accepted': True}
        html = '<body><div class="tab" onclick="switchTab(\'logs\')">日志</div>  <!-- 节点管理 --></body>'
        handler, cls.html = bridge.extend_manager(Base, html, call)
        cls.server = HTTPServer(('127.0.0.1', 0), handler)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.token = json.loads(re.search(r'const etToken=(.*?);', cls.html).group(1))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def req(self, method, path, body=None, **headers):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse(); data = response.read(); status = response.status; hs = dict(response.getheaders()); conn.close()
        return status, hs, data

    def auth(self):
        return {'X-EasyTier-Token': self.token, 'Content-Type': 'application/json'}

    def test_root_is_uncached_and_no_frame(self):
        status, headers, _ = self.req('GET', '/')
        self.assertEqual(status, 200); self.assertEqual(headers['Cache-Control'], 'no-store'); self.assertEqual(headers['X-Frame-Options'], 'DENY')

    def test_rebinding_host_denied(self):
        self.assertEqual(self.req('GET', '/', Host='evil.example')[0], 403)

    def test_cross_origin_page_denied(self):
        self.assertEqual(self.req('GET', '/', Origin='https://evil.example')[0], 403)

    def test_token_required_for_status(self):
        self.assertEqual(self.req('GET', '/api/easytier/status')[0], 403)

    def test_status_no_cors_and_no_mutation(self):
        status, headers, _ = self.req('GET', '/api/easytier/status', **self.auth())
        self.assertEqual(status, 200); self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(self.actions[-1], 'status')

    def test_restart_get_rejected(self):
        self.assertEqual(self.req('GET', '/api/easytier/restart', **self.auth())[0], 404)

    def test_restart_needs_confirmation(self):
        self.assertEqual(self.req('POST', '/api/easytier/restart', '{}', **self.auth())[0], 400)

    def test_restart_integer_not_boolean(self):
        self.assertEqual(self.req('POST', '/api/easytier/restart', '{"confirm":1}', **self.auth())[0], 400)

    def test_restart_extra_arguments_rejected(self):
        self.assertEqual(self.req('POST', '/api/easytier/restart', '{"confirm":true,"cmd":"anything"}', **self.auth())[0], 400)

    def test_authorized_restart_is_asynchronous(self):
        self.assertEqual(self.req('POST', '/api/easytier/restart', '{"confirm":true}', **self.auth())[0], 202)
        self.assertEqual(self.actions[-1], 'restart')

    def test_bad_origin_with_correct_token(self):
        h = self.auth(); h['Origin'] = 'http://evil.example'
        self.assertEqual(self.req('POST', '/api/easytier/restart', '{"confirm":true}', **h)[0], 403)

    def test_null_origin(self):
        h = self.auth(); h['Origin'] = 'null'
        self.assertEqual(self.req('GET', '/api/easytier/status', **h)[0], 403)

    def test_preflight_denied(self):
        self.assertEqual(self.req('OPTIONS', '/api/easytier/restart')[0], 403)

    def test_large_body_and_malformed_json(self):
        self.assertEqual(self.req('POST', '/api/easytier/check', 'x'*130, **self.auth())[0], 400)
        self.assertEqual(self.req('POST', '/api/easytier/check', '{', **self.auth())[0], 400)

    def test_legacy_routes_preserved(self):
        self.assertEqual(self.req('GET', '/api/status')[0], 204)
        self.assertEqual(self.req('POST', '/api/old-action', '{}')[0], 204)

    def test_check_only_empty_body(self):
        self.assertEqual(self.req('POST', '/api/easytier/check', '{}', **self.auth())[0], 202)
        self.assertEqual(self.req('POST', '/api/easytier/check', '{"ip":"1.2.3.4"}', **self.auth())[0], 400)


class TestPatch(unittest.TestCase):
    def test_scoped_hook(self):
        original = 'hello\n' + integrate.ANCHOR + '\nworld'
        patched = integrate.patch(original)
        self.assertEqual(patched.replace(integrate.HOOK, ''), original)
        with self.assertRaises(ValueError): integrate.patch(patched)
        with self.assertRaises(ValueError): integrate.patch('unknown layout')


if __name__ == '__main__':
    unittest.main(verbosity=2)
