#!/usr/bin/env python3
"""Independent, resumable daily Backup API export. Never runs in an HTTP request."""
import argparse, importlib.util, json, os, shutil, sqlite3, sys, time, uuid
from pathlib import Path
from urllib.parse import quote

def load(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
archive=load('storage-archive');backup=load('analytics-backup')
DAY=86400000

def run(database,root,now_ms=None,reserve_bytes=4*1024**3,timeout_seconds=None):
    database=Path(database).resolve(strict=True);spool=archive.Spool(root)
    now=int(time.time()*1000) if now_ms is None else now_ms
    # Separate kernel lock: spool readers must remain available during a long backup.
    import fcntl
    fd=os.open(spool.root/'.backup-job.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return execute(database,spool,now,reserve_bytes,timeout_seconds)
    finally:os.close(fd)

def execute(database,spool,now,reserve_bytes,timeout_seconds):
    work=spool.root/'backup-work'
    if work.is_symlink(): raise ValueError('WORK_SYMLINK')
    work.mkdir(exist_ok=True,mode=0o700)
    status_path=spool.root/'backup-status.json'
    packages=[m for m in spool.list() if m['kind']=='analytics_backup']
    verified=[m for m in packages if spool.receipt(m)]
    pending=[m for m in packages if not spool.receipt(m)]
    latest=max(verified,key=lambda m:(m['created_at_ms'],m['archive_id'])) if verified else None
    status={'checked_at_ms':now,'last_offsite_backup_ms':latest['created_at_ms'] if latest else None,
            'offsite_age_ms':max(0,now-latest['created_at_ms']) if latest else None,
            'pending_bytes':sum(m['bytes'] for m in pending),'oldest_pending_ms':min((m['created_at_ms'] for m in pending),default=None)}
    def finish(state,**extra):
        if state=='published':
            # Publication is not offsite acknowledgement; report this new backlog.
            current=[m for m in spool.list() if m['kind']=='analytics_backup' and not spool.receipt(m)]
            status.update(pending_bytes=sum(m['bytes'] for m in current),oldest_pending_ms=min((m['created_at_ms'] for m in current),default=None))
            status.pop('progress',None)
        status.update(state=state,**extra);archive.write_json(status_path,status);return status
    # A durable ready manifest is the transaction marker across filesystem renames.
    ready=work/'ready.json';source=work/'snapshot.sqlite3'
    if ready.exists():
        spool.regular(ready);m=archive.validate(json.loads(ready.read_text()))
        spool.publish_prepared(source,m,deadline=time.monotonic()+backup.budget_seconds(m['bytes']))
        ready.unlink();archive.sync_dir(work)
        return finish('published',manifest=m)
    if pending:return finish('waiting_for_nas')
    # Keep latest acknowledged local payload; only this job's backups are eligible.
    # Manifest and receipt remain, supporting a lost ACK response after payload GC.
    if latest:
        with spool.lock():
            for m in verified:
                if m['archive_id']==latest['archive_id']:continue
                payload=spool.package(m['archive_id'])/'payload.bin'
                if payload.exists():
                    spool.regular(payload);payload.unlink();archive.sync_dir(payload.parent)
        if now-latest['created_at_ms']<DAY:return finish('not_due')
    # These names belong solely to this job and are never touched while it is live.
    for p in [source,work/'snapshot.partial']:
        if p.exists() or p.is_symlink():spool.regular(p);p.unlink()
    size=database.stat().st_size
    if shutil.disk_usage(spool.root)[2] < size*1.2+reserve_bytes: raise ValueError('BACKUP_SPACE_INSUFFICIENT')
    budget=backup.budget_seconds(size) if timeout_seconds is None else timeout_seconds
    if not 0<=budget<=7200:raise ValueError('INVALID_BACKUP_BUDGET')
    deadline=time.monotonic()+budget;last=[0]
    def progress(value):
        if time.monotonic()-last[0]>=5:
            status.update(state='building',budget_seconds=budget,progress=value)
            archive.write_json(status_path,status);print(json.dumps(value),file=sys.stderr,flush=True);last[0]=time.monotonic()
    try:
        backup._copy_checked(database,work/'snapshot.partial',deadline,progress)
        os.rename(work/'snapshot.partial',source);archive.sync_dir(work)
        with sqlite3.connect('file:'+quote(str(source))+'?mode=ro',uri=True) as db:
            db.execute('PRAGMA trusted_schema=OFF');counting=['schema']
            def count_progress():
                progress({'phase':'count_rows','table':counting[0]})
                return 1 if time.monotonic()>=deadline else 0
            db.set_progress_handler(count_progress,10000)
            names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            import re
            if not names or any(not re.fullmatch('[a-z][a-z0-9_]{0,63}',n) for n in names):raise ValueError('INVALID_TABLE_NAMES')
            # Count(1) executes progress callbacks; NOT INDEXED avoids random
            # traversal of interleaved device-key index pages on spinning disks.
            tables={}
            for n in names:
                counting[0]=n
                tables[n]=db.execute('SELECT count(1) FROM "'+n+'" NOT INDEXED').fetchone()[0]
        m=archive.validate({'schema_version':1,'archive_id':uuid.uuid4().hex,'kind':'analytics_backup','created_at_ms':now,
            'record_count':sum(tables.values()),'bytes':source.stat().st_size,'sha256':backup._sha(source,deadline,progress),
            'source_range':{'tables':tables,'backup_started_at_ms':now}})
        archive.write_json(ready,m)
        spool.publish_prepared(source,m,deadline,progress)
        ready.unlink();archive.sync_dir(work)
        return finish('published',manifest=m,budget_seconds=budget)
    except Exception as e:
        finish('failed',error=type(e).__name__)
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--database',type=Path,required=True);p.add_argument('--root',type=Path,required=True)
    p.add_argument('--reserve-bytes',type=int,default=4*1024**3);p.add_argument('--timeout-seconds',type=float)
    a=p.parse_args()
    if a.reserve_bytes<0:p.error('reserve must be nonnegative')
    print(json.dumps(run(a.database,a.root,reserve_bytes=a.reserve_bytes,timeout_seconds=a.timeout_seconds),sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception as e:print('BACKUP_JOB_FAILED:'+type(e).__name__,file=sys.stderr);sys.exit(1)
