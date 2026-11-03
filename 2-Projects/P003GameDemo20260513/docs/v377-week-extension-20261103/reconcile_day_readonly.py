#!/usr/bin/env python3
"""Single-window read-only reconciliation; runtime supplies DB path and HMAC key.
No credential loading, HTTP calls, writes, raw event text, or model calls.
"""
import argparse,datetime,json,os,pathlib,re,sqlite3,time
now=int(time.time()*1000)
def ro(path):
    db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=.25)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    return db
def rows(db,sql,params=()):
    return [dict(row) for row in db.execute(sql,params)]
# Fixed authorized device/window. No API mutation, inserts, events, or payload text.
window_start=1793679950775;expiry=1794285579162;diag='diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae'
zone=datetime.timezone(datetime.timedelta(hours=8))
parser=argparse.ArgumentParser(description='One authorized device, at most one CST day, read-only.')
parser.add_argument('--date-cst', default=datetime.datetime.now(zone).date().isoformat())
opts=parser.parse_args()
day=datetime.date.fromisoformat(opts.date_cst)
day_start=int(datetime.datetime.combine(day,datetime.time(),zone).timestamp()*1000)
start=max(window_start,day_start)
end=min(now,day_start+86400000,expiry+3600000)
if start>=end: parser.error('Date is future or outside this authorized reconciliation window')
key=os.environ['P003_ANALYTICS_AUDIT_DEVICE_KEY']
assert re.fullmatch(r'[a-f0-9]{64}',key), 'Invalid audit device key'
assert pathlib.Path(os.environ['P003_ANALYTICS_AUDIT_DB']).is_absolute(), 'Absolute database path required'
c=ro(os.environ['P003_ANALYTICS_AUDIT_DB']);c.execute('BEGIN')
# Bound time and an execution budget; query abort is an error, never zero evidence.
deadline=time.monotonic()+8;c.set_progress_handler(lambda: int(time.monotonic()>deadline),10000)
args=(key,start,end)
base=' FROM analytics_batch b WHERE b.device_key=? AND b.received_at_ms>=? AND b.received_at_ms<? '
out={'checked_at':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'device_tail':'03800006','diagnostic_request_id':diag,'window_start_ms':window_start,'query_start_ms':start,'date_cst':opts.date_cst,'authorization_expires_ms':expiry,'query_end_ms':end,'read_only':True}
out['summary']=rows(c,'SELECT count(*) attempts,coalesce(sum(accepted),0) accepted,coalesce(sum(duplicated),0) duplicated,coalesce(sum(rejected),0) rejected'+base,args)
out['batches']=rows(c,"SELECT b.attempt_id,b.request_id AS http_rid,b.batch_id,b.received_at_ms,b.sent_at_ms,b.accepted,b.duplicated,b.rejected,b.http_status,json_extract(b.client_json,'content_version') content_version,json_extract(b.client_json,'app_version') app_version,t.encoding,t.wire_bytes,t.inflated_bytes FROM analytics_batch b LEFT JOIN analytics_transport t ON t.attempt_id=b.attempt_id WHERE b.device_key=? AND b.received_at_ms>=? AND b.received_at_ms<? ORDER BY b.received_at_ms LIMIT 1000",args)
out['batches_truncated']=out['summary'][0]['attempts']>len(out['batches'])
out['settlement']=rows(c,'SELECT s.outcome,s.reason,count(*) n FROM analytics_settlement s JOIN analytics_batch b ON b.attempt_id=s.attempt_id WHERE b.device_key=? AND b.received_at_ms>=? AND b.received_at_ms<? GROUP BY s.outcome,s.reason',args)
out['payload_by_batch']=rows(c,"SELECT batch_attempt_id,tier,count(*) records FROM (SELECT batch_attempt_id,'raw' tier FROM analytics_event WHERE device_key=? AND received_at_ms>=? AND received_at_ms<? UNION ALL SELECT batch_attempt_id,tier FROM analytics_tier_event WHERE device_key=? AND received_at_ms>=? AND received_at_ms<?) GROUP BY batch_attempt_id,tier",args+args)
out['tiers']=rows(c,'SELECT tier,source_event_name,diagnostic_request_id,count(*) records,sum(source_event_count) source_events FROM analytics_tier_event WHERE device_key=? AND received_at_ms>=? AND received_at_ms<? GROUP BY tier,source_event_name,diagnostic_request_id',args)
out['samples']=rows(c,'SELECT client_event_id,diagnostic_request_id,source_event_name,occurred_at_ms,received_at_ms,batch_attempt_id FROM analytics_tier_event WHERE device_key=? AND diagnostic_request_id=? AND received_at_ms>=? AND received_at_ms<? ORDER BY received_at_ms LIMIT 1001',(key,diag,start,end))
out['aggregate_periods']=rows(c,"SELECT client_event_id,source_event_name,source_event_count,json_extract(properties_json,'period_start_ms') period_start_ms,json_extract(properties_json,'period_end_ms') period_end_ms,received_at_ms,batch_attempt_id FROM analytics_tier_event WHERE device_key=? AND received_at_ms>=? AND received_at_ms<? AND tier='aggregate' LIMIT 1000",args)
out['usage']=rows(c,'SELECT request_id,accepted FROM analytics_diagnostic_usage WHERE device_key=? AND request_id=?',(key,diag))
out['has_real_window_traffic']=out['summary'][0]['attempts']>0
out['interpretation']='Nonzero actual client traffic and client-side settlement required; empty equality is not PASS.'
out['settlement_count_matches_attempt_totals']=sum(x['n'] for x in out['settlement'])==sum(out['summary'][0][k] for k in ['accepted','duplicated','rejected'])
out['payload_evidence_may_be_pruned']=now-start>=3*86400000
out['accepted_payload_count_matches']=None if out['payload_evidence_may_be_pruned'] else sum(x['records'] for x in out['payload_by_batch'])==out['summary'][0]['accepted']
c.rollback();c.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
