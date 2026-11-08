"""Bounded DNS-only observations. No cache flush, config change or authenticated request."""
import concurrent.futures, datetime, hashlib, ipaddress, json, random, re, socket, subprocess, time
HOST='cbm01.cn-huabei-1.xf-yun.com'
SERVERS=['127.0.0.53','1.1.1.1','8.8.8.8','223.5.5.5','119.29.29.29']
ROUNDS=18
start=time.time();rows=[];rng=random.Random(20261108)
def query(server,kind,transport,round_no):
 args=['dig','@'+server,HOST,kind,'+time=1','+tries=1','+nocmd','+comments','+answer','+authority','+additional','+stats']
 if transport=='tcp':args+=['+tcp']
 t=time.monotonic();at=time.time()
 try:
  p=subprocess.run(args,capture_output=True,text=True,timeout=2.5);s=p.stdout
  status=re.search(r'status: ([A-Z]+)',s);ms=re.search(r'Query time: (\d+) msec',s);rrs=[];section=None
  for line in s.splitlines():
   if line.startswith(';; ')and line.endswith(' SECTION:'):section=line[3:-9].strip()
   if line.startswith(';')or not line.strip():continue
   parts=line.split()
   if len(parts)>=5 and parts[1].isdigit()and parts[2]=='IN'and parts[3]in ['A','AAAA','CNAME','SOA']:
    rrs.append({'section':section,'owner':parts[0],'ttl':int(parts[1]),'type':parts[3],'value':' '.join(parts[4:])})
  return {'at':at,'server':server,'kind':kind,'transport':transport,'round':round_no,'rc':p.returncode,'status':status[1]if status else None,'wire_ms':int(ms[1])if ms else None,'wall_ms':round((time.monotonic()-t)*1000,3),'records':rrs,'stdout_sha256':hashlib.sha256(s.encode()).hexdigest(),'timeout':'timed out'in s.lower()or p.returncode==9}
 except subprocess.TimeoutExpired:
  return {'at':at,'server':server,'kind':kind,'transport':transport,'round':round_no,'status':None,'rc':None,'wire_ms':None,'wall_ms':round((time.monotonic()-t)*1000,3),'timeout':True,'records':[]}
with concurrent.futures.ThreadPoolExecutor(max_workers=5)as pool:
 for i in range(ROUNDS):
  for kind in ['A','AAAA']:
   order=SERVERS[:];rng.shuffle(order)
   rows.extend(pool.map(lambda s:query(s,kind,'udp',i),order));time.sleep(.5)
 for kind in ['A','AAAA']:
  rows.extend(pool.map(lambda s:query(s,kind,'tcp',0),SERVERS));time.sleep(.5)
out={'started_at':datetime.datetime.fromtimestamp(start,datetime.timezone.utc).isoformat(),'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':HOST,'hostname':socket.gethostname(),'rounds_per_udp_family':ROUNDS,'rows':rows,'scope':'DNS-only; upstream cache temperature unknown; no production cache flush/config change; wire_ms is dig reported DNS transaction latency, wall_ms includes subprocess overhead; valid NOERROR/NODATA AAAA is not a connection failure; TCP one observation per family/resolver is not a performance distribution'}
print(json.dumps(out))
