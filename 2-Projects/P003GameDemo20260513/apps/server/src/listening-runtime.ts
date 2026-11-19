import { readFileSync,statSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceRegistryStore } from './device-registry-store.js';
import { configStore } from './config-store.js';
import { getListeningSettingsStore } from './listening-settings-store.js';
import { ListeningAuthority,type IssueInput } from './listening-authority.js';
import { ListeningAuthorityStore,type AuthoritySession } from './listening-authority-store.js';
import { listeningSessionSchema } from './listening-http-contract.js';

export function listeningWorkerAccounts(raw=process.env.LISTENING_WORKER_ACCOUNTS??''):Record<string,string>{
 try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)return {};
  const entries=Object.entries(value);if(!entries.length||!entries.every(([k,v])=>/^[A-Za-z0-9_-]{1,128}$/.test(k)&&typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v)))return {};
  // One credential identifies one dispatch target, never several roles.
  if(new Set(entries.map(([,v])=>v)).size!==entries.length)return {};return value;
 }catch{return {};}
}
function releaseManifest():unknown {
 try{const path=process.env.LISTENING_RELEASE_MANIFEST_PATH;if(!path||statSync(path).size>16384)return null;
  const raw=readFileSync(path,'utf8');return Buffer.byteLength(raw)<=16384?JSON.parse(raw):null;
 }catch{return null;}
}
/** Read current search authorization only. Never mutate its existing window or reuse its health as listening evidence. */
export function listeningSourceDeadline(session:AuthoritySession,_now:number){
 if(session.source==='normal')return session.source_cutoff_ms;
 try{const flag=(key:string)=>configStore.getFlag('p003.search.canary.'+key)?.value;
  if(session.source_generation!==getListeningSettingsStore().sourceGeneration())return 0;
  const allow:unknown=JSON.parse(flag('allowlist')??'[]'),expiry=Number(flag('expires_at_ms'));
  if(flag('enabled')!=='1'||flag('agent')!==session.agent||!Array.isArray(allow)||!allow.includes(session.sn)||!Number.isSafeInteger(expiry))return 0;
  return Math.min(session.source_cutoff_ms,expiry);
 }catch{return 0;}
}
let instance:ListeningAuthority|undefined;
export function getListeningAuthority(){
 if(!instance){void deviceRegistryStore; // Ensure the existing registry/revocation schema owns this database first.
  instance=new ListeningAuthority({store:new ListeningAuthorityStore(resolve(process.env.DEVICES_DB_PATH?.trim()||'./data/devices.db')),
   getConfig:()=>getListeningSettingsStore().read().config,clock:Date.now,
   // Main ordinary-chat auth may intentionally have no shared key. Internal listening can use its own key.
   secrets:()=>({authSecret:process.env.AUTH_JWT_SECRET??'',grantSecret:process.env.LISTENING_GRANT_SECRET??'',serviceKey:process.env.LISTENING_SERVICE_KEY??process.env.CUSTOM_LLM_API_KEY??'',workerAccounts:listeningWorkerAccounts()}),
   manifest:releaseManifest,sourceDeadline:listeningSourceDeadline,sourceGeneration:()=>getListeningSettingsStore().sourceGeneration(),
   restrictedSince:(revision,sn,scene)=>getListeningSettingsStore().restrictedSince(revision,sn,scene)});
 }return instance;
}
export function listeningRuntimeStatus(){
 try{return getListeningAuthority().runtime();}catch{return {status:'not_integrated',ready:false,effective_enabled:false,applied_revision:null,active_sessions:null,last_ack_at:null,
  message:'缺少可信能力与配置应用证据，暂停签发倾听授权。',parameter_effect:'新进入使用参数快照；关闭和撤权经短租约生效。'};}
}
export async function issueSessionListening(input:IssueInput){
 // Preserve the disabled/old-client signing path without opening new stores or reading release files.
 if(!input.supports.includes('listening_mode_v1'))return null;
 try{const config=getListeningSettingsStore().read().config;if(!config.enabled||!config.allowlist.includes(input.sn))return null;
  if(!listeningSessionSchema.safeParse({sn:input.sn,room:input.room,session_id:input.session_id,trace_id:input.trace_id,account_id:'pending'}).success)return null;
  return await getListeningAuthority().issue(input);
 }catch{console.warn('[device-session] listening optional authorization unavailable');return null;}
}
