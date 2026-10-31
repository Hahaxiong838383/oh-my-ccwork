import {isArkStateQuestion} from '../xiaoke-kb.js';
import {isArkFollowup} from './memory-policy.js';
import {resolve} from 'node:path';
import {ArkStore} from './store.js';
import {ArkRuntime} from './runtime.js';
import {deviceRegistryStore} from '../device-registry-store.js';
import {accountStore} from '../account-store.js';
let service:ArkRuntime|undefined;
let store:ArkStore|undefined;
export const arkCeiling=()=> (process.env.ARK_CONTEXT_SN_ALLOW??'BJP00326081002000026').split(',').map(x=>x.trim()).filter(Boolean).slice(0,32);
export function arkStore(){return store??=new ArkStore(resolve(process.env.ARK_DB_PATH??'./data/ark.db'));}
export function arkService(){return service??=new ArkRuntime({store:arkStore(),
 workerAccountId:process.env.ARK_WORKER_ACCOUNT_ID??process.env.SEARCH_WORKER_ACCOUNT_ID??'',
 readIdentity:sn=>arkCeiling().includes(sn)?deviceRegistryStore.arkIdentity(sn):null,
 validAccount:id=>accountStore.findAccount(id)?.role==='device',
 internalUrl:process.env.ARK_ANALYTICS_INTERNAL_URL??'http://127.0.0.1:3006',internalSecret:process.env.ANALYTICS_INTERNAL_SECRET??''});}
/** Lazy: closed/unused feature creates no new DB and never delays ordinary chat. */
export async function arkContext(q:Parameters<ArkRuntime['context']>[0]){
 if(!isArkStateQuestion(q.text)&&!isArkFollowup(q.text,q.history??[]))return {prompt:''};
 if(!process.env.AUTH_JWT_SECRET?.trim()||!process.env.CUSTOM_LLM_API_KEY?.trim()||q.override||q.feedback||q.auth?.role!=='device')return {prompt:''};
 try{return await arkService().context(q);}catch{return {prompt:''};}
}
