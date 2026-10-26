// Validate isolation BEFORE dynamically importing any singleton stores.
import { prepareCanaryEnvironment, canaryRequestAllowed, canarySns, canaryMaxJobs, canaryAgent } from './search-canary-guard.js';
prepareCanaryEnvironment(process.env);
const allowedSns=canarySns(process.env.SEARCH_CANARY_SN),maxJobs=canaryMaxJobs(process.env.SEARCH_CANARY_MAX_JOBS);
const agent=canaryAgent(process.env.SEARCH_CANARY_AGENT);
const {serve}=await import('@hono/node-server');
const {Hono}=await import('hono');
const {timingSafeEqual}=await import('node:crypto');
const {writeFile,rename}=await import('node:fs/promises');
const {verifyAuthToken}=await import('./auth-jwt.js');
const {configStore}=await import('./config-store.js');
const {customLlmRoute}=await import('./routes/custom-llm.js');
const {searchTaskRoute,searchSettings}=await import('./tools/search-runtime.js');
const {searchAdminRoute}=await import('./routes/search-admin.js');
const {raceProviderHealth}=await import('./providers/provider-health.js');
const app=new Hono();
app.get('/health',c=>c.json({status:'ok',agent,generation:process.env.SEARCH_CANARY_GENERATION,search:searchSettings().enabled,tools:searchSettings().tools,
 llm:process.env.LLM_PROVIDER==='race'?{mode:'race',...raceProviderHealth()}:undefined}));
app.use('/v1/*',async(c,next)=>{
 const auth=await verifyAuthToken(c.req.header('x-p003-worker-token')||c.req.query('token'));
 const got=c.req.header('authorization')||'', want='Bearer '+process.env.CUSTOM_LLM_API_KEY;
 if(Buffer.byteLength(got)!==Buffer.byteLength(want)||!timingSafeEqual(Buffer.from(got),Buffer.from(want))) return c.json({error:'unauthorized'},401);
 if(c.req.path==='/v1/internal/canary-health' && c.req.method==='POST') {
   if(auth?.role!=='device'||auth.accountId!==process.env.SEARCH_WORKER_ACCOUNT_ID) return c.json({error:'unauthorized'},401);
   const raw=await c.req.text(); if(raw.length>2048)return c.json({error:'oversize'},413);
   let v;try{v=JSON.parse(raw)}catch{return c.json({error:'invalid'},400)}
   if(v.agent!==agent||v.generation!==process.env.SEARCH_CANARY_GENERATION||typeof v.registered!=='boolean'||!Number.isInteger(v.jobs)||v.jobs<0||v.jobs>maxJobs||v.ordered_pcm_v1!==true) return c.json({error:'invalid'},400);
   const path=process.env.SEARCH_CANARY_HEALTH_FILE;
   if(!path)return c.json({error:'unconfigured'},503);
   const cleanup=v.cleanup;
   const cleanupOk=process.env.SEARCH_REQUIRE_CLEANUP_HEALTH!=='1'||cleanup?.healthy===true
     &&Number.isFinite(cleanup.at_ms)&&cleanup.at_ms<=Date.now()&&Date.now()-cleanup.at_ms<=120000
     &&cleanup.pending===0&&Number.isInteger(cleanup.remaining)&&cleanup.remaining>=0&&cleanup.remaining<=512;
   const lease={agent:v.agent,generation:v.generation,until_ms:v.registered&&v.jobs<maxJobs&&cleanupOk?Date.now()+15000:0,ordered_pcm_v1:true,
     cleanup:{healthy:cleanupOk,at_ms:Number.isFinite(cleanup?.at_ms)?cleanup.at_ms:0,pending:Number.isInteger(cleanup?.pending)?cleanup.pending:null}};
   await writeFile(path+'.tmp',JSON.stringify(lease),{mode:0o600});await rename(path+'.tmp',path);
   return c.json({ok:true});
 }
 const allowed=canaryRequestAllowed({path:c.req.path,room:c.req.query('room')||'',sn:/^sn-(BJP003\d{14})-/.exec(c.req.query('room')||'')?.[1]||'',allowedSns,account:auth?.accountId||'',expectedAccount:process.env.SEARCH_WORKER_ACCOUNT_ID!,role:auth?.role||'',expires:Number(configStore.getFlag('p003.search.canary.expires_at_ms')?.value),now:Date.now()});
 if(!allowed) return c.json({error:'canary_unavailable'},403);
 await next();
});
app.route('/v1',customLlmRoute);app.route('/v1/internal/search-tasks',searchTaskRoute);
// Only loopback; public nginx location exposes /v1 only, never admin or health.
app.route('/api/admin/search',searchAdminRoute);
const port=Number(process.env.PORT);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('canary_port');
serve({fetch:app.fetch,hostname:'127.0.0.1',port});
console.log('[search-canary] isolated server ready');
