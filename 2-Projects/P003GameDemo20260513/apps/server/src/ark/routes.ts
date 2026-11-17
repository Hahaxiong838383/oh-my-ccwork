import {Hono} from 'hono';
import {verifyDeviceCredential} from '../device-credential.js';
import {snapshotSchema,settingsSchema} from './contracts.js';
import {readBoundedJson,ArkHttpError} from './http.js';
import type {ArkRuntime} from './runtime.js';
import type {ArkStore} from './store.js';
import {retryArkBusy} from './busy-retry.js';
type Options={store:()=>ArkStore;runtime:()=>ArkRuntime;ceiling:()=>string[];secret:()=>string;acceptsCredential:(sn:string,iat:number)=>boolean;isAdmin:(header:string)=>boolean};
export function createArkRoutes(o:Options){
 const app=new Hono(),hits=new Map<string,number[]>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.post('/state',async c=>{
  const credential=await verifyDeviceCredential(c.req.header('authorization'),o.secret(),o.acceptsCredential);
  if(!credential)return c.json({ok:false,error:'invalid_device_credential'},401);
  const identity=o.runtime().identity(credential.sn),grant=identity&&o.store().grant(identity);
  if(!identity||!grant||!o.ceiling().includes(credential.sn))return c.json({ok:false,error:'not_enabled_or_authorized'},403);
  const now=Date.now();for(const [sn,h] of hits)if(!h.length||now-h[h.length-1]>=60000)hits.delete(sn);
  const h=(hits.get(credential.sn)??[]).filter(t=>now-t<60000);
  if(h.length>=12){c.header('Retry-After','60');return c.json({ok:false,error:'rate_limited'},429);}h.push(now);hits.set(credential.sn,h);
  const parsed=snapshotSchema.safeParse(await readBoundedJson(c.req.raw,16384));
  if(!parsed.success)return c.json({ok:false,error:'invalid_snapshot'},400);
  const latest=o.runtime().identity(credential.sn),g=latest&&o.store().grant(latest);
  if(!latest||g?.grant_id!==grant.grant_id)return c.json({ok:false,error:'not_authorized'},403);
  // Recheck revocation after awaited request body; failing dependency returns 503.
  if(!await verifyDeviceCredential(c.req.header('authorization'),o.secret(),o.acceptsCredential))return c.json({ok:false,error:'invalid_device_credential'},401);
  try{return await retryArkBusy(async retry=>{
   if(retry){
    if(!await verifyDeviceCredential(c.req.header('authorization'),o.secret(),o.acceptsCredential))return c.json({ok:false,error:'invalid_device_credential'},401);
    const current=o.runtime().identity(credential.sn),currentGrant=current&&o.store().grant(current);
    if(!current||current.sn!==latest.sn||current.account_id!==latest.account_id||current.epoch!==latest.epoch||currentGrant?.grant_id!==grant.grant_id||!o.ceiling().includes(credential.sn))return c.json({ok:false,error:'not_authorized'},403);
   }
   return c.json({ok:true,...o.store().accept(latest,parsed.data,Date.now())});
  });}
  catch(e){const code=(e as Error).message;if(code==='archive_buffer_full'){c.header('Retry-After','60');return c.json({ok:false,error:code},503);}if(['stale','conflict','before_grant'].includes(code))return c.json({ok:false,error:code},409);if(code==='clock_invalid')return c.json({ok:false,error:code},400);throw e;}
 });
 app.use('/admin/*',async(c,next)=>{if(!o.isAdmin(c.req.header('authorization')??''))return c.json({ok:false,error:'admin_required'},403);await next();});
 app.get('/admin/settings',c=>{const settings=o.store().settings();return c.json({ok:true,...settings,scope_ceiling:o.ceiling(),freshness_seconds:30,interface:'admin_ui_and_api',grants:settings.subjects.map(sn=>{const identity=o.runtime().identity(sn),g=identity&&o.store().grant(identity);return {sn,authorized:!!g,not_before_ms:g?.not_before_ms??null};})});});
 app.put('/admin/devices/:sn/authorize',async c=>{
  const sn=c.req.param('sn');if(!o.ceiling().includes(sn))return c.json({ok:false,error:'invalid_scope'},400);
  const body=await readBoundedJson(c.req.raw,128);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='expected_revision')||('expected_revision' in body&&(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)))return c.json({ok:false,error:'invalid_settings'},400);
  const identity=o.runtime().identity(sn);if(!identity)return c.json({ok:false,error:'invalid_scope'},400);
  o.store().authorize(identity,Date.now(),(body as {expected_revision?:number}).expected_revision);return c.json({ok:true,sn,authorized:true});
 });
 app.put('/admin/settings',async c=>{
  const parsed=settingsSchema.safeParse(await readBoundedJson(c.req.raw,64*1024));if(!parsed.success)return c.json({ok:false,error:'invalid_settings'},400);
  const q=parsed.data,identities=q.subjects.map(sn=>o.ceiling().includes(sn)?o.runtime().identity(sn):null);
  if(q.enabled&&(!q.subjects.length||identities.some(x=>!x)))return c.json({ok:false,error:'invalid_scope'},400);
  o.store().configure(q.enabled,q.enabled?identities.filter(x=>x!==null):[],Date.now(),q.expected_revision);return c.json({ok:true,...o.store().settings()});
 });
 app.get('/admin/preview',async c=>{const sn=c.req.query('sn')??'';if(!o.ceiling().includes(sn))return c.json({ok:false,error:'invalid_scope'},400);return c.json({ok:true,...await o.runtime().preview(sn),interface:'same_runtime_api_preview'});});
 app.onError((e,c)=>{if(e.message==='settings_conflict'||e.message==='STORAGE_CAPACITY_LIMIT')return c.json({ok:false,error:e.message},409);if(e instanceof ArkHttpError)return c.json({ok:false,error:e.message},e.status);return c.json({ok:false,error:'ark_dependency_unavailable'},503);});
 return app;
}
