import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCanaryEnvironment, canaryRequestAllowed, canarySns, canaryMaxJobs } from '../src/search-canary-guard.js';
const root=mkdtempSync(join(tmpdir(),'p003-canary-')); const prod=mkdtempSync(join(tmpdir(),'p003-production-'));
writeFileSync(join(prod,'sentinel'),'unchanged');
try {
 const env:NodeJS.ProcessEnv={SEARCH_CANARY_ROOT:root,SEARCH_CANARY_SN:'BJP00326070803800006',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',CUSTOM_LLM_API_KEY:'test',AUTH_JWT_SECRET:'test'};
 prepareCanaryEnvironment(env);
 assert.equal(env.MEMORY_EXTRACT_ENABLED,'0'); assert.equal(env.MEMORY_EXTRACT_MODE,'turn');
 assert.ok(env.PROFILE_DB_PATH?.startsWith(realpathSync(root)+'/'));
 assert.equal(env.AMAP_USAGE_DB_PATH,join(realpathSync(root),'data','amap-usage.db'));
 assert.throws(()=>prepareCanaryEnvironment({...env,AMAP_USAGE_DB_PATH:join(prod,'amap-usage.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,PROFILE_DB_PATH:join(prod,'profile.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,UNKNOWN_DB_PATH:join(prod,'other.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,SEARCH_CANARY_HEALTH_FILE:join(prod,'health.json')}));
 mkdirSync(join(root,'data'),{recursive:true});symlinkSync(prod,join(root,'escape'));
 assert.throws(()=>prepareCanaryEnvironment({...env,PROFILE_DB_PATH:join(root,'escape/profile.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,AMAP_USAGE_DB_PATH:join(root,'escape/amap-usage.db')}));
 const base={path:'/v1/chat/completions',room:'sn-BJP00326070803800006-123',sn:'BJP00326070803800006',account:'search-canary-worker',expectedAccount:'search-canary-worker',role:'device',expires:2000,now:1000};
 assert.equal(canaryRequestAllowed(base),true);
 for(const path of ['/v1/internal/search-tasks/routing','/v1/internal/search-tasks/routing/ack']) {
  assert.equal(canaryRequestAllowed({...base,path}),true);
  assert.equal(canaryRequestAllowed({...base,path,expires:1000}),false);
  assert.equal(canaryRequestAllowed({...base,path,room:'sn-BJP00326060100100004-123'}),false);
  assert.equal(canaryRequestAllowed({...base,path:path+'/extra'}),false);
 }
 for(const path of ['/v1/internal/search-tasks/session/close','/v1/internal/search-tasks/resume/latest','/v1/internal/search-tasks/resume/cancel','/v1/internal/search-tasks/resume/11e0532a-b4a0-48b0-9da6-925b9a7f9e76/playback','/v1/internal/search-tasks/resume/11e0532a-b4a0-48b0-9da6-925b9a7f9e76/receipt','/v1/internal/search-tasks/11e0532a-b4a0-48b0-9da6-925b9a7f9e76/progress']){
  assert.equal(canaryRequestAllowed({...base,path}),true,'R14 endpoint must pass full candidate guard');
  assert.equal(canaryRequestAllowed({...base,path,expires:1000}),false);assert.equal(canaryRequestAllowed({...base,path,role:'parent'}),false);assert.equal(canaryRequestAllowed({...base,path:path+'/extra'}),false);
 }
 prepareCanaryEnvironment({...env,SEARCH_RESUME_V1:'1',SEARCH_RESUME_AUTHORITY_DB_PATH:'/opt/p003/server/data/devices.db'});
 for(const path of [join(prod,'devices.db'),'/opt/p003/server/data/profile.db',join(root,'data/devices.db')])assert.throws(()=>prepareCanaryEnvironment({...env,SEARCH_RESUME_V1:'1',SEARCH_RESUME_AUTHORITY_DB_PATH:path}),/canary_resume_authority/);
 assert.ok(env.SEARCH_ROUTING_DB_PATH?.startsWith(realpathSync(root)+'/'));
 assert.throws(()=>prepareCanaryEnvironment({...env,SEARCH_ROUTING_DB_PATH:join(prod,'routing.db')}));
 for(const action of ['replay','playback']) {
  const path='/v1/internal/search-tasks/11e0532a-b4a0-48b0-9da6-925b9a7f9e76/'+action;
  assert.equal(canaryRequestAllowed({...base,path}),true,action+' must pass candidate guard');
  assert.equal(canaryRequestAllowed({...base,path:path+'/extra'}),false);
  assert.equal(canaryRequestAllowed({...base,path,role:'parent'}),false);
 }
 assert.equal(canaryRequestAllowed({...base,expires:base.now+168*3600_000}),true);
 assert.equal(canaryRequestAllowed({...base,expires:base.now+168*3600_000+1}),false);
 for(const delta of [{room:'sn-BJP00326060100200003-123'},{account:'worker-service'},{role:'parent'},{expires:1000},{path:'/v1/admin'},{path:'/v1/internal/search-tasks/../secret'}]) assert.equal(canaryRequestAllowed({...base,...delta}),false);
 assert.equal(readFileSync(join(prod,'sentinel'),'utf8'),'unchanged');
 console.log('canary isolation: paths/symlink/identity/expiry passed');
} finally {rmSync(root,{recursive:true,force:true});rmSync(prod,{recursive:true,force:true});}

const a='BJP00326070803800006',b='BJP00326060100100004';
assert.deepEqual(canarySns(a+','+b),[a,b]);
for(const raw of ['',a+','+a,a+',00100004',a+','+b+',BJP00326060100200003']) assert.deepEqual(canarySns(raw),[]);
assert.equal(canaryMaxJobs('2'),2);assert.equal(canaryMaxJobs('3'),0);
const pair={path:'/v1/chat/completions',room:'sn-'+b+'-123',sn:b,allowedSns:[a,b],account:'search-canary-worker',expectedAccount:'search-canary-worker',role:'device',expires:2000,now:1000};
assert.equal(canaryRequestAllowed(pair),true);
assert.equal(canaryRequestAllowed({...pair,allowedSns:[a]}),false);
assert.equal(canaryRequestAllowed({...pair,sn:a}),false);
