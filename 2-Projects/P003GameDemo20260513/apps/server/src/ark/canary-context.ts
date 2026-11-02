import {isArkStateQuestion} from '../xiaoke-kb.js';
import {isArkFollowup} from './memory-policy.js';
import {ArkFactsProxy} from './proxy.js';
import type {ArkReadResult} from './contracts.js';
let proxy:ArkFactsProxy|undefined;
type Query={auth:{accountId:string;role:string}|null;room:string;text:string;history?:{role:string;content:string}[];override?:boolean;feedback?:boolean};
/** Isolated candidate: read authority over authenticated loopback HTTP only. */
export async function arkContext(q:Query):Promise<ArkReadResult>{
 if(!isArkStateQuestion(q.text)&&!isArkFollowup(q.text,q.history??[]))return {prompt:''};
 if(!process.env.AUTH_JWT_SECRET?.trim()||!process.env.CUSTOM_LLM_API_KEY?.trim()||q.override||q.feedback||q.auth?.role!=='device')return {prompt:''};
 if(!process.env.ARK_FACTS_PROXY_URL||!process.env.SEARCH_WORKER_ACCOUNT_ID||q.auth.accountId!==process.env.SEARCH_WORKER_ACCOUNT_ID)return {prompt:''};
 const sn=/^sn-(BJP003\d{14})-\d{1,20}$/.exec(q.room)?.[1];if(!sn)return {prompt:''};
 proxy??=new ArkFactsProxy({url:process.env.ARK_FACTS_PROXY_URL,secret:process.env.ARK_FACTS_PROXY_SECRET??'',allowed:()=> (process.env.SEARCH_CANARY_SN??'').split(',').filter(Boolean)});
 return proxy.context(sn);
}
