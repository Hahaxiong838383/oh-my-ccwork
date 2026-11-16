"""Private execution harness; all inputs synthetic, writes only given NAS test directory."""
import argparse,hashlib,json,os,sqlite3,subprocess,time,traceback,resource
from pathlib import Path

def report(file,value):
 t=file.with_suffix('.tmp');t.write_text(json.dumps(value,indent=2));t.replace(file)
def inspect(file):
 with sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True) as db:
  db.execute('PRAGMA cache_size=-131072')
  schema=db.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name").fetchall()
  tables=[x[1] for x in schema if x[0]=='table' and not x[1].startswith('sqlite_')]
  counts={};devices=None
  for n in tables:
   if n=='analytics_event_seen':
    counts[n],devices=db.execute('SELECT count(1),count(DISTINCT device_key) FROM analytics_event_seen NOT INDEXED').fetchone()
   else:counts[n]=db.execute('SELECT count(1) FROM "'+n+'" NOT INDEXED').fetchone()[0]
  samples={n:[db.execute('SELECT * FROM "'+n+'" ORDER BY rowid LIMIT 1').fetchone(),db.execute('SELECT * FROM "'+n+'" ORDER BY rowid DESC LIMIT 1').fetchone()] for n in tables}
 return {'schema':schema,'counts':counts,'devices':devices,'sample_sha256':hashlib.sha256(json.dumps(samples,sort_keys=True).encode()).hexdigest()}
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--code',required=True);p.add_argument('--candidate',required=True);a=p.parse_args()
 root=Path(a.root);code=Path(a.code);source=root/'mature-50x6000x90.sqlite3';progress=source.with_suffix('.progress.json')
 status={'candidate':a.candidate,'scope':'synthetic actual-row-count mature backup/restore on PRnas; NOT cloud ingestion benchmark','started_at_s':time.time()};dest=root/'MATURE-ACCEPTANCE.json'
 try:
  status['phase']='await_fixture';report(dest,status)
  wait=time.monotonic()+14400
  while True:
   v=json.loads(progress.read_text()) if progress.exists() else {}
   if v.get('phase')=='complete':break
   if time.monotonic()>wait:raise TimeoutError('fixture deadline')
   time.sleep(20)
  expected={'analytics_event':4200000,'analytics_event_seen':27000000,'analytics_rollup_fact':54000000,'analytics_settlement':4200000}
  assert all(v['counts'].get(k)==n for k,n in expected.items()),v.get('counts')
  status.update(phase='source_check',fixture=v,source_bytes=source.stat().st_size);report(dest,status)
  before=inspect(source);assert all(before['counts'][k]==n for k,n in expected.items());assert before['devices']==50
  expected_schema=json.loads((code/'mature-schema.json').read_text())
  assert {(r['type'],r['name']):r['sql'] for r in expected_schema if r['sql']}=={(r[0],r[1]):r[2] for r in before['schema'] if r[2]},'expected schema/index mismatch'
  status.update(source_check=before,phase='backup');report(dest,status)
  t=time.monotonic()
  with (root/'mature-backup.stdout.log').open('w') as out,(root/'mature-backup.stderr.log').open('w') as err:
   r=subprocess.run(['python3',str(code/'storage-backup-job.py'),'--database',str(source),'--root',str(root/'backup-spool')],stdout=out,stderr=err,timeout=7260)
  status.update(backup_exit=r.returncode,backup_elapsed_s=time.monotonic()-t);report(dest,status)
  if r.returncode:raise RuntimeError('backup failed')
  job=json.loads((root/'mature-backup.stdout.log').read_text());m=job['manifest'];assert job['state']=='published';assert m['source_range']['tables']==before['counts'];assert job['pending_bytes']==m['bytes']
  status.update(manifest=m,budget_seconds=job['budget_seconds'],pipeline_MiB_per_s=m['bytes']/1048576/status['backup_elapsed_s'],phase='nas_restore');report(dest,status)
  # A closed package already on PRnas: hardlink avoids an irrelevant extra 50GB
  # transfer copy; WAN resume was independently measured with 100MiB fixtures.
  nas=root/'nas-check';(nas/'incoming'/m['archive_id']).mkdir(parents=True)
  (nas/'incoming'/m['archive_id']/'manifest.json').write_text(json.dumps(m))
  os.link(root/'backup-spool/published'/m['archive_id']/'payload.bin',nas/'incoming'/m['archive_id']/'payload.bin')
  script="import * as n from "+json.dumps((code/'storage-nas-verify.mjs').as_uri())+";const r="+json.dumps(str(nas))+",m="+json.dumps(m)+";await n.finalize(r,m.archive_id);n.acknowledge(r,m.archive_id,{archive_id:m.archive_id,bytes:m.bytes,sha256:m.sha256,record_count:m.record_count,verified_at_ms:Date.now()});console.log(JSON.stringify(await n.rotateBackups(r)));"
  t=time.monotonic()
  with (root/'mature-nas.stdout.log').open('w') as out,(root/'mature-nas.stderr.log').open('w') as err:
   r=subprocess.run(['node','--input-type=module','-e',script],stdout=out,stderr=err,timeout=7200)
  status.update(nas_exit=r.returncode,nas_verify_restore_elapsed_s=time.monotonic()-t);report(dest,status)
  if r.returncode:raise RuntimeError('NAS verify/restore failed')
  nas_result=json.loads((root/'mature-nas.stdout.log').read_text());after=inspect(nas/'restore/latest.sqlite3')
  assert after==before,'schema/count/sample mismatch'
  assert nas_result['restore']['sha256']==m['sha256'] and nas_result['restore']['record_count']==sum(before['counts'].values())
  status.update(phase='complete',result='PASS',nas_result=nas_result,restored_check=after,elapsed_s=time.time()-status['started_at_s'],maxrss_child_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss);report(dest,status)
 except Exception as e:
  status.update(phase='failed',result='FAIL',error=type(e).__name__+':'+str(e),traceback=traceback.format_exc());report(dest,status);raise
if __name__=='__main__':main()
