import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
const dir = mkdtempSync(join(tmpdir(), 'p003-listening-admin-'));
process.chdir(dir);
for (const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK','SMS','PAIRING','OTA','DIAGNOSTICS','TELEMETRY']) process.env[key+'_DB_PATH'] = join(dir,key+'.db');
Object.assign(process.env, {STUDIO_USER:'fake-admin',STUDIO_PASS:'fake-password',STUDIO_EDITOR_USERS:'fake-editor',STUDIO_EDITOR_PASS:'fake-password',STUDIO_GUEST_USER:'fake-guest',STUDIO_GUEST_PASS:'fake-password'});
const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const app = new Hono(); app.route('/api/auth', authRoute); app.route('/api/admin', adminDataRoute);
const path = '/api/admin/worker-voice/listening';
let checks = 0;
async function status(response: Promise<Response>, expected: number) { const r = await response; assert.equal(r.status,expected); checks++; return r; }
await status(app.request(path),401);
let admin = '';
for (const role of ['admin','editor','guest']) {
  const login=await app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'fake-'+role,password:'fake-password'})});
  const token=(await login.json()).token;
  if(role==='admin') admin=token;
  else for(const [suffix,method] of [['','GET'],['','PUT'],['/disable','POST'],['/restore','POST']]) await status(app.request(path+suffix,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},...(method==='GET'?{}:{body:'{}'})}),403);
}
const request=(suffix='',method='GET',body?:unknown)=>app.request(path+suffix,{method,headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const first=await (await status(request(),200)).json();
assert.equal(first.config.enabled,false);assert.deepEqual(first.config.allowlist,[]);assert.equal(first.config.revision,1);
assert.equal(first.runtime.ready,false);assert.equal(first.runtime.effective_enabled,false);assert.equal(first.runtime.applied_revision,null);
assert.equal(first.config.tuning.max_session_sec,1800);checks++;
const patch=structuredClone(first.config);delete patch.revision;delete patch.schema_version;
patch.allowlist=['BJP00326070803800006'];patch.tuning.feedback_max_chars=100;
let saved=await (await status(request('','PUT',{expected_revision:1,settings:patch}),200)).json();
assert.equal(saved.config.revision,2);assert.equal(saved.config.tuning.feedback_max_chars,100);
assert.equal(saved.history[0].actor,'fake-admin');assert.equal(saved.history[0].revision,2);checks++;
await status(request('','PUT',{expected_revision:1,settings:patch}),409);
for(const settings of [null,{...patch,extra:true},{...patch,allowlist:['03800006']},{...patch,allowlist:['BJP00326023103800006']},
  {...patch,allowlist:[...patch.allowlist,...patch.allowlist]},{...patch,scenes:[]}, {...patch,scenes:['singing','singing']},
  {...patch,tuning:{...patch.tuning,max_session_sec:1801}},{...patch,tuning:{...patch.tuning,feedback_max_chars:'100'}},
  {...patch,tuning:{...patch.tuning,summary_interval_sec:0}},{...patch,tuning:{...patch.tuning,lease_ttl_sec:999}}]) {
  await status(request('','PUT',{expected_revision:2,settings}),400);
}
await status(request('','PUT',{expected_revision:2,settings:{...patch,enabled:true}}),409);
await status(request('','PUT',{expected_revision:2,settings:patch,extra:1}),400);
await status(request('/restore','POST',{expected_revision:2,revision:99}),404);
const restored=await (await status(request('/restore','POST',{expected_revision:2,revision:1}),200)).json();
assert.equal(restored.config.revision,3);assert.equal(restored.config.tuning.feedback_max_chars,80);assert.equal(restored.history[0].operation,'restore');checks++;
await status(request('/restore','POST',{expected_revision:2,revision:1}),409);
const disabled=await (await status(request('/disable','POST',{}),200)).json();
assert.equal(disabled.config.enabled,false);assert.equal(disabled.config.revision,4);assert.equal(disabled.history[0].operation,'disable');checks++;
assert.equal(disabled.runtime.active_sessions,null);assert.equal(disabled.history.length,3);checks++;
await status(request('','PUT',{payload:'x'.repeat(70000)}),413);
const inspector=new DatabaseSync(process.env.CONFIG_DB_PATH!);
inspector.exec("UPDATE listening_settings SET value_json='corrupt' WHERE id=1");
const unavailable=await (await status(request(),503)).json();assert.equal(unavailable.ok,false);assert.equal(unavailable.code,'corrupt_config');checks++;
await status(request('','PUT',{expected_revision:4,settings:patch}),503);inspector.close();
console.log('listening admin PASS:',checks,'checks (real auth, SQLite, CAS, restore, audit, runtime not ready)');
rmSync(dir,{recursive:true,force:true});process.exit(0);
