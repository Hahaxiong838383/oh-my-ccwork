import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { issueListeningGrant,verifyListeningGrant,type ListeningBinding } from './listening-grant.js';
import { listeningDigest,listeningSessionSchema,parseListeningRequest,validListeningWorkerCapabilities,LISTENING_VOICE_CAPABILITY,type SessionWire,type ListeningRequest } from './listening-http-contract.js';
import { ListeningAuthorityStore,ListeningError,listeningSnapshot,type AuthoritySession,type ListeningSnapshot } from './listening-authority-store.js';
import { exactObject,type ListeningConfig } from './listening-settings.js';
export interface ListeningSecrets {authSecret:string;grantSecret:string;serviceKey:string;workerAccounts:Record<string,string>}
export interface AuthorityOptions {store:ListeningAuthorityStore;getConfig:()=>ListeningConfig;clock:()=>number;secrets:()=>ListeningSecrets;manifest:()=>unknown;sourceDeadline:(session:AuthoritySession,now:number)=>number;sourceGeneration:()=>number;restrictedSince:(revision:number,sn:string,scene:string)=>boolean}
export interface IssueInput {sn:string;room:string;session_id:string;trace_id:string;agent:string;supports:string[];source:'normal'|'search_canary';expires_at_ms:number;source_cutoff_ms:number;credential:string}
export type ListeningHeaders=Record<string,string|undefined>;
type WorkerEvidence={agent:string;account:string;instance:string;build:string;until:number;revision:number|null;sha:string|null;at:number;capabilities:string[]};
const error=(code:string,status=403,retryable=false)=>new ListeningError(code,status,retryable);
const key=(v:string)=>{if(!v||v!==v.trim()||Buffer.byteLength(v)<32)throw error('authority_unavailable',503,true);return new TextEncoder().encode(v);};
const same=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const grantBinding=(s:SessionWire):ListeningBinding=>({sn:s.sn,room:s.room,sessionId:s.session_id,traceId:s.trace_id,accountId:s.account_id});
export class ListeningAuthority {
 private workers=new Map<string,WorkerEvidence>();
 constructor(readonly options:AuthorityOptions){}
 get store(){return this.options.store;}
 now(){return this.options.clock();}
 config(){return this.options.getConfig();}
 private release(agent:string,build?:string):{agent:string;build_sha:string;capabilities:string[]}|null{
  const value=this.options.manifest();const now=this.now();
  if(!exactObject(value,['version','expires_at_ms','evidence_ref','agents'])||value.version!==1||!Number.isSafeInteger(value.expires_at_ms)
   ||(value.expires_at_ms as number)<=now||typeof value.evidence_ref!=='string'||!value.evidence_ref.trim()||value.evidence_ref.length>512||!Array.isArray(value.agents)||value.agents.length>16)return null;
  if(new Set(value.agents.map(a=>a?.agent)).size!==value.agents.length)return null;
  const r=value.agents.find(a=>a?.agent===agent);
  if(!r||!exactObject(r,['agent','build_sha','capabilities'])||typeof r.build_sha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.build_sha))return null;
  const capabilities=r.capabilities;
  if(!validListeningWorkerCapabilities(capabilities)||build&&r.build_sha!==build)return null;
  return {agent,build_sha:r.build_sha,capabilities};
 }
 private readyWorker(agent:string,config:ListeningConfig,applied=true,build?:string,voice=false):WorkerEvidence|null{
  const snapshot=listeningSnapshot(config);const now=this.now();
  for(const v of this.workers.values())if(v.agent===agent&&this.options.secrets().workerAccounts[agent]===v.account&&v.until>now&&(!build||v.build===build)&&this.release(agent,v.build)
   &&(!applied||v.revision===config.revision&&v.sha===snapshot.sha256)
   &&(!voice||v.capabilities.includes(LISTENING_VOICE_CAPABILITY)&&this.release(agent,v.build)?.capabilities.includes(LISTENING_VOICE_CAPABILITY)))return v;
  return null;
 }
 private async service(headers:ListeningHeaders):Promise<string>{
  const secrets=this.options.secrets();const authKey=key(secrets.authSecret);
  if(!secrets.serviceKey||secrets.serviceKey!==secrets.serviceKey.trim()||!Object.keys(secrets.workerAccounts).length)throw error('authority_unavailable',503,true);
  if(!same(headers.authorization??'',`Bearer ${secrets.serviceKey}`)||!headers['x-p003-worker-token'])throw error('unauthorized',401);
  try{const {payload}=await jwtVerify(headers['x-p003-worker-token'],authKey,{algorithms:['HS256'],issuer:'p003',audience:'kidshub',
   requiredClaims:['iat','exp','role','accountId'],currentDate:new Date(this.now()),clockTolerance:0});
   if(payload.role!=='device'||typeof payload.accountId!=='string'||!Object.values(secrets.workerAccounts).includes(payload.accountId)
    ||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat!>Math.floor(this.now()/1000)||payload.exp!<=payload.iat!)throw error('unauthorized',401);
   return payload.accountId;
  }catch{throw error('unauthorized',401);}
 }
 async workerReady(headers:ListeningHeaders,value:unknown){
  const account=await this.service(headers);const body=parseListeningRequest('/worker-ready',value);if(!body)throw error('invalid_request',400);
  if(this.options.secrets().workerAccounts[body.agent]!==account)throw error('unauthorized',401);
  const now=this.now();for(const [id,v] of this.workers)if(v.until<=now)this.workers.delete(id);
  const config=this.config(),snapshot=listeningSnapshot(config),id=body.agent+':'+body.instance_id;
  if(!body.registered)this.workers.delete(id);
  else{
   if(!this.workers.has(id)&&this.workers.size>=128)throw error('capacity_exceeded',429,true);
   this.workers.set(id,{agent:body.agent,account,instance:body.instance_id,build:body.build_sha,until:now+15000,revision:body.applied_revision,sha:body.applied_config_sha256,at:now,capabilities:[...body.capabilities]});
  }
  const {sha256,...offered}=snapshot;
  return {version:1,ok:true,ready:!!this.readyWorker(body.agent,config),policy_revision:config.revision,config_sha256:sha256,config:offered};
 }
 async issue(input:IssueInput){
  const config=this.config();
  if(!config.enabled||!config.allowlist.includes(input.sn)||!input.supports.includes('listening_mode_v1'))return null;
  const worker=this.readyWorker(input.agent,config);if(!worker)return null;
  const secrets=this.options.secrets();if(!secrets.workerAccounts[input.agent]||!secrets.serviceKey||secrets.serviceKey!==secrets.serviceKey.trim())return null;key(secrets.grantSecret);
  const sourceGeneration=input.source==='search_canary'?this.options.sourceGeneration():0;
  let credential;
  try{const token=/^Bearer (\S+)$/.exec(input.credential)?.[1];if(!token)return null;
   ({payload:credential}=await jwtVerify(token,key(secrets.authSecret),{algorithms:['HS256'],requiredClaims:['iat','exp','sub','kind'],currentDate:new Date(this.now()),clockTolerance:0}));
  }catch{return null;}
  if(credential.kind!=='p003-device'||credential.sub!==input.sn||!Number.isSafeInteger(credential.iat)||!Number.isSafeInteger(credential.exp)
   ||credential.iat!>Math.floor(this.now()/1000)||credential.exp!<=credential.iat!)return null;
  const device=this.store.device(input.sn);if(!device||device.status!=='active'||!device.accountId||credential.iat!<=(device.credentialNotBefore??-1))return null;
  const session:SessionWire={sn:input.sn,room:input.room,session_id:input.session_id,trace_id:input.trace_id,account_id:device.accountId};
  if(!listeningSessionSchema.safeParse(session).success)return null;
  const now=this.now();const until=Math.floor(Math.min(input.expires_at_ms,input.source_cutoff_ms,credential.exp!*1000,now+1800000)/1000)*1000;
  if(!Number.isSafeInteger(until)||until<=now)return null;
  const grant=await issueListeningGrant(grantBinding(session),config.revision,secrets.grantSecret,now,until);
  if(this.config().revision!==config.revision||!this.readyWorker(input.agent,config,true,worker.build)||this.now()>=until||input.source==='search_canary'&&this.options.sourceGeneration()!==sourceGeneration)return null;
  // Only the intersection is authoritative; a client support string alone grants nothing.
  const voice=!!(config.tuning.voice_invitation_enabled&&input.supports.includes(LISTENING_VOICE_CAPABILITY)
   &&this.readyWorker(input.agent,config,true,worker.build,true));
  const voiceControl=voice?{voice_control:{version:1 as const,capability:LISTENING_VOICE_CAPABILITY}}:{};
  this.store.register({...session,...voiceControl,device_epoch:device.epoch,worker_account:secrets.workerAccounts[input.agent],agent:input.agent,build_sha:worker.build,
   source:input.source,source_cutoff_ms:input.source_cutoff_ms,source_generation:sourceGeneration,credential_iat:credential.iat!,credential_expires_ms:credential.exp!*1000,expires_at_ms:until,
   grant_hash:listeningDigest(grant),supports:input.supports.filter(c=>c!==LISTENING_VOICE_CAPABILITY||voice)},this.now());
  return {version:1,authority:'p003-main-brain',grant,session,grant_expires_at_ms:until,agent:input.agent,worker_build_sha:worker.build,snapshot:listeningSnapshot(config),
   ...voiceControl};
 }
 async authorize(headers:ListeningHeaders,binding:SessionWire,scene:string,checkPolicy=true){
  const worker=await this.service(headers);const session=this.store.session(binding.session_id);if(!session)throw error('not_authorized');
  if(Object.keys(binding).some(k=>binding[k as keyof SessionWire]!==session[k as keyof SessionWire])||worker!==session.worker_account
   ||this.options.secrets().workerAccounts[session.agent]!==worker)throw error('not_authorized');
  let observed:unknown;try{this.currentSession(session);}catch(e){observed=e;}
  const grant=headers['x-p003-listening-grant'];if(!grant||listeningDigest(grant)!==session.grant_hash)throw error('unauthorized',401);
  const checked=await verifyListeningGrant(grant,grantBinding(session),this.options.secrets().grantSecret,this.now());if(!checked)throw error('unauthorized',401);
  try{
  if(checkPolicy&&this.store.revoked(session.session_id))throw error('not_authorized');
  if(observed)throw observed;
  // Verification is asynchronous: registry, cutoff and clock must be fresh after it resolves.
  const now=this.currentSession(session);
  const config=this.config();if(checked.policyVersion>config.revision)throw error('not_authorized');
  if(checkPolicy){if(!config.enabled||!config.allowlist.includes(session.sn))throw error('policy_disabled');
   if(!config.scenes.includes(scene as any))throw error('scene_disabled');
   if(this.options.restrictedSince(checked.policyVersion,session.sn,scene))throw error('policy_disabled');
   if(!this.readyWorker(session.agent,config,false,session.build_sha))throw error('worker_not_ready');}
  return {session,config,now};
  }catch(e){
   // A proved revocation consumes the old RTC authority, including every future entry ID.
   if(checkPolicy&&e instanceof ListeningError&&['source_expired','device_changed','policy_disabled','scene_disabled','worker_not_ready'].includes(e.code))this.store.revoke(session.session_id,e.code,this.now());
   throw e;
  }
 }
 private currentSession(session:AuthoritySession){
  const now=this.now();if(now>=session.expires_at_ms||now>=session.credential_expires_ms||now>=session.source_cutoff_ms||now>=this.options.sourceDeadline(session,now))throw error('source_expired');
  const device=this.store.device(session.sn);
  if(!device||device.status!=='active'||device.accountId!==session.account_id||device.epoch!==session.device_epoch||session.credential_iat<=(device.credentialNotBefore??-1))throw error('device_changed');
  return now;
 }
 async lease(headers:ListeningHeaders,value:unknown):Promise<any>{
  const started=this.now();
  const body=parseListeningRequest('/lease',value);if(!body)throw error('invalid_request',400);
  const {session,config,now}=await this.authorize(headers,body.session,body.scene);
  if(now-started>1000)throw error('authority_unavailable',503,true);
  const hash=listeningDigest({path:'/lease',body}),old=this.store.request(session.session_id,body.request_id);
  if(old&&(old.hash!==hash||old.kind!=='lease'))throw error('request_conflict',409);
  const previous=this.store.entry(session.session_id,body.listening_id);
  if(previous&&!previous.closed&&(now>=previous.deadline_ms||previous.lease_until_ms>0&&now>=previous.lease_until_ms)){
   this.store.revoke(session.session_id,'entry_expired',now);throw error('entry_closed');
  }
  const entry=this.store.acquireEntry(session.session_id,body.listening_id,body.scene,body.mode_epoch,listeningSnapshot(config),now);
  if(entry.lease_until_ms>0&&entry.lease_until_ms<=now)throw error('entry_closed');
  if(old?.reply_json)return JSON.parse(old.reply_json);
  if(body.applied_snapshot_sha256!==null&&body.applied_snapshot_sha256!==entry.snapshot.sha256)throw error('snapshot_mismatch',409);
  const authorized=body.applied_snapshot_sha256===entry.snapshot.sha256;
  const until=authorized?Math.min(now+15000,session.expires_at_ms,session.credential_expires_ms,session.source_cutoff_ms,entry.deadline_ms,this.options.sourceDeadline(session,now)):0;
  const reply={version:1,request_id:body.request_id,authorized,lease_id:session.session_id+':'+body.listening_id,policy_revision:config.revision,
   server_time_ms:now,lease_expires_at_ms:until,refresh_after_ms:5000,request_budget_ms:1000,snapshot:entry.snapshot};
  return this.store.recordReply(session.session_id,body.listening_id,body.request_id,hash,'lease',body.mode_epoch,now,reply);
 }
 async close(headers:ListeningHeaders,value:unknown){
  const body=parseListeningRequest('/close',value);if(!body)throw error('invalid_request',400);
  const {session,now}=await this.authorize(headers,body.session,body.scene,false);const hash=listeningDigest({path:'/close',body});
  const old=this.store.request(session.session_id,body.request_id);if(old&&(old.hash!==hash||old.kind!=='close'))throw error('request_conflict',409);
  this.store.closeEntry(session.session_id,body.listening_id,body.mode_epoch);
  return this.store.recordReply(session.session_id,body.listening_id,body.request_id,hash,'close',body.mode_epoch,now,{version:1,request_id:body.request_id,closed:true});
 }
 async contentContext(headers:ListeningHeaders,body:ListeningRequest<'/summary'>|ListeningRequest<'/feedback'>){
  const context=await this.authorize(headers,body.session,body.scene);const entry=this.store.entry(body.session.session_id,body.listening_id);
  if(!entry||entry.closed||entry.scene!==body.scene)throw error('entry_closed');
  if(entry.mode_epoch!==body.mode_epoch)throw error('stale_epoch',409);
  if(context.now>=entry.deadline_ms||context.now>=entry.lease_until_ms){
   if(entry.lease_until_ms>0||context.now>=entry.deadline_ms)this.store.revoke(context.session.session_id,'entry_expired',context.now);
   throw error('lease_required');
  }
  if(entry.snapshot.sha256!==body.snapshot_sha256||entry.snapshot.revision!==body.snapshot_revision)throw error('snapshot_mismatch',409);
  if('trigger' in body&&body.trigger==='voice_command'&&(!entry.snapshot.tuning.voice_invitation_enabled
   ||context.session.voice_control?.version!==1||context.session.voice_control?.capability!==LISTENING_VOICE_CAPABILITY
   ||!this.readyWorker(context.session.agent,context.config,false,context.session.build_sha,true)))throw error('not_authorized');
  return {...context,entry};
 }
 runtime(){try{
  const secrets=this.options.secrets();key(secrets.authSecret);key(secrets.grantSecret);if(!secrets.serviceKey||secrets.serviceKey!==secrets.serviceKey.trim())throw error('authority_unavailable',503);
  const config=this.config();const workers=Object.keys(this.options.secrets().workerAccounts).map(a=>this.readyWorker(a,config)).filter((x):x is WorkerEvidence=>!!x);
  const ready=workers.length>0;
  return {status:ready?'evidence_ready':'not_integrated',ready,effective_enabled:ready&&config.enabled,applied_revision:ready?config.revision:null,
   active_sessions:ready?this.store.activeCount(this.now()):null,last_ack_at:ready?Math.max(...workers.map(w=>w.at)):null,
   message:ready?'已核准构建及配置应用确认；授权会话数不代表设备实听验收。':'缺少核准构建与当前配置应用证据，当前不能开启总闸。',
   parameter_effect:'新进入使用参数快照；关闸、移出名单或禁用场景经短租约撤权。'};
 }catch{return {status:'not_integrated',ready:false,effective_enabled:false,applied_revision:null,active_sessions:null,last_ack_at:null,message:'倾听授权暂不可用',parameter_effect:'暂停签发，等待可信证据'};}}
}
