import {DatabaseSync} from 'node:sqlite';
import {existsSync,statSync} from 'node:fs';import {isAbsolute} from 'node:path';
import {configureAnalyticsWriter,validateWalMaxBytes,ANALYTICS_WAL_MAX_BYTES} from '../src/analytics/sqlite-policy.mjs';
let db:DatabaseSync|undefined;
try{
 const path=process.argv[2],max=validateWalMaxBytes(Number(process.argv[3]??ANALYTICS_WAL_MAX_BYTES));
 if(!path||!isAbsolute(path)||!existsSync(path))throw new Error('INVALID_CHECKPOINT_DATABASE');
 db=new DatabaseSync(path);const version=configureAnalyticsWriter(db);db.exec('PRAGMA busy_timeout=0;');
 const started=performance.now();
 // SQLite takes its exclusive WAL checkpoint lock; a competing checkpointer reports busy.
 const passive=db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as {busy:number;log:number;checkpointed:number};
 let bytes=0;try{bytes=statSync(path+'-wal').size;}catch{}
 let reclaimed=false,reclaimBusy=false;
 // Physical high-water is not unpersisted data. Reclaim only through SQLite, never unlink WAL.
 // TRUNCATE is an exceptional recovery at the hard admission threshold, after full PASSIVE.
 if(bytes>=max&&passive.busy===0&&passive.log===passive.checkpointed){
  const truncated=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number};
  reclaimed=truncated.busy===0;reclaimBusy=!reclaimed;
 }
 console.log(JSON.stringify({ok:true,sqlite_version:version,busy:passive.busy,log_frames:passive.log,checkpointed_frames:passive.checkpointed,duration_ms:performance.now()-started,reclaimed,reclaim_busy:reclaimBusy}));
}catch{console.log(JSON.stringify({ok:false,error:'ANALYTICS_CHECKPOINT_FAILED'}));process.exitCode=1;}
finally{db?.close();}
