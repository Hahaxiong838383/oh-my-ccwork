import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ListeningAuthority,type ListeningHeaders } from '../listening-authority.js';
import { ListeningError } from '../listening-authority-store.js';
import { listeningDigest,parseListeningRequest,type ListeningPath,type ListeningRequest } from '../listening-http-contract.js';
import { summaryInput,feedbackInput,type ListeningContentAdapter } from '../listening-content.js';
const envelope=(e:ListeningError)=>({version:1,ok:false,error:{code:e.code,retryable:e.retryable}});
/** Storage setup failure must affect only listening, never ordinary server startup/signing. */
export function createLazyListeningRoute(factory:()=>Hono){
 const app=new Hono();let route:Hono|undefined;
 app.all('*',c=>{try{return (route??=new Hono().route('/v1/internal/listening',factory())).fetch(c.req.raw);}catch{return c.json(envelope(new ListeningError('authority_unavailable',503,true)),503);}});
 return app;
}
/** Main authority router. Intentionally not mounted in search-canary-main. */
export function createListeningRoute(authority:ListeningAuthority,content:ListeningContentAdapter){
 const app=new Hono();const cache=new Map<string,{reply:any;until:number}>();
 app.use('/worker-ready',bodyLimit({maxSize:4096,onError:c=>c.json(envelope(new ListeningError('request_too_large',413)),413)}));
 app.use('*',bodyLimit({maxSize:96*1024,onError:c=>c.json(envelope(new ListeningError('request_too_large',413)),413)}));
 app.onError((e,c)=>{const safe=e instanceof ListeningError?e:new ListeningError('authority_unavailable',503,true);return c.json(envelope(safe),safe.status as ContentfulStatusCode);});
 for(const path of ['/worker-ready','/lease','/close','/summary','/feedback'] as ListeningPath[])app.post(path,async c=>{
  const body=await c.req.json().catch(()=>null);const parsed=parseListeningRequest(path,body);if(!parsed)throw new ListeningError('invalid_request',400);
  const headers:ListeningHeaders={authorization:c.req.header('authorization'),'x-p003-worker-token':c.req.header('x-p003-worker-token'),'x-p003-listening-grant':c.req.header('x-p003-listening-grant')};
  if(path==='/worker-ready')return c.json(await authority.workerReady(headers,parsed));
  if(path==='/lease')return c.json(await authority.lease(headers,parsed));
  if(path==='/close'){const response=await authority.close(headers,parsed);for(const key of cache.keys())if(key.startsWith((parsed as any).session.session_id+':'))cache.delete(key);return c.json(response);}
  const value=parsed as ListeningRequest<'/summary'>|ListeningRequest<'/feedback'>;
  const context=await authority.contentContext(headers,value);const {session,entry,now}=context;
  if(c.req.raw.signal.aborted)throw new ListeningError('request_spent',409);
  if(path==='/feedback'){
   const f=value as ListeningRequest<'/feedback'>;
   if(f.trigger==='voice_invitation'&&(f.scene==='singing'||!entry.snapshot.tuning.voice_invitation_enabled))throw new ListeningError('not_authorized');
   if(![f.summary,f.recent,f.question].some(s=>s.trim()))throw new ListeningError('invalid_request',400);
  }
  const kind=path.slice(1),hash=listeningDigest({path,body:value}),key=session.session_id+':'+value.request_id;
  const prior=authority.store.claimContent(session.session_id,value.listening_id,value.request_id,hash,kind,value.mode_epoch,now,entry.snapshot.tuning.feedback_cooldown_sec*1000);
  for(const [id,v] of cache)if(v.until<=now)cache.delete(id);
  if(prior){if(prior.status==='running')throw new ListeningError('request_in_progress',409,true);
   const hit=cache.get(key);if(prior.status==='done'&&hit)return c.json(hit.reply);
   throw new ListeningError('request_spent',409);
  }
  const controller=new AbortController();const cancel=()=>controller.abort();c.req.raw.signal.addEventListener('abort',cancel,{once:true});if(c.req.raw.signal.aborted)cancel();
  const budget=path==='/summary'?8000:Math.min(8000,entry.snapshot.tuning.feedback_max_duration_sec*1000);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new ListeningError('model_timeout',504,true));controller.abort();},budget);});
   const work=(async()=>{
    if(controller.signal.aborted)throw new ListeningError('request_spent',409);
    const input=path==='/summary'?summaryInput(value as ListeningRequest<'/summary'>)
     :feedbackInput(value as ListeningRequest<'/feedback'>,entry.snapshot,await content.personality(session));
    if(controller.signal.aborted)throw new ListeningError('request_spent',409);
    const text=(await content.generate({...input,signal:controller.signal})).trim();
    if(!text||Array.from(text).length>input.maxChars||/\[\[\s*DEV:|<\/?tool|<function_call|```/i.test(text))throw new ListeningError('content_invalid',502);
    return text;
   })();
   const aborted=new Promise<never>((_,reject)=>{if(controller.signal.aborted)reject(new ListeningError('request_spent',409));else controller.signal.addEventListener('abort',()=>reject(new ListeningError('request_spent',409)),{once:true});});
   const text=await Promise.race([work,timeout,aborted]);
   await authority.contentContext(headers,value);if(controller.signal.aborted)throw new ListeningError('request_spent',409);
   const common={version:1,request_id:value.request_id,listening_id:value.listening_id,mode_epoch:value.mode_epoch,policy_revision:authority.config().revision,snapshot_revision:entry.snapshot.revision};
   const reply=path==='/summary'?{...common,base_summary_version:(value as ListeningRequest<'/summary'>).base_summary_version,
    source_sha256:listeningDigest({base_summary_version:(value as ListeningRequest<'/summary'>).base_summary_version,previous_summary:(value as ListeningRequest<'/summary'>).previous_summary,has_gap:value.has_gap,segments:(value as ListeningRequest<'/summary'>).segments}),
    covered:(value as ListeningRequest<'/summary'>).segments.map(s=>({seq:s.seq,revision:s.revision})),summary:text,has_gap:value.has_gap}
    :{...common,text,max_chars:entry.snapshot.tuning.feedback_max_chars,max_duration_ms:entry.snapshot.tuning.feedback_max_duration_sec*1000};
   if(!authority.store.finishContent(session.session_id,value.request_id,'done'))throw new ListeningError('request_spent',409);
   if(cache.size>=256)cache.delete(cache.keys().next().value!);cache.set(key,{reply,until:Math.min(authority.now()+60000,session.expires_at_ms)});
   console.info('[listening-content]',JSON.stringify({purpose:kind,outcome:'done',chars:Array.from(text).length,elapsed_ms:authority.now()-now}));
   return c.json(reply);
  }catch(e){authority.store.finishContent(session.session_id,value.request_id,'failed');throw e;}
  finally{if(timer)clearTimeout(timer);controller.abort();c.req.raw.signal.removeEventListener('abort',cancel);}
 });
 return app;
}
