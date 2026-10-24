#!/usr/bin/env python3
"""Install previously verified next-boot DNS hooks without activating them now."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

S = Path(__file__).resolve().parent
D = '/data/adb/video-proxy'
P = D + '/dns-upgrade-20261024'
ENTRY = '/data/adb/service.d/video-proxy.sh'
HOOK = '/data/adb/post-fs-data.d/video-dns-guard.sh'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    adb = ['adb', '-s', args.serial, 'shell']

    def run(cmd, data=None):
        result = subprocess.run(adb + ['/system/xbin/su 0 sh -c ' + shlex.quote(cmd)],
                                input=data, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('device operation failed; potentially sensitive output suppressed')
        return result.stdout

    def read(path):
        return run('cat ' + shlex.quote(path))

    def sha(data):
        return hashlib.sha256(data).hexdigest()

    def snapshot():
        cmds = {'boot': 'cat /proc/sys/kernel/random/boot_id', 'pids': 'pidof sing-box',
                'config': 'sha256sum ' + D + '/config.json',
                'boot_worker': 'sha256sum ' + D + '/video-boot-start.sh',
                'release': 'cat ' + D + '/youtube-failover/release-id',
                'guard': 'sh ' + D + '/youtube-failover/service.sh status',
                'nat': 'iptables -t nat -S', 'filter4': 'iptables -S',
                'filter6': 'ip6tables -S', 'routes4': 'ip -4 rule', 'routes6': 'ip -6 rule',
                'foreground': 'dumpsys activity activities | grep mResumedActivity',
                'codec': 'cat /sys/class/vdec/vdec_status'}
        return {k: run(v).decode().strip() for k, v in cmds.items()}

    run('sh ' + P + '/dns-upgrade-apply.sh --verify')
    boot = read('/proc/sys/kernel/random/boot_id')
    assert boot == read(P + '/installed-boot-id')
    assert 'deferred' in run('sh ' + P + '/dns-upgrade-apply.sh --apply').decode()
    staged = json.loads(read(P + '/payload/youtube-failover/manifest.json'))
    guard = (S / 'video-dns-guard.sh').read_bytes()
    assert sha(guard) == staged['boot_assets']['video-dns-guard.sh']
    old_entry = read(ENTRY)
    assert sha(old_entry) == 'fba318fd39f6b369ac08536bed5fe22be611b28897a8184a271ef224bd0beeca'
    before = snapshot()
    files = {
        D + '/dns-guard-installed-boot-id': boot,
        D + '/video-dns-guard.sh': guard,
        D + '/video-dns-service-start.sh': (S / 'video-dns-service-start.sh').read_bytes(),
        HOOK: (S / 'video-dns-post-fs-data.sh').read_bytes(),
        ENTRY: (S / 'video-dns-service-entry.sh').read_bytes(),
    }
    # Exclusive preflight: no unrelated installation or edits may be overwritten.
    for path in files:
        if path != ENTRY:
            run('test ! -e ' + shlex.quote(path))
    run('test ! -e ' + P + '/backup/service-entry.sh && cp -p ' + ENTRY + ' '
        + P + '/backup/service-entry.sh')
    assert read(P + '/backup/service-entry.sh') == old_entry
    for path, data in files.items():
        temp = path + '.dns-next'
        mode = '700' if path.endswith('.sh') else '600'
        run('test ! -e ' + shlex.quote(temp) + ' && umask 077 && cat > ' + shlex.quote(temp)
            + ' && chmod ' + mode + ' ' + shlex.quote(temp), data)
        assert read(temp) == data
        if path.endswith('.sh'):
            run('sh -n ' + shlex.quote(temp))
    # Commit the current-boot barrier and supporting files first, entry last.
    run('sync')
    for path, data in files.items():
        if path == ENTRY:
            assert read(ENTRY) == old_entry
        run('mv ' + shlex.quote(path + '.dns-next') + ' ' + shlex.quote(path))
        assert read(path) == data
    run('sync')
    deferred = {}
    for path in (HOOK, ENTRY, D + '/video-dns-service-start.sh', D + '/video-dns-guard.sh'):
        result = run('sh ' + shlex.quote(path)).decode().strip()
        assert 'deferred' in result, path
        deferred[path] = result
    after = snapshot()
    unchanged = {k: before[k] == after[k] for k in before if k not in ('foreground', 'codec')}
    assert all(unchanged.values()), unchanged
    result = {'status': 'installed, next boot activation pending',
              'installed_boot': boot.decode().strip(),
              'files': {path: sha(data) for path, data in files.items()},
              'backup_entry': P + '/backup/service-entry.sh', 'deferred_entry_checks': deferred,
              'unchanged': unchanged, 'before': before, 'after': after}
    args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('before', 'after')}, indent=2))


if __name__ == '__main__':
    main()
