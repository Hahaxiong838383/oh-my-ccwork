import {Hono} from 'hono';
import {parseUploadChange,type UploadPolicy} from './upload-policy.js';
import {readBoundedJson} from '../ark/http.js';
type Device={sn:string;note:string;status:string};
type Status={ok:true;revision:number;enabled:boolean;subjects:string[];hour:number;effective_enabled:boolean;valid:boolean;emergency_gate:{enabled:boolean;valid:boolean};managed:boolean};
type Options={authorize:(header:string|undefined)=>string;internalUrl:string;internalSecret:string;fetchImpl?:typeof fetch;devices:()=>Device[];policy:()=>UploadPolicy|null;save:(p:ReturnType<typeof parseUploadChange>,active:string[],by:string)=>UploadPolicy};
export function analyticsControlRoute(o:Options){
  const app=new Hono();
  app.use('*',async(c,next)=>{const role=o.authorize(c.req.header('authorization'));if(role!=='admin')return c.json({ok:false,error:role==='none'?'unauthorized':'forbidden_analytics'},role==='none'?401:403);c.header('Cache-Control','no-store');await next();});
  async function internal(path:string){
    const url=new URL(o.internalUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!o.internalSecret)throw new Error('CAPACITY_UNAVAILABLE');
    const r=await(o.fetchImpl??fetch)(new URL('/internal/analytics/'+path,url),{headers:{'X-Analytics-Internal-Token':o.internalSecret},signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!r.ok)throw new Error('CAPACITY_UNAVAILABLE');
    const body=await readBoundedJson(r,128*1024) as any;if(!body||body.ok!==true)throw new Error('CAPACITY_UNAVAILABLE');return body;
  }
  app.get('/',async c=>{
    const local=o.policy();
    const [live,capacity]=await Promise.all([internal('upload-status').catch(()=>null),internal('capacity').catch(()=>null)]);
    const state=live??{ok:true,revision:local?.revision??0,enabled:local?.enabled??false,subjects:local?.subjects??[],hour:local?.hour??23,effective_enabled:false,valid:false,emergency_gate:{enabled:false,valid:false},managed:!!local};
    const devices=o.devices().map(d=>({sn:d.sn,note:d.note,status:d.status,selected:state.subjects.includes(d.sn),upload_allowed:live===null?null:state.effective_enabled&&d.status==='active'&&state.subjects.includes(d.sn)&&!!state.device_config?.some((x:any)=>x.sn===d.sn&&x.active&&x.enabled)}));
    return c.json({ok:true,policy:state,runtime_available:live!==null,capacity,devices,batching:{max_events:200,max_body_bytes:2*1024*1024,writer_concurrency:1,retry_after_seconds:5,client_config_poll_minutes:30}});
  });
  app.put('/',async c=>{
    let p:ReturnType<typeof parseUploadChange>;
    try{p=parseUploadChange(await readBoundedJson(c.req.raw,64*1024));}catch{return c.json({ok:false,error:'INVALID_POLICY'},400);}
    const current=o.policy();
    if((current?.revision??0)!==p.expected_revision)return c.json({ok:false,error:'POLICY_CONFLICT'},409);
    const active=o.devices().filter(d=>d.status==='active').map(d=>d.sn);
    if(p.enabled&&p.subjects.some(s=>!active.includes(s)))return c.json({ok:false,error:'DEVICE_NOT_ACTIVE'},400);
    // Stale/deleted selections never prevent an emergency stop.
    if(!p.enabled)p.subjects=p.subjects.filter(s=>active.includes(s));
    const previous:Pick<Status,'enabled'|'subjects'>=current??(p.enabled?await internal('upload-status'):{enabled:false,subjects:[]});
    const increases=p.enabled&&(!current||!previous.enabled||p.subjects.some(s=>!previous.subjects.includes(s)));
    if(increases){
      let cap:any;try{cap=await internal('capacity');}catch{return c.json({ok:false,error:'CAPACITY_UNAVAILABLE'},503);}
      if(!Number.isSafeInteger(cap.max_enabled_devices)||cap.max_enabled_devices<0||!Number.isSafeInteger(cap.checked_at_ms)||cap.checked_at_ms<Date.now()-120_000||cap.checked_at_ms>Date.now()+5000)return c.json({ok:false,error:'CAPACITY_UNAVAILABLE'},503);
      if(p.subjects.length>cap.max_enabled_devices)return c.json({ok:false,error:'CAPACITY_LIMIT',max_enabled_devices:cap.max_enabled_devices},409);
    }
    try{const saved=o.save(p,active,'admin');return c.json({ok:true,policy:saved,client_applied:false});}
    catch(e){const code=(e as Error).message;return c.json({ok:false,error:code==='POLICY_CONFLICT'?code:'POLICY_SAVE_FAILED'},code==='POLICY_CONFLICT'?409:503);}
  });
  app.onError((_e,c)=>c.json({ok:false,error:'ANALYTICS_CONTROL_UNAVAILABLE'},503));
  return app;
}
