#!/usr/bin/env python3
"""One bounded Ark export cycle. Separate process; never called by device HTTP.

Uses the existing T2 spool and forced-command transport. No device, owner, grant,
wallet or current-state mutation. Disabling new checkpoints still drains old ones.
"""
import argparse,fcntl,hashlib,importlib.util,json,os,shutil,sqlite3,time,uuid,re,urllib.request,urllib.error,urllib.parse
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ark_spool',HERE/'storage-archive.py')
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
Spool=archive.Spool
MAX_ROWS=1000
MAX_BYTES=1024*1024
MAX_BATCHES=20
DISK_RESERVE_BYTES=9*1024**3//2
DAY=86400000
BUSY_RETRY_SECONDS=1.0

class ExportConnection(sqlite3.Connection):
    """Background-only BUSY retry; one shared budget, no repeated cycle or payload work."""
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.busy_remaining=BUSY_RETRY_SECONDS
        self.busy_retries=0
    def retry(self,operation):
        while True:
            started=time.monotonic()
            try:return operation()
            except sqlite3.OperationalError as error:
                self.busy_remaining-=time.monotonic()-started
                if getattr(error,'sqlite_errorcode',0)&255!=sqlite3.SQLITE_BUSY or self.busy_remaining<=0:raise
                self.busy_retries+=1
                started=time.monotonic();time.sleep(min(.025,self.busy_remaining))
                self.busy_remaining-=time.monotonic()-started
    def execute(self,*args,**kwargs):
        return self.retry(lambda:super(ExportConnection,self).execute(*args,**kwargs))
    def commit(self):
        return self.retry(lambda:super(ExportConnection,self).commit())

class OwnerConnection:
    """Read-only local view; fixed write commands are executed by Brain's owner."""
    busy_retries=0
    def __init__(self, dbfile, url, secret):
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!='http' or parsed.hostname!='127.0.0.1' or parsed.username or parsed.password or parsed.query or parsed.fragment or len(secret)<32:
            raise ValueError('archive_control_config_invalid')
        self.url,self.secret,self.database=url,secret,str(dbfile)
        self.db=sqlite3.connect('file:'+str(dbfile)+'?mode=ro',uri=True,timeout=.1,isolation_level=None)
        self.db.row_factory=sqlite3.Row;self.db.execute('PRAGMA query_only=ON')
    def execute(self,*a,**kw):return self.db.execute(*a,**kw)
    @property
    def in_transaction(self):return self.db.in_transaction
    def close(self):self.db.close()
    def control(self,q):
        data=json.dumps({'database':self.database,'command':q},ensure_ascii=False,separators=(',',':')).encode()
        req=urllib.request.Request(self.url,data,{'Content-Type':'application/json','X-Ark-Archive-Token':self.secret},method='POST')
        # Bypass ambient proxies, refuse redirects; never fall back to a DB writer.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*a,**kw):return None
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        started=time.monotonic()
        while True:
            try:
                with opener.open(req,timeout=2) as r:
                    raw=r.read(8193)
                    if len(raw)>8192:raise ValueError('archive_control_response_invalid')
                    result=json.loads(raw)
                    if result.get('ok') is not True:raise ValueError('archive_control_response_invalid')
                    return result['result']
            except urllib.error.HTTPError as e:
                status=e.code
                try:detail=json.loads(e.read(8192)).get('error','')
                except (ValueError,AttributeError):detail=''
                finally:e.close()
                if status!=503 or time.monotonic()-started>=1:raise ValueError(detail if isinstance(detail,str) and re.fullmatch('archive_[a-z_]+',detail) else 'archive_control_failed') from None
                self.busy_retries+=1;time.sleep(.025)
            except urllib.error.URLError:raise ValueError('archive_control_unreachable') from None

def row_fingerprint(rows):
    columns=['id','grant_id','received_at_ms','envelope','bytes','reserved_bytes','batch_id']
    raw=json.dumps([[r[k] for k in columns] for r in rows],ensure_ascii=False,separators=(',',':')).encode()
    return hashlib.sha256(raw).hexdigest()

def status(db,state,now):
    if isinstance(db,OwnerConnection):return db.control({'op':'status','state':state,'now':now})
    if state=='attempt':db.execute('UPDATE ark_archive_stats SET last_attempt_ms=? WHERE id=1',(now,))
    elif state=='success':db.execute('UPDATE ark_archive_stats SET last_success_ms=?,last_error=NULL WHERE id=1',(now,))
    else:db.execute("UPDATE ark_archive_stats SET last_error='export_failed' WHERE id=1")

def transaction(db,fn):
    db.execute('BEGIN IMMEDIATE')
    try:
        result=fn();db.commit();return result
    except BaseException:
        db.rollback();raise

def claim(db,now):
    if isinstance(db,OwnerConnection):return db.control({'op':'claim','archive_id':uuid.uuid4().hex,'now':now})
    # Only the device appends rows; exporters are serialized by .ark-export.lock.
    # Fetch the bounded prefix before reserving the write lock, so cold-page
    # reads do not reject incoming device snapshots. Recheck it atomically below.
    rows=[];size=0
    for row in db.execute('SELECT id,bytes FROM ark_archive_outbox WHERE batch_id IS NULL ORDER BY id LIMIT ?', (MAX_ROWS,)).fetchall():
        if row['bytes']>MAX_BYTES:raise ValueError('archive_row_too_large')
        if size+row['bytes']>MAX_BYTES:break
        rows.append((row['id'],row['bytes']));size+=row['bytes']
    if not rows:return None
    aid=uuid.uuid4().hex
    def run():
        db.execute("INSERT INTO ark_archive_batch VALUES(?,?,'claimed',NULL,?,?,?,?,NULL)",(aid,now,len(rows),size,rows[0][0],rows[-1][0]))
        changed=db.execute('UPDATE ark_archive_outbox SET batch_id=? WHERE batch_id IS NULL AND id>=? AND id<=? RETURNING id,bytes',(aid,rows[0][0],rows[-1][0])).fetchall()
        if sorted((row['id'],row['bytes']) for row in changed)!=rows:raise ValueError('archive_claim_changed')
        return aid
    return transaction(db,run)

def batch_payload(db,b,rows=None):
    if rows is None:rows=db.execute('SELECT * FROM ark_archive_outbox WHERE batch_id=? ORDER BY id',(b['archive_id'],)).fetchall()
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
    rows=db.execute('SELECT * FROM ark_archive_outbox WHERE batch_id=? ORDER BY id',(aid,)).fetchall()
    payload=batch_payload(db,b,rows)
    m={'schema_version':1,'archive_id':aid,'kind':'ark_checkpoint','created_at_ms':b['created_at_ms'],'record_count':b['record_count'],'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),'source_range':{'format':'ark_jsonl','format_version':1,'lines':b['record_count'],'first_id':b['first_id'],'last_id':b['last_id']}}
    if b['manifest']:
        if json.loads(b['manifest'])!=m:raise ValueError('archive_manifest_mapping_mismatch')
    else:
        if isinstance(db,OwnerConnection):db.control({'op':'prepare','archive_id':aid,'manifest':m})
        else:transaction(db,lambda:db.execute("UPDATE ark_archive_batch SET manifest=?,state='prepared' WHERE archive_id=?",(json.dumps(m,sort_keys=True),aid)))
    receipt=spool.receipt(m)
    if receipt:
        clean_payload(spool,m,work)
        def finish():
            # Verify every original column, but keep JSON parsing, hashing and
            # concatenation outside the device's write lock. A changed mapping
            # or payload still aborts before any outbox deletion.
            current=db.execute('SELECT * FROM ark_archive_outbox WHERE batch_id=? ORDER BY id',(aid,)).fetchall()
            if current!=rows:raise ValueError('archive_mapping_changed')
            db.execute('DELETE FROM ark_archive_outbox WHERE batch_id=?',(aid,))
            db.execute("UPDATE ark_archive_batch SET state='complete',verified_at_ms=? WHERE archive_id=?",(receipt['verified_at_ms'],aid))
            db.execute('UPDATE ark_archive_stats SET last_ack_ms=MAX(COALESCE(last_ack_ms,0),?) WHERE id=1',(receipt['verified_at_ms'],))
        if isinstance(db,OwnerConnection):db.control({'op':'confirm','archive_id':aid,'manifest':m,'rows_sha256':row_fingerprint(rows),'verified_at_ms':receipt['verified_at_ms']})
        else:transaction(db,finish)
        return 'confirmed'
    final=spool.package(aid)/'payload.bin';pending=spool.root/'pending'/aid/'payload.bin';source=work/(aid+'.jsonl')
    # Other processes may consume disk after HTTP acceptance. Stop new file writes,
    # retain the immutable DB mapping, and allow the verified cleanup branch above.
    # publish_prepared renames on the same volume, so at most one payload is new.
    if not final.exists() and shutil.disk_usage(spool.root).free<DISK_RESERVE_BYTES+len(payload)+65536:
        raise ValueError('archive_export_disk_reserve')
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
    if isinstance(db,OwnerConnection):db.control({'op':'published','archive_id':aid})
    else:transaction(db,lambda:db.execute("UPDATE ark_archive_batch SET state='published' WHERE archive_id=?",(aid,)))
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
        if isinstance(db,OwnerConnection):db.control({'op':'prune_batch','archive_id':b['archive_id'],'manifest':m,'now':now})
        else:transaction(db,lambda:db.execute("DELETE FROM ark_archive_batch WHERE archive_id=? AND state='complete'",(b['archive_id'],)))
    # Current grants keep their lightweight cadence even after all body rows are removed.
    if isinstance(db,OwnerConnection):db.control({'op':'prune_baselines','now':now})
    else:transaction(db,lambda:db.execute('DELETE FROM ark_archive_baseline WHERE grant_id IN (SELECT b.grant_id FROM ark_archive_baseline b WHERE received_at_ms<? AND NOT EXISTS(SELECT 1 FROM ark_grant g WHERE g.grant_id=b.grant_id) AND NOT EXISTS(SELECT 1 FROM ark_archive_outbox o WHERE o.grant_id=b.grant_id) LIMIT 100)',(now-90*DAY,)))

def cycle(dbfile,root,now=None):
    now=int(time.time()*1000) if now is None else now;spool=Spool(root)
    fd=os.open(spool.root/'.ark-export.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        dbfile=Path(dbfile).resolve(strict=True)
        control_url=os.environ.get('ARK_ARCHIVE_CONTROL_URL','')
        if control_url:db=OwnerConnection(dbfile,control_url,os.environ.get('ARK_ARCHIVE_CONTROL_SECRET',''))
        else:
            db=sqlite3.connect('file:'+str(dbfile)+'?mode=rw',uri=True,timeout=.1,isolation_level=None,factory=ExportConnection);db.row_factory=sqlite3.Row
        work=spool.root/'ark-work'
        if work.is_symlink():raise ValueError('archive_work_symlink')
        work.mkdir(exist_ok=True,mode=0o700)
        try:
            status(db,'attempt',now)
            count={'published':0,'confirmed':0}
            pending=db.execute("SELECT archive_id FROM ark_archive_batch WHERE state!='complete' ORDER BY created_at_ms,archive_id LIMIT ?",(MAX_BATCHES,)).fetchall()
            disk_paused=False
            for b in pending:
                try:count[process_batch(db,spool,work,b['archive_id'])]+=1
                except ValueError as error:
                    if str(error)!='archive_export_disk_reserve':raise
                    disk_paused=True  # A later already-confirmed batch can still free disk.
            if disk_paused:raise ValueError('archive_export_disk_reserve')
            while count['published']+count['confirmed']<MAX_BATCHES:
                aid=claim(db,now)
                if aid is None:break
                count[process_batch(db,spool,work,aid)]+=1
            prune_metadata(db,spool,now)
            status(db,'success',now)
            count.update(busy_retries=db.busy_retries,sqlite_busy_timeout_ms=db.execute('PRAGMA busy_timeout').fetchone()[0],writer_mode='brain-owner' if isinstance(db,OwnerConnection) else 'direct')
            return count
        except BaseException:
            if db.in_transaction:db.rollback()
            # A second locked status write must not mask the original error/code.
            try:status(db,'failed',now)
            except (sqlite3.Error,ValueError):pass
            raise
        finally:db.close()
    finally:os.close(fd)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--db',required=True,type=Path);p.add_argument('--root',required=True,type=Path);p.add_argument('--require-owner',action='store_true',help='online entry: refuse missing owner URL, never use a direct writer');a=p.parse_args()
    try:
        if a.require_owner and not os.environ.get('ARK_ARCHIVE_CONTROL_URL'):raise ValueError('archive_control_required')
        print(json.dumps(cycle(a.db,a.root)))
    except Exception as e:print('ARK_EXPORT_FAILED:'+type(e).__name__+':'+str(getattr(e,'sqlite_errorname',str(e) if re.fullmatch('archive_[a-z_]+',str(e)) else 'NON_SQLITE')),file=__import__('sys').stderr);raise SystemExit(1)
