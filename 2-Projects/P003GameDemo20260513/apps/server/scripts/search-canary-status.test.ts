import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
const dir=mkdtempSync(tmpdir()+'/canary-admin-');
for(const [key,file] of Object.entries({CONFIG_DB_PATH:'config.db',DEVICES_DB_PATH:'devices.db',OTA_DB_PATH:'ota.db'}))process.env[key]=dir+'/'+file;
process.env.SEARCH_CANARY_OBSERVER_ROOT=dir+'/candidate';
process.env.SEARCH_CANARY_HEALTH_FILE=dir+'/candidate/health.json';
process.env.STUDIO_USER='synthetic-admin';process.env.STUDIO_PASS='test-only';
const sn='BJP00326070803800006',other='BJP00326060100200003';
const originalFetch=globalThis.fetch;
try{
 mkdirSync(dir+'/candidate/data',{recursive:true});
 const candidate=new DatabaseSync(dir+'/candidate/data/config.db');candidate.exec('CREATE TABLE runtime_flag(key TEXT,value TEXT)');candidate.prepare('INSERT INTO runtime_flag VALUES (?,?)').run('p003.search.allowlist',JSON.stringify([sn]));candidate.close();
 writeFileSync(dir+'/candidate/health.json',JSON.stringify({agent:'p003-search-canary-20261021',generation:'g',until_ms:Date.now()+14000}));
 globalThis.fetch=async()=>new Response(JSON.stringify({status:'ok',search:false,tools:false}));
 const {deviceRegistryStore}=await import('../src/device-registry-store.js');
 const {otaStore}=await import('../src/ota-store.js');
 const {configStore}=await import('../src/config-store.js');
 const {authRoute}=await import('../src/routes/auth.js');
 for(const s of [sn,other]){deviceRegistryStore.add(s,'PRIVATE_NOTE');deviceRegistryStore.setAccountId(s,'PRIVATE_ACCOUNT');}
 otaStore.reportCheck(sn,353,'synthetic-version',JSON.stringify({body:'PRIVATE_BODY'}));
 const {token}=await(await authRoute.request('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'synthetic-admin',password:'test-only'})})).json();
 const {canaryAdminRoute}=await import('../src/search-canary-status.js');
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 const initial=await(await canaryAdminRoute.request('/',{headers})).json();
 assert.equal(initial.selected_sn,sn);assert.equal(initial.summary.state,'closed');assert.equal(initial.summary.health_ok,true);assert.equal(initial.summary.lease_ok,true);
 assert.equal(initial.devices.find((d:any)=>d.sn===sn).version_code,353);assert(initial.devices.some((d:any)=>d.version_reported_at_ms));
 assert(!JSON.stringify(initial).includes('PRIVATE_'));
 assert.equal((await canaryAdminRoute.request('/device',{method:'PUT',headers,body:JSON.stringify({sn:other})})).status,200);
 const check=new DatabaseSync(dir+'/config.db',{readOnly:true});const flags=check.prepare('SELECT key,value FROM runtime_flag').all().map(r=>({...r}));assert.deepEqual(flags,[{key:'p003.search.canary.selected_sn',value:other}]);check.close();
 const second=await(await canaryAdminRoute.request('/',{headers})).json();assert.equal(second.selected_sn,other);assert.equal(second.summary.selected_prepared,false);assert.equal(second.summary.state,'closed');
 globalThis.fetch=async()=>{throw new Error('synthetic offline');};
 const offline=await(await canaryAdminRoute.request('/',{headers})).json();assert.equal(offline.summary.health_ok,false);assert(offline.issues.some((i:any)=>i.status==='阻塞'));
 assert.equal(configStore.getFlag('p003.search.canary.enabled'),null);
 console.log('PASS real collector: isolated SQLite, durable selection only, version timestamp, private fields excluded, health failure');
}finally{globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true});}
