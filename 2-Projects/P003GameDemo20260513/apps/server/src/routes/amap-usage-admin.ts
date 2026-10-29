import {Hono} from 'hono';
import {z} from 'zod';
import {isValidToken,isAdminRole,getTokenUser} from './auth.js';
import {amapAdjustmentSchema,type AmapUsageStore} from '../tools/amap-usage.js';

export function createAmapUsageAdminRoute(deps:{store:()=>AmapUsageStore;runtime:()=>Promise<{enabled:boolean;key_configured:boolean}|null>}){
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');const t=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')||'')?.[1]||'';if(!isValidToken(t))return c.json({ok:false,error:'unauthorized'},401);if(!isAdminRole(t))return c.json({ok:false,error:'forbidden'},403);await next();});
 app.onError((e,c)=>{const code=e instanceof z.ZodError||e instanceof SyntaxError?'invalid_request':e.message;return c.json({ok:false,error:['revision_conflict','idempotency_conflict','budget_too_large','invalid_request','body_too_large'].includes(code)?code:'usage_unavailable'},['revision_conflict','idempotency_conflict'].includes(code)?409:code==='invalid_request'||code==='budget_too_large'?400:code==='body_too_large'?413:503);});
 app.get('/',async c=>c.json({ok:true,...deps.store().snapshot(),runtime:await deps.runtime()}));
 app.post('/',async c=>{
  const reader=c.req.raw.body?.getReader();if(!reader)return c.json({ok:false,error:'invalid_request'},400);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048)throw new Error('body_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const v=amapAdjustmentSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  deps.store().adjust(v,getTokenUser((c.req.header('authorization')||'').replace(/^Bearer\s+/i,''))||'admin');
  return c.json({ok:true,...deps.store().snapshot()});
 });return app;
}
