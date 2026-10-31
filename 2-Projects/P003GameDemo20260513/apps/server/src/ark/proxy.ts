import {Hono} from 'hono';
import {timingSafeEqual} from 'node:crypto';
import {readBoundedJson} from './http.js';
/** Read-only bridge for isolated search/listening Brains. No shared writable DB. */
export function arkFactsRoute(o:{secret:()=>string;allowed:()=>string[];facts:(sn:string)=>Promise<{prompt:string}>}){
 const app=new Hono();let pending=0;
 app.post('/',async c=>{
  c.header('Cache-Control','no-store');
  const want=o.secret(),got=c.req.header('X-Ark-Internal-Token')??'';
  if(want.length<32||Buffer.byteLength(want)!==Buffer.byteLength(got)||!timingSafeEqual(Buffer.from(want),Buffer.from(got)))return c.json({ok:false},401);
  if(pending>=8)return c.json({ok:false},503);
  pending++;const work=(async()=>{try{
   const q=await readBoundedJson(c.req.raw,128,150) as {subject?:string};
   if(!q||Object.keys(q).length!==1||typeof q.subject!=='string'||!/^BJP003\d{14}$/.test(q.subject)||!o.allowed().includes(q.subject))return c.json({ok:false},403);
   const result=await o.facts(q.subject);
   // The authority checks current identity and grant again after its async history read.
   if(!o.allowed().includes(q.subject))return c.json({ok:false},403);
   return c.json({ok:true,prompt:result.prompt});
  }catch{return c.json({ok:false},503);}finally{pending--;}})();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<Response>(resolve=>{timer=setTimeout(()=>resolve(c.json({ok:false},503)),150);})]);}finally{clearTimeout(timer);}
 });
 return app;
}
export class ArkFactsProxy{
 private pending=0;
 constructor(private o:{url:string;secret:string;allowed:()=>string[];fetchImpl?:typeof fetch}){}
 async context(sn:string):Promise<{prompt:string}>{
  let url:URL;try{url=new URL(this.o.url);}catch{return {prompt:''};}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||this.o.secret.length<32||!this.o.allowed().includes(sn)||this.pending>=8)return {prompt:''};
  const started=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150);this.pending++;
  try{
   const result=await Promise.race([(async()=>{
    const r=await(this.o.fetchImpl??fetch)(new URL('/internal/ark-facts',url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Ark-Internal-Token':this.o.secret},body:JSON.stringify({subject:sn}),signal:controller.signal});
    if(!r.ok){void r.body?.cancel().catch(()=>{});return {prompt:''};}
    const v=await readBoundedJson(r,8192,150,controller.signal) as {ok?:boolean;prompt?:string};
    return v?.ok===true&&typeof v.prompt==='string'&&v.prompt.length<=6000?{prompt:v.prompt}:{prompt:''};
   })(),new Promise<{prompt:string}>(resolve=>controller.signal.addEventListener('abort',()=>resolve({prompt:''}),{once:true}))]);
   return performance.now()-started<=150&&this.o.allowed().includes(sn)?result:{prompt:''};
  }catch{return {prompt:''};}finally{clearTimeout(timer);controller.abort();this.pending--;}
 }
}
