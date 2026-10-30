#!/usr/bin/env python3
"""Stage a live-release amendment with a complete 15-file rollback group.

No process stop, selector PUT, hook installation or activation. Secret payloads
exist only in memory and in root-only device backup/payload directories.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import urllib.request

from amend_rack_dualstack import amend

S = Path(__file__).resolve().parent
D = '/data/adb/video-proxy'
R = 'youtube-failover/'
PATHS = ['config.json', 'video-boot-start.sh'] + [R+p for p in (
    'main-config.json', 'active-main.sha256', 'release-id', 'enabled', 'manifest.json',
    'service.sh', 'video-boot-start.next.sh', 'guard.dex', 'guard-config.json',
    'guard-observe.json', 'workers/rack/config.json', 'workers/rack/config.sha256')]
PATHS += ['video-dns-service-start.sh']


def sha(data): return hashlib.sha256(data).hexdigest()
def encoded(value): return (json.dumps(value, indent=2) + '\n').encode()


class Device:
    def __init__(self, serial): self.adb = ['adb', '-s', serial]
    def run(self, command, data=None, timeout=30):
        r = subprocess.run(self.adb+['shell', '/system/xbin/su 0 sh -c '+shlex.quote(command)],
                           input=data, capture_output=True, timeout=timeout)
        if r.returncode: raise RuntimeError('device command failed; output suppressed')
        return r.stdout
    def read(self, path): return self.run('cat '+shlex.quote(path))
    def write(self, path, data, mode='600'):
        self.run('umask 077; mkdir -p '+shlex.quote(str(PurePosixPath(path).parent))+
                 ' && test ! -e '+shlex.quote(path)+' && cat > '+shlex.quote(path)+
                 ' && chmod '+mode+' '+shlex.quote(path), data)
        assert self.read(path) == data, 'device write readback mismatch'
    def selections(self, secret):
        local = subprocess.check_output(self.adb+['forward', 'tcp:0', 'tcp:19090'], timeout=10).decode().strip()
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            result = {}
            for tag in ('youtube-video','dns-uplink','zgo-video'):
                req=urllib.request.Request('http://127.0.0.1:'+local+'/proxies/'+tag,headers={'Authorization':'Bearer '+secret})
                with op.open(req,timeout=10) as response: result[tag]=json.load(response)['now']
            return result
        finally: subprocess.run(self.adb+['forward','--remove','tcp:'+local],check=True,capture_output=True,timeout=10)
    def snapshot(self):
        fg=self.run('dumpsys activity activities | grep mResumedActivity').decode().strip()
        codec=self.run('cat /sys/class/vdec/vdec_status').decode()
        decoders=[]
        for block in re.split(r'vdec channel \d+ statistics:',codec)[1:]:
            decoders.append({key:int(m.group(1)) for key in ('frame width','frame height','frame count','drop count','fra err count','hw err count')
                             if (m:=re.search(re.escape(key)+r'\s*:\s*(\d+)',block))})
        processes={}
        for line in self.run('ps -A -o PID,ARGS').decode().splitlines():
            if re.match(r'^\s*\d+ (sing-box run -c /data/adb/video-proxy/|app_process /system/bin YoutubeFailover )',line):
                pid,argv=line.strip().split(None,1)
                ticks=self.read('/proc/'+pid+'/stat').decode().rsplit(')',1)[1].split()[19]
                processes[argv]={'pid':int(pid),'startticks':ticks}
        return {'boot':self.read('/proc/sys/kernel/random/boot_id').decode().strip(),
                'foreground':fg,'decoders':decoders,'processes':processes}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('serial','old-ipv4','ipv4','ipv6','sni','stage-name'): p.add_argument('--'+name,required=True)
    p.add_argument('--port',type=int,required=True)
    p.add_argument('--dex',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True)
    a=p.parse_args()
    assert re.fullmatch(r'rack-dualstack-[0-9]{8}(?:-[a-z0-9]+)?',a.stage_name)
    device=Device(a.serial);P=D+'/'+a.stage_name
    baseline=device.snapshot()
    before={path:device.read(D+'/'+path) for path in PATHS}
    for path in PATHS:
        expected='700' if path.endswith('.sh') else '600'
        assert device.run('/data/adb/magisk/busybox stat -c %a '+D+'/'+path).decode().strip()==expected, 'live mode drift: '+path
    old_release=before[R+'release-id'].decode().strip()
    assert before[R+'enabled']==before[R+'release-id']
    assert before['config.json']==before[R+'main-config.json']
    assert before[R+'active-main.sha256'].decode().strip()==sha(before['config.json'])
    manifest=json.loads(before[R+'manifest.json'])
    assert manifest['release_id']==old_release
    for name,expected in manifest['files'].items():
        path=PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        assert sha(device.read(D+'/'+R+name))==expected,'live manifest drift: '+name
    boot_assets=json.loads(device.read(D+'/boot-assets-current.json'))
    # Preserve and record external early-boot fixes; no stage copy replaces them.
    external={n:sha(device.read(n)) for n in (D+'/video-dns-guard.sh','/data/adb/post-fs-data.d/video-dns-guard.sh','/data/adb/service.d/video-proxy.sh')}
    for name,expected in boot_assets['files'].items():
        assert name in external and external[name]==expected, 'external boot asset drift'
    assert 'verified_read_only' in device.run('sh '+D+'/dns-upgrade-20261024/dns-upgrade-apply.sh --verify').decode()
    main_config=json.loads(before['config.json'])
    selected=device.selections(main_config['experimental']['clash_api']['secret'])
    configs=amend(main_config,json.loads(before[R+'workers/rack/config.json']),
                  json.loads(before[R+'guard-config.json']),json.loads(before[R+'guard-observe.json']),
                  old_ipv4=a.old_ipv4,ipv4=a.ipv4,ipv6=a.ipv6,port=a.port,sni=a.sni,
                  selected_video=selected['youtube-video'],selected_dns=selected['dns-uplink'])
    new=dict(before)
    for path,value in zip(('config.json',R+'workers/rack/config.json',R+'guard-config.json',R+'guard-observe.json'),configs):new[path]=encoded(value)
    new[R+'main-config.json']=new['config.json']
    new[R+'active-main.sha256']=(sha(new['config.json'])+'\n').encode()
    new[R+'workers/rack/config.sha256']=(sha(new[R+'workers/rack/config.json'])+'\n').encode()
    new[R+'guard.dex']=a.dex.read_bytes()
    for path in ('video-boot-start.sh',R+'video-boot-start.next.sh','video-dns-service-start.sh'):
        assert before[path].count(b'dns-upgrade-20261024')==1
        new[path]=before[path].replace(b'dns-upgrade-20261024',a.stage_name.encode())
    assert new['video-boot-start.sh']==new[R+'video-boot-start.next.sh']
    controls=(R+'release-id',R+'enabled',R+'manifest.json')
    release=sha(old_release.encode()+b''.join(path.encode()+bytes.fromhex(sha(new[path])) for path in sorted(new) if path not in controls))
    new[R+'release-id']=new[R+'enabled']=(release+'\n').encode()
    manifest.update(release_id=release,previous_release_id=old_release,
                    amendment='RackNerd migrated IPv4 and explicit IPv6 Reality video/DNS fallback; 15-file transaction',
                    transaction=P,source_guard_sha=sha((S/'YoutubeFailover.java').read_bytes()),
                    initial_selections=selected)
    for path,data in new.items():
        if path.startswith(R) and path!=R+'manifest.json':manifest['files'][path[len(R):]]=sha(data)
    manifest.setdefault('boot_assets',{})['video-boot-start.sh']=sha(new['video-boot-start.sh'])
    new[R+'manifest.json']=encoded(manifest)
    device.run('test ! -e '+P+' && mkdir -m 700 '+P)
    rows=[]
    for path in PATHS:
        mode='700' if path.endswith('.sh') else '600'
        device.write(P+'/backup/'+path,before[path],mode)
        device.write(P+'/payload/'+path,new[path],mode)
        rows.append('\t'.join((path,sha(before[path]),sha(new[path]),mode)))
    device.write(P+'/transaction.tsv',('\n'.join(rows)+'\n').encode())
    device.write(P+'/transaction-profile',b'rack-dualstack-v1\n')
    device.write(P+'/installed-boot-id',(baseline['boot']+'\n').encode())
    device.write(P+'/dns-upgrade-apply.sh',(S/'dns-upgrade-apply.sh').read_bytes(),'700')
    device.write(P+'/external-assets-before.json',encoded(external))
    device.write(P+'/initial-selections.tsv', ''.join(k+'\t'+v+'\n' for k,v in selected.items()).encode())
    for path in ('config.json',R+'workers/rack/config.json'):
        device.run(D+'/sing-box check -c '+P+'/payload/'+path)
    for path in PATHS:
        if path.endswith('.sh'):device.run('sh -n '+P+'/payload/'+path)
    verification=device.run('sh '+P+'/dns-upgrade-apply.sh --verify').decode().strip()
    assert 'verified_read_only' in verification
    deferred=device.run('sh '+P+'/dns-upgrade-apply.sh --apply').decode().strip()
    assert 'deferred_same_boot' in deferred
    dex_check=json.loads(device.run('CLASSPATH='+P+'/payload/'+R+'guard.dex app_process /system/bin YoutubeFailover --check-config '+P+'/payload/'+R+'guard-observe.json'))
    assert dex_check['candidate_count']==5 and dex_check['dns_candidate_count']==3 and dex_check['dry_run'] and not dex_check['authorized']
    for path,data in before.items():assert device.read(D+'/'+path)==data,'live drift during stage: '+path
    after=device.snapshot()
    assert baseline['boot']==after['boot'] and baseline['processes']==after['processes']
    for path,digest in external.items():assert sha(device.read(path))==digest
    result={'stage':P,'old_release':old_release,'new_release':release,'files':len(PATHS),
            'config_sha':sha(new['config.json']),'guard_source_sha':sha((S/'YoutubeFailover.java').read_bytes()),
            'guard_dex_sha':sha(new[R+'guard.dex']),'transaction_verify':verification,
            'same_boot_apply':deferred,'dex_check':dex_check,'before':baseline,'after':after,
            'external_assets':external,'boot_assets_record_preserved':boot_assets,
            'status':'staged only; no hooks changed, no activation'}
    a.evidence.write_bytes(encoded(result));a.evidence.chmod(0o600)
    print(json.dumps({k:result[k] for k in ('stage','new_release','files','config_sha','transaction_verify','same_boot_apply','dex_check','status')}))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print('stage refused; exception type='+type(exc).__name__+'; sensitive details suppressed')
        raise SystemExit(1)
