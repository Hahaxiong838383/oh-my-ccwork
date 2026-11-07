import subprocess,json,hashlib,re,collections
pid='3021826';target='cef3c5ad6570e988';raw=subprocess.check_output(['journalctl','-u','voice-worker-rust','_PID='+pid,'--since','@1793942490','--until','@1793942830','-o','json','--no-pager'],text=True)
markers=['agent turn aborted, history truncated to spoken part','resumed false interrupted speech','interrupt telemetry:','stt final:','asr final received','user turn committed','turn committed','llm first token','tts connection assigned','playout metrics','agent state','VAD speech start','VAD speech end']
rows=[];counts=collections.Counter();unknown=0;identities=set()
for line in raw.splitlines():
 v=json.loads(line);m=v.get('MESSAGE','');m=bytes(m).decode(errors='replace')if isinstance(m,list)else m;m=re.sub(r'\x1b\[[0-9;]*m','',m)
 match=re.search(r'\broom="?(sn-BJP003\d{14}-\d+)',m)
 if not match:unknown+=1;continue
 if hashlib.sha256(match[1].encode()).hexdigest()[:16]!=target:continue
 hits=[x for x in markers if x in m]
 if not hits:continue
 for x in hits:counts[x]+=1
 f={k:x.strip('"')for k,x in re.findall(r'\b([a-z_]+)=("[^"]*"|[^\s]+)',m)if k in {'turn_id','connect_id','played_samples','synth_chars','spoken_chars','chars','pending_chars','interim_chars','state','search_result','underrun_ms','played_frames','exit'}}
 for t in re.findall(r'\b(?:trace|trace_id)="?([a-f0-9-]{36})',m):identities.add(t)
 rows.append({'at_us':int(v['__REALTIME_TIMESTAMP']),'markers':hits,'fields':f})
# Correlate abort with the most recent room-bound ASR final; temporal only.
finals=[r for r in rows if 'stt final:'in r['markers'] or 'asr final received'in r['markers']]
aborts=[]
for r in rows:
 if 'agent turn aborted, history truncated to spoken part'not in r['markers']:continue
 prev=[x for x in finals if x['at_us']<=r['at_us']]
 aborts.append({'at_us':r['at_us'],'since_room_bound_final_ms':round((r['at_us']-prev[-1]['at_us'])/1000,3)if prev else None,**r['fields']})
print(json.dumps({'pid':pid,'room_ref':target,'window_epoch':[1793942490,1793942830],'trace_ids':sorted(identities),'counts':dict(counts),'unattributed_lines_not_assigned':unknown,'events':rows,'abort_correlations':aborts,'raw_journal_sha256':hashlib.sha256(raw.encode()).hexdigest()}))
