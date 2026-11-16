/** Test helper: independent SQLite writer with a shared-memory barrier, isolated fixtures only. */
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const {path,sn,barrier,mode}=workerData,flags=new Int32Array(barrier),db=new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=3000');
parentPort!.postMessage('ready');Atomics.wait(flags,0,0,5000);
Atomics.store(flags,1,1);Atomics.notify(flags,1);
try{
 db.exec('BEGIN IMMEDIATE');
 if(mode==='revoke')db.prepare('INSERT INTO device_credential_revocation(sn,not_before_sec,revoked_by,reason,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(sn) DO UPDATE SET not_before_sec=excluded.not_before_sec').run(sn,Math.floor(Date.now()/1000),'test','test',Date.now(),Date.now());
 else db.prepare("UPDATE device_registry SET parent_account_id='raced-owner' WHERE sn=?").run(sn);
 db.exec('COMMIT');Atomics.store(flags,2,1);parentPort!.postMessage({ok:true});
}catch(e){parentPort!.postMessage({ok:false,error:(e as Error).message});}finally{db.close();}
