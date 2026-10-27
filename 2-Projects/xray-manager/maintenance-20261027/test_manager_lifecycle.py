import importlib.util
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

stub = types.ModuleType('easytier_manager')
stub.extend_manager = lambda handler, html: (handler, html)
sys.modules['easytier_manager'] = stub
spec = importlib.util.spec_from_file_location('manager', (sys.argv.pop(1) if __name__ == '__main__' and len(sys.argv) > 1 and not sys.argv[1].startswith('-') else str(pathlib.Path(__file__).with_name('xray-manager.py'))))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def result(code=0, stdout=''):
    return subprocess.CompletedProcess([], code, stdout, '')

RUNNING = 'gui/501/com.xray.proxy = {\n\tstate = running\n\tpid = 12345\n}\n'

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        m.IS_MACOS, m.IS_LINUX, m.IS_WINDOWS = True, False, False
        m.XRAY_HOME = pathlib.Path(self.tmp.name) / 'xray'
        m.CONFIG_PATH = m.XRAY_HOME / 'config.json'
        m.XRAY_BIN = m.XRAY_HOME / 'xray'
        m.LAUNCHD_PLIST = pathlib.Path(self.tmp.name) / 'com.xray.proxy.plist'
        self.plist = {'Label': 'com.xray.proxy', 'ProgramArguments': [str(m.XRAY_BIN), 'run', '-c', str(m.CONFIG_PATH)], 'WorkingDirectory': str(m.XRAY_HOME), 'KeepAlive': True, 'RunAtLoad': True}
        m.LAUNCHD_PLIST.write_bytes(plistlib.dumps(self.plist))
        self.sleep = patch.object(m.time, 'sleep').start()
        self.uid = patch.object(m.os, 'getuid', return_value=501).start()
        self.popen = patch.object(m.subprocess, 'Popen', side_effect=AssertionError('manual spawn is forbidden')).start()
        self.addCleanup(patch.stopall)
        self.target = 'gui/501/com.xray.proxy'

    def assert_only_launchctl(self, mock):
        self.assertTrue(mock.call_args_list)
        for call in mock.call_args_list:
            self.assertEqual(call.args[0][0], 'launchctl')

    def test_status_uses_exact_service_pid(self):
        with patch.object(m.subprocess, 'run', return_value=result(0, RUNNING)) as run:
            self.assertEqual(m.get_xray_status(), {'running': True, 'pid': 12345, 'count': 1})
        self.assertEqual(run.call_args.args[0], ['launchctl', 'print', self.target])

    def test_other_xray_process_cannot_make_status_running(self):
        with patch.object(m.subprocess, 'run', return_value=result(113, '67890')) as run:
            self.assertFalse(m.get_xray_status()['running'])
        self.assert_only_launchctl(run)

    def test_existing_service_restart_is_targeted(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(0, RUNNING), result(), result(0, RUNNING)]) as run:
            answer = m.restart_xray()
        self.assertTrue(answer['success'])
        self.assertEqual(run.call_args_list[1].args[0], ['launchctl', 'kickstart', '-k', self.target])
        self.assert_only_launchctl(run)

    def test_missing_service_bootstraps_validated_plist_without_second_restart(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(113), result(), result(), result(0, RUNNING)]) as run:
            answer = m.restart_xray()
        self.assertTrue(answer['success'])
        commands = [c.args[0] for c in run.call_args_list]
        self.assertEqual(commands[1], ['launchctl', 'bootstrap', 'gui/501', str(m.LAUNCHD_PLIST)])
        self.assertEqual(commands[2], ['launchctl', 'kickstart', self.target])
        self.assert_only_launchctl(run)

    def test_query_permission_error_never_bootstraps_or_kills(self):
        with patch.object(m.subprocess, 'run', return_value=result(5)) as run:
            self.assertFalse(m.restart_xray()['success'])
        self.assertEqual(run.call_count, 1)
        self.assert_only_launchctl(run)

    def test_bootstrap_rejects_foreign_program(self):
        self.plist['ProgramArguments'][0] = '/foreign/xray'
        m.LAUNCHD_PLIST.write_bytes(plistlib.dumps(self.plist))
        with patch.object(m.subprocess, 'run', return_value=result(113)) as run:
            self.assertFalse(m.restart_xray()['success'])
        self.assertEqual(run.call_count, 1)

    def test_bootstrap_rejects_program_override(self):
        self.plist['Program'] = '/foreign/program'
        m.LAUNCHD_PLIST.write_bytes(plistlib.dumps(self.plist))
        with patch.object(m.subprocess, 'run', return_value=result(113)) as run:
            self.assertFalse(m.restart_xray()['success'])
        self.assertEqual(run.call_count, 1)

    def test_kickstart_failure_has_no_manual_fallback(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(0, RUNNING), result(5)]) as run:
            self.assertFalse(m.restart_xray()['success'])
        self.assertEqual(run.call_count, 2)
        self.assert_only_launchctl(run)

    def test_stop_boots_out_only_primary_service(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(0, RUNNING), result(), result(113)]) as run:
            self.assertTrue(m.stop_xray()['success'])
        self.assertEqual(run.call_args_list[1].args[0], ['launchctl', 'bootout', self.target])
        self.assert_only_launchctl(run)

    def test_stop_does_not_claim_success_if_still_registered(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(0, RUNNING), result(), result(0, RUNNING)]) as run:
            self.assertFalse(m.stop_xray()['success'])
        self.assert_only_launchctl(run)

    def test_stop_reports_launchctl_error(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(0, RUNNING), result(5)]) as run:
            self.assertFalse(m.stop_xray()['success'])
        self.assertEqual(run.call_count, 2)
        self.assert_only_launchctl(run)

    def test_already_stopped_is_idempotent(self):
        with patch.object(m.subprocess, 'run', side_effect=[result(113)]) as run:
            self.assertTrue(m.stop_xray()['success'])
        self.assert_only_launchctl(run)

if __name__ == '__main__':
    unittest.main()
