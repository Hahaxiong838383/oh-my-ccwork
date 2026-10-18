#!/usr/bin/env python3
"""Prepare an INACTIVE Android release; never alter live config/boot or start services.
Secrets flow from ADB through memory to a private device directory, never local disk.
"""
import argparse,hashlib,json,pathlib,re,shlex,subprocess,sys
import generate
SOURCE=pathlib.Path(__file__).resolve().parent
LIVE='/data/adb/video-proxy'
RUNTIME=LIVE+'/youtube-failover'

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--serial',required=True);p.add_argument('--stage-dir',required=True)
 p.add_argument('--dex',type=pathlib.Path,required=True);p.add_argument('--evidence',type=pathlib.Path,required=True)
 a=p.parse_args()
 if not re.fullmatch(r'/data/adb/video-proxy/staged-youtube-failover-[A-Za-z0-9_-]+',a.stage_dir):raise ValueError('stage path rejected')
 adb=['adb','-s',a.serial]
 def shell(command):return subprocess.check_output(adb+['shell',command],text=True,timeout=20).strip()
 def read(path):return subprocess.check_output(adb+['exec-out','cat',path],timeout=20)
 def digest(data):return hashlib.sha256(data).hexdigest()
 source=read(LIVE+'/config.json');config=json.loads(source)
 old_boot=read(LIVE+'/video-boot-start.sh');entry=read('/data/adb/service.d/video-proxy.sh')
 def snapshot():
  cmds={'boot':'cat /proc/sys/kernel/random/boot_id','pid':'pidof sing-box','config_sha':'sha256sum '+LIVE+'/config.json','boot_worker_sha':'sha256sum '+LIVE+'/video-boot-start.sh','entry_sha':'sha256sum /data/adb/service.d/video-proxy.sh','rule4':'ip -4 rule','rule6':'ip -6 rule','nat':'iptables -t nat -S','filter6':'ip6tables -S','foreground':'dumpsys activity activities | grep mResumedActivity','codec':'cat /sys/class/vdec/vdec_status'}
  return {key:shell(cmd) for key,cmd in cmds.items()}
 before=snapshot()
 packages=shell('cmd package list packages -U')
 uid_map={}
 for package in ['org.smarttube.beta','com.google.android.youtube.tv']:
  found=re.findall(r'^package:'+re.escape(package)+r' uid:(\d+)$',packages,re.M)
  if len(found)!=1:raise ValueError('package identity not unique')
  uid_map[package]=int(found[0])
 artifacts={name:(SOURCE/name).read_bytes() for name in ['workerctl.sh','worker-safe-check.sh','service.sh','guard-run.sh','video-boot-start.next.sh']}
 artifacts['guard.dex']=a.dex.read_bytes()
 # Include generated policy/config bytes: changing only the generator must
 # produce a new release identity even when the binary/scripts are unchanged.
 generated=generate.assemble(config,uid_map,RUNTIME,artifacts)
 release=digest(source+b''.join(name.encode()+digest(data).encode() for name,data in sorted({**generated,**artifacts}.items())))
 files=generate.assemble(config,uid_map,RUNTIME,artifacts,release_id=release)
 files.update(artifacts)
 files['active-main.sha256']=(digest(files['main-config.json'])+'\n').encode()
 files['source-config.sha256']=(digest(source)+'\n').encode()
 files['source-boot.sha256']=(digest(old_boot)+'\n').encode()
 files['backup/config.json']=source
 files['backup/video-boot-start.sh']=old_boot
 files['backup/video-proxy.sh']=entry
 stagecheck=json.loads(files['guard-observe.json'])
 for key in ['secret_file','state_file','enabled_marker','boot_guard_file','release_id_file','workerctl']:
  stagecheck[key]=stagecheck[key].replace(RUNTIME,a.stage_dir,1)
 stagecheck['state_file']=a.stage_dir+'/must-not-be-created.json'
 files['guard-stage-check.json']=(json.dumps(stagecheck,indent=2)+'\n').encode()
 for name in files:
  if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:raise ValueError('unsafe artifact path')
  if pathlib.PurePosixPath(name).name in ['enabled','authorized-boot-id']:raise ValueError('activation marker forbidden')
 manifest={'release_id':release,'state':'inactive','runtime_root':RUNTIME,'stage_dir':a.stage_dir,'uid_map':uid_map,'files':{n:digest(v) for n,v in sorted(files.items()) if n!='manifest.json'}}
 files['manifest.json']=(json.dumps(manifest,indent=2)+'\n').encode()
 # Creation is exclusive. Existing releases and all live files are preserved.
 shell('test ! -e '+shlex.quote(a.stage_dir)+' && mkdir -m 700 '+shlex.quote(a.stage_dir))
 for name,data in files.items():
  dest=a.stage_dir+'/'+name;parent=str(pathlib.PurePosixPath(dest).parent)
  command='umask 077; mkdir -p '+shlex.quote(parent)+' && cat > '+shlex.quote(dest)+' && chmod '+('700' if name.endswith('.sh') else '600')+' '+shlex.quote(dest)
  subprocess.run(adb+['shell',command],input=data,stdout=subprocess.DEVNULL,check=True,timeout=20)
 # Every payload is read back independently; no hash-only deployment claims.
 for name,data in files.items():
  if digest(read(a.stage_dir+'/'+name))!=digest(data):raise ValueError('stage readback mismatch')
 checks=[]
 for name in ['main-config.json','workers/rack/config.json','workers/zgo/config.json']:
  q=subprocess.run(adb+['shell',LIVE+'/sing-box check -c '+shlex.quote(a.stage_dir+'/'+name)],capture_output=True,text=True,timeout=20)
  checks.append({'file':name,'rc':q.returncode})
  if q.returncode:raise ValueError('device config check failed: '+name)
 q=subprocess.run(adb+['shell','CLASSPATH='+shlex.quote(a.stage_dir+'/guard.dex')+' app_process /system/bin YoutubeFailover --check-config '+shlex.quote(a.stage_dir+'/guard-stage-check.json')],capture_output=True,text=True,timeout=20)
 if q.returncode:raise ValueError('Android DEX config validation failed')
 # The check mode contract is no network, no state writes and no mutations.
 shell('test ! -e '+shlex.quote(a.stage_dir+'/must-not-be-created.json')+' && test ! -e '+shlex.quote(a.stage_dir+'/enabled')+' && test ! -e '+shlex.quote(a.stage_dir+'/authorized-boot-id'))
 after=snapshot()
 equal={k:before[k]==after[k] for k in before if k not in ('foreground','codec')}
 evidence={'release_id':release,'stage_dir':a.stage_dir,'files':len(files),'checks':checks,'android_config_check':q.stdout.strip(),'before':before,'after':after,'unchanged':equal,'activation':'not enabled, no live files replaced, no restart'}
 a.evidence.write_text(json.dumps(evidence,indent=2,ensure_ascii=False)+'\n')
 if not all(equal.values()):raise ValueError('live-state changed; inspect independent evidence')
 print(json.dumps({'release_id':release,'files':len(files),'checks':checks,'unchanged':equal,'android_config_check':q.stdout.strip(),'activation':'inactive'},ensure_ascii=False))
if __name__=='__main__':
 try:main()
 except Exception as exc:
  # Avoid exception messages, source JSON, stderr, URLs or credentials in logs.
  print('stage failed; exception_type='+type(exc).__name__+'; live deployment was not requested',file=sys.stderr)
  sys.exit(1)
