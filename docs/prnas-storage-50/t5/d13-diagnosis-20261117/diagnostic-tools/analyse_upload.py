import json,pathlib,statistics,collections
D=pathlib.Path(__file__).parent;R=D/'upload-evidence'
def rows(p):return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
def kv(s):return {l.split()[0]:int(l.split()[1]) for l in s.splitlines()}
def pressure(s):return {l.split()[0]:int(l.split('total=')[1]) for l in s.splitlines()}
def io(s):return {k:int(v) for tok in s.strip().split()[1:] for k,v in [tok.split('=')]}
def q(v,p):return sorted(v)[min(len(v)-1,int(len(v)*p))] if v else None
report=[]
for f in sorted(R.glob('p003-t5-d13-*')):
 req=rows(f/'requests.jsonl');writers=rows(f/'writer-diag.jsonl');res=rows(f/'resources.jsonl');good=[r['ms'] for r in req if r['status']==200];metrics=[]
 for r in writers:
  a,b=r['before']['diag'],r['after']['diag'];ca,cb=kv(a['cpu.stat']),kv(b['cpu.stat']);ma,mb=kv(a['memory.events']),kv(b['memory.events']);ia,ib=io(a['io.stat']),io(b['io.stat']);pa,pb=pressure(a['io.pressure']),pressure(b['io.pressure'])
  metrics.append({'ms':r['ms'],'cpu_ms':(cb['usage_usec']-ca['usage_usec'])/1000,'throttled_ms':(cb['throttled_usec']-ca['throttled_usec'])/1000,'io_stall_ms':(pb['full']-pa['full'])/1000,'memory_max_hits':mb['max']-ma['max'],'read_bytes':ib['rbytes']-ia['rbytes'],'write_bytes':ib['wbytes']-ia['wbytes']})
 tail=[m for m in metrics if m['ms']>=q([v['ms'] for v in metrics],.95)] if metrics else []
 x={'name':f.name,'attempts':len(req),'successes':len(good),'p95_ms':q(good,.95),'p99_ms':q(good,.99),'errors':dict(collections.Counter(str(r['error']) for r in req if r['status']!=200)),'duration_ms':max((r['at_ms'] for r in req),default=0)-min((r['start_ms'] for r in req),default=0),'writer_samples':len(metrics),'writer_p95_ms':q([v['ms'] for v in metrics],.95),'slowest_10':sorted(metrics,key=lambda x:x['ms'],reverse=True)[:10],'tail_means':{k:statistics.mean(m[k] for m in tail) for k in tail[0]} if tail else {},'all_means':{k:statistics.mean(m[k] for m in metrics) for k in metrics[0]} if metrics else {}}
 if (f/'RESULT.json').exists():
  result=json.loads((f/'RESULT.json').read_text());x.update({'integrity':result['integrity'],'acks':result['acks'],'resources':result['resources'],'config':result['config'],'health_summary':result['health_summary']})
 if res:
  a,b=res[0]['diag'],res[-1]['diag'];ca,cb=kv(a['cpu.stat']),kv(b['cpu.stat']);pa,pb=pressure(a['io.pressure']),pressure(b['io.pressure']);ma,mb=kv(a['memory.events']),kv(b['memory.events']);ia,ib=io(a['io.stat']),io(b['io.stat']);x['observation_window']={'elapsed_ms':res[-1]['at']-res[0]['at'],'cpu_ms':(cb['usage_usec']-ca['usage_usec'])/1000,'throttled_ms':(cb['throttled_usec']-ca['throttled_usec'])/1000,'io_stall_ms':(pb['full']-pa['full'])/1000,'memory_max_hits':mb['max']-ma['max'],'oom_kill':mb['oom_kill']-ma['oom_kill'],'read_bytes':ib['rbytes']-ia['rbytes'],'write_bytes':ib['wbytes']-ia['wbytes']}
 report.append(x)
(D/'UPLOAD-ANALYSIS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
for x in report:print(x['name'],x['successes'],'p95',x['p95_ms'],'p99',x['p99_ms'],'tail',x['tail_means'],'window',x.get('observation_window'))
