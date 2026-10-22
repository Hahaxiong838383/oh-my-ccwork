import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {authRoute} from '../src/routes/auth.js';
import {createCanaryAdminRoute, summarizeCanary} from '../src/routes/search-canary-admin.js';
process.env.STUDIO_USER='synthetic-admin';process.env.STUDIO_PASS='test-only';
process.env.STUDIO_EDITOR_USERS='synthetic-editor';process.env.STUDIO_EDITOR_PASS='test-only';
const sn='BJP00326070803800006',other='BJP00326060100200003';let saved=sn,active=false,writes=0;
const deps={read:async()=>({selected_sn:saved}),eligible:(s:string)=>[sn,other].includes(s),isOpen:()=>active,save:(s:string)=>{saved=s;writes++}};
const app=new Hono();app.route('/auth',authRoute);app.route('/canary',createCanaryAdminRoute(deps));
async function token(username:string){return (await(await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'test-only'})})).json()).token;}
const admin=await token('synthetic-admin'),editor=await token('synthetic-editor');
async function req(method:string,body?:unknown,t=admin){return app.request('/canary'+(method==='PUT'?'/device':''),{method,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
assert.equal((await req('GET',undefined,'invalid')).status,401);assert.equal((await req('GET',undefined,editor)).status,403);
assert.equal((await req('GET')).status,200);assert.equal((await req('PUT',{sn:other})).status,200);assert.equal(saved,other);assert.equal(writes,1);
for(const body of [{sn:'03800006'},{sn:'BJP00326060100200099'},{sn,enabled:true}])assert.equal((await req('PUT',body)).status,400);
active=true;assert.equal((await req('PUT',{sn})).status,409);assert.equal(writes,1);
assert.equal((await req('PUT',{sn},editor)).status,403);
const base={now:10000,enabled:false,expires:90000,allowlist:[sn],selected:sn,lease:{agent:'p003-search-canary-20261021',until_ms:20000,generation:'g'},health:{status:'ok',search:false,tools:false},settings:{allowlist:[sn]}};
assert.equal(summarizeCanary(base).state,'closed');
assert.equal(summarizeCanary({...base,enabled:true,health:{...base.health,search:true}}).state,'p1');
assert.equal(summarizeCanary({...base,enabled:true,expires:9999}).state,'expired');
assert.equal(summarizeCanary({...base,enabled:true,lease:null}).state,'blocked');
assert.equal(summarizeCanary({...base,enabled:true,health:null}).state,'blocked');
assert.equal(summarizeCanary({...base,enabled:true,health:{...base.health,search:true},settings:{allowlist:[other]}}).state,'blocked');
assert.equal(summarizeCanary({...base,enabled:false,health:null}).health_ok,false);
assert.equal(summarizeCanary({...base,enabled:true,expires:base.now+36*3600_000,health:{...base.health,search:true}}).state,'p1');
assert.equal(summarizeCanary({...base,enabled:true,expires:base.now+36*3600_000+1}).state,'blocked');
console.log('canary admin: auth, scope, no activation, expiry and unavailable checks passed');

const second='BJP00326060100100004';
const pair={...base,enabled:true,selected:second,allowlist:[sn,second],settings:{allowlist:[second,sn]},health:{...base.health,search:true}};
assert.equal(summarizeCanary(pair).state,'p1');assert.equal(summarizeCanary(pair).selected_prepared,true);
assert.equal(summarizeCanary({...pair,settings:{allowlist:[sn]}}).state,'blocked');
assert.equal(summarizeCanary({...pair,allowlist:[sn,sn],settings:{allowlist:[sn,sn]}}).state,'blocked');
assert.equal(summarizeCanary({...pair,selected:other}).selected_prepared,false);
