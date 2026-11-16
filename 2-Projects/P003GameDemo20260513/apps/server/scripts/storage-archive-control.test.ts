import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {storageRoute} from '../src/storage/routes.js';import {ArkStore} from '../src/ark/store.js';import {arkArchiveStatus} from '../src/ark/archive.js';
const root=mkdtempSync(join(tmpdir(),'archive-control-'));process.env.CONFIG_DB_PATH=join(root,'config.db');const {configStore:c}=await import('../src/config-store.js');
const ark=new ArkStore(join(root,'ark.db')),counts=()=>({analytics:0,ark:0});
const route=storageRoute({authorize:h=>h==='Bearer admin'?'admin':'none',read:()=>({policy:c.storagePolicy(),profile:c.storageProfile(),enabled:counts(),ark_capacity:{}}),save:p=>c.saveStoragePolicy(p,counts,'test'),archive:()=>arkArchiveStatus(ark.db,c.storagePolicy().archive_enabled),saveArchive:p=>(c as any).saveStorageArchive(p,'test') } as any);
const call=(method:string,p:any={},auth='Bearer admin',url='/archive')=>route.request(url,{method,headers:{authorization:auth,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(p)})});
test('independent archive CAS toggles without changing quota, device policy, verified scale or grants',async()=>{
 try{
  assert.equal((await call('GET',{},'Bearer admin','/')).status,200);assert.equal((await call('PUT',{expected_revision:0,enabled:true},'')).status,401);
  assert.equal((await call('PUT',{expected_revision:0,enabled:true})).status,200);assert.equal(c.storagePolicy().archive_enabled,true);assert.equal(c.storagePolicy().target_devices,50);assert.equal(c.analyticsPolicy(),null);assert.equal(ark.settings().enabled,false);
  assert.equal((await call('PUT',{expected_revision:0,enabled:false})).status,409);assert.equal(c.storagePolicy().archive_enabled,true);
  assert.equal((await call('PUT',{expected_revision:1,enabled:false,target_devices:100})).status,400);
  assert.equal((await call('PUT',{expected_revision:1,target_devices:100},'Bearer admin','/')).status,200);assert.equal(c.storagePolicy().archive_enabled,true);
  assert.equal((await call('PUT',{expected_revision:2,enabled:false})).status,200);const j=await (await call('GET',{},'Bearer admin','/')).json();assert.equal(j.archive.state,'disabled');assert.equal(j.archive.last_ack_ms,null);assert.equal(j.device_config_changed,false);
 }finally{ark.close();rmSync(root,{recursive:true,force:true});}
});
