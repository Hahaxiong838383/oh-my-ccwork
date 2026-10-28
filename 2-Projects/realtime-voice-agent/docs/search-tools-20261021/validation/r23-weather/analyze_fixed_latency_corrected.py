from pathlib import Path
import sys,json,subprocess,re,datetime,statistics,math,hashlib
D=Path(sys.argv[1]) if len(sys.argv)==2 else (_ for _ in ()).throw(SystemExit('usage: analyze_fixed_latency_corrected.py PRIVATE_EVIDENCE_DIRECTORY'))
from utterance_association import associate
raw=json.loads((D/'fixed-latency-private.json').read_text())
ls=[]
for x in raw['logs']:
 s=re.sub(r'\x1b\[[0-9;]*m','',x['message']);f={k:v.strip('"')for k,v in re.findall(r'\b([A-Za-z_][A-Za-z_0-9]*)=("[^"]*"|[^\s]+)',s)}
 try:t=datetime.datetime.fromisoformat(s.split()[0].replace('Z','+00:00')).timestamp()*1000
 except ValueError:t=x['at_ms']
 ls.append({'t':t,'s':s,'f':f})
norm=lambda s:re.sub(r'[，。！？,.!?\s]','',s)
rows=[]
for sample in raw['samples']:
 logs=[l for l in ls if sample['room']in l['s']];commits=[l for l in logs if 'turn committed:'in l['s']and sample['input_start_ms']<=l['t']<=sample['end_ms']];bodies=[l for l in logs if'body first frame published'in l['s']];caps=[c for c in sample['captions']if c['role']=='user'];errors=[]
 if sample.get('runner_error'):errors.append('runner_error')
 if not(sample.get('cleanup')or{}).get('checks_passed'):errors.append('cleanup_missing')
 cs=[]
 for c in commits:
  m=re.search(r'turn committed: (.*?) room=',c['s']);cs.append({'t':c['t'],'text':m[1]if m else ''})
 linked=associate(cs,[c['text']for c in caps],[{'t':b['t'],'since_turn_ms':int(b['f']['since_turn_ms'])}for b in bodies],sample['end_ms'])
 errors.extend(linked['errors']);row={'index':sample['index'],'arm':sample['arm'],'room':sample['room'],'wav_sha256':sample['wav_sha256'],'asr_sha256':hashlib.sha256(linked['asr'].encode()).hexdigest(),'runtime_manifest':sample['runtime_manifest'],'audio_subscriber_received':sample['voiced_ms']>500,**{k:v for k,v in linked.items()if k not in ['errors','asr']},'errors':errors}
 rows.append(row)
pairs=[]
for i in range(20):
 a=next((r for r in rows if r['index']==i and r['arm']=='A'),None);b=next((r for r in rows if r['index']==i and r['arm']=='B'),None);why=[]
 if not a or not b:why.append('missing_sample')
 else:
  if a['errors']or b['errors']:why.append('sample_error')
  if a['wav_sha256']!=b['wav_sha256']or a['asr_sha256']!=b['asr_sha256']:why.append('input_mismatch')
  if a['runtime_manifest']['env_sha256']!=b['runtime_manifest']['env_sha256']:why.append('worker_env_mismatch')
  if not a['audio_subscriber_received']or not b['audio_subscriber_received']:why.append('subscriber_audio_missing')
 pairs.append({'index':i,'eligible':not why,'errors':why,'delta_ms':round(b['commit_to_body_ms']-a['commit_to_body_ms'],3)if not why else None})
ds=sorted(p['delta_ms']for p in pairs if p['eligible']);summary={'samples':len(rows),'eligible_pairs':len(ds),'median_delta_ms':statistics.median(ds)if ds else None,'p90_delta_ms':ds[math.ceil(.9*len(ds))-1]if ds else None,'new_missing_body':sum(r['arm']=='B'and r.get('bodies',0)!=1 for r in rows)}
summary['gate_pass']=len(ds)==20 and summary['median_delta_ms']<=100 and summary['p90_delta_ms']<=300 and summary['new_missing_body']==0
report={'correction':'ASR segmentation association only; same 40 samples, same thresholds, no reruns or exclusions', 'original_report_sha256':hashlib.sha256((D/'fixed-latency-safe.json').read_bytes()).hexdigest(),'protocol_sha256':hashlib.sha256((D/'latency_protocol.json').read_bytes()).hexdigest(),'summary':summary,'samples':rows,'pairs':pairs,'physical_hearing':False,'all_attempts_retained':True};(D/'fixed-latency-corrected-safe.json').write_text(json.dumps(report,indent=2));print(json.dumps(summary))
