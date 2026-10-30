import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { ListeningSettingsStore } from '../src/listening-settings-store.js';
import { defaultListeningConfig, parseListeningEditable, listeningPolicyFromConfig } from '../src/listening-settings.js';
const editable = () => {const {schema_version, revision, ...p} = defaultListeningConfig();return p;};
if(process.argv[2]==='--racer') {
  const store=new ListeningSettingsStore(process.argv[3]);
  try {store.save(1,{...editable(),allowlist:['BJP00326070803800006']},process.argv[4]);console.log('saved');}
  catch(e) {if((e as Error).message==='revision_conflict') console.log('conflict');else throw e;}
  store.close();process.exit(0);
}
const dir=mkdtempSync(join(tmpdir(),'p003-listening-store-'));let checks=0;
try {
  const file=join(dir,'config.db');let store=new ListeningSettingsStore(file);const other=new ListeningSettingsStore(file);
  const draft=editable();draft.allowlist=['BJP00326070803800006'];draft.tuning.feedback_max_chars=120;
  const second=store.save(1,draft,'admin-one');assert.equal(second.revision,2);checks++;
  assert.throws(()=>other.save(1,editable(),'stale-admin'),/revision_conflict/);checks++;
  const auditDb=new DatabaseSync(file);
  auditDb.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY,value TEXT); INSERT INTO unrelated VALUES('existing','keep');");
  auditDb.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON listening_settings_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END;");
  assert.throws(()=>store.save(2,editable(),'failed-admin'),/test audit failure/);
  assert.equal(store.read().config.revision,2);assert.equal(store.history().length,1);checks++;
  auditDb.exec('DROP TRIGGER fail_audit');
  store.close();store=new ListeningSettingsStore(file);
  assert.equal(store.read().config.tuning.feedback_max_chars,120);checks++;
  const opened=store.save(2,{...draft,enabled:true},'authorized-integration');
  const closed=other.disable('operator');assert.equal(closed.enabled,false);assert.equal(closed.tuning.feedback_max_chars,120);assert.equal(closed.revision,opened.revision+1);checks++;
  const restored=store.restore(4,3,'operator');assert.equal(restored.enabled,false);assert.equal(restored.revision,5);checks++;
  assert.deepEqual(listeningPolicyFromConfig(restored),{version:5,enabled:false,allowlist:['BJP00326070803800006']});checks++;
  assert.equal((auditDb.prepare("SELECT value FROM unrelated WHERE id='existing'").get() as any).value,'keep');checks++;
  const oldConfig=store.read().config;
  auditDb.exec("UPDATE listening_settings SET value_json='broken' WHERE id=1");
  assert.throws(()=>store.read(),/corrupt_config/);assert.throws(()=>store.save(5,editable(),'admin'),/corrupt_config/);checks++;
  auditDb.prepare('UPDATE listening_settings SET value_json=? WHERE id=1').run(JSON.stringify(oldConfig));
  for(const bad of [{...draft,allowlist:Array(1)},{...draft,scenes:Array(1)},Object.assign(Object.create(draft),{a:1,b:2,c:3,d:4}),{...draft,tuning:{...draft.tuning,voice_invitation_enabled:1}}]) assert.equal(parseListeningEditable(bad),null);checks++;
  store.close();other.close();auditDb.close();
  const racePath=join(dir,'race.db');new ListeningSettingsStore(racePath).close();
  const run=(actor:string)=>new Promise<string>((resolve,reject)=>{
    const p=spawn(process.execPath,['--experimental-sqlite','--import','tsx',process.argv[1],'--racer',racePath,actor],{stdio:['ignore','pipe','pipe']});let out='',err='';
    p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));
  });
  assert.deepEqual((await Promise.all([run('race-a'),run('race-b')])).sort(),['conflict','saved']);checks++;
  const raced=new ListeningSettingsStore(racePath);assert.equal(raced.read().config.revision,2);assert.equal(raced.history().length,1);const view=raced.view();assert.equal(view.config.revision,view.history[0].revision);raced.close();checks++;
  console.log('listening config store PASS:',checks,'checks; persistence, two-process CAS, audit rollback, restore, unrelated data preserved');
} finally {rmSync(dir,{recursive:true,force:true});}
