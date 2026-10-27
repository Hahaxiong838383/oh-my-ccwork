"""Read-only status integration; no ports, credentials or actual subprocesses."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
import tempfile
import unittest
from unittest.mock import Mock, patch

stub = types.ModuleType('easytier_manager')
stub.extend_manager = lambda handler, html: (handler, html)
sys.modules['easytier_manager'] = stub
spec = importlib.util.spec_from_file_location('managed_ui_manager', Path(__file__).with_name('xray-manager.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
import managed_status


class StatusIntegrationTests(unittest.TestCase):
    def test_status_endpoint_only_invokes_sanitized_collector(self):
        handler = object.__new__(m.Handler)
        handler.path = '/api/managed-status'
        handler._json = Mock()
        expected = {'schema_version': 1, 'managed': True, 'overall': {'status': 'stale'}}
        with patch.object(managed_status, 'collect_managed_status', return_value=expected) as collect, \
             patch.object(m, 'load_config', side_effect=AssertionError('no raw config API')):
            handler.do_GET()
        collect.assert_called_once_with(m.XRAY_HOME)
        handler._json.assert_called_once_with(expected)

    def test_route_summary_keeps_balancer_and_inbound_constraints(self):
        result = m.extract_routes({'routing': {'rules': [
            {'inboundTag': ['cf-probe-home'], 'outboundTag': 'cf-home'},
            {'domain': ['domain:fixture.invalid'], 'balancerTag': 'cf-lisa'}]}})
        self.assertEqual(result[0]['inboundTags'], ['cf-probe-home'])
        self.assertEqual(result[1]['balancerTag'], 'cf-lisa')
        self.assertEqual(result[1]['outboundTag'], '')

    def test_query_error_is_unknown_not_stopped(self):
        with patch.object(m, 'IS_MACOS', True), patch.object(m.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 5, stdout='')):
            self.assertEqual(m.get_xray_status()['error'], 'service_status_unavailable')

    def test_query_timeout_is_unknown_not_stopped(self):
        with patch.object(m, 'IS_MACOS', True), patch.object(m.subprocess, 'run',
                side_effect=subprocess.TimeoutExpired('fixture', 5)):
            self.assertEqual(m.get_xray_status()['error'], 'service_status_unavailable')

    def test_launchagent_alone_keeps_backend_write_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            xray = home / 'xray'
            xray.mkdir()
            config = xray / 'config.json'
            raw = b'{ "routing": {"rules": []} }\n'
            config.write_bytes(raw)
            plist = home / 'Library/LaunchAgents/com.company.lisa-failover.plist'
            plist.parent.mkdir(parents=True)
            plist.write_text('fixture managed installation marker')
            with patch.object(m, 'XRAY_HOME', xray), patch.object(m, 'CONFIG_PATH', config):
                with self.assertRaises(m.ManagedConfigError):
                    m.save_config({'routing': {'rules': []}, 'log': {'loglevel': 'warning'}})
                self.assertEqual(config.read_bytes(), raw)
                self.assertFalse(config.with_suffix('.json.bak').exists())
                m.save_config(json.loads(raw))
                self.assertEqual(config.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
