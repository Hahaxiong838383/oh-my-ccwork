import { LISTENING_CANARY_AGENT, validCanaryAllowlist } from './search-canary-policy.js';
import { existsSync, realpathSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
const stores = {ACCOUNTS_DB_PATH:'accounts.db',PROFILE_DB_PATH:'profile.db',DEVICES_DB_PATH:'devices.db',CONFIG_DB_PATH:'config.db',CONVERSATION_DB_PATH:'conversation.db',FEEDBACK_DB_PATH:'feedback.db',TELEMETRY_DB_PATH:'telemetry.db',DIAGNOSTICS_DB_PATH:'diagnostics.db',OTA_DB_PATH:'ota.db',PAIRING_DB_PATH:'pairing.db',SMS_DB_PATH:'sms.db',SEARCH_TASK_DB_PATH:'search.db',SEARCH_ROUTING_DB_PATH:'search-routing.db',SEARCH_DEVICE_LOCATION_DB_PATH:'device-location.db',AMAP_USAGE_DB_PATH:'amap-usage.db'};
export const CANARY_AGENT='p003-search-canary-20261021';
export const VERIFICATION_AGENT='p003-search-verification-20261026';
export const VERIFICATION_SN='BJP00399999999999901';
export function canaryAgent(raw:string|undefined):string {
 if(raw===undefined||raw===CANARY_AGENT)return CANARY_AGENT;
 if(raw===VERIFICATION_AGENT)return VERIFICATION_AGENT;
 if(raw===LISTENING_CANARY_AGENT)return LISTENING_CANARY_AGENT;
 throw new Error('canary_agent');
}
export function canarySns(raw:string|undefined):string[] { const list=(raw||'').split(','); return validCanaryAllowlist(list)?list:[]; }
export function canaryMaxJobs(raw:string|undefined):number { return raw===undefined||raw==='1'?1:raw==='2'?2:0; }
function canonical(path:string):string {
  if (existsSync(path)) return realpathSync(path);
  const parent=dirname(path); if(parent===path) throw new Error('canary_path');
  return join(canonical(parent),relative(parent,path));
}
// Reject overlap in both directions: an ancestor root could otherwise admit
// writable paths inside the production or another candidate's database tree.
export function canaryRootIsolated(root:string,agent:string):boolean {
 const protectedRoots=['/opt/p003/server',
  ...(agent!==CANARY_AGENT?['/opt/p003/search-canary-20261021']:[]),
  ...(agent!==VERIFICATION_AGENT?['/opt/p003/search-verification-20261026']:[]),
  ...(agent!==LISTENING_CANARY_AGENT?['/opt/p003/listening-canary-20261030']:[])];
 const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
 return root!=='/'&&!protectedRoots.some(p=>overlap(root,p));
}
export function prepareCanaryEnvironment(env:NodeJS.ProcessEnv) {
  const agent=canaryAgent(env.SEARCH_CANARY_AGENT);
  const verification=agent===VERIFICATION_AGENT,listening=agent===LISTENING_CANARY_AGENT;
  const workerAccount=listening?'listening-canary-worker':'search-canary-worker';
  if(verification&&(env.SEARCH_CANARY_SN!==VERIFICATION_SN||canaryMaxJobs(env.SEARCH_CANARY_MAX_JOBS)!==1))throw new Error('canary_verification_identity');
  if(!env.SEARCH_CANARY_ROOT || !isAbsolute(env.SEARCH_CANARY_ROOT)) throw new Error('canary_root_required');
  const root=realpathSync(env.SEARCH_CANARY_ROOT);
  if(!canaryRootIsolated(root,agent)) throw new Error('canary_production_root');
  const contained=(p:string)=>{const r=relative(root,canonical(resolve(p)));return r!==''&&!r.startsWith('..')&&!isAbsolute(r);};
  for(const [k,file] of Object.entries(stores)) {
    const path=env[k]||join(root,'data',file);
    if(!contained(path)) throw new Error('canary_path_'+k);
    env[k]=path;
  }
  for(const k of ['LOCAL_AUDIO_DIR','OTA_DIR','SEARCH_CANARY_HEALTH_FILE']) {
    const path=env[k]||join(root,'data',k.toLowerCase());
    if(!contained(path)) throw new Error('canary_path_'+k);
    env[k]=path;
  }
  // Live candidate reads the reviewed authority; verification reads only its own synthetic registry.
  // SearchResume still opens the authority read-only in either profile.
  const authority=env.SEARCH_RESUME_AUTHORITY_DB_PATH;
  if(authority!==undefined || env.SEARCH_RESUME_V1==='1') {
    const expected=verification?join(root,'data','devices.db'):'/opt/p003/server/data/devices.db';
    if(authority!==expected || existsSync(authority) && (realpathSync(authority)!==authority || !lstatSync(authority).isFile())) throw new Error('canary_resume_authority');
  }
  // Reject all other future/unreviewed store overrides.
  for(const k of Object.keys(env)) if(k.endsWith('_DB_PATH') && !(k in stores) && k!=='SEARCH_RESUME_AUTHORITY_DB_PATH') throw new Error('canary_unknown_store');
  const data=join(root,'data');mkdirSync(data,{recursive:true});
  const scan=(p:string)=>{for(const e of readdirSync(p,{withFileTypes:true})){const q=join(p,e.name);if(e.isSymbolicLink()||lstatSync(q).nlink>1&&!e.isDirectory())throw new Error('canary_link');if(e.isDirectory())scan(q);}};scan(data);
  if(!canarySns(env.SEARCH_CANARY_SN).length || !canaryMaxJobs(env.SEARCH_CANARY_MAX_JOBS) || env.SEARCH_WORKER_ACCOUNT_ID!==workerAccount || !env.CUSTOM_LLM_API_KEY || !env.AUTH_JWT_SECRET) throw new Error('canary_identity');
  for(const k of ['MEMORY_EXTRACT_ENABLED','PERSONA_INSIGHT_ENABLED','PERSONA_LOCAL_AUDIO_ENABLED','PERSONA_NARRATIVE_ENABLED']) env[k]='0';
  env.MEMORY_EXTRACT_MODE='turn';env.LOCAL_AUDIO_GENERATION_PAUSED='1';env.LOCAL_AUDIO_WRITES_PAUSED='1';
}
export type CanaryRequest = {path:string;room:string;sn:string;allowedSns?:string[];account:string;expectedAccount:string;role:string;expires:number;now:number};
export function canaryRequestAllowed(i:CanaryRequest) {
  return validCanaryAllowlist(i.allowedSns??[i.sn]) && (i.allowedSns??[i.sn]).includes(i.sn) && /^BJP003\d{14}$/.test(i.sn) && i.room.startsWith('sn-'+i.sn+'-')
    && /^sn-BJP003\d{14}-\d{1,20}$/.test(i.room) && i.role==='device'
    && ['search-canary-worker','listening-canary-worker'].includes(i.expectedAccount) && i.account===i.expectedAccount
    && Number.isFinite(i.expires) && i.expires>i.now && i.expires-i.now<=168*3600_000
    && (['/v1/chat/completions','/v1/internal/local-audio-texts','/v1/internal/search-tasks/routing','/v1/internal/search-tasks/routing/ack'].includes(i.path)
      || /^\/v1\/internal\/search-tasks(?:\/(?:session\/(?:cancel|close)|resume\/(?:latest|cancel|[a-f0-9-]{36}\/(?:playback|receipt))|[a-f0-9-]{36}(?:\/(?:claim|receipt|cancel|replay|playback|progress))?))?$/.test(i.path));
}
