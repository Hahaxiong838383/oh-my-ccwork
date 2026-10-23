#!/usr/bin/env python3
"""Stage only; secret node objects arrive via stdin and never enter argv/output."""
import hashlib,json,os,pathlib,subprocess,sys,tempfile

def sha(b):return hashlib.sha256(b).hexdigest()

def main():
    payload=json.load(sys.stdin);home=pathlib.Path.home()
    assert home==pathlib.Path('/Users/fu-121')
    expected={'build_config.py','controller.py','install_studio.py','rollback_studio.py'}
    if set(payload['files'])!=expected:raise RuntimeError('invalid_file_inventory')
    stage=pathlib.Path(tempfile.mkdtemp(prefix='company-lisa-stage-',dir=home/'xray'));os.chmod(stage,0o700)
    for name,text in payload['files'].items():(stage/name).write_text(text);os.chmod(stage/name,0o600)
    sys.path.insert(0,str(stage))
    from build_config import client_config,controller_config
    original=(home/'xray/config.json').read_bytes();base=json.loads(original)
    old=next(n for n in base['outbounds'] if n['tag']=='admin-LISA-DMIT-11443')
    if old!=payload['nodes']['dmit']:raise RuntimeError('DMIT_source_mismatch')
    c,count=client_config(base,payload['nodes'],{'admin-LISA-DMIT-11443'})
    candidate=(json.dumps(c,ensure_ascii=False,indent=2)+'\n').encode()
    (stage/'candidate.json').write_bytes(candidate);os.chmod(stage/'candidate.json',0o600)
    controller=controller_config(str(home/'xray/xray'),str(home/'xray/company-lisa-failover'))
    controller['guard_config_path']=str(home/'xray/config.json')
    controller['guard_config_sha256']=sha(candidate)
    (stage/'controller.json').write_text(json.dumps(controller,indent=2)+'\n');os.chmod(stage/'controller.json',0o600)
    r=subprocess.run([str(home/'xray/xray'),'run','-test','-c',str(stage/'candidate.json')],capture_output=True,text=True)
    if r.returncode:raise RuntimeError('config_validation_failed')
    manifest={'baseline_sha256':sha(original),'candidate_sha256':sha(candidate),'replaced_rules':count,
              'code_sha256':{n:sha((stage/n).read_bytes()) for n in ['controller.py','controller.json','rollback_studio.py']}}
    (stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(stage/'manifest.json',0o600)
    print(json.dumps({'stage':str(stage),'config_valid':True,'production_changed':False,**manifest}))

if __name__=='__main__':main()
