#!/usr/bin/env python3
"""No real SSH/sudo: exercise stdin-only credentials and script invariants."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
FAKE = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL_7q!'


class Credentials(unittest.TestCase):
    def run_shell(self, body, include=True):
        with tempfile.TemporaryDirectory() as d:
            env=dict(os.environ, TEST_DIR=d)
            if include: env['TEST_CREDENTIAL']=FAKE
            else: env.pop('TEST_CREDENTIAL',None)
            # These functions intercept the real executables. No host is contacted.
            prelude='''source "$COMMON_FILE"
ssh() { printf '%s\\n' "$@" > "$TEST_DIR/argv"; cat > "$TEST_DIR/stdin"; return "${FAKE_EXIT:-0}"; }
sudo() { printf '%s\\n' "$@" > "$TEST_DIR/argv"; cat > "$TEST_DIR/stdin"; return "${FAKE_EXIT:-0}"; }
'''
            env['COMMON_FILE']=str(BASE/'common.sh')
            r=subprocess.run(['/bin/bash','-c',prelude+body],env=env,capture_output=True,text=True)
            argv=Path(d,'argv').read_text() if Path(d,'argv').exists() else ''
            stdin=Path(d,'stdin').read_text() if Path(d,'stdin').exists() else ''
            return r,argv,stdin

    def test_remote_stdin_not_argv(self):
        r,args,data=self.run_shell('et_sudo_env example TEST_CREDENTIAL "printf ok"')
        self.assertEqual(r.returncode,0);self.assertNotIn(FAKE,args);self.assertEqual(data,FAKE+'\n')
        self.assertIn('StrictHostKeyChecking=yes',args)

    def test_local_stdin_not_argv(self):
        r,args,data=self.run_shell('et_sudo_env __LOCAL__ TEST_CREDENTIAL "printf ok"')
        self.assertEqual(r.returncode,0);self.assertNotIn(FAKE,args);self.assertEqual(data,FAKE+'\n')

    def test_trace_not_secret(self):
        r,args,data=self.run_shell('set -x; et_sudo_env example TEST_CREDENTIAL "printf ok"')
        self.assertEqual(r.returncode,0);self.assertNotIn(FAKE,r.stderr+r.stdout+args)

    def test_missing_fails_before_ssh(self):
        r,args,data=self.run_shell('et_sudo_env example TEST_CREDENTIAL "printf ok"',False)
        self.assertEqual(r.returncode,2);self.assertEqual(args+data,'');self.assertNotIn(FAKE,r.stderr)

    def test_variable_injection_rejected(self):
        r,args,data=self.run_shell("et_sudo_env example 'TEST_CREDENTIAL;whoami' true")
        self.assertEqual(r.returncode,2);self.assertEqual(args+data,'')

    def test_exit_code_preserved(self):
        r,args,data=self.run_shell('FAKE_EXIT=7; et_sudo_env example TEST_CREDENTIAL true')
        self.assertEqual(r.returncode,7)

    def test_no_literal_routing(self):
        for name in ['common.sh','deploy-node.sh','uninstall-node.sh','mesh-status.sh','bench.sh']:
            self.assertNotIn('literal:',(BASE/name).read_text(),name)
        self.assertIn('secret:DEV198_SUDO_PASS',(BASE/'common.sh').read_text())

    def test_shell_syntax(self):
        for path in BASE.glob('*.sh'):
            r=subprocess.run(['/bin/bash','-n',str(path)],capture_output=True)
            self.assertEqual(r.returncode,0,path.name)


if __name__=='__main__':unittest.main(verbosity=2)
