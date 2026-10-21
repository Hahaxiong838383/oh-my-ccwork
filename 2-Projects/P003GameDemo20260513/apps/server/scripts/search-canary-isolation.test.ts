import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCanaryEnvironment, canaryRequestAllowed } from '../src/search-canary-guard.js';
const root=mkdtempSync(join(tmpdir(),'p003-canary-')); const prod=mkdtempSync(join(tmpdir(),'p003-production-'));
writeFileSync(join(prod,'sentinel'),'unchanged');
try {
 const env:NodeJS.ProcessEnv={SEARCH_CANARY_ROOT:root,SEARCH_CANARY_SN:'BJP00326070803800006',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',CUSTOM_LLM_API_KEY:'test',AUTH_JWT_SECRET:'test'};
 prepareCanaryEnvironment(env);
 assert.equal(env.MEMORY_EXTRACT_ENABLED,'0'); assert.equal(env.MEMORY_EXTRACT_MODE,'turn');
 assert.ok(env.PROFILE_DB_PATH?.startsWith(realpathSync(root)+'/'));
 assert.throws(()=>prepareCanaryEnvironment({...env,PROFILE_DB_PATH:join(prod,'profile.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,UNKNOWN_DB_PATH:join(prod,'other.db')}));
 assert.throws(()=>prepareCanaryEnvironment({...env,SEARCH_CANARY_HEALTH_FILE:join(prod,'health.json')}));
 mkdirSync(join(root,'data'),{recursive:true});symlinkSync(prod,join(root,'escape'));
 assert.throws(()=>prepareCanaryEnvironment({...env,PROFILE_DB_PATH:join(root,'escape/profile.db')}));
 const base={path:'/v1/chat/completions',room:'sn-BJP00326070803800006-123',sn:'BJP00326070803800006',account:'search-canary-worker',expectedAccount:'search-canary-worker',role:'device',expires:2000,now:1000};
 assert.equal(canaryRequestAllowed(base),true);
 for(const delta of [{room:'sn-BJP00326060100200003-123'},{account:'worker-service'},{role:'parent'},{expires:1000},{path:'/v1/admin'},{path:'/v1/internal/search-tasks/../secret'}]) assert.equal(canaryRequestAllowed({...base,...delta}),false);
 assert.equal(readFileSync(join(prod,'sentinel'),'utf8'),'unchanged');
 console.log('canary isolation: paths/symlink/identity/expiry passed');
} finally {rmSync(root,{recursive:true,force:true});rmSync(prod,{recursive:true,force:true});}
