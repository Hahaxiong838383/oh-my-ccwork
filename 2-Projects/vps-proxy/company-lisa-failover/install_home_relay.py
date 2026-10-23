#!/usr/bin/env python3
"""Create an independent home relay. Must run via authenticated root; no main-service reload."""
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
from build_config import relay_config

ROOT=Path('/usr/local/etc/xray-company-relay')
UNIT=Path('/etc/systemd/system/xray-company-relay.service')
HOME=Path('/home/hahaxiong83')
BIND='10.10.10.23'
SOURCE={'studio':'10.10.10.12','mini':'10.10.10.11','dev198':'10.10.10.13'}


def run(args, **kwargs):
    r=subprocess.run(args,capture_output=True,text=True,timeout=20,**kwargs)
    if r.returncode: raise RuntimeError('command_failed_'+Path(args[0]).name)
    return r.stdout


def main():
    if os.geteuid()!=0: raise RuntimeError('root_required')
    if ROOT.exists() or UNIT.exists(): raise RuntimeError('existing_installation_refuse_overwrite')
    with socket.socket() as s: s.bind((BIND,10810))
    base=json.loads(Path('/usr/local/etc/xray/config.json').read_text())
    node=next(n for n in base['outbounds'] if n['tag']=='新美宅-Claude-GPT')
    # A narrow, verified fixed DMIT v6 route; refuse historical tag drift.
    dest=node['settings']['vnext'][0]
    if dest['address']!='2605:52c0:2:c1a:e896:25ff:fe53:fea7' or dest['port']!=7443:
        raise RuntimeError('home_primary_endpoint_changed')
    # Canonical credentials are generated in the administrator's existing secret store.
    accounts=json.load(sys.stdin)
    if {a.get('user') for a in accounts} != set(SOURCE) or len(accounts)!=3:
        raise RuntimeError('invalid_account_inventory')
    if any(len(a.get('pass',''))<32 for a in accounts):
        raise RuntimeError('invalid_account_secret')
    config=relay_config(node,accounts,BIND,list(SOURCE.values()))
    account=pwd.getpwnam('xray')
    ROOT.mkdir(mode=0o750)  # exclusive ownership gate, outside cleanup transaction
    unit_created=False
    try:
        os.chown(ROOT,0,account.pw_gid)
        p=ROOT/'config.json'
        fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
        with os.fdopen(fd,'w') as f:json.dump(config,f,ensure_ascii=False,indent=2);f.write('\n')
        os.chown(p,0,account.pw_gid)
        env={**os.environ,'XRAY_LOCATION_ASSET':'/usr/local/share/xray'}
        run(['/usr/local/bin/xray','run','-test','-c',str(p)],env=env)
        unit_text='''[Unit]
Description=Company private fixed DMIT Lisa relay (independent)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
User=xray
Group=xray
Environment=XRAY_LOCATION_ASSET=/usr/local/share/xray
ExecStart=/usr/local/bin/xray run -c /usr/local/etc/xray-company-relay/config.json
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
'''
        with UNIT.open('x') as f:f.write(unit_text)
        unit_created=True;os.chmod(UNIT,0o644)
        run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','xray-company-relay.service'])
        run(['systemctl','is-active','xray-company-relay.service'])
        print(json.dumps({'installed':True,'service':'xray-company-relay.service','bind':BIND+':10810',
                          'fixed_route':'home DMIT IPv6 7443 -> Lisa','main_xray_restarted':False}))
    except BaseException:
        if unit_created:
            subprocess.run(['systemctl','disable','--now','xray-company-relay.service'],capture_output=True)
            if UNIT.exists():UNIT.unlink()
        if (ROOT/'config.json').exists():(ROOT/'config.json').unlink()
        if ROOT.exists():ROOT.rmdir()
        subprocess.run(['systemctl','daemon-reload'],capture_output=True)
        raise

if __name__=='__main__':main()
