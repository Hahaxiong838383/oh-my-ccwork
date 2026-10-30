import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ListeningAuthorityStore,type AuthoritySession } from '../src/listening-authority-store.js';
import { defaultListeningConfig } from '../src/listening-settings.js';
import { listeningSnapshot } from '../src/listening-authority-store.js';
const sn='BJP00326070803800006';const now=1800000000000;
function setup(){const dir=mkdtempSync(join(tmpdir(),'listening-authority-'));const file=join(dir,'devices.db');const db=new DatabaseSync(file);
 db.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,account_id TEXT);CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);`);
 db.prepare('INSERT INTO device_registry VALUES(?,?,?)').run(sn,'active','account-1');
 const store=new ListeningAuthorityStore(file);return {store,db,file,cleanup(){store.close();db.close();rmSync(dir,{recursive:true,force:true});}};}
function session(epoch:number):AuthoritySession{return {sn,room:`sn-${sn}-1800000000`,session_id:'session-1',trace_id:'trace-1',account_id:'account-1',device_epoch:epoch,worker_account:'worker-service',agent:'rust-worker',build_sha:'a'.repeat(40),source:'normal',source_generation:0,source_cutoff_ms:now+1800000,credential_iat:now/1000-1,credential_expires_ms:now+1800000,expires_at_ms:now+1800000,grant_hash:'a'.repeat(64),supports:['listening_mode_v1']};}
test('authority survives restart and registry A→B→A/delete invalidate old ownership epoch',()=>{const f=setup();try{
 const before=f.store.device(sn);assert.ok(before);f.store.register(session(before.epoch));assert.equal(f.store.session('session-1')?.account_id,'account-1');const reopened=new ListeningAuthorityStore(f.file);assert.equal(reopened.session('session-1')?.account_id,'account-1');reopened.close();
 f.db.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run('account-2',sn);f.db.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run('account-1',sn);
 assert.ok(f.store.device(sn)!.epoch>before.epoch);
 f.db.prepare('DELETE FROM device_registry WHERE sn=?').run(sn);f.db.prepare('INSERT INTO device_registry VALUES(?,?,?)').run(sn,'active','account-1');
 assert.ok(f.store.device(sn)!.epoch>before.epoch);assert.equal(f.store.session('session-1')?.device_epoch,before.epoch);
}finally{f.cleanup();}});
test('entry snapshot stays frozen, old epoch/id cannot reopen, closed entry allows newer seq',()=>{const f=setup();try{
 f.store.register(session(f.store.device(sn)!.epoch));const config=defaultListeningConfig();config.revision=3;
 const a=f.store.acquireEntry('session-1','trace-1:1','story',1,listeningSnapshot(config),now);
 config.revision=4;config.tuning.feedback_max_chars=120;
 const b=f.store.acquireEntry('session-1','trace-1:1','story',2,listeningSnapshot(config),now+1000);
 assert.equal(b.snapshot.revision,3);assert.equal(b.snapshot.tuning.feedback_max_chars,80);
 assert.throws(()=>f.store.acquireEntry('session-1','trace-1:1','story',1,listeningSnapshot(config),now+1001),/stale_epoch/);
 assert.throws(()=>f.store.acquireEntry('session-1','trace-1:2','story',3,listeningSnapshot(config),now+1001),/entry_conflict/);
 f.store.closeEntry('session-1','trace-1:1',3);
 assert.throws(()=>f.store.acquireEntry('session-1','trace-1:1','story',3,listeningSnapshot(config),now+1002),/entry_closed/);
 assert.equal(f.store.acquireEntry('session-1','trace-1:2','sharing',4,listeningSnapshot(config),now+1002).snapshot.revision,4);
 assert.equal(a.deadline_ms,now+1800000);
}finally{f.cleanup();}});
test('durable request replay rejects changed content, concurrent tasks and second feedback in same epoch',()=>{const f=setup();try{
 f.store.register(session(f.store.device(sn)!.epoch));f.store.acquireEntry('session-1','trace-1:1','story',1,listeningSnapshot(defaultListeningConfig()),now);
 const claim=(id:string,hash:string,epoch=1,kind='feedback',at=now)=>f.store.claimContent('session-1','trace-1:1',id,hash,kind,epoch,at,5000);
 assert.equal(claim('r1','h1'),null);assert.equal(claim('r1','h1')?.status,'running');assert.throws(()=>claim('r1','h2'),/request_conflict/);
 assert.throws(()=>claim('r2','h2',1,'summary'),/content_busy/);
 f.store.finishContent('session-1','r1','done');assert.throws(()=>claim('r3','h3',1,'feedback',now+6000),/request_spent/);
 f.store.acquireEntry('session-1','trace-1:1','story',2,listeningSnapshot(defaultListeningConfig()),now+1000);assert.throws(()=>claim('r4','h4',2,'feedback',now+1000),/feedback_cooldown/);
 f.store.acquireEntry('session-1','trace-1:1','story',2,listeningSnapshot(defaultListeningConfig()),now+6000);assert.equal(claim('r5','h5',2,'feedback',now+6000),null);
}finally{f.cleanup();}});
