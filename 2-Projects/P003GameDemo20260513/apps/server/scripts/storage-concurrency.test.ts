import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArkStore} from '../src/ark/store.js';
import {arkAdmissionLimit,VERIFIED_PROFILE_KEY} from '../src/storage/policy.js';
const worker=process.argv[2];
const dir=worker?process.argv[3]:mkdtempSync(join(tmpdir(),'storage-race-'));
process.env.CONFIG_DB_PATH=join(dir,'config.db');
const {configStore:c}=await import('../src/config-store.js');
const ark=new ArkStore(join(dir,'ark.db'),{run:fn=>c.withStorageAdmission(fn),limit:()=>arkAdmissionLimit(c.storagePolicy(),c.storageProfile(),ark.settings().subjects.length)});
const sn=(n:number)=>'BJP003'+String(n).padStart(14,'0');
const identity=(n:number)=>({sn:sn(n),account_id:'a'+n,epoch:1});
const counts=()=>({analytics:0,ark:ark.settings().subjects.length});
if(worker){
 process.send?.({ready:true});
 process.once('message',()=>{try{
  if(worker==='grant')ark.authorize(identity(50),Date.now());
  else c.saveStoragePolicy({expected_revision:c.storagePolicy().revision,target_devices:49},counts,'race');
  process.send?.({result:'ok'});
 }catch(e){process.send?.({result:(e as Error).message});}finally{ark.close();process.disconnect();}});
}else{
 try{
  c.setFlag(VERIFIED_PROFILE_KEY,JSON.stringify({version:1,analytics_devices:50,ark_devices:50,evidence:'SYNTHETIC-RACE-TEST',candidate:'test',validated_at_ms:Date.now()}),'test');
  for(let round=0;round<6;round++){
   c.saveStoragePolicy({expected_revision:c.storagePolicy().revision,target_devices:50},counts,'reset');
   ark.configure(true,Array.from({length:49},(_,i)=>identity(i+1)),Date.now(),ark.settings().revision);
   const children=['grant','lower'].map(mode=>fork(fileURLToPath(import.meta.url),[mode,dir],{execArgv:['--experimental-sqlite','--import','tsx'],stdio:['ignore','ignore','pipe','ipc']}));
   const results=children.map(child=>new Promise<string>((resolve,reject)=>{child.on('message',(m:any)=>{if(m.result)resolve(m.result);});child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error('child exit '+code));});}));
   await Promise.all(children.map(child=>new Promise<void>(resolve=>child.on('message',(m:any)=>{if(m.ready)resolve();}))));
   children.forEach(child=>child.send('go'));const result=await Promise.all(results);
   assert(result.includes('ok'));assert(result.every(x=>['ok','STORAGE_ENABLED_CONFLICT','STORAGE_CAPACITY_LIMIT'].includes(x)),JSON.stringify(result));
   assert(ark.settings().subjects.length<=c.storagePolicy().target_devices);
  }
  console.log('storage two-process race: PASS (6 actual SQLite races; config->Ark lock; quota/grants consistent)');
 }finally{ark.close();rmSync(dir,{recursive:true,force:true});}
}
