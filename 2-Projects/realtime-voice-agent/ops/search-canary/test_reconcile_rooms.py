import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import base64
import hashlib
import hmac
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('reconcile_rooms.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RoomAPI:
    """Only the remote SFU boundary is replaced; real record lifecycle is tested."""
    def __init__(self, sid='RM_old'):
        self.room = {'name': 'sn-BJP00326060100100004-123', 'sid': sid}
        self.calls = []
        self.fail_delete = False
        self.keep_room = False

    def post(self, method, data):
        self.calls.append((method, data))
        if method == 'ListRooms':
            assert data == {'names': ['sn-BJP00326060100100004-123']}
            return {'rooms': [self.room] if self.room else []}
        assert method == 'DeleteRoom'
        assert data == {'room': 'sn-BJP00326060100100004-123'}
        if self.fail_delete:
            raise OSError('injected transport failure')
        if not self.keep_room:
            self.room = None
        return {}


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'pending.json'
        self.record = {'schema': 1, 'room': 'sn-BJP00326060100100004-123',
                       'sid': 'RM_old', 'generation': 'g1', 'deadline_ms': 90000,
                       'state': 'active', 'updated_at_ms': 1000,
                       'pid': 123, 'process_start': '12345'}
        self.window = {'enabled': True, 'generation': 'g1', 'expires_at_ms': 90000,
                       'allowlist': ['BJP00326060100100004']}
        self.api = RoomAPI()
        self.save()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.record))

    def run_case(self, now=5000, alive=True):
        return m.reconcile(self.path, self.window, self.api, now, lambda *_: alive)

    def test_live_authorized_room_is_never_deleted_early(self):
        self.assertEqual(self.run_case()['status'], 'active')
        self.assertEqual(self.api.calls, [])
        self.assertTrue(self.path.exists())

    def test_verification_cannot_query_or_delete_a_real_device_record(self):
        result = m.reconcile(self.path, {}, self.api, 90000, lambda *_: False,
                             only_subject='BJP00399999999999901')
        self.assertEqual(result['status'], 'invalid')
        self.assertEqual(self.api.calls, [])
        self.assertTrue(self.path.exists())

    def test_verification_own_record_still_reconciles(self):
        self.record['room'] = 'sn-BJP00399999999999901-123'
        self.save()
        class AbsentAPI:
            def post(inner, method, data):
                self.assertEqual(method, 'ListRooms')
                self.assertEqual(data, {'names': [self.record['room']]})
                return {'rooms': []}
        result = m.reconcile(self.path, {}, AbsentAPI(), 90000, lambda *_: False,
                             only_subject='BJP00399999999999901')
        self.assertEqual(result['status'], 'absent')
        self.assertFalse(self.path.exists())

    def test_deadline_deletes_and_confirms_absence(self):
        self.assertEqual(self.run_case(now=90000)['status'], 'deleted')
        self.assertFalse(self.path.exists())
        self.assertEqual([x[0] for x in self.api.calls], ['ListRooms', 'DeleteRoom', 'ListRooms'])

    def test_transport_failure_survives_next_run_and_then_recovers(self):
        self.api.fail_delete = True
        self.assertEqual(self.run_case(now=90000)['status'], 'pending')
        self.assertTrue(self.path.exists())
        self.api.fail_delete = False
        self.assertEqual(self.run_case(now=90001)['status'], 'deleted')
        self.assertFalse(self.path.exists())

    def test_success_response_without_room_disappearing_keeps_pending(self):
        self.api.keep_room = True
        self.assertEqual(self.run_case(now=90000)['status'], 'pending')
        self.assertTrue(self.path.exists())

    def test_name_reused_by_new_sid_is_not_deleted(self):
        self.api.room['sid'] = 'RM_new'
        self.assertEqual(self.run_case(now=90000)['status'], 'superseded')
        self.assertFalse(self.path.exists())
        self.assertEqual([x[0] for x in self.api.calls], ['ListRooms'])

    def test_dead_worker_or_revoked_window_cleans_room(self):
        self.assertEqual(self.run_case(alive=False)['status'], 'deleted')
        self.api = RoomAPI()
        self.save()
        self.window['enabled'] = False
        self.assertEqual(self.run_case()['status'], 'deleted')

    def test_closing_waits_for_foreground_bounded_attempts(self):
        self.record['state'] = 'closing'
        self.save()
        self.assertEqual(self.run_case(now=9999)['status'], 'foreground')
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.run_case(now=11000)['status'], 'deleted')

    def test_new_window_does_not_renew_old_intent(self):
        self.window.update(generation='g2', expires_at_ms=180000)
        self.assertEqual(self.run_case()['status'], 'deleted')

    def test_corrupt_or_unscoped_records_cannot_delete_any_room(self):
        self.record['room'] = 'production-unrelated'
        self.save()
        self.assertEqual(self.run_case(now=90000)['status'], 'invalid')
        self.assertEqual(self.api.calls, [])
        self.assertTrue(self.path.exists())

    def test_record_replaced_during_request_is_not_removed(self):
        original = self.api.post
        def replace_after_delete(method, data):
            result = original(method, data)
            if method == 'DeleteRoom':
                self.record['sid'] = 'RM_replacement'
                self.save()
            return result
        self.api.post = replace_after_delete
        self.assertEqual(self.run_case(now=90000)['status'], 'record_changed')
        self.assertEqual(json.loads(self.path.read_text())['sid'], 'RM_replacement')

    def test_symlink_record_is_rejected_without_requests(self):
        target = Path(self.tmp.name) / 'real-record'
        self.path.rename(target)
        self.path.symlink_to(target)
        self.assertEqual(self.run_case(now=90000)['status'], 'invalid')
        self.assertEqual(self.api.calls, [])
        self.assertTrue(target.exists())

    def test_absent_room_is_idempotent_without_delete(self):
        self.api.room = None
        self.assertEqual(self.run_case(now=90000)['status'], 'absent')
        self.assertEqual(self.run_case(now=90001)['status'], 'gone')
        self.assertEqual([x[0] for x in self.api.calls], ['ListRooms'])

    def test_real_http_adapter_scopes_jwt_and_keeps_failure_for_retry(self):
        state = {'present': True, 'fail': True, 'calls': [], 'grants': []}
        room = self.record['room']
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                token = self.headers['Authorization'].removeprefix('Bearer ')
                header, claims, signature = token.split('.')
                decode = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
                assert hmac.compare_digest(decode(signature), hmac.new(
                    b'test-secret', (header + '.' + claims).encode(), hashlib.sha256).digest())
                grant = json.loads(decode(claims))['video']
                method = self.path.rsplit('/', 1)[-1]
                state['calls'].append(method)
                state['grants'].append(grant)
                if method == 'ListRooms':
                    assert body == {'names': [room]}
                    status, data = 200, {'rooms': [{'name': room, 'sid': 'RM_old'}] if state['present'] else []}
                else:
                    assert method == 'DeleteRoom' and body == {'room': room}
                    status, data = (503, {}) if state['fail'] else (200, {})
                    if not state['fail']:
                        state['present'] = False
                raw = json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.api = m.RoomAPI('ws://127.0.0.1:' + str(server.server_port), 'test-key', 'test-secret')
            self.assertEqual(self.run_case(now=90000)['status'], 'pending')
            self.assertTrue(self.path.exists())
            state['fail'] = False
            self.assertEqual(self.run_case(now=90001)['status'], 'deleted')
            self.assertEqual(state['calls'], ['ListRooms', 'DeleteRoom', 'ListRooms', 'DeleteRoom', 'ListRooms'])
            self.assertEqual(state['grants'], [{'roomList': True}, {'roomCreate': True, 'room': room},
                {'roomList': True}, {'roomCreate': True, 'room': room}, {'roomList': True}])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class BusinessCleanupTests(unittest.TestCase):
    """Same SFU failure matrix, with ownership lifecycle instead of canary TTL."""
    def setUp(self):
        CleanupTests.setUp(self)
        self.record.update(schema=2, generation='cfg-12', deadline_ms=0)
        self.save()

    save = CleanupTests.save
    tearDown = CleanupTests.tearDown

    def run_case(self, now=5000, alive=True):
        return m.reconcile(self.path, {}, self.api, now, lambda *_: alive, mode='business')

    def test_live_business_room_is_not_deleted_by_old_canary_window_or_elapsed_hours(self):
        self.assertEqual(self.run_case(now=99_000_000)['status'], 'active')
        self.assertEqual(self.api.calls, [])

    def test_dead_business_owner_retries_durable_record_after_process_restart(self):
        self.api.fail_delete = True
        self.assertEqual(self.run_case(alive=False)['status'], 'pending')
        self.assertTrue(self.path.exists())
        self.api.fail_delete = False
        self.assertEqual(self.run_case(alive=False)['status'], 'deleted')
        self.assertFalse(self.path.exists())

    def test_business_closing_200_with_original_sid_stays_pending(self):
        self.record['state'] = 'closing'; self.save(); self.api.keep_room = True
        self.assertEqual(self.run_case(now=11000)['status'], 'pending')
        self.assertTrue(self.path.exists())

    def test_business_closing_name_reuse_is_preserved(self):
        self.record['state'] = 'closing'; self.save(); self.api.room['sid'] = 'RM_new'
        self.assertEqual(self.run_case(now=11000)['status'], 'superseded')
        self.assertEqual([x[0] for x in self.api.calls], ['ListRooms'])

    def test_business_real_http_failure_is_retried_after_next_invocation(self):
        self.record['state'] = 'closing'; self.save()
        CleanupTests.test_real_http_adapter_scopes_jwt_and_keeps_failure_for_retry(self)

    def test_business_changed_record_during_http_is_preserved(self):
        self.record['state'] = 'closing'; self.save()
        CleanupTests.test_record_replaced_during_request_is_not_removed(self)

    def test_business_and_candidate_records_cannot_cross_cleanup_modes(self):
        self.assertEqual(m.reconcile(self.path, {}, self.api, 999999,
            lambda *_: False)['status'], 'invalid')
        self.record.update(schema=1, generation='g1', deadline_ms=90000); self.save()
        self.assertEqual(self.run_case(alive=False)['status'], 'invalid')
        self.assertEqual(self.api.calls, [])

if __name__ == '__main__':
    unittest.main()
