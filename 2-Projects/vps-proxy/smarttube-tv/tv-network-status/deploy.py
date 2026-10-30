#!/usr/bin/env python3
"""Install the independent helper without restarting/changing the proxy or foreground."""
import argparse, hashlib, json, pathlib, shlex, subprocess, sys
S=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(S.parent/'youtube-failover'))
from stage_rack_dualstack import Device, encoded, sha

def main():
    p=argparse.ArgumentParser(); p.add_argument('--serial',required=True)
    p.add_argument('--apk',type=pathlib.Path,required=True); p.add_argument('--evidence',type=pathlib.Path,required=True)
    a=p.parse_args(); d=Device(a.serial); root='/data/adb/tv-network-status'; pkg='cn.hahaxiong.tvnetstatus'
    before=d.snapshot()
    base='/data/adb/video-proxy'
    manifest=json.loads(d.read(base+'/youtube-failover/manifest.json'))
    protected=[base+'/youtube-failover/'+n for n in manifest['files']]
    protected += [base+'/config.json',base+'/video-boot-start.sh',base+'/boot-assets-current.json',
                  '/data/adb/service.d/video-proxy.sh','/data/adb/service.d/97-dangbei-clock-refresh.sh']
    hashes={n:sha(d.read(n)) for n in protected}
    files={root+'/'+n:(S/n).read_bytes() for n in ('watch.sh','state.sh')}
    files['/data/adb/service.d/98-tv-network-status.sh']=(S/'98-tv-network-status.sh').read_bytes()
    old_raw=d.run('if [ -f '+root+'/installed.json ]; then cat '+root+'/installed.json; fi')
    old=json.loads(old_raw) if old_raw else None
    if old:
        for name,digest in old['files'].items(): assert sha(d.read(name))==digest,'existing helper drift'
    else:
        for name in files: assert d.run('test ! -e '+shlex.quote(name)+' && echo absent').strip()==b'absent'
    remote='/data/local/tmp/tv-network-status.apk'
    subprocess.run(d.adb+['push',str(a.apk),remote],check=True,capture_output=True)
    try:
        result=d.run('pm install -r --user 0 '+remote,timeout=90).decode()
        assert result.strip()=='Success', 'package install did not succeed'
    finally: d.run('rm -f '+remote)
    d.run('appops set --user 0 '+pkg+' SYSTEM_ALERT_WINDOW allow')
    permission=d.run('appops get --user 0 '+pkg+' SYSTEM_ALERT_WINDOW').decode().strip()
    assert 'SYSTEM_ALERT_WINDOW: allow' in permission
    d.run('mkdir -p '+root+' && chmod 700 '+root)
    for name,data in files.items():
        if old:
            previous=d.read(name)
            backup=root+'/backup-'+sha(previous)[:12]+'-'+pathlib.Path(name).name
            exists=d.run('if [ -f '+shlex.quote(backup)+' ]; then echo yes; fi').strip()
            if exists: assert d.read(backup)==previous
            else: d.write(backup,previous,'700')
        d.write(name+'.new',data,'700'); d.run('mv '+shlex.quote(name+'.new')+' '+shlex.quote(name))
        assert d.read(name)==data
        d.run('/data/adb/magisk/busybox sh -n '+shlex.quote(name))
    installed={'files':{n:sha(v) for n,v in files.items()},'apk_sha256':sha(a.apk.read_bytes()),'package':pkg}
    d.write(root+'/installed.json.new',encoded(installed)); d.run('mv '+root+'/installed.json.new '+root+'/installed.json')
    # Exercise the actual Magisk entry with an empty inherited PATH. Already-ready
    # boots are consumed silently; no Activity or playback action is permitted.
    d.run('PATH=/nonexistent /system/bin/sh /data/adb/service.d/98-tv-network-status.sh')
    after=d.snapshot()
    assert before['boot']==after['boot'] and before['foreground']==after['foreground']
    assert before['processes']==after['processes']
    for n,digest in hashes.items(): assert sha(d.read(n))==digest,'protected proxy/clock file changed'
    result={'installed':installed,'overlay_permission':permission,'before':before,'after':after,
            'protected_file_count':len(hashes),'protected_files_unchanged':True,'rebooted':False}
    a.evidence.write_bytes(encoded(result)); a.evidence.chmod(0o600)
    print(json.dumps({'status':'installed','apk_sha256':installed['apk_sha256'],
                      'foreground_unchanged':True,'proxy_processes_unchanged':True,'protected_files_unchanged':True}))
if __name__=='__main__': main()
