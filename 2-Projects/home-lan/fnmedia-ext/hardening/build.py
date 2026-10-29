#!/usr/bin/env python3
"""Rebuild the pinned local edition; never installs it on a NAS."""
import argparse
import hashlib
from pathlib import Path
import subprocess

UPSTREAM = 'https://github.com/yujian0815/fnmedia-ext.git'
COMMIT = '93a781b1813eaaa83723765f38e6e4dddd60a651'
FNPACK_URL = 'https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64'
FNPACK_SHA = '54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--proxy')
    args = parser.parse_args()
    work = args.work_dir.resolve()
    if work.exists():
        raise SystemExit('work-dir must not exist; no existing directory will be replaced')
    work.mkdir(parents=True)
    root = work / 'source'
    def run(command, cwd=work):
        subprocess.run(command, cwd=cwd, check=True)
    git = ['git'] + (['-c', 'http.proxy=' + args.proxy] if args.proxy else [])
    run(git + ['init', str(root)])
    run(git + ['fetch', '--depth=1', UPSTREAM, COMMIT], root)
    run(git + ['checkout', '--detach', COMMIT], root)
    patch = Path(__file__).resolve().with_name('hardening.patch')
    run(git + ['apply', '--check', str(patch)], root)
    run(git + ['apply', str(patch)], root)
    pip = ['pip3', 'download'] + (['--proxy', args.proxy] if args.proxy else [])
    run(pip + ['--only-binary=:all:', '--python-version', '311', '--platform',
               'manylinux2014_x86_64', '--implementation', 'cp', '--abi', 'cp311',
               '--require-hashes', '--dest', 'wheelhouse', '-r', 'requirements.hashed.txt'], root)
    fnpack = work / 'fnpack'
    curl = ['curl', '--fail', '--location', '--max-time', '120']
    if args.proxy: curl += ['--proxy', args.proxy]
    run(curl + ['--output', str(fnpack), FNPACK_URL])
    if hashlib.sha256(fnpack.read_bytes()).hexdigest() != FNPACK_SHA:
        raise SystemExit('fnpack checksum mismatch; refusing to execute')
    fnpack.chmod(0o700)
    run(['bash', 'packaging/fpk/build.sh', '--public', '--fnpack', str(fnpack), '--out', str(work / 'dist')], root)
    print('Built:', work / 'dist')


if __name__ == '__main__':
    main()
