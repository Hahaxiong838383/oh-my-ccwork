#!/usr/bin/env python3
"""Close only the named listening window; never restore a historical database."""
import argparse, json, os, pathlib, sqlite3, time, fcntl

def expire_main(db_path, window, now):
    if now < window['expires_at_ms']: return 'not_due'
    db=sqlite3.connect(db_path,timeout=5)
    try:
        db.execute('BEGIN IMMEDIATE')
        flags=dict(db.execute("SELECT key,value FROM runtime_flag WHERE key LIKE 'p003.search.canary.%'"))
        prefix='p003.search.canary.'
        if any(flags.get(prefix+k)!=str(window[k]) for k in ['agent','generation','expires_at_ms']):
            db.rollback();return 'different_window'
        if flags.get(prefix+'enabled')=='1':
            db.execute('UPDATE runtime_flag SET value=?,updated_at=?,updated_by=?,note=? WHERE key=?',('0',now,'listening-expiry','v374 bounded listening window expired',prefix+'enabled'))
        row=db.execute('SELECT revision,value_json FROM listening_settings WHERE id=1').fetchone()
        if row:
            previous=json.loads(row[1]);assert previous['revision']==row[0]
            if previous['enabled']:
                current={**previous,'enabled':False,'revision':row[0]+1}
                body=json.dumps(current,separators=(',',':'));actor='listening-expiry'
                db.execute('UPDATE listening_settings SET revision=?,value_json=?,updated_at=?,updated_by=? WHERE id=1',(current['revision'],body,now,actor))
                db.execute('INSERT INTO listening_settings_audit VALUES(?,?,?,?,?,?)',(current['revision'],'disable',actor,now,row[1],body))
        db.commit();return 'closed'
    except:
        db.rollback();raise
    finally: db.close()

def expire_worker(path, window, now):
    if now < window['expires_at_ms']: return 'not_due'
    path=pathlib.Path(path)
    with (path.parent/'window.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        current=json.loads(path.read_text())
        if any(current.get(k)!=window[k] for k in ['generation','expires_at_ms']):return 'different_window'
        if current.get('enabled'):
            current['enabled']=False;temp=path.with_suffix('.expiry.tmp')
            temp.write_text(json.dumps(current));os.chmod(temp,0o600);os.replace(temp,path)
        return 'closed'

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--kind',choices=['main','worker'],required=True);p.add_argument('--state',required=True);p.add_argument('--target',required=True);a=p.parse_args()
    w=json.loads(pathlib.Path(a.state).read_text());assert w['agent']=='p003-search-listening-20261030';assert w['allowlist']==['BJP00326070803800006'];assert isinstance(w['generation'],str) and w['generation'];assert isinstance(w['expires_at_ms'],int)
    now=int(time.time()*1000);result=(expire_main if a.kind=='main' else expire_worker)(a.target,w,now)
    print(json.dumps({'result':result,'kind':a.kind,'at_ms':now,'generation':w['generation']}))
