#!/usr/bin/env python3
"""Install only the P003 private offsite pull LaunchAgent on the current Studio."""
import hashlib,json,os,plistlib,shutil,subprocess
from pathlib import Path

LABEL='com.rayman.p003.analytics-offsite-backup'
def main():
 if Path.home()!=Path('/Users/fu-121') or os.getuid()==0:raise RuntimeError('Studio user required')
 source=Path(__file__).with_name('analytics-offsite-pull.py');ops=Path.home()/'.local/share/p003-analytics-ops';ops.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(ops,0o700)
 target=ops/source.name;shutil.copyfile(source,target);os.chmod(target,0o600)
 destination=Path.home()/'.local/share/p003-analytics-backups/hk';destination.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(destination,0o700)
 plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist';plist.parent.mkdir(parents=True,exist_ok=True)
 arguments=['/usr/bin/python3',str(target),'--destination',str(destination)]
 config={'Label':LABEL,'ProgramArguments':arguments,'RunAtLoad':True,'StartCalendarInterval':{'Hour':0,'Minute':45},'StartInterval':3600,'EnvironmentVariables':{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},'StandardOutPath':str(ops/'offsite.log'),'StandardErrorPath':str(ops/'offsite.stderr.log')}
 if plist.exists():
  prior=plistlib.loads(plist.read_bytes())
  if prior.get('Label')!=LABEL or prior.get('ProgramArguments',[None,None])[1]!=str(target):raise RuntimeError('existing LaunchAgent has a different owner')
 plist.write_bytes(plistlib.dumps(config));os.chmod(plist,0o600)
 domain='gui/'+str(os.getuid());subprocess.run(['launchctl','print',domain],check=True,capture_output=True)
 subprocess.run(['launchctl','bootout',domain,str(plist)],capture_output=True)
 subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True,capture_output=True)
 print(json.dumps({'ok':True,'label':LABEL,'daily_hour_cst':0,'daily_minute':45,'catchup_interval_seconds':3600,'pull_source_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'private_destination':str(destination)}))
if __name__=='__main__':
 try:main()
 except Exception:print(json.dumps({'ok':False,'error':'ANALYTICS_OFFSITE_INSTALL_FAILED'}));raise SystemExit(1)
