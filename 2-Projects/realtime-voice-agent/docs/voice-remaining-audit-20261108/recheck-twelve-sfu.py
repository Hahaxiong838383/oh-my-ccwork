import collections, datetime, hashlib, json, re, subprocess
tails=['1794035162','1794035475','1794035701','1794035916','1794036810','1794037285','1794037493','1794038010','1794038616','1794040343','1794041570','1794042077']
out={'collected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'window':[1794034800,1794042600],'units':{}}
patterns=['job assignment received','received job request, accepting','assigned job to worker','starting RTC session','participant active','mediaTrack published','closing room','room closed','job closed','job ended']
for unit in ['livekit-server']:
 raw=subprocess.check_output(['journalctl','-u',unit,'--since','@1794034800','--until','@1794042600','--no-pager','-o','json'],text=True)
 rows=[];total=0;first=None;last=None;allmarkers=collections.Counter();matches={t:[] for t in tails}
 for line in raw.splitlines():
  j=json.loads(line);us=int(j['__REALTIME_TIMESTAMP']);total+=1;first=us if first is None else min(first,us);last=us if last is None else max(last,us)
  m=j.get('MESSAGE','');m=bytes(m).decode(errors='replace')if isinstance(m,list)else m
  tags=[x for x in patterns if x in m]
  allmarkers.update(tags)
  for t in tails:
   if re.search(r'sn-BJP003\d{6}02000053-'+t+r'\b',m):
    matches[t].append({'at_us':us,'pid':j.get('_PID'),'markers':tags,'message_sha256':hashlib.sha256(m.encode()).hexdigest()})
 out['units'][unit]={'lines':total,'first_us':first,'last_us':last,'raw_sha256':hashlib.sha256(raw.encode()).hexdigest(),'all_room_marker_counts':dict(allmarkers),'matches':matches}
out['service']=subprocess.check_output(['systemctl','show','livekit-server','-p','LoadState,ActiveState,MainPID'],text=True).splitlines()
assert 'LoadState=loaded' in out['service']
out['scope']='Read-only retained journal; no matching room entry is not proof the client received a ticket or attempted connect.'
print(json.dumps(out))
