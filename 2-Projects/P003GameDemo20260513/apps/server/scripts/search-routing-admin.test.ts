import assert from 'node:assert/strict';import {Hono} from 'hono';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {authRoute} from '../src/routes/auth.js';import {RoutingStore} from '../src/tools/search-routing-store.js';import {defaultRoutingConfig} from '../src/tools/search-routing-config.js';
const m:any=await import('../src/routes/search-routing-admin.js').catch(()=>({}));assert.equal(typeof m.createRoutingAdminRoute,'function','admin routing gate required');
process.env.STUDIO_USER='r7-admin';process.env.STUDIO_PASS='r7-test';process.env.STUDIO_EDITOR_USERS='r7-editor';process.env.STUDIO_EDITOR_PASS='r7-test';
const dir=mkdtempSync(join(tmpdir(),'routing-admin-')),s=new RoutingStore(join(dir,'routing.db')),sn='BJP00326060100100004';
let fail=false;const preview=async(_c:any,utterances:any[])=>({ok:true,decisions:utterances.map((u:any)=>({action:fail?'chat':u.text==='今天北京的天气'?'search':'chat'}))});
// Publish regression is injected separately: HTTP auth/scope/write tests do not fake routing correctness.
const app=new Hono();app.route('/auth',authRoute);app.route('/r',m.createRoutingAdminRoute({store:()=>s,scope:()=>[sn],preview,regression:async()=>({passed:!fail,total:20,failures:fail?[{expected:'search',actual:'chat'}]:[]})}));
async function token(user:string){return(await(await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password:'r7-test'})})).json()).token;}
const admin=await token('r7-admin'),editor=await token('r7-editor');
const req=(path:string,method='GET',body?:unknown,auth=admin)=>app.request('/r'+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
try {
 assert.equal((await req('','GET',undefined,'bad')).status,401);assert.equal((await req('','GET',undefined,editor)).status,403);
 assert.equal((await req('/draft','PUT',{expected_revision:0,config:defaultRoutingConfig()})).status,200);
 assert.equal((await req('/draft','PUT',{expected_revision:0,config:defaultRoutingConfig()})).status,409);
 assert.equal((await req('/preview','POST',{config:defaultRoutingConfig(),utterances:[{text:'今天北京的天气',at_ms:0}]})).status,200);assert.equal(s.state().revision,1);
 assert.equal((await req('/publish','POST',{expected_revision:1,sns:['BJP00326070803800006']})).status,403);
 assert.equal((await req('/publish','POST',{expected_revision:1,sns:[sn],enabled:true})).status,400);
 fail=true;assert.equal((await req('/publish','POST',{expected_revision:1,sns:[sn]})).status,409);assert.equal(s.snapshot(sn),null);
 fail=false;assert.equal((await req('/publish','POST',{expected_revision:1,sns:[sn]})).status,200);assert.ok(s.snapshot(sn));
 assert.equal((await req('/publish','POST',{expected_revision:1,sns:[sn]})).status,409);
 console.log('routing admin: permissions, scope, strict fields, no preview writes, CAS, regression gate passed');
} finally{s.close();rmSync(dir,{recursive:true,force:true});}
