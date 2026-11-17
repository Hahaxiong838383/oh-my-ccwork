import {historySchema} from './contracts.js';
import {readBoundedJson} from './http.js';
import {setTimeout as delay} from 'node:timers/promises';
/** Startup only: warm HTTP/body/schema without creating a store, grant or device fact. */
export async function warmArkHistory(o:{internalUrl:string;internalSecret:string}):Promise<{status:'ready'|'degraded'|'skipped'}>{
 let url:URL;try{url=new URL(o.internalUrl);}catch{return {status:'skipped'};}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!o.internalSecret)return {status:'skipped'};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);
 try{
  // A listening socket can precede writer/bootstrap checkpoint readiness. Do not
  // race that initialization with the first facts request. This shares the same
  // one-second startup budget; it never waits on the ordinary conversation path.
  for(;;){
   const ready=await fetch(new URL('/ready',url),{redirect:'error',signal:controller.signal});
   const state=await readBoundedJson(ready,8192,1000,controller.signal);
   if(ready.ok&&(state as {ready?:unknown})?.ready===true)break;
   if(ready.status!==503)return {status:'degraded'};
   await delay(25,undefined,{signal:controller.signal});
  }
  const response=await fetch(new URL('/internal/analytics/ark-warmup',url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Analytics-Internal-Token':o.internalSecret},body:'{}',signal:controller.signal});
  if(!response.ok){void response.body?.cancel().catch(()=>{});return {status:'degraded'};}
  historySchema.parse(await readBoundedJson(response,8192,1000,controller.signal));
  return {status:'ready'};
 }catch{return {status:'degraded'};}finally{clearTimeout(timer);controller.abort();}
}
