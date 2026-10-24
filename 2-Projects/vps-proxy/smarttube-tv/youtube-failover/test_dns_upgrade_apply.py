#!/usr/bin/env python3
"""Exercise the next-boot transaction on real isolated files, including SIGKILL.

No ADB, network or production paths. Fault injection replaces only mv in PATH;
the deployed script has no failure-injection command or test-only branch.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('dns-upgrade-apply.sh')
PATHS = [
    'config.json', 'video-boot-start.sh',
    'youtube-failover/main-config.json', 'youtube-failover/active-main.sha256',
    'youtube-failover/release-id', 'youtube-failover/enabled',
    'youtube-failover/manifest.json', 'youtube-failover/service.sh',
    'youtube-failover/video-boot-start.next.sh',
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Transaction(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dns-upgrade-test-')
        self.base = Path(self.tmp.name)
        self.root = self.base / 'video-proxy'
        self.stage = self.root / 'dns-upgrade-test'
        self.proc = self.base / 'proc'
        self.proc.mkdir()
        self.stage.mkdir(parents=True, mode=0o700)
        # Debian's BusyBox omits flock; use the actual util-linux syscall tool
        # for that applet, rather than mocking lock acquisition as success.
        self.busybox = self.base/'busybox-host'
        self.busybox.write_text('#!/bin/sh\nif [ "$1" = flock ]; then\n  shift\n  [ "$1" = -n ] && [ "$#" -ge 3 ] || exit 64\n  case "$2" in /*) ;; *) exit 65 ;; esac\n  exec /usr/bin/flock "$@"\nfi\nexec /usr/bin/busybox "$@"\n')
        self.busybox.chmod(0o700)
        self.script = self.stage / SOURCE.name
        shutil.copyfile(SOURCE, self.script)
        self.script.chmod(0o700)
        self.boot = self.base / 'boot-id'
        self.boot.write_text('next-boot\n')
        (self.stage / 'installed-boot-id').write_text('installed-boot\n')
        self.old = self.make_files('old')
        self.new = self.make_files('new')
        for directory, files in [(self.root, self.old), (self.stage/'backup', self.old), (self.stage/'payload', self.new)]:
            for relative, data in files.items():
                path = directory / relative
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                path.write_bytes(data)
                path.chmod(self.mode(relative))
        self.write_transaction()
        self.env = dict(os.environ, VIDEO_DNS_ROOT=str(self.root),
                        VIDEO_DNS_BOOT_ID_FILE=str(self.boot),
                        VIDEO_DNS_PROC_ROOT=str(self.proc),
                        VIDEO_DNS_BUSYBOX=str(self.busybox))
        self.env.pop('DNS_TEST_MODE', None)
        self.env.pop('DNS_TEST_AT', None)

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def mode(path):
        return 0o700 if path.endswith('.sh') else 0o600

    @staticmethod
    def make_files(label):
        config = (json.dumps({'dns': {'label': label}})+'\n').encode()
        release = sha(label.encode())+'\n'
        result = {p: ('#!/system/bin/sh\n# '+label+'\n').encode() for p in PATHS if p.endswith('.sh')}
        result.update({
            'config.json': config,
            'youtube-failover/main-config.json': config,
            'youtube-failover/active-main.sha256': (sha(config)+'\n').encode(),
            'youtube-failover/release-id': release.encode(),
            'youtube-failover/enabled': release.encode(),
            'youtube-failover/manifest.json': (json.dumps({'label': label})+'\n').encode(),
        })
        return result

    def write_transaction(self, paths=PATHS):
        (self.stage/'transaction.tsv').write_text(''.join(
            f'{p}\t{sha(self.old[p])}\t{sha(self.new[p])}\t{self.mode(p):o}\n' for p in paths))

    def run_apply(self, action='--apply', env=None):
        start = time.monotonic()
        # BusyBox ash resolves compiled applets without PATH, preventing an mv
        # wrapper from observing real rename calls. Use POSIX dash for injected
        # cases; the normal deployment/replay/rollback tests run real ash.
        shell=['/bin/dash'] if env and env.get('DNS_TEST_MODE') else ['busybox', 'ash']
        result = subprocess.run(shell+[str(self.script), action], env=env or self.env,
                                text=True, capture_output=True, timeout=8)
        self.assertLess(time.monotonic()-start, 8)
        return result

    def snapshot(self):
        result = {}
        for p in self.base.rglob('*'):
            key = str(p.relative_to(self.base))
            if p.is_symlink():
                result[key] = ('link', os.readlink(p))
            elif p.is_file():
                result[key] = (p.stat().st_mode & 0o777, p.read_bytes())
            elif p.is_dir():
                result[key] = ('dir', p.stat().st_mode & 0o777)
        return result

    def assert_refused_unchanged(self, action='--apply'):
        before = self.snapshot()
        result = self.run_apply(action)
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(self.snapshot(), before)
        return result

    def assert_live(self, expected):
        for relative, data in expected.items():
            with self.subTest(path=relative):
                path = self.root/relative
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual(path.stat().st_mode & 0o777, self.mode(relative))

    def fake_process(self, argv, exe=None):
        p = self.proc/'123'
        p.mkdir()
        (p/'cmdline').write_bytes(b'\0'.join(v.encode() for v in argv)+b'\0')
        if exe is not None:
            (p/'exe').symlink_to(exe)

    def injected(self, mode, at=3):
        commands = self.base/'commands'
        commands.mkdir()
        program = commands/'mv'
        program.write_text('''#!/usr/bin/python3
import os, pathlib, signal, subprocess, sys
counter=pathlib.Path(os.environ['DNS_TEST_COUNTER'])
source=sys.argv[-2]
destination=sys.argv[-1]
target='.dns-upgrade-' in source and destination.startswith(os.environ['VIDEO_DNS_ROOT']+'/')
n=int(counter.read_text())+1 if counter.exists() else 1
if target: counter.write_text(str(n))
inject=target and n==int(os.environ['DNS_TEST_AT'])
if inject and os.environ['DNS_TEST_MODE']=='fail': sys.exit(73)
result=subprocess.run(['/bin/mv', *sys.argv[1:]])
if result.returncode: sys.exit(result.returncode)
if inject:
    signal_number=signal.SIGKILL if os.environ['DNS_TEST_MODE']=='kill' else signal.SIGTERM
    os.kill(os.getppid(), signal_number)
sys.exit(0)
''')
        program.chmod(0o700)
        return dict(self.env, PATH=str(commands)+':'+self.env['PATH'], DNS_TEST_MODE=mode,
                    DNS_TEST_AT=str(at), DNS_TEST_COUNTER=str(self.base/'rename-count'))

    def test_verify_is_read_only_and_checks_both_sets(self):
        before = self.snapshot()
        result = self.run_apply('--verify')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('verified_read_only', result.stdout)
        self.assertEqual(self.snapshot(), before)
        (self.stage/'backup/config.json').write_text('damaged')
        self.assert_refused_unchanged('--verify')

    def test_install_boot_is_zero_action_even_if_payload_incomplete(self):
        self.boot.write_text('installed-boot\n')
        (self.stage/'payload/config.json').unlink()
        for action in ['--apply', '--rollback']:
            before = self.snapshot()
            result = self.run_apply(action)
            self.assertEqual(result.returncode, 0)
            self.assertIn('deferred_same_boot', result.stdout)
            self.assertEqual(self.snapshot(), before)

    def test_apply_reads_back_all_files_and_markers_and_is_repeatable(self):
        for _ in range(2):
            result = self.run_apply()
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            self.assert_live(self.new)
            marker = self.stage/'applied-boot-id'
            self.assertEqual(marker.read_text(), 'next-boot\n')
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root/'youtube-failover/authorized-boot-id').exists())

    def test_missing_payload_refuses_before_any_live_write(self):
        (self.stage/'payload/youtube-failover/service.sh').unlink()
        self.assert_refused_unchanged()

    def test_unrecognized_live_drift_refuses_without_mutation(self):
        (self.root/'video-boot-start.sh').write_text('external edit\n')
        self.assert_refused_unchanged()

    def test_tampered_payload_and_tampered_backup_refuse(self):
        for directory in ['payload', 'backup']:
            target=self.stage/directory/'config.json'
            original=target.read_bytes()
            target.write_text('changed\n')
            self.assert_refused_unchanged()
            target.write_bytes(original)

    def test_incomplete_duplicate_unapproved_paths_and_wrong_mode_refuse(self):
        original=(self.stage/'transaction.tsv').read_text()
        bad=[original.rsplit('\n', 2)[0]+'\n', original+original.splitlines()[0]+'\n',
             original.replace('config.json\t', '../config.json\t', 1),
             original.replace('\t600\n', '\t700\n', 1)]
        for content in bad:
            with self.subTest(content=content):
                (self.stage/'transaction.tsv').write_text(content)
                self.assert_refused_unchanged()

    def test_inconsistent_new_anchor_and_release_refuse(self):
        for relative in ['youtube-failover/active-main.sha256', 'youtube-failover/enabled']:
            original=self.new[relative]
            self.new[relative]=b'wrong\n'
            (self.stage/'payload'/relative).write_bytes(self.new[relative])
            self.write_transaction()
            self.assert_refused_unchanged()
            self.new[relative]=original
            (self.stage/'payload'/relative).write_bytes(original)

    def test_symlink_target_and_payload_refuse(self):
        for directory in [self.root, self.stage/'payload']:
            target=directory/'config.json'
            original=target.read_bytes()
            saved=self.base/'symlink-source'
            saved.write_bytes(original)
            target.unlink()
            target.symlink_to(saved)
            self.assert_refused_unchanged()
            target.unlink()
            target.write_bytes(original)
            target.chmod(0o600)

    def test_main_process_refuses_but_worker_is_not_main(self):
        binary=str(self.root/'sing-box')
        self.fake_process([binary, 'run', '-c', str(self.root/'config.json')], binary)
        result=self.assert_refused_unchanged()
        self.assertIn('production_process_running', result.stdout)
        (self.proc/'123/cmdline').write_bytes(b'\0'.join(v.encode() for v in [
            binary, 'run', '-c', str(self.root/'youtube-failover/workers/rack/config.json')])+b'\0')
        result=self.run_apply()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assert_live(self.new)

    def test_guardian_process_refuses(self):
        self.fake_process(['/system/bin/app_process', '/system/bin', 'YoutubeFailover',
                           str(self.root/'youtube-failover/guard-config.json')])
        result=self.assert_refused_unchanged()
        self.assertIn('production_process_running', result.stdout)

    def test_supervisor_process_refuses(self):
        self.fake_process(['sh', str(self.root/'youtube-failover/guard-run.sh')])
        self.assert_refused_unchanged()

    def test_failed_third_rename_restores_every_original_file(self):
        result=self.run_apply(env=self.injected('fail'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('failed_backup_restored', result.stdout)
        self.assert_live(self.old)
        self.assertFalse((self.stage/'applied-boot-id').exists())
        self.assertEqual((self.stage/'rolled-back-boot-id').read_text(), 'next-boot\n')
        result=self.run_apply()
        self.assertEqual(result.returncode, 0)
        self.assertIn('rolled_back_preserved', result.stdout)
        self.assert_live(self.old)

    def test_sigterm_during_transaction_restores_backup(self):
        result=self.run_apply(env=self.injected('term'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('failed_backup_restored', result.stdout)
        self.assert_live(self.old)

    def test_sigkill_leaves_mixed_state_and_replay_completes(self):
        result=self.run_apply(env=self.injected('kill'))
        self.assertEqual(result.returncode, 137, result.stdout+result.stderr)
        self.assertEqual((self.root/PATHS[0]).read_bytes(), self.new[PATHS[0]])
        self.assertEqual((self.root/PATHS[-1]).read_bytes(), self.old[PATHS[-1]])
        self.assertFalse((self.stage/'applied-boot-id').exists())
        result=self.run_apply()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assert_live(self.new)

    def test_rollback_restores_whole_release_and_prevents_accidental_reapply(self):
        self.assertEqual(self.run_apply().returncode, 0)
        result=self.run_apply('--rollback')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assert_live(self.old)
        self.assertFalse((self.stage/'applied-boot-id').exists())
        self.boot.write_text('another-boot\n')
        result=self.run_apply()
        self.assertEqual(result.returncode, 0)
        self.assert_live(self.old)

    def test_busy_transaction_lock_refuses_without_mutation(self):
        import fcntl
        lock=self.stage/'transaction.lock'
        lock.touch(mode=0o600)
        with lock.open() as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_refused_unchanged()


if __name__ == '__main__':
    unittest.main(verbosity=2)
