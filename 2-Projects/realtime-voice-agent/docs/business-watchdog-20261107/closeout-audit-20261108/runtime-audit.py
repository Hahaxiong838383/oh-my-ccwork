from pathlib import Path
import subprocess,json,hashlib,re,time,datetime,os,importlib.util,collections
since_ms=int(time.time()*1000)-4*3600_000
out={'since_epoch_ms':since_ms,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hostname':subprocess.check_output(['hostname'],text=True).strip(),'units':{}}
roots={'voice-worker-rust':('/root/rust-worker','rust-worker.env'),'p003-listening-worker':('/opt/p003-listening-canary-20261030','canary.env'),'p003-search-worker':('/opt/p003-search-canary-20261021','canary.env')}
for unit,(root,envname) in roots.items():
 row=dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',unit,'-p','MainPID,NRestarts,ActiveState,ActiveEnterTimestamp'],text=True).splitlines());pid=row['MainPID'];p=Path(root);row['proc_sha256']=hashlib.sha256(Path('/proc',pid,'exe').read_bytes()).hexdigest();row['disk_sha256']=hashlib.sha256((p/'voice-rust-worker').read_bytes()).hexdigest();row['env_sha256']=hashlib.sha256((p/envname).read_bytes()).hexdigest()
 if (p/'release.json').exists():row['release']=json.loads((p/'release.json').read_text())
 env=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
 safe=['P003_BUSINESS_WATCHDOG_MODE','P003_TTS_CONNECT_RECOVERY_V1','P003_ASR_CONNECT_RECOVERY_V1','P003_ASYNC_DNS_V1','P003_TTS_DNS_HEDGE_V1','P003_TTS_LATENCY_V1','P003_TTS_FIRST_PCM_BUDGET_MS','WORKER_MAX_JOBS'];row['flags']={k:env.get(k)for k in safe};row['watchdog_scope']=[s[-8:]for s in env.get('P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST','').split(',')if s]
 raw=subprocess.check_output(['journalctl','-u',unit,'_PID='+pid,'--since','@'+str(since_ms//1000),'-o','json','--no-pager'],text=True);row['journal_sha256']=hashlib.sha256(raw.encode()).hexdigest();counts=collections.Counter();connections=[];samples=[];rooms=set();last_ms=None
 for line in raw.splitlines():
  try:v=json.loads(line)
  except ValueError:continue
  msg=v.get('MESSAGE','');msg=bytes(msg).decode(errors='replace')if isinstance(msg,list)else msg;msg=re.sub(r'\x1b\[[0-9;]*m','',msg);last_ms=int(v['__REALTIME_TIMESTAMP'])//1000
  for key,pattern in {'accept_job':'received job request, accepting','decline_job':'declining job','assigned':'job assignment received','job_closed':'job closed','panic':'panicked at|thread .*panicked','error':r'\bERROR\b','connection_timeout':'[Tt]imed [Oo]ut|[Cc]onnection.*timeout|[Cc]onnect.*timeout','asr_no_audio':'45000002','playout':'playout','business_close':'decision=Close','asr_final':'stt final:'}.items():
   if re.search(pattern,msg):counts[key]+=1
  for sn in re.findall(r'room(?:_name)?="?sn-(BJP003\d{14})-',msg):rooms.add(sn[-8:])
  if any(x in msg for x in ['tts connection timing','tts stream timing','asr connection timing','voice dns','voice tcp','stt connect timing','tts dispatch timing','tts stream diagnostics','playout metrics']):
   nums={k:int(n)for k,n in re.findall(r'\b([A-Za-z_]+(?:_ms|_count|_frames|_id))=([0-9]+)',msg)}
   labels={k:m for k,m in re.findall(r'\b(provider|stage|outcome|reason|phase)="?([A-Za-z_0-9-]+)',msg)}
   samples.append({'at_ms':last_ms,'numbers':nums,'labels':labels})
 row['counts']=dict(counts);row['room_sn_suffixes']=sorted(rooms);row['last_journal_ms']=last_ms;row['timing_sample_count']=len(samples);row['timing_samples']=samples[-120:];out['units'][unit]=row
# Direct SFU room snapshot; never print credentials or body text.
pid=out['units']['voice-worker-rust']['MainPID'];env=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(env['LIVEKIT_URL'],env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET']);rooms=api.post('ListRooms',{}).get('rooms',[])
out['sfu_rooms']=[{'name':re.sub(r'BJP003\d+',lambda x:'****'+x[0][-8:],r.get('name','')),'sid':r.get('sid'),'created':r.get('creation_time'),'num_participants':r.get('num_participants')}for r in rooms]
out['main_cleanup']=json.loads(Path('/var/lib/p003-business-cleanup/status.json').read_text())
for name,p in [('listening_cleanup','/opt/p003-listening-canary-20261030/cleanup-status.json'),('search_cleanup','/opt/p003-search-canary-20261021/cleanup-status.json')]:
 if Path(p).exists():out[name]=json.loads(Path(p).read_text())
print(json.dumps(out))
