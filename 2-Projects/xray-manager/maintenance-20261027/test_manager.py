import copy
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest

stub = types.ModuleType('easytier_manager')
stub.extend_manager = lambda handler, html: (handler, html)
sys.modules['easytier_manager'] = stub
spec = importlib.util.spec_from_file_location('manager', (sys.argv.pop(1) if __name__ == '__main__' and len(sys.argv) > 1 and not sys.argv[1].startswith('-') else str(pathlib.Path(__file__).with_name('xray-manager.py'))))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ManagedWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        m.XRAY_HOME = pathlib.Path(self.tmp.name)
        m.CONFIG_PATH = m.XRAY_HOME / 'config.json'
        self.cfg = {'routing': {'rules': [{'domain': ['example.com'], 'outboundTag': 'proxy'}]}, 'outbounds': []}
        self.raw = (json.dumps(self.cfg, indent=4) + '\n').encode()
        m.CONFIG_PATH.write_bytes(self.raw)
        self.managed = m.XRAY_HOME / 'company-lisa-failover'
        self.managed.mkdir()
        (self.managed / 'controller.json').write_text('{}')

    def test_managed_change_is_rejected_before_writing_or_backup(self):
        changed = copy.deepcopy(self.cfg)
        changed['routing']['rules'][0]['outboundTag'] = 'direct'
        with self.assertRaises(ValueError):
            m.save_config(changed)
        self.assertEqual(m.CONFIG_PATH.read_bytes(), self.raw)
        self.assertFalse(m.CONFIG_PATH.with_suffix('.json.bak').exists())

    def test_semantically_identical_save_does_not_reformat_managed_file(self):
        m.save_config(self.cfg)
        self.assertEqual(m.CONFIG_PATH.read_bytes(), self.raw)

    def test_unmanaged_save_still_works(self):
        (self.managed / 'controller.json').unlink()
        changed = copy.deepcopy(self.cfg)
        changed['log'] = {'loglevel': 'warning'}
        m.save_config(changed)
        self.assertEqual(json.loads(m.CONFIG_PATH.read_text()), changed)

    def test_delete_endpoint_returns_conflict_and_preserves_config(self):
        handler = object.__new__(m.Handler)
        handler.path = '/api/node/proxy'
        result = []
        handler._json = lambda data, code=200: result.append((code, data))
        handler.do_DELETE()
        self.assertEqual(result[0][0], 409)
        self.assertFalse(result[0][1]['success'])
        self.assertEqual(m.CONFIG_PATH.read_bytes(), self.raw)

    def test_route_endpoint_returns_conflict_and_preserves_config(self):
        handler = object.__new__(m.Handler)
        handler.path = '/api/route'
        body = json.dumps({'domain': ['new.example.com'], 'outboundTag': 'proxy'}).encode()
        handler.headers = {'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        result = []
        handler._json = lambda data, code=200: result.append((code, data))
        handler.do_POST()
        self.assertEqual(result[0][0], 409)
        self.assertEqual(m.CONFIG_PATH.read_bytes(), self.raw)

if __name__ == '__main__':
    unittest.main()
