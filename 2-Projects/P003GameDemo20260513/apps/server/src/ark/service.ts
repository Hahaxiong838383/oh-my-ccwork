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
export const arkCeiling=()=> (process.env.ARK_CONTEXT_SN_ALLOW??'BJP00326081002000026').split(',').map(x=>x.trim()).filter(Boolean).slice(0,32);
export function arkStore(){return store??=new ArkStore(resolve(process.env.ARK_DB_PATH??'./data/ark.db'));}
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
  proxy??=new ArkFactsProxy({url:process.env.ARK_FACTS_PROXY_URL,secret:process.env.ARK_FACTS_PROXY_SECRET??'',allowed:()=> (process.env.SEARCH_CANARY_SN??'').split(',').filter(Boolean)});
  return proxy.context(sn);
 }
 try{return await arkService().context(q);}catch{return {prompt:''};}
}
