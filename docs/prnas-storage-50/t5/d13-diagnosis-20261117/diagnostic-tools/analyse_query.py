import json,pathlib
D=pathlib.Path(__file__).parent;R=D/'query-evidence'
def pairs(s,sep=None):
 out={}
 for l in s.splitlines():
  a=l.split(sep);out[a[0].rstrip(':')]=int(a[1].strip())
 return out
def rows(p):return [json.loads(s) for s in p.read_text().splitlines()]
report=[]
for run in json.loads((R/'QUERY-RUNS.json').read_text()):
 name=run['name'];summary=json.loads((R/(name+'.json')).read_text());client=rows(R/(name+'.jsonl'));server=rows(R/(name+'.reader.jsonl'));sm={r['query_id']:r for r in server};obs=[]
 for c in client:
  r=sm.get(c['query_id'],{});o={'query_id':c['query_id'],'actor':c['actor'],'client_ms':c['ms'],'body_complete':c['body_complete'],'status':c['status'],'reader_ms':r.get('ms'),'body_ms':c.get('body_ms')}
  if 'before' in r:
   a,b=r['before'],r['after'];ia,ib=pairs(a['io']),pairs(b['io']);ca,cb=pairs(a['cgroup']['cpu.stat']),pairs(b['cgroup']['cpu.stat']);o.update({'read_bytes':ib['read_bytes']-ia['read_bytes'],'cpu_us':sum(b['cpu'].values())-sum(a['cpu'].values()),'throttled_us':cb['throttled_usec']-ca['throttled_usec'],'sql':r['sql'],'sql_ms':sum(q['ms'] for q in r['sql'])})
  obs.append(o)
 report.append({'name':name,'summary':{k:summary[k] for k in ('p95_ms','p99_ms','history_transport_failures','invalid_facts','pass')},'first':obs[0],'second':obs[1],'21st':obs[20],'failures':[o for o in obs if not o['body_complete'] or o['status']!=200],'over_120':[o for o in obs if o['client_ms']>120]})
(D/'QUERY-ANALYSIS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
for r in report:
 print(r['name'],r['summary'])
 for label in ('first','second','21st'):
  x=r[label];print(label,{k:(round(v,2) if isinstance(v,float) else v) for k,v in x.items() if k!='sql'})
 print('failures',[v['query_id'] for v in r['failures']])
