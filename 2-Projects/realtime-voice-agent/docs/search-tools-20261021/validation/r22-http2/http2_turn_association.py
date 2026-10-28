"""Associate an observed body with an input commit, without a latency cutoff."""
def associate_body(commit_ms, next_commit_ms, bodies, background_ids):
    matched=[];other=[]
    for body in bodies:
        start=body['t']-body['since_turn_ms']
        if body['turn_id']in background_ids:reason='background'
        elif start+1<commit_ms:reason='started_before_target_commit'
        elif start>=next_commit_ms:reason='belongs_to_next_commit'
        elif body['t']<commit_ms:reason='body_before_target_commit'
        else:
            matched.append({**body,'start_clock_ms':start,'commit_to_body_ms':body['t']-commit_ms})
            continue
        other.append({**body,'reason':reason})
    return {'matched':matched,'other':other,'missing_or_ambiguous':len(matched)!=1}
