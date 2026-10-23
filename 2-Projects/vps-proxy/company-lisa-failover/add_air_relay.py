#!/usr/bin/env python3
"""Independent Air-only relay; does not reload the Studio/company relay."""
import copy,hashlib,json,os,pathlib,pwd,socket,subprocess,sys
ROOT=pathlib.Path('/usr/local/etc/xray-air-relay')
UNIT=pathlib.Path('/etc/systemd/system/xray-air-relay.service')
BASE=pathlib.Path('/usr/local/etc/xray-company-relay/config.json')

def command(args):
    r=subprocess.run(args,capture_output=True,text=True,timeout=20)
    if r.returncode:raise RuntimeError('command_failed_'+pathlib.Path(args[0]).name)
    return r.stdout

def main():
    assert os.geteuid()==0
    x=json.load(sys.stdin)
    assert x['source']=='10.10.10.31' and x['user']=='air' and len(x['password'])>=32
    if ROOT.exists() or UNIT.exists():raise RuntimeError('existing_air_relay_stop')
    with socket.socket() as s:s.bind(('127.0.0.1',10811))
    original=BASE.read_bytes();c=json.loads(original)
    assert len(c['inbounds'])==1 and c['inbounds'][0]['listen']=='10.10.10.23'
    c['inbounds'][0]['port']=10811
    c['inbounds'][0]['listen']='127.0.0.1'
    c['inbounds'][0]['settings']['accounts']=[{'user':'air','pass':x['password']}]
    found=0
    for rule in c['routing']['rules']:
        if 'source' in rule:rule['source']=['127.0.0.1'];found+=1
    assert found==1
    u=pwd.getpwnam('xray');ROOT.mkdir(mode=0o750);made_unit=False
    try:
        os.chown(ROOT,0,u.pw_gid)
        p=ROOT/'config.json';fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o640)
        with os.fdopen(fd,'w') as f:json.dump(c,f,ensure_ascii=False,indent=2)
        os.chown(p,0,u.pw_gid)
        env={**os.environ,'XRAY_LOCATION_ASSET':'/usr/local/share/xray'}
        r=subprocess.run(['/usr/local/bin/xray','run','-test','-c',str(p)],env=env,capture_output=True,text=True,timeout=10)
        if r.returncode:raise RuntimeError('air_relay_config_invalid')
        unit='''[Unit]
Description=Air private fixed DMIT Lisa relay
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
User=xray
Group=xray
Environment=XRAY_LOCATION_ASSET=/usr/local/share/xray
ExecStart=/usr/local/bin/xray run -c /usr/local/etc/xray-air-relay/config.json
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
        with UNIT.open('x') as f:f.write(unit)
        made_unit=True;os.chmod(UNIT,0o644)
        command(['systemctl','daemon-reload']);command(['systemctl','enable','--now','xray-air-relay.service'])
        command(['systemctl','is-active','xray-air-relay.service'])
        assert BASE.read_bytes()==original
        print(json.dumps({'air_relay_installed':True,'bind':'127.0.0.1:10811','source':'authenticated Air SSH tunnel','company_relay_config_unchanged':True}))
    except BaseException:
        if made_unit:
            subprocess.run(['systemctl','disable','--now','xray-air-relay.service'],capture_output=True)
            UNIT.unlink()
        if (ROOT/'config.json').exists():(ROOT/'config.json').unlink()
        ROOT.rmdir();subprocess.run(['systemctl','daemon-reload'],capture_output=True)
        raise
if __name__=='__main__':main()
