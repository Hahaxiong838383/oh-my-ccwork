import {isArkStateQuestion} from '../xiaoke-kb.js';
import {isArkFollowup} from './memory-policy.js';
import {historySchema,unknownHistory,type ArkHistory} from './contracts.js';
import {readBoundedJson} from './http.js';
import {formatArkFacts} from './context.js';
import type {ArkIdentity} from './identity.js';
import type {ArkStore} from './store.js';
type Options={workerAccountId:string;store:ArkStore;readIdentity:(sn:string)=>ArkIdentity|null;validAccount:(accountId:string)=>boolean;internalUrl:string;internalSecret:string;fetchImpl?:typeof fetch};
type Input={auth:{accountId:string;role:string}|null;room:string;text:string;override?:boolean;feedback?:boolean;history?:{role:string;content:string}[]};
/** All authorization is re-read after asynchronous work; no authorization or fact cache. */
export class ArkRuntime {
 private pending=0;
 constructor(private o:Options){}
 identity(sn:string){const i=this.o.readIdentity(sn);return i&&this.o.validAccount(i.account_id)?i:null;}
 async context(q:Input):Promise<{prompt:string}>{
  if(!isArkStateQuestion(q.text)&&!isArkFollowup(q.text,q.history??[]))return {prompt:''};
  if(q.override||q.feedback||q.auth?.role!=='device'||!this.o.workerAccountId||q.auth.accountId!==this.o.workerAccountId)return {prompt:''};
  const sn=/^sn-(BJP003\d{14})-\d+$/.exec(q.room)?.[1];if(!sn)return {prompt:''};
  return this.facts(sn);
 }
 async preview(sn:string){return this.facts(sn);}
 private async facts(sn:string):Promise<{prompt:string}>{
  const started=performance.now();
  try{
   const identity=this.identity(sn),grant=identity&&this.o.store.grant(identity);if(!identity||!grant)return {prompt:''};
   let history:ArkHistory=unknownHistory();
   let url:URL|null=null;try{url=new URL(this.o.internalUrl);}catch{}
   if(url&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&this.o.internalSecret&&this.pending<8){
    const controller=new AbortController(),remaining=Math.max(1,120-(performance.now()-started));
    const timer=setTimeout(()=>controller.abort(),remaining);this.pending++;
    try{
     const result=await Promise.race([(async()=>{const response=await (this.o.fetchImpl??fetch)(new URL('/internal/analytics/ark-summary',url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Analytics-Internal-Token':this.o.internalSecret},body:JSON.stringify({subject:sn,account_id:identity.account_id,epoch:identity.epoch,not_before_ms:grant.not_before_ms}),signal:controller.signal});
      if(!response.ok){void response.body?.cancel().catch(()=>{});return unknownHistory();}
      return historySchema.parse(await readBoundedJson(response,8192,remaining,controller.signal));})(),new Promise<ArkHistory>(resolve=>controller.signal.addEventListener('abort',()=>resolve(unknownHistory()),{once:true}))]);
     if(performance.now()-started<=125)history=result;
    }catch{}finally{clearTimeout(timer);controller.abort();this.pending--;}
   }
   const latest=this.identity(sn),currentGrant=latest&&this.o.store.grant(latest);
   if(!latest||latest.account_id!==identity.account_id||latest.epoch!==identity.epoch||currentGrant?.grant_id!==grant.grant_id)return {prompt:''};
   return {prompt:formatArkFacts({snapshot:this.o.store.current(latest),history},Date.now())};
  }catch{return {prompt:''};}
 }
}
