"""Routing policy HTTP boundary, with a fake publisher and no production access."""
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

stub = types.ModuleType('easytier_manager')
stub.extend_manager = lambda handler, html: (handler, html)
sys.modules['easytier_manager'] = stub
spec = importlib.util.spec_from_file_location('routing_http_manager', Path(__file__).with_name('xray-manager.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RoutingHttpTests(unittest.TestCase):
    def handler(self, path='/api/routing-policy/preview', body=b'{"action":"normalize"}', origin='http://127.0.0.1:8888', host='127.0.0.1:8888'):
        h = object.__new__(m.Handler)
        h.path = path
        h.headers = Message()
        h.headers['Host'] = host
        if origin is not None:
            h.headers['Origin'] = origin
        h.headers['Content-Type'] = 'application/json'
        h.headers['Content-Length'] = str(len(body))
        h.client_address = ('127.0.0.1', 12345)
        h.server = types.SimpleNamespace(server_port=8888)
        h.connection = Mock()
        h.rfile = io.BytesIO(body)
        h._json = Mock()
        h.send_error = Mock()
        return h

    def invoke(self, h, method='POST'):
        publisher = Mock()
        publisher.preview.return_value = {'success': True, 'preview_id': 'fixture'}
        publisher.apply.return_value = {'success': True, 'state': 'applied'}
        publisher.status.return_value = {'schema_version': 1, 'groups': []}
        with patch.object(m, 'get_routing_publisher', return_value=publisher, create=True), \
             patch.object(m, 'save_config', side_effect=AssertionError('legacy write forbidden')):
            getattr(h, 'do_' + method)()
        return publisher

    def test_preview_calls_only_preview(self):
        h = self.handler(); p = self.invoke(h)
        p.preview.assert_called_once_with({'action': 'normalize'})
        p.apply.assert_not_called()

    def test_chatgpt_enable_and_remove_are_preview_only(self):
        for request in ({'action': 'domain_route', 'enabled': True, 'outbound': 'us-fixture'},
                        {'action': 'domain_route', 'enabled': False}):
            with self.subTest(request=request):
                h = self.handler(body=json.dumps(request).encode()); p = self.invoke(h)
                p.preview.assert_called_once_with(request)
                p.apply.assert_not_called()

    def test_chatgpt_request_cannot_supply_domains_config_or_ambiguous_target(self):
        valid = {'action': 'domain_route', 'enabled': True, 'outbound': 'us-fixture'}
        cases = [dict(valid, domains=['domain:foreign.invalid']), dict(valid, config={}),
                 dict(valid, tag='cf-lisa'), dict(valid, enabled=1), dict(valid, outbound=''),
                 dict(valid, outbound='x' * 129), dict(valid, outbound=[]),
                 {'action': 'domain_route', 'enabled': True},
                 {'action': 'domain_route'}, dict(valid, enabled=False)]
        for request in cases:
            with self.subTest(request=request):
                h = self.handler(body=json.dumps(request).encode()); p = self.invoke(h)
                self.assertEqual(h._json.call_args.args[1], 400)
                self.assertFalse(p.mock_calls)

    def test_apply_accepts_only_preview_id(self):
        h = self.handler('/api/routing-policy/apply', b'{"preview_id":"fixture"}')
        p = self.invoke(h); p.apply.assert_called_once_with('fixture');p.preview.assert_not_called()

    def test_get_status_is_read_only_and_allows_absent_origin(self):
        h = self.handler('/api/routing-policy', origin=None)
        p = self.invoke(h, 'GET');p.status.assert_called_once_with();p.preview.assert_not_called();p.apply.assert_not_called()

    def test_origin_host_remote_client_and_fetch_site_are_rejected(self):
        cases = [self.handler(origin=None), self.handler(origin='http://foreign.invalid'), self.handler(host='foreign.invalid:8888')]
        remote = self.handler();remote.client_address=('192.0.2.1',123);cases.append(remote)
        cross = self.handler();cross.headers['Sec-Fetch-Site']='cross-site';cases.append(cross)
        duplicate = self.handler();duplicate.headers['Host']='127.0.0.1:8888';cases.append(duplicate)
        duplicate_origin = self.handler();duplicate_origin.headers['Origin']='http://127.0.0.1:8888';cases.append(duplicate_origin)
        for h in cases:
            with self.subTest(headers=str(h.headers)):
                p=self.invoke(h);self.assertEqual(h._json.call_args.args[1],403);self.assertFalse(p.mock_calls)

    def test_body_boundary_rejects_ambiguous_or_oversized_input(self):
        cases=[self.handler(body=b'[]'),self.handler(body=b'{bad'),self.handler(body=b'{"action":"normalize","action":"toggle"}'),
               self.handler(body=b'{"action":"normalize","config":{}}'),self.handler(body=b'{"action":"toggle","tag":"x","enabled":1,"fallback":"b"}'),
               self.handler(body=b'{"action":"toggle","tag":"x","enabled":false}'),self.handler('/api/routing-policy/apply',b'{"preview_id":"x","config":{}}')]
        oversized=self.handler();oversized.headers.replace_header('Content-Length','4097');cases.append(oversized)
        chunked=self.handler();chunked.headers['Transfer-Encoding']='chunked';cases.append(chunked)
        duplicate=self.handler();duplicate.headers['Content-Length']='2';cases.append(duplicate)
        form=self.handler();form.headers.replace_header('Content-Type','text/plain');cases.append(form)
        duplicate_type=self.handler();duplicate_type.headers['Content-Type']='application/json';cases.append(duplicate_type)
        for h in cases:
            with self.subTest(body=h.rfile.getvalue()):
                p=self.invoke(h);self.assertEqual(h._json.call_args.args[1],400);self.assertFalse(p.mock_calls)

    def test_publisher_conflict_returns_safe_message_and_code(self):
        class SafeError(Exception):
            code='revision_changed';message='配置已变化，请重新预览';status_code=409
        h=self.handler();publisher=Mock();publisher.preview.side_effect=SafeError('private fixture must not leak')
        with patch.object(m,'get_routing_publisher',return_value=publisher,create=True),patch.dict(sys.modules,{'routing_publish':types.SimpleNamespace(PublisherError=SafeError)}):
            h.do_POST()
        payload,status=h._json.call_args.args
        self.assertEqual(status,409);self.assertEqual(payload['code'],'revision_changed');self.assertNotIn('private',str(payload))

    def test_unexpected_exception_is_redacted(self):
        h=self.handler();publisher=Mock();publisher.preview.side_effect=RuntimeError('private fixture must not leak')
        with patch.object(m,'get_routing_publisher',return_value=publisher,create=True):h.do_POST()
        payload,status=h._json.call_args.args
        self.assertEqual(status,500);self.assertNotIn('private',str(payload))


if __name__ == '__main__':unittest.main()
