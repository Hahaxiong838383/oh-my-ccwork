from pathlib import Path
import subprocess,json,hashlib,datetime,time,os,importlib.util,re
D=Path('/root/p003-main-asr-preconnect-20261108');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'units':{},'files':{}}
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for unit,root,envname in [('voice-worker-rust','/root/rust-worker','rust-worker.env'),('p003-listening-worker','/opt/p003-listening-canary-20261030','canary.env'),('p003-search-worker','/opt/p003-search-canary-20261021','canary.env')]:
 v=dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',unit,'-p','MainPID,NRestarts,ActiveState,ActiveEnterTimestamp'],text=True).splitlines());v['process_sha256']=sha('/proc/'+v['MainPID']+'/exe');v['disk_sha256']=sha(Path(root)/'voice-rust-worker');v['env_sha256']=sha(Path(root)/envname);out['units'][unit]=v
u=out['units']['voice-worker-rust'];pid=u['MainPID'];expected='057f19722de3c2711a50ebb88d2768b8ab36111927495eb8efeda2ee286c426d';assert u['process_sha256']==u['disk_sha256']==expected and u['NRestarts']=='0'
raw=subprocess.check_output(['journalctl','-u','voice-worker-rust','_PID='+pid,'--no-pager','-o','cat'],text=True);s=re.sub(r'\x1b\[[0-9;]*m','',raw)
out['logs']={'sha256':hashlib.sha256(raw.encode()).hexdigest(),'bytes':len(raw.encode()),'assignments':s.count('job assignment received'),'job_exits':s.count('process exiting'),'asr_finals':s.count('asr final received'),'panic':s.count('panicked at'),'error_lines':sum(' ERROR 'in x for x in s.splitlines()),'events':[x for x in s.splitlines() if any(k in x for k in ['begin timeout → rtc','input phase → rtc','business watchdog terminal','replacing failed idle ASR','TTS transport timing','tts transport timing','underrun','first_pcm_ms='])]}
out['cleanup']=json.loads(Path('/var/lib/p003-business-cleanup/status.json').read_text())
e=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']);out['sfu_room_count']=len(api.post('ListRooms',{}).get('rooms',[]));e.clear()
for n in ['PRODUCTION_PROBES.json','production-probes-launch.json','production-probes.log','production-probe-0.log','production-probe-1.log','main-handoff-release-ordered0.json','main-handoff-release-ordered1.json']:
 p=D/n
 if p.exists():out['files'][n]=p.read_text()
print(json.dumps(out,ensure_ascii=False))
