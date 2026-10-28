"""Separate corrected timing report; preserves original failure and every room."""
from pathlib import Path
import json,re,sys,datetime,statistics,math,hashlib,copy
from http2_turn_association import associate_body
D=Path(__file__).parent
if len(sys.argv)!=2:raise SystemExit('usage: analyze_http2_corrected.py PRIVATE_EVIDENCE_DIRECTORY')
E=Path(sys.argv[1])
raw=json.loads((E/'evidence-private.json').read_text());original=json.loads((E/'safe.json').read_text())
norm=lambda s:re.sub(r'[，。！？,.!?\s]','',s)
logs=[]
for entry in raw['logs']:
 s=re.sub(r'\x1b\[[0-9;]*m','',entry['message']);f={k:x.strip('"')for k,x in re.findall(r'\b([A-Za-z_][A-Za-z_0-9]*)=("[^"]*"|[^\s]+)',s)}
 try:t=datetime.datetime.fromisoformat(s.split()[0].replace('Z','+00:00')).timestamp()*1000
 except ValueError:t=entry['at_ms']
 logs.append({'t':t,'s':s,'f':f,'room':f.get('room',f.get('room_name'))})
rows=[]
for prior in original['samples']:
 row=copy.deepcopy(prior);row['original_exclusions']=list(prior['exclusions'])
 if prior['group']=='normal':rows.append(row);continue
 s=next(s for s in raw['samples']if s['room']==prior['room']);a=next((a for a in raw['samples']if a.get('producer_group')=='mixed'and a['index']==s['index']and a['arm']=='A'),None);group=prior['group']
 why=[x for x in prior['exclusions']if not x.startswith(('commit_count_','user_caption_count_','body_count_'))]
 ag=a['groups'].get(group)if a else None;g=s['groups'].get(group)
 ac=[c for c in a['captions']if c['role']=='user'and ag['input_start_ms']<=c['at_ms']<=ag['end_ms']]if ag else []
 if len(ac)!=1 or not g:
  row['eligible']=False;row['exclusions']=why+['paired_target_input_not_unique'];rows.append(row);continue
 target=norm(ac[0]['text']);caps=[c for c in s['captions']if c['role']=='user'and g['input_start_ms']<=c['at_ms']<=g['end_ms']and norm(c['text'])==target]
 ls=[l for l in logs if l['room']==s['room']and s['start_ms']<=l['t']<=s['end_ms']+1000];background={l['f'].get('turn_id')for l in ls if'background search first audio published'in l['s']}
 commits=[l for l in ls if g['input_start_ms']<=l['t']<=g['end_ms']and'turn committed:'in l['s']]
 target_commits=[l for l in commits if (m:=re.search(r'turn committed: (.*?) room=',l['s']))and norm(m[1])==target]
 if len(caps)!=1:why.append('target_caption_not_unique')
 if len(target_commits)!=1:why.append('target_commit_not_unique')
 row['target_input_observed']=len(caps)==len(target_commits)==1
 if row['target_input_observed']:
  commit=target_commits[0];next_time=min([l['t']for l in commits if l['t']>commit['t']]+[g['end_ms']+1])
  bodies=[{'t':l['t'],'turn_id':l['f']['turn_id'],'since_turn_ms':int(l['f']['since_turn_ms'])}for l in ls if g['input_start_ms']<=l['t']<=g['end_ms']and'body first frame published'in l['s']and'since_turn_ms'in l['f']]
  linked=associate_body(commit['t'],next_time,bodies,background);row['body_association']=linked
  # A missing or ambiguous output remains a missing-output gate violation. It
  # cannot disappear through the minimum-valid-pairs exclusion allowance.
  row['commits']=1;row['bodies']=0 if linked['missing_or_ambiguous']else 1
  if linked['missing_or_ambiguous']:why.append('target_body_missing_or_ambiguous')
  else:
   body=linked['matched'][0];row['commit_to_body_ms']=round(body['t']-commit['t'],3);row['sender_end_to_commit_ms']=round(commit['t']-g['input_end_ms'],3);row['sender_end_to_body_ms']=round(body['t']-g['input_end_ms'],3)
  row['asr_sha256']=hashlib.sha256(target.encode()).hexdigest()
 row['eligible']=not why;row['exclusions']=why;rows.append(row)
pairs=[];summary={}
for group in ['normal','search','resume']:
 rs=[r for r in rows if r['group']==group];new_missing=[]
 for i in range(30):
  a=next((r for r in rs if r['arm']=='A'and r['index']==i),None);b=next((r for r in rs if r['arm']=='B'and r['index']==i),None)
  if not(a and b):continue
  manifest_equal=all(a['runtime_manifest'][k]==b['runtime_manifest'][k]for k in ['env_sha256','worker_sha256','brain_manifest_sha256','asr_nonstream','initial_prompt_sha256'])
  ok=a['eligible']and b['eligible']and a['wav_sha256']==b['wav_sha256']and a['asr_sha256']==b['asr_sha256']and manifest_equal
  if a['bodies']>0 and b['commits']>0 and b['bodies']==0:new_missing.append(i)
  pairs.append({'group':group,'index':i,'eligible':ok,'delta_ms':round(b['commit_to_body_ms']-a['commit_to_body_ms'],3)if ok else None,'manifest_equal':manifest_equal})
 ds=sorted(p['delta_ms']for p in pairs if p['group']==group and p['eligible']);median=statistics.median(ds)if ds else None;p90=ds[math.ceil(.9*len(ds))-1]if ds else None
 missing={arm:sum(r['commits']>0 and r['bodies']==0 for r in rs if r['arm']==arm)for arm in ['A','B']}
 summary[group]={'samples':len(rs),'pairs':len(ds),'median_delta_ms':median,'empirical_p90_delta_ms':p90,'missing_body':missing,'new_missing_body_pair_indices':new_missing,'passes_threshold':len(ds)>=20 and median<=100 and p90<=300 and missing['B']<=missing['A']and not new_missing}
report={'label':'r22-http2-final','scope':'separate measurement correction; original report unchanged','original_report_sha256':hashlib.sha256((E/'safe.json').read_bytes()).hexdigest(),'protocol_sha256':hashlib.sha256((D/'http2-measurement-correction-protocol.json').read_bytes()).hexdigest(),'summary':summary,'samples':rows,'pairs':pairs,'all_attempts_retained':True,'physical_hearing':False}
dest=E/'corrected-safe.json';assert not dest.exists(),'immutable report';dest.write_text(json.dumps(report,indent=2));print(json.dumps({'evidence':str(dest),'summary':summary}))
