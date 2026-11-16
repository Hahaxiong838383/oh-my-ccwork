from pathlib import Path
import json,hashlib,subprocess,time,os,importlib.util
D=Path('/root/p003-asr-three-device-20261116');spec=json.loads((D/'SPEC.json').read_text());out={'at_ms':int(time.time()*1000),'pools':{},'releases':{},'files':{}}
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for pool,cp in spec['pools'].items():
 u=cp['unit'];root=Path(cp['root']);state=dict(x.split('=',1) for x in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines());pid=state['MainPID'];env=dict(os.fsdecode(x).split('=',1) for x in Path('/proc',pid,'environ').read_bytes().split(b'\0') if b'=' in x)
 item={'state':state,'process_sha256':sha(Path('/proc',pid,'exe')),'disk_sha256':sha(root/'voice-rust-worker'),'env_sha256':sha(cp['files']['env']['path']),'diagnostics':{k:env.get(k) for k in ['P003_ASR_DIAGNOSTICS_SN_ALLOW','P003_ASR_DIAGNOSTICS_UNTIL_MS']}}
 if pool in ['main','listening']:
  release=json.loads((D/('RELEASE-'+pool+'.json')).read_text());assert release['success'];assert state==release['after'];assert item['process_sha256']==item['disk_sha256']==release['process_sha256'];assert item['diagnostics']['P003_ASR_DIAGNOSTICS_SN_ALLOW']==','.join(spec['device_sns']);assert item['diagnostics']['P003_ASR_DIAGNOSTICS_UNTIL_MS']==str(spec['until_ms']);item['stable_seconds']=(out['at_ms']-release['finished_ms'])/1000;out['releases'][pool]=release
  lines=subprocess.check_output(['journalctl','-u',u,'_PID='+pid,'--since','@'+str(release['started_ms']//1000),'--no-pager','-o','cat'],text=True).splitlines();item['registration_count']=sum('registered worker' in line for line in lines);item['panic_count']=sum('panicked' in line for line in lines);item['diagnostic_connection_summary_count']=sum('asr diagnostic connection summary' in line for line in lines);assert item['registration_count']>=1 and item['panic_count']==0
 else:
  assert state==cp['before'];assert item['process_sha256']==item['disk_sha256']==cp['process_sha256'];assert item['env_sha256']==cp['files']['env']['sha256']
 for name in ['window.json']:
  if name in cp['files']: assert sha(root/name)==cp['files'][name]['sha256'];out['files'][pool+'/'+name]=sha(root/name)
 assert sha(cp['files']['unit']['path'])==cp['files']['unit']['sha256'];out['files'][pool+'/unit']=sha(cp['files']['unit']['path'])
 if pool=='listening':
  h=json.loads(Path(env['P003_SEARCH_CANARY_HEALTH_FILE']).read_text());assert h['registered'] and h['cleanup']['healthy'] and 0<=int(time.time()*1000)-h['at_ms']<8000;item['health']={k:h[k] for k in ['at_ms','registered','jobs']};item['health']['observed_at_ms']=int(time.time()*1000);item['cleanup_healthy']=h['cleanup']['healthy']
 out['pools'][pool]=item
h=json.loads(Path('/var/lib/p003-business-cleanup/status.json').read_text());assert h['healthy'] and 0<=int(time.time()*1000)-h['at_ms']<120000;out['cleanup']={k:h[k] for k in ['at_ms','healthy','remaining']};out['cleanup']['observed_at_ms']=int(time.time()*1000)
out['pass']=True;out['until_ms']=spec['until_ms'];out['device_sns']=spec['device_sns'];out['real_device_retest']=False
print(json.dumps(out))
