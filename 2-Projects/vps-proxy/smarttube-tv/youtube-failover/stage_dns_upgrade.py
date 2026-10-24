#!/usr/bin/env python3
"""Stage a DNS-only amendment of the live four-route release. No live activation.

Production credentials stay in memory or root-only device directories. Never
regenerate the established four-route configuration from an older stage.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import shlex
import subprocess

SOURCE = Path(__file__).resolve().parent
D = '/data/adb/video-proxy'
P = D + '/dns-upgrade-20261024'
R = 'youtube-failover/'
PATHS = ['config.json', 'video-boot-start.sh'] + [R + p for p in (
    'main-config.json', 'active-main.sha256', 'release-id', 'enabled',
    'manifest.json', 'service.sh', 'video-boot-start.next.sh')]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    adb = ['adb', '-s', args.serial, 'shell']

    def run(command, data=None):
        result = subprocess.run(adb + ['/system/xbin/su 0 sh -c ' + shlex.quote(command)],
                                input=data, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('device operation failed; potentially sensitive output suppressed')
        return result.stdout

    def read(path):
        return run('cat ' + shlex.quote(path))

    def write(path, data, mode='600'):
        parent = str(PurePosixPath(path).parent)
        run('umask 077; mkdir -p ' + shlex.quote(parent) + ' && cat > ' + shlex.quote(path)
            + ' && chmod ' + mode + ' ' + shlex.quote(path), data)
        if read(path) != data:
            raise RuntimeError('independent payload readback mismatch')

    before = {p: read(D + '/' + p) for p in PATHS}
    boot = read('/proc/sys/kernel/random/boot_id')
    pids = run('pidof sing-box')
    old_release = before[R + 'release-id'].decode().strip()
    assert before[R + 'enabled'].decode().strip() == old_release
    assert before[R + 'active-main.sha256'].decode().strip() == sha(before['config.json'])
    assert before[R + 'main-config.json'] == before['config.json']
    manifest = json.loads(before[R + 'manifest.json'])
    assert manifest['release_id'] == old_release
    # Audit the actual installed release, including its previous corrections.
    for name, expected in manifest['files'].items():
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        if sha(read(D + '/' + R + name)) != expected:
            raise RuntimeError('installed release drift: ' + name)

    original = json.loads(before['config.json'])
    config = copy.deepcopy(original)
    assert 'optimistic' not in config['dns']
    assert 'cache_file' not in config.get('experimental', {})
    config['dns']['optimistic'] = {'enabled': True, 'timeout': '5m'}
    config.setdefault('experimental', {})['cache_file'] = {
        'enabled': True, 'path': D + '/dns-cache.db', 'store_dns': True}
    # Assert no routing, account, protocol, or API changes.
    check = copy.deepcopy(config)
    del check['dns']['optimistic']
    del check['experimental']['cache_file']
    if 'experimental' not in original:
        del check['experimental']
    assert check == original
    new = dict(before)
    new['config.json'] = (json.dumps(config, indent=2) + '\n').encode()
    new[R + 'main-config.json'] = new['config.json']
    new[R + 'active-main.sha256'] = (sha(new['config.json']) + '\n').encode()
    new['video-boot-start.sh'] = (SOURCE / 'video-boot-start.next.sh').read_bytes()
    new[R + 'video-boot-start.next.sh'] = new['video-boot-start.sh']
    # service.sh is part of the rollback set but intentionally unchanged.
    guard = (SOURCE / 'video-dns-guard.sh').read_bytes()
    release = sha(old_release.encode() + guard + b''.join(
        p.encode() + bytes.fromhex(sha(new[p])) for p in sorted(new)
        if p not in (R + 'release-id', R + 'enabled', R + 'manifest.json')))
    new[R + 'release-id'] = new[R + 'enabled'] = (release + '\n').encode()
    manifest.update(release_id=release, previous_release_id=old_release,
                    amendment='Early dual-stack DNS protection and persistent DNS with 5m optimistic window')
    for p, data in new.items():
        if p.startswith(R) and p != R + 'manifest.json':
            manifest['files'][p[len(R):]] = sha(data)
    manifest['boot_assets'] = {'video-boot-start.sh': sha(new['video-boot-start.sh']),
                               'video-dns-guard.sh': sha(guard)}
    new[R + 'manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    run('test ! -e ' + P + ' && mkdir -m 700 ' + P)
    lines = []
    for path in PATHS:
        mode = '700' if path.endswith('.sh') else '600'
        write(P + '/backup/' + path, before[path], mode)
        write(P + '/payload/' + path, new[path], mode)
        lines.append('\t'.join((path, sha(before[path]), sha(new[path]), mode)))
    write(P + '/transaction.tsv', ('\n'.join(lines) + '\n').encode())
    write(P + '/installed-boot-id', boot)
    write(P + '/dns-upgrade-apply.sh', (SOURCE / 'dns-upgrade-apply.sh').read_bytes(), '700')
    write(P + '/video-dns-guard.sh', guard, '700')
    # check does not run the engine or open its production cache database.
    run(D + '/sing-box check -c ' + P + '/payload/config.json')
    for path in [P + '/dns-upgrade-apply.sh', P + '/video-dns-guard.sh',
                 P + '/payload/video-boot-start.sh']:
        run('sh -n ' + path)
    verification = run('sh ' + P + '/dns-upgrade-apply.sh --verify').decode().strip()
    deferred = run('sh ' + P + '/dns-upgrade-apply.sh --apply').decode().strip()
    assert 'deferred' in deferred
    for path, data in before.items():
        assert read(D + '/' + path) == data, 'live file changed: ' + path
    assert read('/proc/sys/kernel/random/boot_id') == boot
    assert run('pidof sing-box') == pids
    result = {'stage': P, 'old_release': old_release, 'next_release': release,
              'old_config_sha': sha(before['config.json']),
              'next_config_sha': sha(new['config.json']), 'files': len(PATHS),
              'device_config_check': 'passed', 'transaction_verify': verification,
              'same_boot_apply': deferred, 'all_live_files_unchanged': True,
              'proxy_pids_unchanged': pids.decode().strip(),
              'status': 'staged; activation hook not installed by this tool'}
    args.evidence.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
