import assert from 'node:assert/strict';
import {Hono} from 'hono';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {authRoute} from '../src/routes/auth.js';import {RoutingStore} from '../src/tools/search-routing-store.js';import {createRoutingAdminRoute} from '../src/routes/search-routing-admin.js';
process.env.STUDIO_USER='p1-routing-admin';process.env.STUDIO_PASS='synthetic';process.env.STUDIO_EDITOR_USERS='p1-routing-editor';process.env.STUDIO_EDITOR_PASS='synthetic';
const dir=mkdtempSync(tmpdir()+'/global-routing-'),main=new RoutingStore(dir+'/p1.db',Date.now,{allowGlobal:true}),candidate=new RoutingStore(dir+'/p2.db');
const app=new Hono();app.route('/auth',authRoute);let pass=true;
const deps={scope:()=>[],preview:async()=>({}),regression:async()=>({passed:pass,total:20,failures:pass?[]:['synthetic']})};
app.route('/p1',createRoutingAdminRoute({...deps,store:()=>main,allowGlobal:true}));app.route('/p2',createRoutingAdminRoute({...deps,store:()=>candidate}));
async function token(username:string){return(await(await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'synthetic'})})).json()).token;}
const admin=await token('p1-routing-admin'),editor=await token('p1-routing-editor');
const req=(path:string,body:unknown,auth=admin)=>app.request(path,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)});
try{
 assert.equal((await req('/p1/publish-all',{expected_revision:0},editor)).status,403);
 assert.equal((await req('/p2/publish-all',{expected_revision:0})).status,403);
 assert.equal((await req('/p1/publish-all',{expected_revision:0,tools:true})).status,400);
 pass=false;assert.equal((await req('/p1/publish-all',{expected_revision:0})).status,409);assert.equal(main.state().revision,0);
 pass=true;const published=await(await req('/p1/publish-all',{expected_revision:0})).json();assert.equal(published.ok,true);
 const fresh='BJP00326079999999999';assert.equal(main.snapshot(fresh)?.version,published.version);
 assert.equal((await req('/p1/publish-all',{expected_revision:0})).status,409);
 assert.equal((await req('/p1/rollback-all',{expected_revision:1,version:published.version})).status,200);
 assert.equal(candidate.state().revision,0);assert.equal(candidate.snapshot(fresh),null);
 console.log('PASS global HTTP: admin only, strict fields, regression/CAS gate, future SN, isolated P2, rollback');
}finally{main.close();candidate.close();rmSync(dir,{recursive:true,force:true});}
