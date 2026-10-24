import { validCanaryAllowlist } from './search-canary-policy.js';
import { existsSync, realpathSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
const stores = {ACCOUNTS_DB_PATH:'accounts.db',PROFILE_DB_PATH:'profile.db',DEVICES_DB_PATH:'devices.db',CONFIG_DB_PATH:'config.db',CONVERSATION_DB_PATH:'conversation.db',FEEDBACK_DB_PATH:'feedback.db',TELEMETRY_DB_PATH:'telemetry.db',DIAGNOSTICS_DB_PATH:'diagnostics.db',OTA_DB_PATH:'ota.db',PAIRING_DB_PATH:'pairing.db',SMS_DB_PATH:'sms.db',SEARCH_TASK_DB_PATH:'search.db',SEARCH_ROUTING_DB_PATH:'search-routing.db',SEARCH_DEVICE_LOCATION_DB_PATH:'device-location.db'};
export function canarySns(raw:string|undefined):string[] { const list=(raw||'').split(','); return validCanaryAllowlist(list)?list:[]; }
export function canaryMaxJobs(raw:string|undefined):number { return raw===undefined||raw==='1'?1:raw==='2'?2:0; }
function canonical(path:string):string {
  if (existsSync(path)) return realpathSync(path);
  const parent=dirname(path); if(parent===path) throw new Error('canary_path');
  return join(canonical(parent),relative(parent,path));
}
export function prepareCanaryEnvironment(env:NodeJS.ProcessEnv) {
  if(!env.SEARCH_CANARY_ROOT || !isAbsolute(env.SEARCH_CANARY_ROOT)) throw new Error('canary_root_required');
  const root=realpathSync(env.SEARCH_CANARY_ROOT);
  if(root==='/' || root==='/opt/p003/server' || root.startsWith('/opt/p003/server/')) throw new Error('canary_production_root');
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
  // One reviewed read-only authority source. It is never a singleton store override.
  // SearchResume opens this exact file with DatabaseSync({readOnly:true}); all writes stay isolated.
  const authority=env.SEARCH_RESUME_AUTHORITY_DB_PATH;
  if(authority!==undefined || env.SEARCH_RESUME_V1==='1') {
    if(authority!=='/opt/p003/server/data/devices.db' || existsSync(authority) && (realpathSync(authority)!==authority || !lstatSync(authority).isFile())) throw new Error('canary_resume_authority');
  }
  // Reject all other future/unreviewed store overrides.
  for(const k of Object.keys(env)) if(k.endsWith('_DB_PATH') && !(k in stores) && k!=='SEARCH_RESUME_AUTHORITY_DB_PATH') throw new Error('canary_unknown_store');
  const data=join(root,'data');mkdirSync(data,{recursive:true});
  const scan=(p:string)=>{for(const e of readdirSync(p,{withFileTypes:true})){const q=join(p,e.name);if(e.isSymbolicLink()||lstatSync(q).nlink>1&&!e.isDirectory())throw new Error('canary_link');if(e.isDirectory())scan(q);}};scan(data);
  if(!canarySns(env.SEARCH_CANARY_SN).length || !canaryMaxJobs(env.SEARCH_CANARY_MAX_JOBS) || env.SEARCH_WORKER_ACCOUNT_ID!=='search-canary-worker' || !env.CUSTOM_LLM_API_KEY || !env.AUTH_JWT_SECRET) throw new Error('canary_identity');
  for(const k of ['MEMORY_EXTRACT_ENABLED','PERSONA_INSIGHT_ENABLED','PERSONA_LOCAL_AUDIO_ENABLED','PERSONA_NARRATIVE_ENABLED']) env[k]='0';
  env.MEMORY_EXTRACT_MODE='turn';env.LOCAL_AUDIO_GENERATION_PAUSED='1';env.LOCAL_AUDIO_WRITES_PAUSED='1';
}
export type CanaryRequest = {path:string;room:string;sn:string;allowedSns?:string[];account:string;expectedAccount:string;role:string;expires:number;now:number};
export function canaryRequestAllowed(i:CanaryRequest) {
  return validCanaryAllowlist(i.allowedSns??[i.sn]) && (i.allowedSns??[i.sn]).includes(i.sn) && /^BJP003\d{14}$/.test(i.sn) && i.room.startsWith('sn-'+i.sn+'-')
    && /^sn-BJP003\d{14}-\d{1,20}$/.test(i.room) && i.role==='device'
    && i.expectedAccount==='search-canary-worker' && i.account===i.expectedAccount
    && Number.isFinite(i.expires) && i.expires>i.now && i.expires-i.now<=72*3600_000
    && (['/v1/chat/completions','/v1/internal/local-audio-texts','/v1/internal/search-tasks/routing','/v1/internal/search-tasks/routing/ack'].includes(i.path)
      || /^\/v1\/internal\/search-tasks(?:\/(?:session\/(?:cancel|close)|resume\/(?:latest|cancel|[a-f0-9-]{36}\/(?:playback|receipt))|[a-f0-9-]{36}(?:\/(?:claim|receipt|cancel|replay|playback|progress))?))?$/.test(i.path));
}
