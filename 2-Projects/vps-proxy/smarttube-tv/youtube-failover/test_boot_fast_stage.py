#!/usr/bin/env python3
"""New immutable entry against the real fifteen-file transaction on local files."""
from pathlib import Path
import subprocess
import unittest
import stage_boot_fast as staging
import test_dns_upgrade_apply as transactions

S = Path(__file__).resolve().parent


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = transactions.Transaction('test_rack_profile_apply_rollback_covers_all_fifteen_files')
        self.fixture.setUp()
        f = self.fixture
        f.enable_rack()
        self.events = f.base/'boot-events'
        for label, data, bases in [('old',f.old,[f.root,f.stage/'backup']), ('new',f.new,[f.stage/'payload'])]:
            script = ('#!/bin/sh\necho '+label+' >> "'+str(self.events)+'"\n').encode()
            data['video-boot-start.sh'] = script
            for base in bases: (base/'video-boot-start.sh').write_bytes(script)
        f.write_transaction()
        starter = (S/'video-dns-service-start.sh').read_bytes().replace(b'dns-upgrade-20261024',f.stage.name.encode())
        wrapper, hook = staging.wiring(starter,(S/'video-dns-service-entry.sh').read_bytes(),f.stage.name)
        for name, data in [('service-start-entry.sh',wrapper),('hook.sh',hook)]:
            data=data.replace(staging.D.encode(),str(f.root).encode()).replace(b'/proc/sys/kernel/random/boot_id',str(f.boot).encode())
            data=data.replace(b'/data/adb/magisk/busybox',str(f.busybox).encode())
            (f.stage/name).write_bytes(data)

    def tearDown(self): self.fixture.tearDown()

    def start(self, name='service-start-entry.sh'):
        f=self.fixture
        return subprocess.run(['sh',str(f.stage/name)],env=f.env,capture_output=True,text=True,timeout=8)

    def test_same_boot_entry_and_wrapper_zero_actions(self):
        f=self.fixture
        (f.stage/'installed-boot-id').write_text(f.boot.read_text())
        before=f.snapshot()
        for name in ('hook.sh','service-start-entry.sh'):
            self.assertEqual(self.start(name).returncode,0)
        self.assertEqual(f.snapshot(),before)
        self.assertFalse(self.events.exists())

    def test_new_boot_applies_before_start_and_replays(self):
        f=self.fixture
        self.assertEqual(self.start().returncode,0)
        f.assert_live(f.new)
        self.assertEqual(self.events.read_text(),'new\n')
        f.boot.write_text('second-boot\n')
        self.assertEqual(self.start().returncode,0)
        self.assertEqual((f.stage/'applied-boot-id').read_text(),'second-boot\n')
        self.assertEqual(self.events.read_text(),'new\nnew\n')

    def test_rollback_entry_keeps_old_release_on_future_boot(self):
        f=self.fixture
        self.assertEqual(self.start().returncode,0)
        self.assertEqual(f.run_apply('--rollback').returncode,0)
        f.boot.write_text('third-boot\n')
        self.assertEqual(self.start().returncode,0)
        f.assert_live(f.old)
        self.assertEqual(self.events.read_text(),'new\nold\n')

    def test_unknown_drift_never_starts(self):
        f=self.fixture
        (f.root/'config.json').write_text('unknown')
        self.assertNotEqual(self.start().returncode,0)
        self.assertFalse(self.events.exists())

    def test_mixed_partial_apply_finishes_before_start(self):
        f=self.fixture
        for name in f.paths[:4]: (f.root/name).write_bytes(f.new[name])
        self.assertEqual(self.start().returncode,0)
        f.assert_live(f.new)
        self.assertEqual(self.events.read_text(),'new\n')

    def test_successive_stage_hook_uses_latest_boot_barrier(self):
        original=(S/'video-dns-service-entry.sh').read_bytes()
        starter=(S/'video-dns-service-start.sh').read_bytes()
        _,first=staging.wiring(starter,original,'boot-fast-20261030')
        _,second=staging.wiring(starter,first,'boot-fast-20261030-workers','boot-fast-20261030')
        self.assertIn(b'boot-fast-20261030-workers/installed-boot-id',second)
        self.assertIn(b'boot-fast-20261030-workers/service-start-entry.sh',second)
        self.assertNotIn(b'boot-fast-20261030/',second)
        with self.assertRaises(AssertionError):
            staging.wiring(starter,first,'boot-fast-20261030-workers','unknown')


if __name__ == '__main__': unittest.main()
