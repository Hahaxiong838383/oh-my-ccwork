import {statfsSync} from 'node:fs';
import {configStore} from '../config-store.js';
import {arkAdmissionLimit,readArkLegacyLimit} from '../storage/policy.js';
import {arkDirectReplyAllowed} from './answer.js';
import type {ArkReadResult} from './contracts.js';
import {isArkStateQuestion} from '../xiaoke-kb.js';
import {isArkFollowup} from './memory-policy.js';
import {resolve} from 'node:path';
import {ArkStore} from './store.js';
import {ArkRuntime} from './runtime.js';
import {ArkFactsProxy} from './proxy.js';
import {deviceRegistryStore} from '../device-registry-store.js';
import {accountStore} from '../account-store.js';
let service:ArkRuntime|undefined;
let store:ArkStore|undefined;
let proxy:ArkFactsProxy|undefined;
// Candidate devices are not permission grants. Every read/write still checks current identity + Ark grant.
export const arkCeiling=()=>deviceRegistryStore.list().filter(d=>d.status==='active').map(d=>d.sn);
export function arkCapacity(){
 const settings=arkStore().settings(),policy=configStore.storagePolicy(),profile=configStore.storageProfile(),legacy=readArkLegacyLimit(configStore.getFlag('ark.scope-seed.v1')?.value);
 const fs=statfsSync(resolve(process.env.ARK_DB_PATH??'./data/ark.db'));
 const free=Number(fs.bavail)*Number(fs.bsize),diskOk=free>=4.5*1024**3;
 return {storage_policy_revision:policy.revision,validated_devices:profile.ark_devices||null,legacy_preserved_devices:legacy,current_devices:settings.enabled?settings.subjects.length:0,max_enabled_devices:diskOk?arkAdmissionLimit(policy,profile,settings.subjects.length,legacy):0,free_bytes:free,checked_at_ms:Date.now(),limiting_factors:[...(!diskOk?['cloud_disk']:[]),...(profile.ark_devices<policy.target_devices?['not_validated']:[])]};
}
export function arkAuthorizedSubjects(){const a=arkStore();return a.settings().subjects.filter(sn=>{const i=arkService().identity(sn);return !!i&&!!a.grant(i);});}
export function arkStore():ArkStore{
 if(!store){
  store=new ArkStore(resolve(process.env.ARK_DB_PATH??'./data/ark.db'),{run:fn=>configStore.withStorageAdmission(fn),limit:()=>arkCapacity().max_enabled_devices});
  // Record the old environment seed once; never create grants or device configurations from it.
  configStore.withStorageAdmission(()=>{if(!configStore.getFlag('ark.scope-seed.v1'))configStore.setFlag('ark.scope-seed.v1',JSON.stringify({version:1,legacy_limit:store!.settings().subjects.length,subjects:(process.env.ARK_CONTEXT_SN_ALLOW??'').split(',').map(x=>x.trim()).filter(x=>/^BJP003\d{14}$/.test(x)),migrated_at_ms:Date.now()}),'migration','legacy scope seed only; current grants are authoritative');});
 }return store;
}
export function arkService(){return service??=new ArkRuntime({store:arkStore(),
 workerAccountId:process.env.ARK_WORKER_ACCOUNT_ID??process.env.SEARCH_WORKER_ACCOUNT_ID??'',
 readIdentity:sn=>arkCeiling().includes(sn)?deviceRegistryStore.arkIdentity(sn):null,
 validAccount:id=>accountStore.findAccount(id)?.role==='device',
 internalUrl:process.env.ARK_ANALYTICS_INTERNAL_URL??'http://127.0.0.1:3006',internalSecret:process.env.ANALYTICS_INTERNAL_SECRET??''});}
/** Lazy: closed/unused feature creates no new DB and never delays ordinary chat. */
export async function arkContext(q:Parameters<ArkRuntime['context']>[0]):Promise<ArkReadResult>{
 if(!isArkStateQuestion(q.text)&&!isArkFollowup(q.text,q.history??[]))return {prompt:''};
 if(!process.env.AUTH_JWT_SECRET?.trim()||(!process.env.CUSTOM_LLM_API_KEY?.trim()&&!arkDirectReplyAllowed(q.auth,q.room,!!q.override,!!q.feedback))||q.override||q.feedback||q.auth?.role!=='device')return {prompt:''};
 if(process.env.ARK_FACTS_PROXY_URL){
  if(!process.env.SEARCH_WORKER_ACCOUNT_ID||q.auth.accountId!==process.env.SEARCH_WORKER_ACCOUNT_ID)return {prompt:''};
  const sn=/^sn-(BJP003\d{14})-\d{1,20}$/.exec(q.room)?.[1];if(!sn)return {prompt:''};
  proxy??=new ArkFactsProxy({url:process.env.ARK_FACTS_PROXY_URL,secret:process.env.ARK_FACTS_PROXY_SECRET??''});
  return proxy.context(sn);
 }
 try{return await arkService().context(q);}catch{return {prompt:''};}
}
