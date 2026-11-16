#!/usr/bin/env python3
"""Synthetic 50-device / 90-day retained-schema fixture, NOT an ingestion load test.

Creates only a new path, uses actual schema exported by AnalyticsStore. No user data.
Secondary indexes are built after bulk generation and present for all measurements.
"""
import argparse, hashlib, json, sqlite3, time
from pathlib import Path

def build(schema_file,target,devices=50,events_per_day=6000,days=90,resume=False):
    target=Path(target)
    existing=target.exists()
    if existing and not resume:raise FileExistsError(target)
    schema=json.loads(Path(schema_file).read_text());start=time.time();status=target.with_suffix('.progress.json')
    prior=json.loads(status.read_text()) if existing else None
    if prior and any(prior.get(k)!=v for k,v in {'synthetic':True,'devices':devices,'events_per_day':events_per_day,'days':days}.items()):raise ValueError('fixture_resume_scale_mismatch')
    if prior:start=prior['started_at_s']
    db=sqlite3.connect(target);db.executescript('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-524288; PRAGMA temp_store=FILE;')
    actual=dict(db.execute("SELECT name,sql FROM sqlite_master WHERE type='table'"))
    expected={r['name']:r['sql'] for r in schema if r['type']=='table'}
    if existing and actual!=expected:raise ValueError('fixture_resume_schema_mismatch')
    for row in schema:
        if row['type']=='table' and not existing:db.execute(row['sql'])
    daily=devices*events_per_day;seen=daily*days;raw=daily*min(14,days);facts=seen*2
    base=1794787200000 # 2026-11-16 00:00 UTC; ages and counts explicit.
    state={'synthetic':True,'devices':devices,'events_per_day':events_per_day,'days':days,'started_at_s':start}
    def report(**fields):
        state.update(fields,elapsed_s=time.time()-start,bytes=target.stat().st_size);tmp=status.with_suffix('.tmp');tmp.write_text(json.dumps(state));tmp.replace(status)
    dev="printf('%064x',n%"+str(devices)+")"
    ts=str(base)+"-(n/"+str(daily)+")*86400000+(n%"+str(daily)+")"
    day="strftime('%Y-%m-%d',("+ts+")/1000,'unixepoch','+8 hours')"
    expr={
      'analytics_event_seen':(seen,f"{dev},printf('%064x',n),printf('%064x',n+1),{ts}"),
      'analytics_rollup_fact':(facts,f"CASE WHEN n%2=0 THEN 'received' ELSE 'occurred' END,strftime('%Y-%m-%d',({base}-(n/2/{daily})*86400000)/1000,'unixepoch','+8 hours'),printf('%064x',(n/2)%{devices}),printf('%064x',n/2),'focus_segment',printf('%032x',n/100),0,'{{\"duration_ms\":60000,\"synthetic\":true,\"source\":\"t2-mature-backup-fixture\"}}',{base}-(n/2/{daily})*86400000+(n/2%{daily})"),
      'analytics_event':(raw,f"{dev},printf('%036x',n),'focus_segment',{ts},{ts},printf('%032x',n/100),n,'normal',?, ?,printf('%032x',n/200),{day},{day},0"),
      'analytics_settlement':(raw,"printf('%032x',n/200),printf('%064x',n),'accepted',NULL"),
      'analytics_batch':((raw+199)//200,f"printf('%032x',n),printf('ana-synthetic-%032x',n),printf('%032x',n),printf('%064x',n%{devices}),{base}-n*1000,{base}-n*1000,'{{\"synthetic\":true}}',200,0,0,200,1"),
      'analytics_transport':((raw+199)//200,"printf('%032x',n),'identity',256000,256000")}
    for table,(total,values) in expr.items():
        completed=db.execute('SELECT count(1) FROM "'+table+'" NOT INDEXED').fetchone()[0] if existing else 0
        if completed>total or completed!=total and completed%10000:raise ValueError('fixture_resume_count_mismatch')
        for offset in range(completed,total,10000):
            end=min(total,offset+10000)
            sql=f'WITH RECURSIVE seq(n) AS (SELECT {offset} UNION ALL SELECT n+1 FROM seq WHERE n+1<{end}) INSERT INTO {table} SELECT {values} FROM seq'
            params=(json.dumps({'synthetic':True,'device_mode':'normal','fixture_padding':'x'*150}),json.dumps({'duration_ms':60000,'synthetic':True,'fixture_padding':'y'*500})) if table=='analytics_event' else ()
            db.execute(sql,params);db.commit()
            report(phase='generate',table=table,rows=end,total=total)
    last=[0]
    def progress():
        if time.time()-last[0]>10:report(phase='indexes');last[0]=time.time()
        return 0
    db.set_progress_handler(progress,100000)
    indexes={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    for row in schema:
        if row['type']=='index' and row['sql'] and row['name'] not in indexes:db.execute(row['sql']);db.commit()
    # At least one retained aggregate/diagnostic row, so backup covers all tier tables.
    for n,tier in enumerate(['aggregate','diagnostic']):
        db.execute('INSERT OR IGNORE INTO analytics_tier_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('f'*64,'tier-'+str(n),'analytics.periodic_aggregate' if n==0 else 'analytics.on_demand_sample',base,base,'fixture',n,'normal','{}','{}','fixture','2026-11-16','2026-11-16',0,tier,'focus_segment',1,None))
    db.commit();db.set_progress_handler(None,0)
    counts={r['name']:db.execute('SELECT count(1) FROM "'+r['name']+'" NOT INDEXED').fetchone()[0] for r in schema if r['type']=='table'}
    sample=db.execute('SELECT * FROM analytics_event WHERE rowid=1').fetchone()
    db.close();report(phase='complete',counts=counts,sample_sha256=hashlib.sha256(json.dumps(sample,separators=(',',':')).encode()).hexdigest(),schema_sha256=hashlib.sha256(Path(schema_file).read_bytes()).hexdigest())
    return state

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--schema',required=True);p.add_argument('--target',required=True);p.add_argument('--devices',type=int,default=50);p.add_argument('--events-per-day',type=int,default=6000);p.add_argument('--days',type=int,default=90);p.add_argument('--resume',action='store_true');a=p.parse_args()
    if min(a.devices,a.events_per_day,a.days)<1:p.error('positive scale required')
    print(json.dumps(build(a.schema,a.target,a.devices,a.events_per_day,a.days,a.resume)))
