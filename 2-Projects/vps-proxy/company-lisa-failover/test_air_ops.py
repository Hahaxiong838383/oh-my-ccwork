"""Offline rollback regression tests; no real files, services or credentials.

Run with: python3 -B -m unittest -v test_air_ops.py
"""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import air_ops


class MemoryPath:
    def __init__(self, name, files, events):
        self.name, self.files, self.events = name, files, events

    def __truediv__(self, name):
        return MemoryPath(self.name + '/' + name, self.files, self.events)

    def __str__(self):
        return self.name

    def read_bytes(self):
        return self.files[self.name]

    def read_text(self):
        return self.read_bytes().decode()

    def exists(self):
        return self.name in self.files

    def unlink(self):
        self.events.append(('unlink', self.name))
        del self.files[self.name]


class AirRollbackTests(unittest.TestCase):
    def setUp(self):
        self.old, self.candidate = b'baseline fixture', b'candidate fixture'
        self.files = {
            'config': self.candidate,
            'runtime/backup-config.json': self.old,
            'runtime/manifest.json': json.dumps({
                'candidate_sha256': air_ops.sha(self.candidate),
                'baseline_sha256': air_ops.sha(self.old),
            }).encode(),
            'controller.plist': b'controller fixture',
            'tunnel.plist': b'tunnel fixture',
        }
        self.events = []
        self.services = {'controller', 'tunnel', 'xray'}
        self.restart_failures = 0
        self.status_codes = {}
        self.drift_on_stop = False
        self.output = Mock()
        self.process = Mock(side_effect=self.launchctl)
        replacements = {
            'CONFIG': self.path('config'),
            'RUNTIME': self.path('runtime'),
            'PLIST': self.path('controller.plist'),
            'TUNNEL_PLIST': self.path('tunnel.plist'),
            'LABEL': 'controller', 'TUNNEL': 'tunnel',
            'XRAY': 'xray', 'DOMAIN': 'gui/test',
            'write': self.write,
            'subprocess': SimpleNamespace(run=self.process),
            'print': self.output,
        }
        for name, value in replacements.items():
            patcher = patch.object(air_ops, name, value, create=name == 'print')
            patcher.start()
            self.addCleanup(patcher.stop)

    def path(self, name):
        return MemoryPath(name, self.files, self.events)

    def write(self, path, data):
        self.events.append(('write', path.name))
        self.files[path.name] = data

    def launchctl(self, cmd, **kwargs):
        self.events.append(tuple(cmd))
        self.assertEqual(cmd[0], 'launchctl')
        action, label = cmd[1], cmd[-1]
        if action == 'print':
            code = self.status_codes.get(label, 0 if label in self.services else 113)
        elif action == 'bootout':
            self.assertIn(label, self.services)
            self.services.remove(label)
            if label == 'controller' and self.drift_on_stop:
                self.files['config'] = b'concurrent edit'
            code = 0
        elif action == 'kickstart':
            self.assertEqual(cmd, ['launchctl', 'kickstart', '-k', 'xray'])
            code = int(self.restart_failures > 0)
            if code:
                self.restart_failures -= 1
        elif action == 'bootstrap':
            self.assertEqual(cmd, ['launchctl', 'bootstrap', 'gui/test', 'controller.plist'])
            self.services.add('controller')
            code = 0
        else:
            self.fail('Unexpected command: ' + repr(cmd))
        return SimpleNamespace(returncode=code, stdout='')

    def assert_restored(self):
        self.assertEqual(self.files['config'], self.old)
        self.assertNotIn('controller', self.services)
        self.assertNotIn('tunnel', self.services)
        self.assertNotIn('controller.plist', self.files)
        self.assertNotIn('tunnel.plist', self.files)
        self.output.assert_called_once_with('ORIGINAL_CONFIG_RESTORED; verify application')

    def test_failed_kickstart_then_successful_retry(self):
        self.restart_failures = 1
        with self.assertRaisesRegex(RuntimeError, '^command_failed_launchctl$'):
            air_ops.rollback()
        self.assertEqual(self.files['config'], self.old)
        self.assertNotIn('controller', self.services)
        self.assertIn('tunnel', self.services)
        self.assertIn('controller.plist', self.files)
        self.assertIn('tunnel.plist', self.files)
        self.output.assert_not_called()

        cut = len(self.events)
        air_ops.rollback()
        retry = self.events[cut:]
        self.assert_restored()
        self.assertNotIn(('launchctl', 'bootout', 'controller'), retry)
        self.assertEqual(self.events.count(('write', 'config')), 1)
        self.assertEqual(self.events.count(('launchctl', 'kickstart', '-k', 'xray')), 2)
        restart = retry.index(('launchctl', 'kickstart', '-k', 'xray'))
        tunnel_stop = retry.index(('launchctl', 'bootout', 'tunnel'))
        self.assertLess(restart, tunnel_stop)
        for name in ('controller.plist', 'tunnel.plist'):
            self.assertLess(tunnel_stop, retry.index(('unlink', name)))

    def test_controller_already_unloaded(self):
        self.services.remove('controller')
        air_ops.rollback()
        self.assert_restored()
        self.assertNotIn(('launchctl', 'bootout', 'controller'), self.events)

    def test_config_drift_aborts_without_side_effects(self):
        self.files['config'] = b'unrelated edit'
        before = self.files.copy()
        with self.assertRaisesRegex(RuntimeError, '^rollback_drift_stop$'):
            air_ops.rollback()
        self.assertEqual(self.files, before)
        self.process.assert_not_called()
        self.output.assert_not_called()
        self.assertEqual(self.events, [])

    def test_backup_drift_aborts_without_side_effects(self):
        self.files['runtime/backup-config.json'] = b'corrupt backup'
        before = self.files.copy()
        with self.assertRaisesRegex(RuntimeError, '^rollback_drift_stop$'):
            air_ops.rollback()
        self.assertEqual(self.files, before)
        self.process.assert_not_called()
        self.output.assert_not_called()

    def test_concurrent_config_drift_restores_controller(self):
        self.drift_on_stop = True
        with self.assertRaisesRegex(RuntimeError, '^rollback_config_changed$'):
            air_ops.rollback()
        self.assertEqual(self.files['config'], b'concurrent edit')
        self.assertIn('controller', self.services)
        self.assertIn('tunnel', self.services)
        self.assertIn('controller.plist', self.files)
        self.assertIn('tunnel.plist', self.files)
        self.assertNotIn(('write', 'config'), self.events)
        self.assertNotIn(('launchctl', 'kickstart', '-k', 'xray'), self.events)
        self.output.assert_not_called()

    def test_loaded_zero_is_true(self):
        self.status_codes['controller'] = 0
        self.assertIs(air_ops.loaded('controller'), True)

    def test_loaded_113_is_false(self):
        self.status_codes['controller'] = 113
        self.assertIs(air_ops.loaded('controller'), False)

    def test_loaded_other_codes_raise(self):
        for code in (1, 5, 112, -15):
            with self.subTest(code=code):
                self.status_codes['controller'] = code
                with self.assertRaisesRegex(RuntimeError, '^launchctl_status_unknown$'):
                    air_ops.loaded('controller')


if __name__ == '__main__':
    unittest.main()
