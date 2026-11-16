import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseStorageChange,readStoragePolicy,VERIFIED_PROFILE_KEY,readVerifiedProfile,arkAdmissionLimit} from '../src/storage/policy.js';
import {ArkStore} from '../src/ark/store.js';
import {settingsSchema} from '../src/ark/contracts.js';
import {capacityForecast} from '../src/analytics/capacity.js';
const dir=mkdtempSync(join(tmpdir(),'storage-policy-'));
process.env.CONFIG_DB_PATH=join(dir,'config.db');
const {configStore:c}=await import('../src/config-store.js');
const subjects=Array.from({length:101},(_,i)=>'BJP003'+String(i+1).padStart(14,'0'));
const identity=(sn:string)=>({sn,account_id:'a-'+sn,epoch:1});
const ark=new ArkStore(join(dir,'ark.db'),{run:fn=>c.withStorageAdmission(fn),limit:()=>arkAdmissionLimit(c.storagePolicy(),c.storageProfile(),ark.settings().subjects.length)});
const counts=()=>({analytics:c.analyticsPolicy()?.enabled?c.analyticsPolicy()!.subjects.length:0,ark:ark.settings().enabled?ark.settings().subjects.length:0});
const db=new DatabaseSync(process.env.CONFIG_DB_PATH);
const seq=()=>JSON.stringify(db.prepare('SELECT * FROM config_meta').all());
try{
 assert.equal(c.storagePolicy().target_devices,50);assert.equal(c.storagePolicy().archive_enabled,false);
 const before=seq();let p=c.saveStoragePolicy({expected_revision:0,target_devices:100},counts,'test');assert.equal(seq(),before);assert.equal(p.revision,1);
 assert.throws(()=>c.saveStoragePolicy({expected_revision:0,target_devices:50},counts,'test'),/STORAGE_POLICY_CONFLICT/);
 for(const value of [0,-1,1.5,1001,'50',NaN,null])assert.throws(()=>parseStorageChange({expected_revision:1,target_devices:value}),/INVALID_STORAGE_POLICY/);
 assert.throws(()=>parseStorageChange({expected_revision:1,target_devices:50,archive_enabled:true}),/INVALID_STORAGE_POLICY/);
 assert.equal(readVerifiedProfile(null).analytics_devices,14);assert.equal(readVerifiedProfile(null).ark_devices,0);
 assert.throws(()=>ark.authorize(identity(subjects[0]),Date.now()),/STORAGE_CAPACITY_LIMIT/);
 // Deliberately synthetic admission profile: this is NOT a real 100-device load validation.
 c.setFlag(VERIFIED_PROFILE_KEY,JSON.stringify({version:1,analytics_devices:100,ark_devices:100,evidence:'SYNTHETIC-TEST-ONLY',candidate:'test',validated_at_ms:Date.now()}),'test');
 p=c.saveStoragePolicy({expected_revision:p.revision,target_devices:50},counts,'test');
 ark.configure(true,subjects.slice(0,32).map(identity),Date.now(),0);
 ark.authorize(identity(subjects[32]),Date.now());assert.equal(ark.settings().subjects.length,33);
 ark.configure(true,subjects.slice(0,49).map(identity),Date.now(),ark.settings().revision);
 ark.authorize(identity(subjects[49]),Date.now());assert.equal(ark.settings().subjects.length,50);
 assert.throws(()=>ark.authorize(identity(subjects[50]),Date.now()),/STORAGE_CAPACITY_LIMIT/);
 assert.throws(()=>c.saveStoragePolicy({expected_revision:p.revision,target_devices:49},counts,'test'),/STORAGE_ENABLED_CONFLICT/);
 assert.equal(c.storagePolicy().target_devices,50);assert.equal(ark.settings().subjects.length,50);
 const arkRev=ark.settings().revision;
 assert.throws(()=>ark.authorize(identity(subjects[0]),Date.now(),arkRev-1),/settings_conflict/);
 p=c.saveStoragePolicy({expected_revision:p.revision,target_devices:100},counts,'test');
 ark.configure(true,subjects.slice(0,100).map(identity),Date.now(),arkRev);assert.equal(ark.settings().subjects.length,100);
 assert.throws(()=>ark.authorize(identity(subjects[100]),Date.now()),/STORAGE_CAPACITY_LIMIT/);
 assert.equal(settingsSchema.safeParse({enabled:true,subjects:subjects.slice(0,100),expected_revision:ark.settings().revision}).success,true);
 assert.equal(seq(),before); // quota/Ark changes never touch device cfg revisions or false->true
 const fresh=new DatabaseSync(process.env.CONFIG_DB_PATH,{readOnly:true});
 assert.equal(readStoragePolicy((fresh.prepare("SELECT value FROM runtime_flag WHERE key='storage.policy.v1'").get() as {value:string}).value).target_devices,100);fresh.close();
 const sample={free_bytes:1e12,total_bytes:2e12,db_bytes:0,wal_bytes:0,daily_peak:6000,sample_devices:4,maintenance_ok:true,checked_at_ms:Date.now()};
 const cap=capacityForecast(sample,{policy:c.storagePolicy(),profile:c.storageProfile()});
 assert.equal(cap.target_devices,100);assert.equal(cap.validated_device_limit,100);assert.equal(cap.max_enabled_devices,cap.maintenance_limit);assert.equal(cap.target_devices_fit,cap.max_enabled_devices>=100);
 assert.equal(capacityForecast(sample).validated_device_limit,14);
 // Profile loss/capacity reduction must not revoke existing grants; reductions/stop remain possible.
 c.clearFlag(VERIFIED_PROFILE_KEY);ark.configure(true,subjects.slice(0,99).map(identity),Date.now(),ark.settings().revision);
 ark.configure(false,[],Date.now(),ark.settings().revision);assert.equal(ark.settings().enabled,false);
 console.log('storage policy: PASS (50 default, 1..1000 strict, 32/33/49/50/51/100, CAS, no device cfg, restart read, safe stop)');
}finally{db.close();ark.close();rmSync(dir,{recursive:true,force:true});}
