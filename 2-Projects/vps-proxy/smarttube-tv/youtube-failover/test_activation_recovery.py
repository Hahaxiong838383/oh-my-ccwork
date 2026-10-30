#!/usr/bin/env python3
"""Regression for activation review findings on real temporary files.

Process actions are recorded substitutes, not evidence of Android restarts.
The production rollback/byte-matching functions themselves are executed.
"""
import hashlib
from pathlib import Path
import re
import os
import signal
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).with_name('activate-rack-dualstack.sh').read_text()


def function(name):
    match = re.search(r'^' + name + r'\(\) [{(][\s\S]*?^[})]', SOURCE, re.M)
    assert match, name
    return match.group(0)


class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rack-activation-recovery-')
        self.root = Path(self.temp.name)
        self.d = self.root/'live'; self.p = self.root/'stage'; self.r = self.d/'youtube-failover'
        self.r.mkdir(parents=True); self.p.mkdir()
        rows=[]
        for name in ('config.json', 'video-dns-service-start.sh'):
            old = b'old release\n'; new = b'new release\n'
            mode = 0o700 if name.endswith('.sh') else 0o600
            for group,data in [('backup',old),('payload',new)]:
                target=self.p/group/name;target.parent.mkdir(exist_ok=True);target.write_bytes(data);target.chmod(mode)
            target=self.d/name;target.write_bytes(new if name.endswith('.sh') else old);target.chmod(mode)
            rows.append('\t'.join((name,hashlib.sha256(old).hexdigest(),hashlib.sha256(new).hexdigest(),oct(mode)[2:])))
        (self.p/'transaction.tsv').write_text('\n'.join(rows)+'\n')
        (self.r/'service.sh').write_text('printf resumed > "'+str(self.root/'resume-called')+'"\n')
        self.prefix='\n'.join(['set -u', 'D='+str(self.d), 'R='+str(self.r), 'P='+str(self.p),
            'BB=/usr/bin/busybox', 'applied=0', 'log() { echo "$*"; }', 'main_pid() { echo 123; }',
            'without_activation_lock() { "$@"; }',
            'start_release() { echo unexpected_start; return 1; }',
            function('digest'),function('matches_set'),function('restore_boot_entry'),function('failed')])+'\n'

    def tearDown(self): self.temp.cleanup()
    def run_script(self, code):
        return subprocess.run(['/bin/sh','-c',self.prefix+code],capture_output=True,text=True,timeout=10)

    def test_unapplied_failure_restores_entry_and_resumes_old_service(self):
        result=self.run_script('failed\n')
        self.assertEqual(result.returncode,1)
        self.assertIn('old_runtime_restored',result.stdout)
        self.assertEqual((self.d/'video-dns-service-start.sh').read_bytes(),b'old release\n')
        self.assertTrue((self.root/'resume-called').is_file())
        self.assertFalse((self.p/'rolled-back-boot-id').exists())

    def test_restore_copy_failure_never_claims_success(self):
        result=self.run_script('cp() { return 73; }\nfailed\n')
        self.assertEqual(result.returncode,1)
        self.assertIn('boot_entry_restore_failed',result.stdout)
        self.assertNotIn('old_runtime_restored',result.stdout)
        self.assertFalse((self.root/'resume-called').exists())
        self.assertEqual((self.d/'video-dns-service-start.sh').read_bytes(),b'new release\n')

    def test_successful_exit_with_rollback_message_cannot_complete_activation(self):
        # Execute the exact production activation tail. A transaction that
        # preserved rollback returns 0, but must not be accepted as applied.
        tail=SOURCE[SOURCE.index('result=$(sh "$P/dns-upgrade-apply.sh" --apply-authorized)'):]
        result=self.run_script('sh() { echo dns_upgrade_rolled_back_preserved; }\n'+tail)
        self.assertEqual(result.returncode,1)
        self.assertNotIn('completed',result.stdout)
        self.assertEqual((self.d/'config.json').read_bytes(),b'old release\n')

    def test_mixed_old_new_files_fail_completion_match(self):
        self.assertNotEqual(self.run_script('matches_set payload\n').returncode,0)
        self.assertEqual(self.run_script('matches_set backup yes\n').returncode,0)

    def test_foreground_is_bound_to_current_verified_player(self):
        marker=self.p/'authorized-foreground-component'
        diyp='com.player.diyp2020/com.player.activity.PlayerActivity'
        zspace='com.zentraedi.zspace.tv/example.VideoPlayerActivity'
        def check(value):
            return self.run_script(function('foreground_allowed')+'\nforeground_allowed '+value+'\n').returncode
        self.assertNotEqual(check(diyp),0)
        marker.write_text(diyp+'\n');marker.chmod(0o600)
        self.assertEqual(check(diyp),0)
        self.assertNotEqual(check(zspace),0)
        marker.write_text('com.liskovsoft.smarttubetv/.MainActivity\n')
        self.assertNotEqual(check('com.liskovsoft.smarttubetv/.MainActivity'),0)
        marker.write_text(diyp+'\n');marker.chmod(0o644)
        self.assertNotEqual(check(diyp),0)

    def test_detached_daemon_does_not_keep_maintenance_lock(self):
        child=self.root/'child.sh';pidfile=self.root/'child.pid'
        child.write_text('echo $$ > '+str(pidfile)+'\nexec sleep 10\n')
        for close_fd in (False,True):
            launcher=self.root/'launch.sh'
            spawn='without_activation_lock sh' if close_fd else 'sh'
            launcher.write_text('D='+str(self.d)+'\n'+function('without_activation_lock')+'\n'+
                               spawn+' '+str(child)+' >/dev/null 2>&1 </dev/null &\nsleep 0.1\n')
            try:
                subprocess.run(['/usr/bin/flock','-n',str(self.d/'rack-activation.lock'),'sh',str(launcher)],check=True,timeout=3)
                result=subprocess.run(['/usr/bin/flock','-n',str(self.d/'rack-activation.lock'),'true'],timeout=3)
                self.assertEqual(result.returncode,0 if close_fd else 1)
            finally:
                if pidfile.exists():
                    os.kill(int(pidfile.read_text()),signal.SIGTERM);pidfile.unlink()


if __name__=='__main__': unittest.main()
