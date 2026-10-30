/** Isolated RTC authority entry, never imported/mounted by production index.ts.
 * Usage: node --experimental-sqlite --import tsx scripts/listening-rtc-brain.ts INPUT NEW_DIRECTORY
 * RTC credentials come from the launching process, not argv/output. No preseeded ready or frozen clock.
 */
import {readFileSync,writeFileSync,mkdirSync,statSync,realpathSync,chmodSync} from 'node:fs';
import {resolve,dirname,basename,sep} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
const [inputArg,dirArg]=process.argv.slice(2);
if(!inputArg||!dirArg)throw Error('INPUT and NEW_DIRECTORY required');
const inputPath=resolve(inputArg),dir=resolve(realpathSync(dirname(resolve(dirArg))),basename(dirArg));
if((statSync(inputPath).mode&0o077)!==0)throw Error('Input must be private (0600)');
const input=JSON.parse(readFileSync(inputPath,'utf8'));
if(!/^p003-listening-p0-[A-Za-z0-9_-]+$/.test(input.agent)||!/^[a-f0-9]{40}$/.test(input.build_sha))throw Error('Isolated agent/build required');
const port=input.port??18738;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid loopback port');
if(!['real','synthetic_signing_only'].includes(input.rtc_credentials_kind))throw Error('Explicit RTC boundary required');
for(const key of ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'])if(!process.env[key])throw Error('Missing process RTC credentials');
// Refuse reused directories, repo data and production roots. All imported singleton stores resolve here.
if(dir.startsWith('/opt/p003/')||dir.startsWith(realpathSync('.')+sep))throw Error('Use a fresh isolated directory outside the repository');
mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);process.chdir(dir);process.umask(0o077);
// Never inherit production database paths, search windows or provider settings from a launch shell.
const inherited=new Set(['PATH','HOME','TMPDIR','TEMP','TMP','SYSTEMROOT','NODE_EXTRA_CA_CERTS','LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET']);
for(const key of Object.keys(process.env))if(!inherited.has(key))delete process.env[key];
const sn='BJP00326103099999938',account='p0-synthetic-account-38',workerAccount='p0-synthetic-worker-39';
const auth=randomBytes(48).toString('hex'),service=randomBytes(32).toString('hex');
Object.assign(process.env,{AUTH_JWT_SECRET:auth,LISTENING_GRANT_SECRET:randomBytes(48).toString('hex'),LISTENING_SERVICE_KEY:service,
 LISTENING_WORKER_ACCOUNTS:JSON.stringify({[input.agent]:workerAccount}),LISTENING_RELEASE_MANIFEST_PATH:resolve(dir,'release.json'),
 DEVICES_DB_PATH:resolve(dir,'devices.db'),CONFIG_DB_PATH:resolve(dir,'config.db'),PROFILE_DB_PATH:resolve(dir,'profile.db'),
 DEVICE_SN_ALLOW:sn,DEVICE_SESSION_RPM:'1000',DEVICE_SESSION_TTL_S:'1800',ONESHOT_FIRST_TURN_AGENT_NAME:input.agent,
 ONESHOT_FIRST_TURN_POLICY:'capability'});
writeFileSync(process.env.LISTENING_RELEASE_MANIFEST_PATH!,JSON.stringify({version:1,expires_at_ms:Date.now()+4*3600_000,
 evidence_ref:'isolated-p0-build-approval-not-readiness',agents:[{agent:input.agent,build_sha:input.build_sha,
 capabilities:['listening_mode_v1','listening_http_v1','per_frame_output_permit_v1','capture_drain_v1','local_ready_ack_v1','listening_voice_control_v1']}]}),{mode:0o600});
// Dynamic imports intentionally follow isolation/env setup.
const [{deviceRegistryStore},{getListeningSettingsStore},{defaultListeningConfig},{getListeningAuthority},
 {deviceSessionRoute},{createListeningRoute},{LISTENING_WORKER_CAPABILITIES}]=await Promise.all([
 import('../src/device-registry-store.js'),import('../src/listening-settings-store.js'),import('../src/listening-settings.js'),
 import('../src/listening-runtime.js'),import('../src/routes/device-session.js'),import('../src/routes/listening.js'),import('../src/listening-http-contract.js')]);
deviceRegistryStore.add(sn,'synthetic P0 only');deviceRegistryStore.setAccountId(sn,account);
const settings=getListeningSettingsStore(),{schema_version,revision,...editable}=defaultListeningConfig();
settings.save(revision,{...editable,enabled:true,allowlist:[sn]},'isolated-p0-bootstrap');
const authority=getListeningAuthority();
const workerJwt=await new SignJWT({role:'device',accountId:workerAccount}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('4h').sign(new TextEncoder().encode(auth));
const deviceBearer=await new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(sn).setIssuedAt().setExpirationTime('4h').sign(new TextEncoder().encode(auth));
const markers=input.synthetic_markers??[];
if(!Array.isArray(markers)||markers.length>16||!markers.every(v=>typeof v==='string'&&v.length>0&&v.length<=128))throw Error('Invalid synthetic markers');
const feedbackText=input.feedback_text??'我听到你说，最后一件礼物是一只紫色风筝。这个故事里的分享和等待让我印象很深，也谢谢你耐心地把它讲给我听。';
if(typeof feedbackText!=='string'||!feedbackText.trim()||Array.from(feedbackText).length>80)throw Error('Synthetic feedback must fit 80 chars');
const providerObservations:unknown[]=[],requestContext=new AsyncLocalStorage<Record<string,unknown>>();
const observations:{at:number;path:string;status:number;request_id?:string;ready?:boolean;policy_revision?:number}[]=[];
const app=new Hono();
app.use('*',async(c,next)=>{
 let body:any;try{if(c.req.path.startsWith('/v1/internal/listening/'))body=await c.req.raw.clone().json();}catch{}
 const context={request_id:body?.request_id,trace_id:body?.session?.trace_id,room:body?.session?.room,session_id:body?.session?.session_id,listening_id:body?.listening_id,mode_epoch:body?.mode_epoch};
 await requestContext.run(context,next);if(c.req.path.startsWith('/v1/internal/listening/')){
 let reply:any;try{reply=await c.res.clone().json();}catch{}
 observations.push({at:Date.now(),path:c.req.path,status:c.res.status,request_id:reply?.request_id,ready:reply?.ready,policy_revision:reply?.policy_revision});
 if(observations.length>256)observations.shift();writeFileSync(resolve(dir,'observations.json'),JSON.stringify(observations,null,2)+'\n',{mode:0o600});
}});
app.get('/health',c=>c.json({status:'ok',runtime:authority.runtime(),boundaries:{clock:'Date.now',provider:'synthetic_text_only',rtc_credentials:input.rtc_credentials_kind},observations}));
app.route('/v1/device',deviceSessionRoute);
app.route('/v1/internal/listening',createListeningRoute(authority,{
 personality:async()=> '小可是合成联调角色，不写长期记忆。',
 generate:async v=>{
  providerObservations.push({...requestContext.getStore(),at:Date.now(),purpose:v.purpose,synthetic_only:true,chars:Array.from(v.userText).length,sha256:createHash('sha256').update(v.userText).digest('hex'),markers:Object.fromEntries(markers.map((m:string)=>[m,v.userText.includes(m)]))});
  writeFileSync(resolve(dir,'provider-observations.json'),JSON.stringify(providerObservations,null,2)+'\n',{mode:0o600});
  return v.purpose==='listening_summary'?'合成联调摘要：用户分享了一段故事。':Array.from(feedbackText).slice(0,v.maxChars).join('');
 },
}));
// Explicit provider substitute, not the production ordinary-chat route or persistence pipeline.
app.post('/v1/chat/completions',async c=>{
 if(c.req.header('authorization')!=='Bearer '+service||c.req.query('token')!==workerJwt)return c.json({error:'unauthorized'},401);
 return new Response('data: '+JSON.stringify({choices:[{delta:{content:'这是隔离联调的合成聊天回复。'},index:0}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port},()=>{
 writeFileSync(resolve(dir,'credentials.json'),JSON.stringify({agent:input.agent,build_sha:input.build_sha,device_sn:sn,
  device_bearer:deviceBearer,worker_jwt:workerJwt,service_bearer:service,capabilities:[...LISTENING_WORKER_CAPABILITIES,'listening_voice_control_v1'],
  worker_env:{LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,LLM_API_KEY:service,LLM_URL_QUERY:'token='+encodeURIComponent(workerJwt),LLM_MODEL:'isolated-synthetic-text'}},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'listening',url:`http://127.0.0.1:${port}`,private_directory:dir,ready:authority.runtime().ready,provider:'synthetic_text_only'}));
});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
