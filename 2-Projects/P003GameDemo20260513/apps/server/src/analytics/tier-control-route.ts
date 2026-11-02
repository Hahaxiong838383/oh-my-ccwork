import {Hono} from 'hono';
import type {ConfigStore} from '../config-store.js';
import {readBoundedJson,ArkHttpError} from '../ark/http.js';
import {validateDeviceSn} from '../device-sn.js';
import {DIAGNOSTIC_SOURCES} from './tier-contracts.js';
type Options={authorize:(header:string|undefined)=>string;internalUrl:string;internalSecret:string;fetchImpl?:typeof fetch;devices:()=>{sn:string;status:string}[];config:ConfigStore};
export function analyticsTierControlRoute(o:Options){
 const app=new Hono();
 app.use('*',async(c,next)=>{const role=o.authorize(c.req.header('authorization'));if(role!=='admin')return c.json({ok:false,error:role==='none'?'unauthorized':'forbidden_analytics'},role==='none'?401:403);c.header('Cache-Control','no-store');await next();});
 app.use('/:sn/*',async(c,next)=>{const sn=c.req.param('sn');if(!validateDeviceSn(sn).ok||!o.devices().some(d=>d.sn===sn))return c.json({ok:false,error:'DEVICE_NOT_FOUND'},404);await next();});
 async function live(sn:string){
  const url=new URL(o.internalUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!o.internalSecret)throw new Error('ANALYTICS_UNAVAILABLE');
  const target=new URL('/internal/analytics/tiering',url);target.searchParams.set('sn',sn);
  const r=await(o.fetchImpl??fetch)(target,{headers:{'X-Analytics-Internal-Token':o.internalSecret},signal:AbortSignal.timeout(2500),redirect:'error'});
  if(!r.ok)throw new Error('ANALYTICS_UNAVAILABLE');return await readBoundedJson(r,512*1024) as any;
 }
 async function requireReady(sn:string){const s=await live(sn);if(s?.ok!==true||s.capabilities?.version!==1||!s.runtime_ready)throw new Error('ANALYTICS_UNAVAILABLE');if(!s.upload_allowed||!o.devices().some(d=>d.sn===sn&&d.status==='active'))throw new Error('DEVICE_UPLOAD_NOT_ENABLED');}
 app.get('/:sn',async c=>{
  const sn=c.req.param('sn');if(!validateDeviceSn(sn).ok||!o.devices().some(d=>d.sn===sn))return c.json({ok:false,error:'DEVICE_NOT_FOUND'},404);
  o.config.expireAnalyticsDiagnosticRequests(sn);
  const runtime=await live(sn).catch(()=>null);
  return c.json({ok:true,sn,...o.config.analyticsTierSettings(sn),requests:o.config.analyticsDiagnosticRequests(sn),allowed_event_names:DIAGNOSTIC_SOURCES,runtime,client_applied:false});
 });
 app.put('/:sn',async c=>{
  const sn=c.req.param('sn');if(!validateDeviceSn(sn).ok||!o.devices().some(d=>d.sn===sn))return c.json({ok:false,error:'DEVICE_NOT_FOUND'},404);
  const input=await readBoundedJson(c.req.raw,8192) as any,current=o.config.analyticsTierSettings(sn);
  if(input?.settings&&Object.entries(input.settings).some(([k,v])=>v===true&&current.analytics[k]!==true))await requireReady(sn);
  return c.json({ok:true,sn,...o.config.saveAnalyticsTierSettings(sn,input,'admin'),client_applied:false});
 });
 app.post('/:sn/requests',async c=>{
  const sn=c.req.param('sn'),input=await readBoundedJson(c.req.raw,8192) as any;await requireReady(sn);
  return c.json({ok:true,sn,...o.config.createAnalyticsDiagnosticRequest(sn,input,'admin'),client_applied:false});
 });
 app.delete('/:sn/requests/:id',c=>c.json({ok:true,sn:c.req.param('sn'),...o.config.revokeAnalyticsDiagnosticRequest(c.req.param('sn'),c.req.param('id'),'admin'),client_applied:false}));
 app.onError((e,c)=>{
  if(e instanceof ArkHttpError)return c.json({ok:false,error:e.message},e.status);
  const code=e.message;
  const status=code==='POLICY_CONFLICT'?409:code==='DEVICE_UPLOAD_NOT_ENABLED'?403:code==='DIAGNOSTIC_REQUEST_NOT_FOUND'?404:code==='DIAGNOSTIC_REQUEST_LIMIT'?429:['INVALID_TIER_SETTINGS','INVALID_DIAGNOSTIC_REQUEST','TIERING_NOT_ENABLED'].includes(code)?400:503;
  return c.json({ok:false,error:status===503?'ANALYTICS_UNAVAILABLE':code},status);
 });
 return app;
}
