import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {storageRoute} from '../src/storage/routes.js';
import {analyticsControlRoute} from '../src/analytics/control-route.js';
import {AnalyticsDeviceReader} from '../src/analytics/device-context.js';
import {AnalyticsStore} from '../src/analytics/store.js';
import {capacityReader} from '../src/analytics/capacity.js';
const dir=mkdtempSync(join(tmpdir(),'storage-http-'));process.env.CONFIG_DB_PATH=join(dir,'config.db');
const {configStore:c}=await import('../src/config-store.js');
const sn='BJP00326070803800006';
let enabledArk=0;
const count=()=>({analytics:c.analyticsPolicy()?.enabled?c.analyticsPolicy()!.subjects.length:0,ark:enabledArk});
const auth=(s:string|undefined)=>s==='Bearer admin'?'admin':s==='Bearer viewer'?'viewer':'none';
const route=storageRoute({authorize:auth,read:()=>({policy:c.storagePolicy(),profile:c.storageProfile(),enabled:count(),ark_capacity:{}}),save:p=>c.saveStoragePolicy(p,count,'test')});
const req=(method:string,body?:unknown,authorization='Bearer admin')=>route.request('/',{method,headers:{authorization,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
try{
 assert.equal((await req('GET',undefined,'')).status,401);assert.equal((await req('GET',undefined,'Bearer viewer')).status,403);
 assert.equal((await req('PUT',{expected_revision:0,target_devices:100,archive_enabled:true})).status,400);
 assert.equal((await req('PUT',{expected_revision:0,target_devices:100})).status,200);
 assert.equal((await req('PUT',{expected_revision:0,target_devices:50})).status,409);
 enabledArk=51;assert.equal((await req('PUT',{expected_revision:1,target_devices:50})).status,409);assert.equal(c.storagePolicy().target_devices,100);enabledArk=0;
 // Independent read-only DB connection must see policy changes immediately despite the 60s metrics cache.
 const reader=new AnalyticsDeviceReader({devicesPath:join(dir,'devices.db'),configPath:process.env.CONFIG_DB_PATH,deviceKeySecret:'test',envAllow:[]});
 const store=new AnalyticsStore(join(dir,'analytics.db'));const capacity=capacityReader(store,()=>reader.storageControls());
 const first=capacity();assert.equal(first.target_devices,100);
 assert.equal((await req('PUT',{expected_revision:1,target_devices:49})).status,200);
 const second=capacity();assert.equal(second.checked_at_ms,first.checked_at_ms);assert.equal(second.target_devices,49);assert.equal(second.storage_policy_revision,2);store.close();
 let mode='race';
 const control=analyticsControlRoute({authorize:auth,internalUrl:'http://127.0.0.1:3006',internalSecret:'test',devices:()=>[{sn,status:'active',note:''}],policy:()=>c.analyticsPolicy(),storageRevision:()=>c.storagePolicy().revision,
  save:(p,a,b,admission)=>c.saveAnalyticsPolicy(p,a,b,admission),fetchImpl:async url=>{
   if(String(url).endsWith('upload-status'))return Response.json({ok:true,enabled:false,subjects:[]});
   const revision=c.storagePolicy().revision;
   if(mode==='race')c.saveStoragePolicy({expected_revision:revision,target_devices:1},count,'concurrent');
   return Response.json({ok:true,max_enabled_devices:50,storage_policy_revision:revision,checked_at_ms:mode==='stale'?Date.now()-121000:Date.now()});
  }});
 const put=(enabled=true)=>control.request('/',{method:'PUT',headers:{authorization:'Bearer admin'},body:JSON.stringify({expected_revision:c.analyticsPolicy()?.revision??0,enabled,subjects:[sn],hour:23})});
 let r=await put();assert.equal(r.status,409);assert.equal((await r.json()).error,'STORAGE_POLICY_CONFLICT');assert.equal(c.analyticsPolicy(),null);
 mode='stale';assert.equal((await put()).status,503);assert.equal((await put(false)).status,200);
 mode='good';assert.equal((await put()).status,200);
 // Recheck inside the writer rejects a cached capacity revision even without the route guard.
 assert.throws(()=>c.saveAnalyticsPolicy({expected_revision:c.analyticsPolicy()!.revision,enabled:true,subjects:[sn,'BJP00326081002000026'],hour:23},[sn,'BJP00326081002000026'],'test',{revision:0,limit:50,checked_at_ms:Date.now()}),/STORAGE_POLICY_CONFLICT/);
 console.log('storage HTTP: PASS (auth, strict body, 409 CAS, enabled lower bound, independent reader cache revision, await race, stale refusal, emergency stop)');
}finally{rmSync(dir,{recursive:true,force:true});}
