#!/usr/bin/env python3
"""Real executable /proc fixtures, compared with the deployed shell predicates."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

S = Path(__file__).resolve().parent


class ScannerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='video-proc-scan-test-')
        cls.base = Path(cls.tmp.name)
        cls.exe = cls.base/'video-proc-scan'
        subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(S/'video-proc-scan.c'), '-o', str(cls.exe)], check=True)

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def setUp(self):
        self.proc = self.base/'proc'
        self.proc.mkdir()
        self.d = '/fixture/video-proxy'

    def tearDown(self): shutil.rmtree(self.proc)

    def process(self, argv, exe=None, pid='301', raw=None):
        p = self.proc/pid
        p.mkdir()
        (p/'exe').symlink_to(exe or self.d+'/sing-box')
        (p/'cmdline').write_bytes(raw if raw is not None else b'\0'.join(x.encode() for x in argv)+b'\0')
        (p/'comm').write_text('renamed-orphan\n')
        return p

    def native(self, mode='transaction', profile='rack'):
        r = subprocess.run([str(self.exe), str(self.proc), mode, self.d, profile], capture_output=True)
        self.assertEqual(r.stdout+r.stderr, b'')
        return r.returncode

    def shell(self, mode='transaction', profile='rack', helper=None, digest_override=None):
        name = 'running' if mode == 'transaction' else 'production_proxy_running'
        file = S/('dns-upgrade-apply.sh' if mode == 'transaction' else 'video-boot-start.next.sh')
        func = file.read_text().split(name+'() {', 1)[1].split('\n}', 1)[0]
        # The exact original fallback is the loop after the native branch.
        if helper is None: func = func[func.index('  for proc in'):]
        else:
            func = func.replace('UNSTAGED_PROC_SCAN_SHA256', digest_override or hashlib.sha256(helper.read_bytes()).hexdigest())
            func = func.replace('"$P/video-proc-scan"', '"'+str(helper)+'"')
            func = func.replace('"$D/UNSTAGED_PROC_SCAN_STAGE/video-proc-scan"', '"'+str(helper)+'"')
        func = func.replace('/proc/[0-9]*', '"$PROC"/[0-9]*').replace('"$scan" /proc main', '"$scan" "$PROC" main')
        code = '''regular() { [ -f "$1" ] && [ ! -L "$1" ]; }
digest() { "$BB" sha256sum "$1" | "$BB" awk '{print $1}'; }
f() {\n'''+func+'\n}\nf\n'
        env = dict(os.environ, D=self.d, PROC=str(self.proc), P=str(self.base),
                   BB=shutil.which('busybox'), profile=profile)
        return subprocess.run(['sh', '-c', code], env=env, capture_output=True).returncode

    def compare(self, txn, main, profile='rack'):
        for mode, wanted in [('transaction', txn), ('main', main)]:
            self.assertEqual(self.native(mode, profile), wanted)
            self.assertEqual(self.shell(mode, profile), wanted)
            self.assertEqual(self.shell(mode, profile, self.exe), wanted)

    def test_empty(self): self.compare(1, 1)

    def test_main_renamed_orphan(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'])
        self.compare(0, 0)

    def test_duplicate_instances(self):
        for pid in ['301', '502']: self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'], pid=pid)
        self.compare(0, 0)

    def test_wrong_executable(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'], exe='/wrong/sing-box')
        self.compare(1, 1)

    def test_deleted_executable(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'], exe=self.d+'/sing-box (deleted)')
        self.compare(1, 1)

    def test_extra_argument(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json', '--extra'])
        self.compare(1, 1)

    def test_argv0_not_executable(self):
        self.process(['sing-box', 'run', '-c', self.d+'/config.json'])
        self.compare(1, 1)

    def test_rack(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/youtube-failover/workers/rack/config.json'])
        self.compare(0, 1)
        self.compare(1, 1, 'dns9')

    def test_zgo_allowed(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/youtube-failover/workers/zgo/config.json'])
        self.compare(1, 1)

    def test_guardian_suffix(self):
        self.process(['app_process', '/system/bin', 'YoutubeFailover', self.d+'/youtube-failover/guard-config.json'], exe='/system/bin/app_process')
        self.compare(0, 1)

    def test_supervisor_suffix(self):
        self.process(['sh', self.d+'/youtube-failover/guard-run.sh'], exe='/system/bin/sh')
        self.compare(0, 1)

    def test_guardian_with_extra_arg_matches_old_policy(self):
        self.process(['app_process', 'YoutubeFailover', self.d+'/youtube-failover/guard-config.json', 'extra'], exe='/system/bin/app_process')
        self.compare(1, 1)

    def test_vanished_pid(self):
        self.process(['anything'])
        (self.proc/'301'/'cmdline').unlink()
        self.compare(1, 1)

    def test_empty_kernel_cmdline(self):
        self.process([], raw=b'')
        self.compare(1, 1)

    def test_read_error_uncertain(self):
        p = self.process(['anything'])
        (p/'cmdline').unlink(); (p/'cmdline').mkdir()
        self.assertEqual(self.native(), 2)
        self.assertEqual(self.shell(helper=self.exe), 0)  # old txn fail-closed
        self.assertEqual(self.shell(mode='main', helper=self.exe), 1)  # old main semantics

    def test_over_limit_uncertain(self):
        self.process([], raw=b'x'*(1024*1024)+b'\0')
        self.assertEqual(self.native(), 2)

    def test_missing_nul_uncertain(self):
        self.process([], raw=b'not-complete')
        self.assertEqual(self.native(), 2)

    def test_no_proc_root(self):
        self.assertEqual(subprocess.run([str(self.exe), '/definitely-absent-proc', 'main', self.d, 'rack']).returncode, 2)

    def test_worker_requires_exact_executable_and_full_argv(self):
        exe=self.d+'/sing-box';cfg=self.d+'/youtube-failover/workers/zgo/config.json'
        def native(): return subprocess.run([str(self.exe),str(self.proc),'worker',exe,cfg]).returncode
        self.assertEqual(native(),1)
        p=self.process([exe,'run','-c',cfg])
        self.assertEqual(native(),0)
        (p/'cmdline').write_bytes(b'\0'.join(x.encode() for x in [exe,'run','-c',cfg,'extra'])+b'\0')
        self.assertEqual(native(),1)
        (p/'cmdline').write_bytes(b'\0'.join(x.encode() for x in [exe,'run','-c',cfg])+b'\0')
        (p/'exe').unlink(); (p/'exe').symlink_to('/wrong/sing-box')
        self.assertEqual(native(),1)

    def test_helper_errors_fallback(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'])
        helper = self.base/'fake-helper'
        for body in ['#!/bin/sh\nexit 2\n', '#!/bin/sh\nexit 127\n', 'broken executable\n']:
            helper.write_text(body); helper.chmod(0o700)
            self.assertEqual(self.shell(helper=helper), 0)
            self.assertEqual(self.shell(mode='main', helper=helper), 0)
        # Symlink is refused even with a matching digest.
        link = self.base/'linked-helper'; link.symlink_to(self.exe)
        self.assertEqual(self.shell(helper=link), 0)
        link.unlink()

    def test_missing_or_bad_digest_fallback(self):
        self.process([self.d+'/sing-box', 'run', '-c', self.d+'/config.json'])
        helper = self.base/'always-absent'
        helper.write_text('#!/bin/sh\nexit 1\n'); helper.chmod(0o700)
        for mode in ('main', 'transaction'):
            self.assertEqual(self.shell(mode=mode, helper=helper, digest_override='0'*64), 0)
            self.assertEqual(self.shell(mode=mode, helper=self.base/'missing', digest_override='0'*64), 0)


# Run the real transaction's existing failure/lock/replay/rollback suite with
# the native path enabled, not just isolated predicate calls.
import test_dns_upgrade_apply as transaction_tests


class NativeTransaction(transaction_tests.Transaction):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix='native-transaction-test-')
        cls.binary = Path(cls.build.name)/'video-proc-scan'
        subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(S/'video-proc-scan.c'), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls): cls.build.cleanup()

    def setUp(self):
        super().setUp()
        data = self.binary.read_bytes()
        (self.stage/'video-proc-scan').write_bytes(data)
        (self.stage/'video-proc-scan').chmod(0o700)
        self.script.write_text(self.script.read_text().replace('UNSTAGED_PROC_SCAN_SHA256', hashlib.sha256(data).hexdigest()))


if __name__ == '__main__': unittest.main()
