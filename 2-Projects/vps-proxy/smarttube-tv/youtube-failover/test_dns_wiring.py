#!/usr/bin/env python3
"""Execute boot wiring in isolated paths; never use Android or host firewall."""
import os
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True


class Wiring(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tv-dns-wiring-')
        self.root = Path(self.temp.name)
        self.upgrade = self.root / 'dns-upgrade-20261024'
        self.upgrade.mkdir()
        (self.root / 'boot').write_text('new-boot\n')
        (self.root / 'dns-guard-installed-boot-id').write_text('installed-boot\n')
        self.events = self.root / 'events'
        self.bb = self.root / 'busybox'
        self.bb.write_text('#!/bin/sh\napplet=$1\nshift\nexec "/usr/bin/$applet" "$@"\n')
        self.bb.chmod(0o700)
        for name in ('video-dns-post-fs-data.sh', 'video-dns-service-entry.sh', 'video-dns-service-start.sh'):
            text = (SOURCE / name).read_text().replace('/data/adb/video-proxy', str(self.root))
            text = text.replace('/data/adb/magisk/busybox', str(self.bb))
            text = text.replace('/proc/sys/kernel/random/boot_id', str(self.root / 'boot'))
            (self.root / name).write_text(text)
        self.script('video-dns-guard.sh', 'echo "guard:$1" >> "$EVENTS"')
        self.script('video-boot-start.sh', 'echo boot >> "$EVENTS"')
        self.script('dns-upgrade-20261024/dns-upgrade-apply.sh', 'echo apply >> "$EVENTS"')
        self.env = dict(os.environ, EVENTS=str(self.events))

    def tearDown(self):
        self.temp.cleanup()

    def script(self, name, text):
        (self.root / name).write_text('#!/bin/sh\n' + text + '\n')

    def run_script(self, name):
        return subprocess.run(['/bin/sh', str(self.root / name)], capture_output=True,
                              text=True, env=self.env, timeout=5)

    def lines(self):
        return self.events.read_text().splitlines() if self.events.exists() else []

    def wait_lines(self, expected):
        deadline = time.monotonic() + 3
        while self.lines() != expected and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(self.lines(), expected)

    def test_same_boot_all_entries_zero_action(self):
        (self.root / 'dns-guard-installed-boot-id').write_text('new-boot\n')
        for name in ('video-dns-post-fs-data.sh', 'video-dns-service-entry.sh', 'video-dns-service-start.sh'):
            result = self.run_script(name)
            self.assertEqual(result.returncode, 0)
            self.assertIn('deferred', result.stdout)
        self.assertEqual(self.lines(), [])

    def test_postfs_only_protection_then_background_audit(self):
        self.assertEqual(self.run_script('video-dns-post-fs-data.sh').returncode, 0)
        self.wait_lines(['guard:--install', 'guard:--watch'])

    def test_postfs_background_child_reaches_real_ready_without_path(self):
        spec = importlib.util.spec_from_file_location('guard_fixture', SOURCE / 'test_dns_guard.py')
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        p = guard.fixture(self.root, 'real-postfs', {'watch_repair': True})
        text = (SOURCE / 'video-dns-post-fs-data.sh').read_text()
        text = text.replace('/data/adb/video-proxy', str(p / 'device'))
        text = text.replace('/data/adb/magisk/busybox', str(p / 'bin' / 'busybox'))
        entry = p / 'post-fs-data.sh'
        entry.write_text(text)
        child_env = {**guard.env(p), 'PATH': str(p / 'missing-vendor-bin')}
        result = subprocess.run(['/bin/sh', str(entry)], env=child_env,
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        log = p / 'device' / 'dns-guard.log'
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if log.exists() and 'startup_audit_ready' in log.read_text():
                break
            time.sleep(.02)
        self.assertTrue((p / 'removed-hook').exists(), 'the actual child must enter its watcher loop')
        self.assertIn('startup_audit_ready', log.read_text())
        self.assertEqual(guard.run(p, '--verify', {'PATH': child_env['PATH']}).returncode, 0)

    def test_service_entry_runs_transaction_before_boot_worker(self):
        self.assertEqual(self.run_script('video-dns-service-entry.sh').returncode, 0)
        self.wait_lines(['apply', 'boot'])

    def test_unrecovered_transaction_failure_never_starts_proxy(self):
        self.script('dns-upgrade-20261024/dns-upgrade-apply.sh', 'echo failed >> "$EVENTS"; exit 1')
        self.assertNotEqual(self.run_script('video-dns-service-start.sh').returncode, 0)
        self.assertEqual(self.lines(), ['failed'])

    def test_restored_backup_must_be_verified_before_old_worker(self):
        self.script('dns-upgrade-20261024/dns-upgrade-apply.sh', '''
P=$(dirname "$0")
if [ ! -e "$P/rolled-back-boot-id" ]; then
  echo restored >> "$EVENTS"
  echo new-boot > "$P/rolled-back-boot-id"
  exit 1
fi
echo verified-backup >> "$EVENTS"
''')
        self.assertEqual(self.run_script('video-dns-service-start.sh').returncode, 0)
        self.assertEqual(self.lines(), ['restored', 'verified-backup', 'boot'])


if __name__ == '__main__':
    unittest.main()
