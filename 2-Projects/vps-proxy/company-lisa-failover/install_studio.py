#!/usr/bin/env python3
"""Root transactional installer; refuses active Codeg turns and config drift."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

HOME=Path('/Users/fu-121')
CONFIG=HOME/'xray/config.json'
RUNTIME=HOME/'xray/company-lisa-failover'
PLIST=Path('/Library/LaunchDaemons/com.company.lisa-failover.plist')
DB=HOME/'Library/Application Support/Codeg-company-studio/codeg.db'
LABEL='system/com.company.lisa-failover'
XRAY='system/com.xray.proxy.studio'


def digest(data):return hashlib.sha256(data).hexdigest()


def idle():
    db=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True)
    try:active=[r[0] for r in db.execute("SELECT id FROM conversation WHERE status='in_progress'")]
    finally:db.close()
    if active:raise RuntimeError('ACTIVE_CODEG_TURNS_'+','.join(map(str,active)))


def run(args,timeout=15):
    r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if r.returncode:raise RuntimeError('command_failed_'+Path(args[0]).name)
    return r.stdout


def write_owned(path,data,uid,gid,mode=0o600):
    tmp=path.with_name(path.name+'.pending-'+str(os.getpid()))
    fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.chown(tmp,uid,gid);os.replace(tmp,path)
    finally:
        if tmp.exists():tmp.unlink()


def main(stage):
    if os.geteuid()!=0:raise RuntimeError('root_required')
    if RUNTIME.exists() or PLIST.exists():raise RuntimeError('existing_install_refuse_overwrite')
    manifest=json.loads((stage/'manifest.json').read_text())
    original=CONFIG.read_bytes();candidate=(stage/'candidate.json').read_bytes()
    if digest(original)!=manifest['baseline_sha256']:raise RuntimeError('production_config_drift')
    if digest(candidate)!=manifest['candidate_sha256']:raise RuntimeError('staged_config_drift')
    if set(manifest['code_sha256'])!={'controller.py','controller.json','rollback_studio.py'}:raise RuntimeError('invalid_manifest_inventory')
    code_bytes={}
    for name,sha in manifest['code_sha256'].items():
        if name not in ['controller.py','controller.json','rollback_studio.py']:raise RuntimeError('invalid_manifest')
        code_bytes[name]=(stage/name).read_bytes()
        if digest(code_bytes[name])!=sha:raise RuntimeError('staged_code_drift')
    idle()
    for port in [14991,10828,10829,10830]:
        with socket.socket() as s:s.bind(('127.0.0.1',port))
    run([str(HOME/'xray/xray'),'run','-test','-c',str(stage/'candidate.json')])
    if (stage/'candidate.json').read_bytes()!=candidate:raise RuntimeError('staged_config_changed_during_validation')
    user=pwd.getpwnam('fu-121');uid,gid=user.pw_uid,user.pw_gid
    RUNTIME.mkdir(mode=0o700);os.chown(RUNTIME,uid,gid)
    write_owned(RUNTIME/'backup-config.json',original,uid,gid)
    for name in ['controller.py','controller.json','rollback_studio.py']:
        write_owned(RUNTIME/name,code_bytes[name],uid,gid)
    manifest['installed_at']=time.time()
    write_owned(RUNTIME/'manifest.json',json.dumps(manifest).encode(),uid,gid)
    plist={'Label':'com.company.lisa-failover','UserName':'fu-121',
           'ProgramArguments':['/usr/bin/python3','-B',str(RUNTIME/'controller.py'),'--config',str(RUNTIME/'controller.json')],
           'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,
           'WorkingDirectory':str(RUNTIME),'StandardOutPath':str(RUNTIME/'service.log'),
           'StandardErrorPath':str(RUNTIME/'service.log')}
    switched=False;controller_started=False
    try:
        # Final idle/hash gate directly before committing the configuration.
        idle()
        if CONFIG.read_bytes()!=original:raise RuntimeError('production_config_changed_abort')
        write_owned(PLIST,plistlib.dumps(plist),0,0,0o644)
        write_owned(CONFIG,candidate,uid,gid);switched=True
        run(['/bin/launchctl','kickstart','-k',XRAY])
        run(['/bin/launchctl','bootstrap','system',str(PLIST)]);controller_started=True
        for i in range(30):
            time.sleep(1)
            try:
                state=json.loads((RUNTIME/'state.json').read_text())
                if state.get('status')=='OK' and state.get('selected') in ['dmit','zgo','home']:break
            except FileNotFoundError:pass
        else:raise RuntimeError('controller_no_healthy_route')
        accepted=0
        for i in range(3):
            r=subprocess.run(['/usr/bin/curl','-q','--proxy','socks5h://127.0.0.1:10808','--noproxy','',
                  '--silent','--output','/dev/null','--write-out','%{http_code}','--connect-timeout','4','--max-time','6',
                  'https://chatgpt.com/backend-api/codex/models?client_version=0.160.1'],capture_output=True,text=True,timeout=8)
            if r.returncode==0 and r.stdout.strip() in ['200','401']:accepted+=1
        if accepted<2:raise RuntimeError('real_entry_acceptance_failed')
        print(json.dumps({'installed':True,'selected':state['selected'],'actual_entry_successes':accepted,
                          'backup':str(RUNTIME/'backup-config.json'),'codeg_restarted':False}))
    except BaseException:
        if switched and digest(CONFIG.read_bytes())!=digest(candidate):raise RuntimeError('rollback_config_conflict_stop')
        if controller_started:run(['/bin/launchctl','bootout',LABEL])
        if switched:
            if digest(CONFIG.read_bytes())!=digest(candidate):
                if controller_started:
                    run(['/bin/launchctl','bootstrap','system',str(PLIST)])
                raise RuntimeError('rollback_config_conflict_stop')
            write_owned(CONFIG,original,uid,gid)
            run(['/bin/launchctl','kickstart','-k',XRAY])
        if PLIST.exists():PLIST.unlink()
        # Keep protected backup/artifacts for incident review; no blind retry.
        print('INSTALL_ROLLED_BACK' if switched else 'INSTALL_NOT_APPLIED')
        raise

if __name__=='__main__':main(Path(sys.argv[1]))
