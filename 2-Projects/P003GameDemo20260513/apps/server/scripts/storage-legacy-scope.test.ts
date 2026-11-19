import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const child=process.argv[2]==='restore',root=child?process.argv[3]:mkdtempSync(join(tmpdir(),'storage-legacy-')),cwd=process.cwd();
process.chdir(root);
for(const k of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK'])process.env[k+'_DB_PATH']=join(root,k.toLowerCase()+'.db');
const subjects=Array.from({length:4},(_,i)=>'BJP003'+String(i+991).padStart(14,'0'));
process.env.ARK_CONTEXT_SN_ALLOW=(child?subjects.slice(3):subjects.slice(0,3)).join(',');
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');
const {accountStore}=await import('../src/account-store.js');
const {configStore}=await import('../src/config-store.js');
const {ArkStore}=await import('../src/ark/store.js');
if(!child){
 for(const sn of subjects){devices.add(sn,'synthetic fixture');const a=accountStore.createDeviceAccount(sn,'test');devices.setAccountId(sn,a.id);}
 const legacy=new ArkStore(process.env.ARK_DB_PATH!);legacy.configure(true,subjects.slice(0,3).map(sn=>devices.arkIdentity(sn)!),Date.now());legacy.close();
}
const {arkStore,arkCapacity}=await import('../src/ark/service.js');
try{
 const counts=()=>({analytics:0,ark:arkStore().settings().subjects.length});
 if(child){
  assert.equal(arkCapacity().max_enabled_devices,3);assert.equal(configStore.storageProfile().ark_devices,0);
  const seed=JSON.parse(configStore.getFlag('ark.scope-seed.v1')!.value);assert.deepEqual(seed.subjects,subjects.slice(0,3));
  for(const sn of subjects.slice(0,3))arkStore().authorize(devices.arkIdentity(sn)!,Date.now());
  assert.throws(()=>arkStore().authorize(devices.arkIdentity(subjects[3])!,Date.now()),/STORAGE_CAPACITY_LIMIT/);
 }else{
  assert.equal(arkCapacity().max_enabled_devices,3);const seed=configStore.getFlag('ark.scope-seed.v1')!.value;
  arkStore().configure(false,[],Date.now(),arkStore().settings().revision);assert.equal(arkCapacity().max_enabled_devices,3);
  const r=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(import.meta.url),'restore',root],{cwd,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(arkStore().settings().subjects.length,3);assert.equal(configStore.getFlag('ark.scope-seed.v1')!.value,seed);
  assert.throws(()=>configStore.saveStoragePolicy({expected_revision:0,target_devices:2},counts,'test'),/STORAGE_ENABLED_CONFLICT/);
  arkStore().configure(false,[],Date.now(),arkStore().settings().revision);
  configStore.saveStoragePolicy({expected_revision:0,target_devices:2},counts,'test');
  for(const sn of subjects.slice(0,2))arkStore().authorize(devices.arkIdentity(sn)!,Date.now());
  assert.throws(()=>arkStore().authorize(devices.arkIdentity(subjects[2])!,Date.now()),/STORAGE_CAPACITY_LIMIT/);
  console.log('storage legacy scope: PASS (real service, 3 original grants, stop/restart/reenable, immutable env seed, no fourth device, quota clamp)');
 }
}finally{arkStore().close();process.chdir(cwd);if(!child)rmSync(root,{recursive:true,force:true});}
