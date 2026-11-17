import pathlib,json,statistics
D=pathlib.Path(__file__).parent;R=D/'upload-evidence';report=[]
def read(p):return [json.loads(l) for l in p.read_text().splitlines()]
def q(a,p):return sorted(a)[int(len(a)*p)] if a else None
for f in sorted(R.glob('p003-t5-d13-*')):
 h=read(f/'health.jsonl');req=read(f/'requests.jsonl');intervals={}
 for r in h:
  c=r.get('checkpoint',{});a=c.get('last_attempt_ms');end=c.get('last_completed_ms')
  if a and end and end>=a:intervals[a]={'start':a,'end':end,'duration_ms':end-a,'reported_io_ms':(c.get('last_result') or {}).get('duration_ms')}
 groups={'checkpoint_overlap':[],'not_observed_overlap':[]}
 for r in req:
  if r['status']!=200:continue
  key='checkpoint_overlap' if any(i['start']<=r['at_ms'] and i['end']>=r['start_ms'] for i in intervals.values()) else 'not_observed_overlap';groups[key].append(r['ms'])
 report.append({'name':f.name,'checkpoint_intervals':list(intervals.values()),'groups':{k:{'n':len(v),'p95_ms':q(v,.95),'p99_ms':q(v,.99)} for k,v in groups.items()},'caveat':'1-second observations can miss completed cycles; overlap is association, not exclusive checkpoint attribution'})
(D/'CHECKPOINT-ALIGNMENT.json').write_text(json.dumps(report,indent=2))
for v in report:print(v['name'],v['groups'])
