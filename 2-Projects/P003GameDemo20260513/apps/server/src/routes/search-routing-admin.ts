import {Hono} from 'hono';import {z} from 'zod';
import {isValidToken,isAdminRole,getTokenUser} from './auth.js';
import {routingConfigSchema,validateRoutingRegression,type RoutingConfig,type RouteUtterance} from '../tools/search-routing-config.js';
import type {RoutingStore} from '../tools/search-routing-store.js';
const revision=z.number().int().nonnegative();
const scope=z.array(z.string().regex(/^BJP003\d{14}$/)).min(1).max(2).refine(a=>new Set(a).size===a.length);
const input=z.object({config:routingConfigSchema,utterances:z.array(z.object({text:z.string().refine(s=>[...s].length<=128),at_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),reset:z.boolean().optional()}).strict()).min(1).max(32)}).strict();
export function createRoutingAdminRoute(deps:{store:()=>RoutingStore;scope:()=>string[];preview:(c:RoutingConfig,u:RouteUtterance[])=>Promise<any>;regression?:(c:RoutingConfig)=>Promise<any>}) {
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')||'')?.[1]||'';if(!isValidToken(token))return c.json({error:'unauthorized'},401);if(!isAdminRole(token))return c.json({error:'forbidden'},403);await next();});
 app.onError((e,c)=>{const code=e instanceof z.ZodError||e instanceof SyntaxError?'invalid_request':e.message;const known=['revision_conflict','invalid_request','routing_version_unknown','invalid_scope','preview_timeout','preview_failed','preview_unavailable','body_too_large'];return c.json({error:known.includes(code)?code:'routing_unavailable'},code==='revision_conflict'?409:code==='invalid_request'||code==='invalid_scope'?400:code==='body_too_large'?413:503);});
 const body=async(c:any)=>{const reader=c.req.raw.body?.getReader();if(!reader)throw new Error('invalid_request');let size=0;const parts:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw new Error('body_too_large');parts.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return JSON.parse(Buffer.concat(parts).toString('utf8'));};
 const who=(c:any)=>getTokenUser((c.req.header('authorization')||'').replace(/^Bearer\s+/i,''))||'admin';
 app.get('/',c=>c.json({ok:true,...deps.store().state(),eligible_sns:deps.scope()}));
 app.put('/draft',async c=>{const v=z.object({expected_revision:revision,config:routingConfigSchema}).strict().parse(await body(c));deps.store().saveDraft(v.config,v.expected_revision,who(c));return c.json({ok:true,...deps.store().state()});});
 app.post('/preview',async c=>{const v=input.parse(await body(c));return c.json(await deps.preview(v.config,v.utterances));});
 app.post('/publish',async c=>{
  const v=z.object({expected_revision:revision,sns:scope}).strict().parse(await body(c));if(v.sns.some(sn=>!deps.scope().includes(sn)))return c.json({error:'outside_canary_scope'},403);
  const state=deps.store().state();if(state.revision!==v.expected_revision)return c.json({error:'revision_conflict'},409);
  const check=deps.regression?await deps.regression(state.draft):await validateRoutingRegression(state.draft,deps.preview);
  if(!check.passed)return c.json({error:'routing_regression_failed',regression:check},409);
  // Recheck prepared scope after async validation; do not widen authorization by a stale snapshot.
  if(v.sns.some(sn=>!deps.scope().includes(sn)))return c.json({error:'outside_canary_scope'},403);
  const version=deps.store().publish(v.expected_revision,v.sns,who(c));return c.json({ok:true,version,regression:check,...deps.store().state()});
 });
 app.post('/rollback',async c=>{const v=z.object({expected_revision:revision,sns:scope,version:z.string().regex(/^r7-[a-f0-9]{24}$/)}).strict().parse(await body(c));if(v.sns.some(sn=>!deps.scope().includes(sn)))return c.json({error:'outside_canary_scope'},403);deps.store().rollback(v.version,v.expected_revision,v.sns,who(c));return c.json({ok:true,...deps.store().state()});});
 return app;
}
