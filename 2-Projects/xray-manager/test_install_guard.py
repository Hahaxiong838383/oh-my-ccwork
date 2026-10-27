"""Installer must refuse managed installs before any external command or write."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
INSTALLER=(pathlib.Path(sys.argv.pop(1)) if __name__=='__main__' and len(sys.argv)>1 and not sys.argv[1].startswith('-') else pathlib.Path(__file__).with_name('install.sh'))

class InstallerGuardTests(unittest.TestCase):
    def check_guard(self,marker=None,dangling=False):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);home=root/'home';home.mkdir();commands=root/'commands';commands.mkdir();log=root/'commands.log'
            # Block every external command before an old installer can mutate anything.
            for name in ['dirname','uname','mkdir','curl','cp','launchctl','sed','crontab','python3']:
                command=commands/name;command.write_text('#!/bin/sh\nprintf \'%s\\n\' "$0" >> "$XRAY_TEST_COMMAND_LOG"\nexit 91\n');command.chmod(0o700)
            if marker:
                path=home/marker;path.parent.mkdir(parents=True,exist_ok=True)
                if dangling:path.symlink_to(home/'missing-target')
                else:path.write_text('installed even if metadata is invalid')
            before=sorted(str(p.relative_to(home)) for p in home.rglob('*'))
            isolated=root/'install-isolated.sh'
            isolated.write_text(INSTALLER.read_text().replace('$HOME', '$XRAY_TEST_HOME'))
            env={**os.environ,'XRAY_TEST_HOME':str(home),'PATH':str(commands),'XRAY_TEST_COMMAND_LOG':str(log)}
            result=subprocess.run(['/bin/bash',str(isolated)],env=env,capture_output=True,text=True,timeout=5)
            after=sorted(str(p.relative_to(home)) for p in home.rglob('*'))
            self.assertEqual(before,after)
            if marker:
                self.assertEqual(result.returncode,78)
                self.assertIn('受管',result.stderr)
                self.assertFalse(log.exists(),'guard must precede even dirname/uname')
            else:
                self.assertEqual(result.returncode,91)
                self.assertTrue(log.exists(),'unmanaged installer retains original path')
    def test_controller_marker_refuses_before_side_effects(self):
        self.check_guard('xray/company-lisa-failover/controller.json')
    def test_plist_marker_refuses_before_side_effects(self):
        self.check_guard('Library/LaunchAgents/com.company.lisa-failover.plist')
    def test_dangling_managed_marker_is_not_bypassed(self):
        self.check_guard('xray/company-lisa-failover/controller.json',dangling=True)
    def test_unmanaged_install_preserves_original_flow(self):
        self.check_guard()

if __name__=='__main__':unittest.main()
