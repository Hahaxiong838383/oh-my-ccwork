"""Build gate must verify Cargo's actual artifact and carry the approved compile SHA."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('build-local.sh')
SHA = 'a' * 40

class BuildBinding(unittest.TestCase):
    def run_build(self, sha=SHA):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_dir = root / '.cargo/bin'
            bin_dir.mkdir(parents=True)
            artifact = root / 'custom-target/release/voice-rust-worker'
            commands = {
                'dpkg': 'echo "ii  fake"',
                'rustc': 'echo rustc-test',
                'cargo': '''if [ "$1" = "-V" ]; then echo cargo-test; exit; fi
[ -n "${P003_WORKER_BUILD_SHA:-}" ] || exit 41
printf '%s' "$P003_WORKER_BUILD_SHA" > "$TEST_ROOT/compiled-sha"
mkdir -p "$CARGO_TARGET_DIR/release"
printf candidate > "$CARGO_TARGET_DIR/release/voice-rust-worker"
printf '{"reason":"compiler-artifact","target":{"name":"voice-rust-worker","kind":["bin"]},"executable":"%s/release/voice-rust-worker"}\\n' "$CARGO_TARGET_DIR"
''',
                'ldd': 'echo "ldd 2.39"',
                'strings': 'echo GLIBCXX_3.4.30',
                'objdump': 'echo GLIBC_2.39; echo GLIBCXX_3.4.30',
                'sha256sum': 'echo "sha256-artifact  $1"',
                'md5sum': 'echo "md5-artifact  $1"',
                'sort': 'exec /usr/bin/sort "$@"',
            }
            # macOS sort supports -V via bundled brew GNU sort when available.
            if Path('/opt/homebrew/bin/gsort').exists():
                commands['sort'] = 'exec /opt/homebrew/bin/gsort "$@"'
            for name, body in commands.items():
                p = bin_dir / name
                p.write_text('#!/bin/bash\n' + body + '\n')
                p.chmod(0o755)
            env = dict(os.environ, HOME=td, LC_ALL="C", TEST_ROOT=td, CARGO_TARGET_DIR=str(root/'custom-target'))
            env.pop('P003_WORKER_BUILD_SHA', None)
            if sha is not None:
                env['P003_WORKER_BUILD_SHA'] = sha
            result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True, text=True, errors="replace", timeout=30)
            recorded = (root/'compiled-sha').read_text() if (root/'compiled-sha').exists() else None
            return result, recorded, str(artifact)

    def test_actual_artifact_and_compile_sha(self):
        r, sha, artifact = self.run_build()
        self.assertEqual(r.returncode, 0, r.stdout+r.stderr)
        self.assertEqual(sha, SHA)
        self.assertIn(artifact, r.stdout)
        self.assertIn('sha256-artifact', r.stdout)

    def test_missing_build_sha_fails_before_cargo(self):
        r, sha, _ = self.run_build(None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(sha)

    def test_invalid_build_sha_fails_before_cargo(self):
        r, sha, _ = self.run_build('not-a-commit')
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(sha)

if __name__ == '__main__':
    unittest.main()
