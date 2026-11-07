from pathlib import Path
import json,re,collections,hashlib
D=Path(__file__).parent;p=D/'DNS_DIAGNOSTICS_PROBES_FINAL.json';v=json.loads(p.read_text())
assert v['finished.json']['status']=='COMPLETE'
assert len(v['rounds'])==2
out={'source_commit':'b9114ac6b7274e0a67ccffc4dde4a5bd5d5a77fe','input_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'rounds':[]}
for r in v['rounds']:
 x=r['result.json'];s=x['stats'];t=r['timings.json']
 assert r['process.json']['returncode']==0 and x['status']=='FUNCTIONAL_PASS'
 assert s['ffi_subscribers_after_cleanup']==0 and s['audible_ms']>=500 and s['user_finals']>=1 and s['answer_finals']>=1
 assert {'eou','tts','llm'}<=set(s['metric_kinds']) and s['input_samples_sent']==60699
 assert x['natural_room_gone'] and not x['fixture_cleanup']
 outer=set();diagnostics=[];counts=collections.Counter()
 for line in t:
  if 'tts connection timing' in line:outer.add(('tts',re.search(r'connect_id=(\d+)',line)[1]))
  if 'asr connection timing' in line:outer.add(('asr',re.search(r'request_id="([^"]+)"',line)[1]))
 for line in t:
  if not any(k in line for k in ['voice dns family timing','voice tcp address timing']):continue
  m=re.search(r'voice_connection\{provider="(asr|tts)" (?:connect_id=(\d+)|request_id="([^"]+)")',line);assert m,line
  key=(m[1],m[2] or m[3]);assert key in outer,(key,line)
  family=re.search(r'family="([^"]+)"',line)[1];kind='dns' if 'voice dns family timing' in line else 'tcp'
  counts[(key,family,kind)]+=1;diagnostics.append(line)
 assert all(n<= (1 if key[2]=='dns' else 8)for key,n in counts.items())
 assert any('outcome="cancelled"' in l and 'voice tcp address timing'in l for l in diagnostics)
 assert {'asr','tts'}=={key[0][0] for key in counts}
 assert not any(k in '\n'.join(diagnostics) for k in ['authorization=','access_token=','wss://','api_key='])
 assert not r['capture/ended.json']['limit_hit'] and r['capture/ended.json']['capture_kernel_drops']==0
 out['rounds'].append({'round':r['round'],'trace_id':x['trace_id'],'sid':x['sid'],'ready_ms':s['ready_ms'],'phase_ms':s['phase_ms'],'audible_ms':s['audible_ms'],'finals':[s['user_finals'],s['answer_finals']],'diagnostic_rows':len(diagnostics),'connection_keys':len(outer),'cancelled_tcp_rows':sum('outcome="cancelled"'in l and 'voice tcp address timing'in l for l in diagnostics),'all_diagnostics_correlate':True,'clean_process_exit':True,'natural_room_gone':True})
out['status']='PASS_RELEASE_RTC_AND_DIAGNOSTIC_CORRELATION'
(D/'DNS_DIAGNOSTICS_PROBES_VERIFIED.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
