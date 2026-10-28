"""Join a single known input's ASR segments; never drop slow or absent output."""
import re
normalize=lambda s:re.sub(r'[，。！？,.!?\s]','',s)
def associate(commits,captions,bodies,end_ms):
 errors=[];combined=''.join(normalize(c)for c in captions)
 if not commits or not combined:return {'errors':['input_missing'],'asr':combined,'bodies':0}
 if ''.join(normalize(c['text'])for c in commits)!=combined:errors.append('commit_caption_mismatch')
 # Earlier segments must be superseded before any body. Otherwise this is not
 # the single response to the recorded input, and it remains a gate failure.
 last=commits[-1];matches=[];earlier=[]
 for b in bodies:
  began=b['t']-b['since_turn_ms']
  if commits[0]['t']<=began+1<last['t']:earlier.append(b)
  elif last['t']<=began+1<end_ms and b['t']>=last['t']:matches.append(b)
 if earlier:errors.append('superseded_segment_produced_body')
 if len(matches)!=1:errors.append('body_count_'+str(len(matches)))
 return {'errors':errors,'asr':combined,'commits':len(commits),'bodies':len(matches),'commit_to_body_ms':round(matches[0]['t']-last['t'],3)if len(matches)==1 else None,'association':'final_commit_of_complete_input','superseded_without_body':len(commits)-1}
