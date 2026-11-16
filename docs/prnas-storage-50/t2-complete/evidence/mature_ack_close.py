"""Run only after the isolated mature acceptance has PASS; no production paths."""
import importlib.util,json,pathlib,time,sys
root=pathlib.Path('/data');code=pathlib.Path('/code')
a=json.loads((root/'MATURE-ACCEPTANCE.json').read_text());assert a['result']=='PASS'
m=a['manifest'];receipt=json.loads((root/'nas-check/receipts'/(m['archive_id']+'.json')).read_text())
assert all(receipt[k]==m[k] for k in ['archive_id','sha256','bytes','record_count'])
spec=importlib.util.spec_from_file_location('storage_backup_job',code/'storage-backup-job.py');job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)
spool=job.archive.Spool(root/'backup-spool')
before=len(spool.list());r=spool.ack(m['archive_id'],m['sha256'],m['bytes'],m['record_count'])
assert r==spool.ack(m['archive_id'],m['sha256'],m['bytes'],m['record_count'])
assert (int(time.time()*1000)+8*3600000)//86400000==(m['created_at_ms']+8*3600000)//86400000,'different CST day: refuse automatic additional full backup'
status=job.run(root/'mature-50x6000x90.sqlite3',root/'backup-spool')
assert status['state']=='not_due' and status['pending_bytes']==0 and status['last_offsite_backup_ms']==m['created_at_ms']
assert status['offsite_age_ms']>0 and len(spool.list())==before
out={'result':'PASS','candidate':a['candidate'],'source_ack_tuple_matches_nas':True,'repeat_ack_identical':True,'packages_before':before,'packages_after':len(spool.list()),'state':status,'scope':'isolated mature package acknowledgement; real SSH transport tested separately with 100MiB'}
(root/'MATURE-SOURCE-ACK.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
