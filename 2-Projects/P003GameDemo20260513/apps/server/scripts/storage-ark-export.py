#!/usr/bin/env python3
"""One bounded Ark export cycle. Separate process; never called by device HTTP.

Uses the existing T2 spool and forced-command transport. No device, owner, grant,
wallet or current-state mutation. Disabling new checkpoints still drains old ones.
"""
import argparse,fcntl,hashlib,importlib.util,json,os,sqlite3,time,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ark_spool',HERE/'storage-archive.py')
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
Spool=archive.Spool
MAX_ROWS=1000
MAX_BYTES=1024*1024
MAX_BATCHES=20
DAY=86400000

def transaction(db,fn):
    db.execute('BEGIN IMMEDIATE')
    try:
        result=fn();db.commit();return result
    except BaseException:
        db.rollback();raise

def claim(db,now):
    def run():
        rows=[];size=0
        for row in db.execute('SELECT id,bytes FROM ark_archive_outbox WHERE batch_id IS NULL ORDER BY id LIMIT ?', (MAX_ROWS,)):
            if row['bytes']>MAX_BYTES:raise ValueError('archive_row_too_large')
            if size+row['bytes']>MAX_BYTES:break
            rows.append(row['id']);size+=row['bytes']
        if not rows:return None
        aid=uuid.uuid4().hex
        db.execute("INSERT INTO ark_archive_batch VALUES(?,?,'claimed',NULL,?,?,?,?,NULL)",(aid,now,len(rows),size,rows[0],rows[-1]))
        for rid in rows:db.execute('UPDATE ark_archive_outbox SET batch_id=? WHERE id=? AND batch_id IS NULL',(aid,rid))
        return aid
    return transaction(db,run)

def batch_payload(db,b):
    rows=db.execute('SELECT * FROM ark_archive_outbox WHERE batch_id=? ORDER BY id',(b['archive_id'],)).fetchall()
    if len(rows)!=b['record_count'] or not rows or rows[0]['id']!=b['first_id'] or rows[-1]['id']!=b['last_id']:raise ValueError('archive_mapping_mismatch')
    chunks=[]
    for row in rows:
        e=json.loads(row['envelope'])
        if e.get('record_id')!=row['id'] or e.get('grant_id')!=row['grant_id'] or e.get('received_at_ms')!=row['received_at_ms']:raise ValueError('archive_envelope_mismatch')
        data=(row['envelope']+'\n').encode()
        if len(data)!=row['bytes']:raise ValueError('archive_bytes_mismatch')
        chunks.append(data)
    payload=b''.join(chunks)
    if len(payload)!=b['bytes'] or len(payload)>MAX_BYTES:raise ValueError('archive_bytes_mismatch')
    return payload

def clean_payload(spool,m,work):
    # Exact verified tuple was checked against DB mapping before entering here.
    with spool.lock():
        if spool.manifest(m['archive_id'])!=m or not spool.receipt(m):raise ValueError('archive_confirmation_changed')
        for p in [spool.package(m['archive_id'])/'payload.bin',work/(m['archive_id']+'.jsonl')]:
            if p.exists() or p.is_symlink():
                if spool.regular(p).st_size!=m['bytes'] or archive.sha(p)!=m['sha256']:raise ValueError('archive_cleanup_changed')
                p.unlink();archive.sync_dir(p.parent)

def process_batch(db,spool,work,aid):
    b=db.execute('SELECT * FROM ark_archive_batch WHERE archive_id=?',(aid,)).fetchone()
    payload=batch_payload(db,b)
    m={'schema_version':1,'archive_id':aid,'kind':'ark_checkpoint','created_at_ms':b['created_at_ms'],'record_count':b['record_count'],'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),'source_range':{'format':'ark_jsonl','format_version':1,'lines':b['record_count'],'first_id':b['first_id'],'last_id':b['last_id']}}
    if b['manifest']:
        if json.loads(b['manifest'])!=m:raise ValueError('archive_manifest_mapping_mismatch')
    else:
        transaction(db,lambda:db.execute("UPDATE ark_archive_batch SET manifest=?,state='prepared' WHERE archive_id=?",(json.dumps(m,sort_keys=True),aid)))
    receipt=spool.receipt(m)
    if receipt:
        clean_payload(spool,m,work)
        def finish():
            # Writer only appends unbatched rows; verify mappings again in short transaction.
            if batch_payload(db,b)!=payload:raise ValueError('archive_mapping_changed')
            db.execute('DELETE FROM ark_archive_outbox WHERE batch_id=?',(aid,))
            db.execute("UPDATE ark_archive_batch SET state='complete',verified_at_ms=? WHERE archive_id=?",(receipt['verified_at_ms'],aid))
            db.execute('UPDATE ark_archive_stats SET last_ack_ms=MAX(COALESCE(last_ack_ms,0),?) WHERE id=1',(receipt['verified_at_ms'],))
        transaction(db,finish);return 'confirmed'
    final=spool.package(aid)/'payload.bin';pending=spool.root/'pending'/aid/'payload.bin';source=work/(aid+'.jsonl')
    if not final.exists() and not pending.exists():
        if source.exists() or source.is_symlink():
            if spool.regular(source).st_size!=len(payload) or archive.sha(source)!=m['sha256']:raise ValueError('archive_work_changed')
        else:
            # An interrupted temporary is safe to discard; immutable DB mapping rebuilds it.
            temp=work/(aid+'.partial')
            if temp.exists() or temp.is_symlink():spool.regular(temp);temp.unlink()
            with temp.open('xb') as f:os.fchmod(f.fileno(),0o600);f.write(payload);f.flush();os.fsync(f.fileno())
            os.replace(temp,source);archive.sync_dir(work)
    spool.publish_prepared(source,m)
    transaction(db,lambda:db.execute("UPDATE ark_archive_batch SET state='published' WHERE archive_id=?",(aid,)))
    return 'published'

def prune_metadata(db,spool,now):
    rows=db.execute("SELECT * FROM ark_archive_batch WHERE state='complete' AND verified_at_ms<? ORDER BY verified_at_ms LIMIT 100",(now-90*DAY,)).fetchall()
    for b in rows:
        m=json.loads(b['manifest']);folder=spool.package(b['archive_id'])
        with spool.lock():
            if folder.exists():
                names={p.name for p in folder.iterdir()}
                if not names.issubset({'manifest.json'}):raise ValueError('archive_unexpected_gc_payload')
                if (folder/'manifest.json').exists():
                    if spool.manifest(b['archive_id'])!=m:raise ValueError('archive_gc_manifest_changed')
                    (folder/'manifest.json').unlink()
                folder.rmdir();archive.sync_dir(folder.parent)
            p=spool.root/'receipts'/(b['archive_id']+'.json')
            if p.exists():
                if not spool.receipt(m):raise ValueError('archive_missing_receipt')
                p.unlink();archive.sync_dir(p.parent)
        transaction(db,lambda:db.execute("DELETE FROM ark_archive_batch WHERE archive_id=? AND state='complete'",(b['archive_id'],)))
    # Current grants keep their lightweight cadence even after all body rows are removed.
    transaction(db,lambda:db.execute('DELETE FROM ark_archive_baseline WHERE grant_id IN (SELECT b.grant_id FROM ark_archive_baseline b WHERE received_at_ms<? AND NOT EXISTS(SELECT 1 FROM ark_grant g WHERE g.grant_id=b.grant_id) AND NOT EXISTS(SELECT 1 FROM ark_archive_outbox o WHERE o.grant_id=b.grant_id) LIMIT 100)',(now-90*DAY,)))

def cycle(dbfile,root,now=None):
    now=int(time.time()*1000) if now is None else now;spool=Spool(root)
    fd=os.open(spool.root/'.ark-export.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        dbfile=Path(dbfile).resolve(strict=True)
        db=sqlite3.connect('file:'+str(dbfile)+'?mode=rw',uri=True,timeout=.1,isolation_level=None);db.row_factory=sqlite3.Row
        work=spool.root/'ark-work'
        if work.is_symlink():raise ValueError('archive_work_symlink')
        work.mkdir(exist_ok=True,mode=0o700)
        try:
            db.execute('UPDATE ark_archive_stats SET last_attempt_ms=? WHERE id=1',(now,))
            count={'published':0,'confirmed':0}
            pending=db.execute("SELECT archive_id FROM ark_archive_batch WHERE state!='complete' ORDER BY created_at_ms,archive_id LIMIT ?",(MAX_BATCHES,)).fetchall()
            for b in pending:count[process_batch(db,spool,work,b['archive_id'])]+=1
            while count['published']+count['confirmed']<MAX_BATCHES:
                aid=claim(db,now)
                if aid is None:break
                count[process_batch(db,spool,work,aid)]+=1
            prune_metadata(db,spool,now)
            db.execute('UPDATE ark_archive_stats SET last_success_ms=?,last_error=NULL WHERE id=1',(now,))
            return count
        except BaseException:
            if db.in_transaction:db.rollback()
            db.execute("UPDATE ark_archive_stats SET last_error='export_failed' WHERE id=1")
            raise
        finally:db.close()
    finally:os.close(fd)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--db',required=True,type=Path);p.add_argument('--root',required=True,type=Path);a=p.parse_args()
    try:print(json.dumps(cycle(a.db,a.root)))
    except Exception as e:print('ARK_EXPORT_FAILED:'+type(e).__name__,file=__import__('sys').stderr);raise SystemExit(1)
