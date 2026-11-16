import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'backup-wrapper-'))),file=path.join(root,'db');
try {
 const db=new DatabaseSync(file);db.exec("CREATE TABLE analytics_meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE events(id TEXT);INSERT INTO events VALUES('real')");db.close();
 const wrapper=process.argv[2]??'scripts/analytics-maintenance.mjs';
 const env={...process.env,ANALYTICS_DB_PATH:file,ANALYTICS_ARCHIVE_ROOT:path.join(root,'spool'),ANALYTICS_BACKUP_DIR:path.join(root,'legacy')};
 function run(){const r=spawnSync(process.execPath,[wrapper,'backup'],{encoding:'utf8',env,timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
 const first=run();assert.equal(first.result.state,'published');
 const before=new DatabaseSync(file);const mark=before.prepare("SELECT value FROM analytics_meta WHERE key='last_backup_success_ms'").get().value;before.close();
 assert.equal(Number(mark),first.result.manifest.created_at_ms,'backup watermark must be the captured snapshot time, not publication completion');
 const retry=run();assert.equal(retry.result.state,'waiting_for_nas');assert.equal(retry.result.last_offsite_backup_ms,null);
 const after=new DatabaseSync(file);assert.equal(after.prepare("SELECT value FROM analytics_meta WHERE key='last_backup_success_ms'").get().value,mark,'waiting is not a fresh backup');after.close();
 assert.equal(fs.existsSync(path.join(root,'legacy')),false,'archive mode must not invoke independent keep2 pruning');
 assert.equal(fs.readdirSync(path.join(root,'spool/published')).length,1);
 // Recover a durable ready snapshot captured three days ago, not a fresh backup.
 const m={...first.result.manifest,archive_id:'f'.repeat(32),created_at_ms:Date.now()-3*86400000};
 const recovery=path.join(root,'recovery');fs.mkdirSync(path.join(recovery,'backup-work'),{recursive:true});
 fs.copyFileSync(path.join(root,'spool/published',first.result.manifest.archive_id,'payload.bin'),path.join(recovery,'backup-work/snapshot.sqlite3'));
 fs.writeFileSync(path.join(recovery,'backup-work/ready.json'),JSON.stringify(m));
 env.ANALYTICS_ARCHIVE_ROOT=recovery;
 const recovered=run();assert.equal(recovered.result.manifest.created_at_ms,m.created_at_ms);
 const recoveredDb=new DatabaseSync(file);assert.equal(Number(recoveredDb.prepare("SELECT value FROM analytics_meta WHERE key='last_backup_success_ms'").get().value),m.created_at_ms,'old ready recovery must not reset age to now');recoveredDb.close();
 console.log('PASS real maintenance wrapper exports once, preserves awaiting NAS, honest watermark, no keep2 overlap');
}finally{fs.rmSync(root,{recursive:true,force:true});}
