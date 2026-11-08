import collections,datetime,hashlib,json,re,statistics,subprocess
pid=subprocess.check_output(['systemctl','show','voice-worker-rust','-p','MainPID','--value'],text=True).strip()
raw=subprocess.check_output(['journalctl','-u','voice-worker-rust','_PID='+pid,'--since','@1794092463','--no-pager','-o','json'],text=True)
rows=[];assigned=[];closed=[]
for line in raw.splitlines():
 j=json.loads(line);m=j.get('MESSAGE','');m=bytes(m).decode(errors='replace')if isinstance(m,list)else m;m=re.sub(r'\x1b\[[0-9;]*m','',m)
 sn=re.search(r'\broom(?:_name)?="?sn-(BJP003\d{14})-(\d+)',m);ref=sn[1][-8:]if sn else None
 if 'job assignment received'in m:assigned.append({'at_us':int(j['__REALTIME_TIMESTAMP']),'sn_tail':ref})
 if 'job closed'in m:closed.append({'at_us':int(j['__REALTIME_TIMESTAMP']),'sn_tail':ref})
 if 'tts connection timing'not in m:continue
 nums={k:int(v)for k,v in re.findall(r'\b(connect_id|elapsed_ms|dns_ms|tcp_ms|tls_ws_ms)=(\d+)',m)}
 labels={k:v for k,v in re.findall(r'\b(stage|outcome|reason|dns_path)="?([a-z_]+)',m)}
 rows.append({'at_us':int(j['__REALTIME_TIMESTAMP']),'sn_tail':ref,'numbers':nums,'labels':labels})
summary={}
for name,rs in [('all',rows),('real_bound',[r for r in rows if r['sn_tail']and not r['sn_tail'].startswith('9999')])]:
 vals=[r['numbers']['dns_ms']for r in rs if 'dns_ms'in r['numbers']]
 summary[name]={'records':len(rs),'outcomes':dict(collections.Counter(r['labels'].get('outcome')for r in rs)),'dns_count':len(vals),'dns_min':min(vals)if vals else None,'dns_median':statistics.median(vals)if vals else None,'dns_max':max(vals)if vals else None}
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pid':pid,'journal_sha256':hashlib.sha256(raw.encode()).hexdigest(),'assignments':assigned,'job_closes':closed,'summary':summary,'connection_records':rows,'scope':'TTS connect timings, not user-to-audible latency; only explicit room-bound SN can classify real/synthetic; no transcripts exported'}))
