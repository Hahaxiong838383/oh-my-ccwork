#!/usr/bin/env python3
"""Stage the native scan amendment, optionally wire it for the next boot only.

Uses the existing fifteen-file rollback group plus workerctl.sh. Credentials never
leave memory or root-only device files. The immutable helper is a pinned stage
dependency; restored old scripts do not need it. Does not restart any process.
"""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
from stage_rack_dualstack import Device, PATHS as BASE_PATHS, D, R, sha, encoded

PATHS = BASE_PATHS + [R+'workerctl.sh']

S = Path(__file__).resolve().parent
HOOK = '/data/adb/service.d/video-proxy.sh'
ASSETS = D+'/boot-assets-current.json'


def wiring(starter, old_hook, stage, previous_stage=None):
    p = D+'/'+stage
    directory_line = b'D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1'
    assert starter.count(directory_line) == 1
    assert starter.count(b'$D/dns-guard-installed-boot-id') == 1
    old_marker = b'$D/dns-guard-installed-boot-id'
    old_target = b'$D/video-dns-service-start.sh'
    if old_target not in old_hook:
        assert previous_stage and re.fullmatch(r'[a-z0-9-]+', previous_stage)
        old_marker = (D+'/'+previous_stage+'/installed-boot-id').encode()
        old_target = (D+'/'+previous_stage+'/service-start-entry.sh').encode()
    assert old_hook.count(old_marker) == 1
    assert old_hook.count(old_target) == 1
    starter = starter.replace(directory_line, ('D='+D).encode())
    starter = starter.replace(b'$D/dns-guard-installed-boot-id', (p+'/installed-boot-id').encode())
    hook = old_hook.replace(old_target, (p+'/service-start-entry.sh').encode())
    hook = hook.replace(old_marker, (p+'/installed-boot-id').encode())
    assert hook != old_hook and hook.count((p+'/service-start-entry.sh').encode()) == 1
    assert b'$D/video-dns-service-start.sh' not in hook
    return starter, hook


def payload(before, manifest, stage, helper):
    """Only boot scripts and release metadata change; all network bytes persist."""
    new = dict(before)
    old_stage = PurePosixPath(manifest['transaction']).name
    assert re.fullmatch(r'[a-z0-9-]+', old_stage)
    boot = (S/'video-boot-start.next.sh').read_bytes()
    for old, value in [(b'dns-upgrade-20261024', stage.encode()),
                       (b'UNSTAGED_PROC_SCAN_STAGE', stage.encode()),
                       (b'UNSTAGED_PROC_SCAN_SHA256', sha(helper).encode())]:
        assert boot.count(old) == 1
        boot = boot.replace(old, value)
    new['video-boot-start.sh'] = new[R+'video-boot-start.next.sh'] = boot
    worker = (S/'workerctl.sh').read_bytes()
    for old, value in [(b'UNSTAGED_PROC_SCAN_STAGE', stage.encode()),
                       (b'UNSTAGED_PROC_SCAN_SHA256', sha(helper).encode())]:
        assert worker.count(old) == 1
        worker = worker.replace(old, value)
    new[R+'workerctl.sh'] = worker
    starter = before['video-dns-service-start.sh']
    assert starter.count(old_stage.encode()) == 1
    new['video-dns-service-start.sh'] = starter.replace(old_stage.encode(), stage.encode())
    controls = {R+'release-id', R+'enabled', R+'manifest.json'}
    release = sha(before[R+'release-id']+bytes.fromhex(sha(helper))+b''.join(
        p.encode()+bytes.fromhex(sha(new[p])) for p in sorted(new) if p not in controls))
    new[R+'release-id'] = new[R+'enabled'] = (release+'\n').encode()
    manifest = json.loads(json.dumps(manifest))
    manifest.update(release_id=release, previous_release_id=before[R+'release-id'].decode().strip(),
                    amendment='Native read-only process scans; original locking, DNS and rollback gates retained',
                    transaction=D+'/'+stage, stage_dependency_sha256=sha(helper))
    for p, data in new.items():
        if p.startswith(R) and p != R+'manifest.json': manifest['files'][p[len(R):]] = sha(data)
    manifest.setdefault('boot_assets', {})['video-boot-start.sh'] = sha(boot)
    new[R+'manifest.json'] = encoded(manifest)
    return new


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--stage-name', required=True)
    parser.add_argument('--helper', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--wire-next-boot', action='store_true')
    args = parser.parse_args()
    assert re.fullmatch(r'boot-fast-[0-9]{8}(?:-[a-z0-9]+)?', args.stage_name)
    device = Device(args.serial)
    p = D+'/'+args.stage_name
    baseline = device.snapshot()
    before = {name:device.read(D+'/'+name) for name in PATHS}
    for name in PATHS:
        assert device.run('/data/adb/magisk/busybox stat -c %a '+D+'/'+name).decode().strip() == ('700' if name.endswith('.sh') else '600')
    manifest = json.loads(before[R+'manifest.json'])
    assert manifest['release_id'] == before[R+'release-id'].decode().strip()
    assert before[R+'enabled'] == before[R+'release-id']
    assert before['config.json'] == before[R+'main-config.json']
    assert sha(before['config.json']) == before[R+'active-main.sha256'].decode().strip()
    for name, digest in manifest['files'].items():
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        assert sha(device.read(D+'/'+R+name)) == digest, 'live manifest drift: '+name
    old_txn = manifest['transaction']
    assert old_txn.startswith(D+'/') and re.fullmatch(r'[a-z0-9-]+', old_txn[len(D)+1:])
    assert 'verified_read_only' in device.run('sh '+old_txn+'/dns-upgrade-apply.sh --verify').decode()
    old_hook, old_assets = device.read(HOOK), device.read(ASSETS)
    assets = json.loads(old_assets)
    for path, digest in assets['files'].items(): assert sha(device.read(path)) == digest
    helper = args.helper.read_bytes()
    assert helper[:4] == b'\x7fELF'
    new = payload(before, manifest, args.stage_name, helper)
    engine = (S/'dns-upgrade-apply.sh').read_bytes()
    assert engine.count(b'UNSTAGED_PROC_SCAN_SHA256') == 1
    engine = engine.replace(b'UNSTAGED_PROC_SCAN_SHA256', sha(helper).encode())
    # The immutable outer entry is outside the rollback group. A rollback
    # leaves it pointing at this transaction, whose rolled-back state is stable;
    # it then executes the restored old boot script. No stale stage can reapply.
    starter, hook = wiring(new['video-dns-service-start.sh'], old_hook, args.stage_name, PurePosixPath(old_txn).name)
    device.run('test ! -e '+p+' && mkdir -m 700 '+p)
    rows = []
    for name in PATHS:
        mode = '700' if name.endswith('.sh') else '600'
        device.write(p+'/backup/'+name, before[name], mode)
        device.write(p+'/payload/'+name, new[name], mode)
        rows.append('\t'.join((name, sha(before[name]), sha(new[name]), mode)))
    device.write(p+'/transaction.tsv', ('\n'.join(rows)+'\n').encode())
    device.write(p+'/transaction-profile', b'rack-dualstack-v2\n')
    device.write(p+'/installed-boot-id', (baseline['boot']+'\n').encode())
    dependencies = {'video-proc-scan':helper, 'dns-upgrade-apply.sh':engine, 'service-start-entry.sh':starter}
    for name, content in dependencies.items():
        device.write(p+'/'+name, content, '700')
        assert device.run('/data/adb/magisk/busybox stat -c %a '+p+'/'+name).decode().strip() == '700'
    dependency_manifest = {name:{'sha256':sha(data),'mode':'700'} for name,data in dependencies.items()}
    device.write(p+'/dependency-manifest.json', encoded(dependency_manifest))
    device.write(p+'/external-backup/video-proxy.sh', old_hook, '700')
    device.write(p+'/external-backup/boot-assets-current.json', old_assets)
    device.write(p+'/next-boot-hook.sh', hook, '700')
    device.write(p+'/external-assets-before.json', encoded({name:sha(device.read(name)) for name in
        (HOOK, D+'/video-dns-guard.sh', '/data/adb/post-fs-data.d/video-dns-guard.sh')}))
    for name in PATHS:
        if name.endswith('.sh'): device.run('sh -n '+p+'/payload/'+name)
    for name in ('dns-upgrade-apply.sh','service-start-entry.sh','next-boot-hook.sh'): device.run('sh -n '+p+'/'+name)
    for name in ('config.json', R+'workers/rack/config.json'): device.run(D+'/sing-box check -c '+p+'/payload/'+name)
    verification = device.run('sh '+p+'/dns-upgrade-apply.sh --verify').decode().strip()
    assert 'verified_read_only' in verification
    deferred = device.run('sh '+p+'/dns-upgrade-apply.sh --apply').decode().strip()
    assert 'deferred_same_boot' in deferred
    assert 'deferred until next boot' in device.run('sh '+p+'/service-start-entry.sh').decode()
    assert 'deferred until next boot' in device.run('sh '+p+'/next-boot-hook.sh').decode()
    for name,data in before.items(): assert device.read(D+'/'+name) == data
    assert device.read(HOOK) == old_hook and device.read(ASSETS) == old_assets
    after = device.snapshot()
    assert baseline['boot'] == after['boot'] and baseline['processes'] == after['processes']
    if args.wire_next_boot:
        assets['files'][HOOK] = sha(hook)
        assets.update(amendment='Pinned native process scanner; next-boot stage entry',
                      stage=p, dependency_manifest=p+'/dependency-manifest.json',
                      verification='Staged and same-boot deferred; restart acceptance pending')
        assets.pop('source_commit', None)
        staged_assets = encoded(assets)
        device.write(p+'/boot-assets-next.json', staged_assets)
        # Recheck immediately before the small external atomic replacements.
        assert device.read(HOOK) == old_hook and device.read(ASSETS) == old_assets
        device.run('cp '+p+'/next-boot-hook.sh '+HOOK+'.boot-fast-new && chmod 700 '+HOOK+'.boot-fast-new && mv '+HOOK+'.boot-fast-new '+HOOK)
        assert device.read(HOOK) == hook
        device.run('cp '+p+'/boot-assets-next.json '+ASSETS+'.boot-fast-new && chmod 600 '+ASSETS+'.boot-fast-new && mv '+ASSETS+'.boot-fast-new '+ASSETS)
        assert device.read(ASSETS) == staged_assets
        assert 'deferred until next boot' in device.run('sh '+HOOK).decode()
    result = dict(stage=p, release=json.loads(new[R+'manifest.json'])['release_id'],
                  files=len(PATHS), helper_sha=sha(helper), config_unchanged=new['config.json']==before['config.json'],
                  dependencies=dependency_manifest, transaction_verify=verification, same_boot_apply=deferred,
                  before=baseline, after=device.snapshot(), next_boot_wired=args.wire_next_boot)
    assert result['after']['processes'] == baseline['processes'] and result['after']['boot'] == baseline['boot']
    args.evidence.write_bytes(encoded(result)); args.evidence.chmod(0o600)
    print(json.dumps({key:result[key] for key in ('stage','release','files','helper_sha','config_unchanged','next_boot_wired')}))


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print('stage refused; '+type(exc).__name__+'; sensitive details suppressed')
        raise SystemExit(1)
