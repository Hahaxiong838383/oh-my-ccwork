import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as nas from './storage-nas-verify.mjs';
assert.equal(typeof nas.rotateBackups,'function','daily/weekly retention is missing');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nas-retention-')));
try {
 const source=path.join(root,'db');const db=new DatabaseSync(source);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(id TEXT); INSERT INTO events VALUES('accepted')");db.close();
 const bytes=fs.readFileSync(source),hash=createHash('sha256').update(bytes).digest('hex');
 const now=Date.parse('2026-11-16T04:00:00Z'),day=86400000;
 async function add(n,created=now-n*day,ack=true,kind='analytics_backup') {
  const id=n.toString(16).padStart(32,'0');const m={schema_version:1,archive_id:id,kind,created_at_ms:created,record_count:1,bytes:bytes.length,sha256:hash,source_range:{tables:{events:1}}};
  const f=path.join(root,'meta.json');fs.writeFileSync(f,JSON.stringify(m));const p=nas.prepare(root,f,{reserveBytes:0});fs.copyFileSync(source,p.payload);await nas.finalize(root,id);
  if(ack)nas.acknowledge(root,id,{archive_id:id,sha256:hash,bytes:bytes.length,record_count:1,verified_at_ms:now});
  return id;
 }
 const ids=[];for(let n=0;n<45;n++)ids.push(await add(n));
 const ark=await add(100,now-60*day,true,'ark_checkpoint'),unacked=await add(101,now-61*day,false);
 const result=await nas.rotateBackups(root,{nowMs:now,reserveBytes:0});
 for(let n=0;n<7;n++)assert.ok(result.kept.includes(ids[n]),'last 7 distinct daily slots retained');
 // Mon Nov16, Sun Nov15, Sun Nov8, Sun Nov1 are latest snapshots of four ISO weeks.
 for(const n of [0,1,8,15])assert.ok(result.kept.includes(ids[n]),'last 4 weekly slots retained');
 assert.equal(result.kept.length,9);assert.equal(result.removed.length,36);
 assert.ok(fs.existsSync(path.join(root,'packages',ark)));assert.ok(fs.existsSync(path.join(root,'packages',unacked)));
 const retiredMeta={schema_version:1,archive_id:ids[44],kind:'analytics_backup',created_at_ms:now-44*day,record_count:1,bytes:bytes.length,sha256:hash,source_range:{tables:{events:1}}};
 fs.writeFileSync(path.join(root,'list.json'),JSON.stringify([retiredMeta]));
 assert.ok(!nas.queue(root,path.join(root,'list.json')).includes(ids[44]),'rotation must not redownload retired acknowledged backups');
 assert.equal(result.restore.integrity_check,'ok');assert.equal(result.restore.record_count,1);
 // Corruption of newest must abort rotation before any older good copy is removed.
 const next=await add(102,now+day);fs.writeFileSync(path.join(root,'packages',next,'payload.bin'),Buffer.alloc(bytes.length));
 const before=fs.readdirSync(path.join(root,'packages')).sort();
 await assert.rejects(()=>nas.rotateBackups(root,{nowMs:now+day,reserveBytes:0}),/CHECKSUM/);
 assert.deepEqual(fs.readdirSync(path.join(root,'packages')).sort(),before);
 // Enforce budget before allocating the next incoming payload; zero is real, not fallback.
 const m={schema_version:1,archive_id:'f'.repeat(32),kind:'transfer_probe',created_at_ms:now,record_count:0,bytes:bytes.length,sha256:hash,source_range:{}};
 fs.writeFileSync(path.join(root,'meta.json'),JSON.stringify(m));assert.throws(()=>nas.prepare(root,path.join(root,'meta.json'),{budgetBytes:1,reserveBytes:0}),/BUDGET/);
 assert.ok(!fs.existsSync(path.join(root,'incoming',m.archive_id)));
 console.log('PASS NAS daily/weekly retention, real restore gate, corruption preserves old backups, budget');
}finally{fs.rmSync(root,{recursive:true,force:true});}
