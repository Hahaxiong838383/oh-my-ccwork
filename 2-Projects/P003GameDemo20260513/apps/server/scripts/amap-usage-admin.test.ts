import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {authRoute} from '../src/routes/auth.js';
import {createAmapUsageAdminRoute} from '../src/routes/amap-usage-admin.js';
import {AmapUsageStore} from '../src/tools/amap-usage.js';
process.env.STUDIO_USER='quota-admin';process.env.STUDIO_PASS='synthetic-only';
process.env.STUDIO_EDITOR_USERS='quota-editor';process.env.STUDIO_EDITOR_PASS='synthetic-only';
const s=new AmapUsageStore(':memory:'),app=new Hono();app.route('/auth',authRoute);
app.route('/budget',createAmapUsageAdminRoute({store:()=>s,runtime:async()=>({enabled:true,key_configured:true})}));
async function token(username:string){return (await(await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'synthetic-only'})})).json()).token;}
const admin=await token('quota-admin'),editor=await token('quota-editor');
const body={request_id:randomUUID(),mode:'add',amount:5000,expected_revision:0};
const req=(method:string,value?:unknown,t=admin)=>app.request('/budget',{method,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
try{
 for(const method of ['GET','POST']){assert.equal((await req(method,method==='POST'?body:undefined,'invalid')).status,401);assert.equal((await req(method,method==='POST'?body:undefined,editor)).status,403);}
 assert.equal((await req('POST',{...body,enabled:true})).status,400);
 assert.equal((await req('POST',{...body,amount:-1})).status,400);
 assert.equal((await req('POST',body)).status,200);assert.equal((await req('POST',body)).status,200);
 assert.equal((await req('POST',{...body,amount:6000})).status,409);
 assert.equal((await req('POST',{...body,request_id:randomUUID()})).status,409);
 const r=await req('GET'),v=await r.json();assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(v.remaining,5000);assert.equal(v.estimate,true);assert.equal(v.runtime.enabled,true);
 assert.equal((await req('POST',{...body,request_id:randomUUID(),mode:'set_remaining',amount:0,expected_revision:v.revision})).status,200);
 assert.equal(s.snapshot().remaining,0);console.log('PASS quota admin: authentication, strict input, idempotency, stale revision, calibration, no-store');
}finally{s.close();}
