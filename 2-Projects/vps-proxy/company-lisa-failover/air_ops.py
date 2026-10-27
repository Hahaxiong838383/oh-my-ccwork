#!/usr/bin/env python3
"""Air user-launchd prepare/apply/rollback. Apply is an explicitly authorized interruption."""
import argparse,hashlib,json,os,pathlib,plistlib,shlex,socket,subprocess,tempfile,time
HOME=pathlib.Path.home()
CONFIG=HOME/'xray/config.json'
RUNTIME=HOME/'xray/company-lisa-failover'
PLIST=HOME/'Library/LaunchAgents/com.company.lisa-failover.plist'
DOMAIN='gui/'+str(os.getuid())
LABEL=DOMAIN+'/com.company.lisa-failover'
XRAY=DOMAIN+'/com.xray.proxy'
TUNNEL=DOMAIN+'/com.company.lisa-home-tunnel'
TUNNEL_PLIST=HOME/'Library/LaunchAgents/com.company.lisa-home-tunnel.plist'
SSH_ARGS=['/usr/bin/ssh','-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','ConnectTimeout=8','-o','ControlMaster=no','-o','ControlPath=none','-L','127.0.0.1:10832:127.0.0.1:10811','home-studio-mesh']

def sha(data):return hashlib.sha256(data).hexdigest()

def run(cmd,timeout=15):
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    if r.returncode:raise RuntimeError('command_failed_'+pathlib.Path(cmd[0]).name)
    return r.stdout

def write(path,data,mode=0o600):
    fd,tmp=tempfile.mkstemp(prefix='.pending-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),mode);f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def prepare():
    from build_config import client_config,controller_config
    from controller import canonical_config_sha256
    if RUNTIME.exists() or PLIST.exists() or TUNNEL_PLIST.exists():raise RuntimeError('already_installed')
    raw=CONFIG.read_bytes();base=json.loads(raw);nodes={}
    for n,t in [('dmit','admin-LISA-DMIT-11443'),('zgo','admin-LISA-ZGO-12443')]:
        nodes[n]=next(x for x in base['outbounds'] if x['tag']==t)
    secret=next(shlex.split(l.split('=',1)[1])[0] for l in (HOME/'.mycc-secrets.env').read_text().splitlines() if l.startswith('COMPANY_RELAY_AIR_PASS='))
    nodes['home']={'protocol':'socks','settings':{'servers':[{'address':'127.0.0.1','port':10832,'users':[{'user':'air','pass':secret}]}]}}
    candidate,count=client_config(base,nodes,{'admin-LISA-DMIT-11443'})
    stage=pathlib.Path(tempfile.mkdtemp(prefix='company-lisa-air-stage-',dir=HOME/'xray'));os.chmod(stage,0o700)
    data=(json.dumps(candidate,ensure_ascii=False,indent=2)+'\n').encode();write(stage/'candidate.json',data)
    cfg=controller_config(str(HOME/'xray/xray'),str(RUNTIME));cfg.update(guard_config_path=str(CONFIG),guard_config_sha256=sha(data),
        guard_config_semantic_sha256=canonical_config_sha256(data))
    write(stage/'controller.json',json.dumps(cfg,indent=2).encode())
    for name in ['controller.py','air_ops.py']:write(stage/name,pathlib.Path(__file__).with_name(name).read_bytes())
    manifest={'baseline_sha256':sha(raw),'candidate_sha256':sha(data),'replaced_rules':count,
        'code_sha256':{n:sha((stage/n).read_bytes()) for n in ['controller.py','controller.json','air_ops.py']}}
    write(stage/'manifest.json',json.dumps(manifest,indent=2).encode())
    run([str(HOME/'xray/xray'),'run','-test','-c',str(stage/'candidate.json')])
    print(json.dumps({'stage':str(stage),'config_valid':True,'replaced_rules':count}))

def apply(stage):
    if RUNTIME.exists() or PLIST.exists() or TUNNEL_PLIST.exists():raise RuntimeError('existing_install_stop')
    m=json.loads((stage/'manifest.json').read_text());old=CONFIG.read_bytes();new=(stage/'candidate.json').read_bytes()
    if sha(old)!=m['baseline_sha256'] or sha(new)!=m['candidate_sha256']:raise RuntimeError('config_drift_stop')
    if set(m['code_sha256'])!={'controller.py','controller.json','air_ops.py'}:raise RuntimeError('manifest_inventory')
    files={n:(stage/n).read_bytes() for n in m['code_sha256']}
    if any(sha(v)!=m['code_sha256'][n] for n,v in files.items()):raise RuntimeError('code_drift_stop')
    for port in [14991,10828,10829,10830,10832]:
        with socket.socket() as s:s.bind(('127.0.0.1',port))
    run([str(HOME/'xray/xray'),'run','-test','-c',str(stage/'candidate.json')])
    if (stage/'candidate.json').read_bytes()!=new:raise RuntimeError('stage_changed')
    RUNTIME.mkdir(mode=0o700);write(RUNTIME/'backup-config.json',old)
    for n,v in files.items():write(RUNTIME/n,v)
    m['installed_at']=time.time();write(RUNTIME/'manifest.json',json.dumps(m,indent=2).encode())
    plist={'Label':'com.company.lisa-failover','ProgramArguments':['/usr/bin/python3','-B',str(RUNTIME/'controller.py'),'--config',str(RUNTIME/'controller.json')],
        'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'WorkingDirectory':str(RUNTIME),
        'StandardOutPath':str(RUNTIME/'service.log'),'StandardErrorPath':str(RUNTIME/'service.log')}
    changed=False;started=False;tunnel_started=False
    try:
        tunnel={'Label':'com.company.lisa-home-tunnel','ProgramArguments':SSH_ARGS,'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'StandardOutPath':str(RUNTIME/'tunnel.log'),'StandardErrorPath':str(RUNTIME/'tunnel.log')}
        write(TUNNEL_PLIST,plistlib.dumps(tunnel))
        run(['launchctl','bootstrap',DOMAIN,str(TUNNEL_PLIST)]);tunnel_started=True
        for attempt in range(20):
            try:
                with socket.create_connection(('127.0.0.1',10832),2) as sock:
                    sock.sendall(b'\x05\x01\x00')
                    if sock.recv(2)==b'\x05\xff':break
            except OSError:pass
            time.sleep(.5)
        else:raise RuntimeError('home_tunnel_not_ready')
        if CONFIG.read_bytes()!=old:raise RuntimeError('concurrent_change_abort')
        write(PLIST,plistlib.dumps(plist));write(CONFIG,new);changed=True
        run(['launchctl','kickstart','-k',XRAY]);run(['launchctl','bootstrap',DOMAIN,str(PLIST)]);started=True
        for i in range(35):
            time.sleep(1)
            try:
                s=json.loads((RUNTIME/'state.json').read_text())
                if s.get('status')=='OK' and s.get('selected') in ['dmit','zgo','home']:break
            except FileNotFoundError:pass
        else:raise RuntimeError('no_healthy_route')
        success=0;receipts=[]
        for i in range(3):
            r=subprocess.run(['/usr/bin/curl','-q','--proxy','http://127.0.0.1:10808','--noproxy','','--silent','--output','/dev/null','--write-out','%{http_code}',
                '--connect-timeout','4','--max-time','7','https://chatgpt.com/backend-api/codex/models?client_version=0.160.1'],capture_output=True,text=True,timeout=9)
            receipts.append({'exit':r.returncode,'http':r.stdout.strip()[:3]})
            success+=int(r.returncode==0 and r.stdout.strip() in ['200','401'])
        write(RUNTIME/'entry-probes.json',json.dumps(receipts).encode())
        if success<2:raise RuntimeError('main_entry_acceptance_failed')
        print(json.dumps({'installed':True,'selected':s['selected'],'main_http_proxy_successes':success,'backup':str(RUNTIME/'backup-config.json')}))
    except BaseException:
        if changed and CONFIG.read_bytes()!=new:raise RuntimeError('rollback_conflict_stop')
        if started:run(['launchctl','bootout',LABEL])
        if changed:
            if CONFIG.read_bytes()!=new:
                if started:run(['launchctl','bootstrap',DOMAIN,str(PLIST)])
                raise RuntimeError('rollback_conflict_stop')
            write(CONFIG,old);run(['launchctl','kickstart','-k',XRAY])
        if PLIST.exists():PLIST.unlink()
        if tunnel_started:run(['launchctl','bootout',TUNNEL])
        if TUNNEL_PLIST.exists():TUNNEL_PLIST.unlink()
        print('ROLLED_BACK' if changed else 'NOT_APPLIED');raise

def loaded(label):
    r=subprocess.run(['launchctl','print',label],capture_output=True,text=True,timeout=15)
    if r.returncode==0:return True
    if r.returncode==113:return False
    raise RuntimeError('launchctl_status_unknown')

def rollback():
    m=json.loads((RUNTIME/'manifest.json').read_text());current=CONFIG.read_bytes();old=(RUNTIME/'backup-config.json').read_bytes()
    # Allow retry after config restoration when kickstart or service cleanup failed.
    if sha(current) not in [m['candidate_sha256'],m['baseline_sha256']] or sha(old)!=m['baseline_sha256']:
        raise RuntimeError('rollback_drift_stop')
    stopped=loaded(LABEL)
    if stopped:run(['launchctl','bootout',LABEL])
    try:
        if CONFIG.read_bytes()!=current:raise RuntimeError('rollback_config_changed')
        if current!=old:write(CONFIG,old)
    except BaseException:
        if stopped:run(['launchctl','bootstrap',DOMAIN,str(PLIST)])
        raise
    # Keep tunnel and plists until the original Xray restart succeeds.
    run(['launchctl','kickstart','-k',XRAY])
    if loaded(TUNNEL):run(['launchctl','bootout',TUNNEL])
    for p in [PLIST,TUNNEL_PLIST]:
        if p.exists():p.unlink()
    print('ORIGINAL_CONFIG_RESTORED; verify application')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','apply','rollback']);p.add_argument('--stage',type=pathlib.Path)
    a=p.parse_args()
    if a.action=='prepare':prepare()
    elif a.action=='apply':
        if not a.stage:p.error('--stage required')
        apply(a.stage)
    else:rollback()
