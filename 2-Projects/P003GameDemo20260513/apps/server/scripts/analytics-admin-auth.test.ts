import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Hono} from 'hono';
const dir=mkdtempSync(join(tmpdir(),'analytics-admin-auth-'));
for(const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK','SMS','PAIRING','OTA','DIAGNOSTICS','TELEMETRY'])process.env[key+'_DB_PATH']=join(dir,key.toLowerCase()+'.db');
process.env.STUDIO_USER='fake-admin';process.env.STUDIO_PASS='fake-admin-password';process.env.STUDIO_EDITOR_USERS='fake-editor';process.env.STUDIO_EDITOR_PASS='fake-editor-password';process.env.STUDIO_GUEST_USER='fake-guest';process.env.STUDIO_GUEST_PASS='fake-guest-password';process.env.ANALYTICS_INTERNAL_SECRET='fake-internal';
const {authRoute}=await import('../src/routes/auth.js');
const {adminDataRoute}=await import('../src/routes/admin-data.js');
const app=new Hono();app.route('/api/auth',authRoute);app.route('/api/admin',adminDataRoute);
let calls=0;const realFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{calls++;assert.equal(new URL(String(input)).hostname,'127.0.0.1');assert.equal(new Headers(init?.headers).get('X-Analytics-Internal-Token'),'fake-internal');return Response.json({ok:true,items:[]});};
const login=async(role:string)=>{const r=await app.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fake-'+role,password:'fake-'+role+'-password'})});assert.equal(r.status,200);return (await r.json()).token;};
for(const role of ['editor','guest','admin']){
 const token=await login(role);for(const path of ['overview','daily','batches','events','registry','health','collection-config','control']){
  const r=await app.request('/api/admin/analytics/'+path,{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,role==='admin'?200:403,role+' '+path);
 }
}
assert.equal(calls,9);assert.equal((await app.request('/api/admin/analytics/daily')).status,401);
for(const role of ['editor','guest','admin']){const token=await login(role);const response=await app.request('/api/admin/analytics/control',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({expected_revision:0,enabled:false,subjects:[],hour:23})});assert.equal(response.status,role==='admin'?200:403);if(role==='admin'){const old=await app.request('/api/admin/device-config/global',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({key:'analytics.event_upload_enabled',value:true})});assert.equal(old.status,409);}}
globalThis.fetch=realFetch;rmSync(dir,{recursive:true,force:true});console.log('analytics admin actual gateway: PASS (real admin login/middleware; editor/guest/unauthed denied)');process.exit(0);
