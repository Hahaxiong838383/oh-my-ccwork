import {validCanaryAllowlist} from '../search-canary-policy.js';
import {Hono} from 'hono';
import {isValidToken,isAdminRole,getTokenUser} from './auth.js';
export const DEFAULT_CANARY_SN='BJP00326070803800006';
type SnapshotInput={now:number;enabled:boolean;expires:number;allowlist:string[];selected:string;lease:any;health:any;settings:any};
export function summarizeCanary(i:SnapshotInput){
  const health_ok=i.health?.status==='ok';
  const lease_ok=i.lease?.agent==='p003-search-canary-20261021' && typeof i.lease?.generation==='string' && i.lease.generation.length>0 && Number.isFinite(i.lease.until_ms) && i.lease.until_ms>i.now && i.lease.until_ms-i.now<=15000;
  const scope_ok=validCanaryAllowlist(i.allowlist) && Array.isArray(i.settings?.allowlist) && validCanaryAllowlist(i.settings.allowlist) && i.settings.allowlist.length===i.allowlist.length && i.allowlist.every(sn=>i.settings.allowlist.includes(sn));
  const state=!i.enabled?'closed':i.expires<=i.now?'expired':!health_ok||!lease_ok||!scope_ok||i.expires-i.now>168*3600_000?'blocked':!i.health.search?'regression':i.health.tools?'p2':'p1';
  return {state,health_ok,lease_ok,scope_ok,dispatch_requested:i.enabled,expires_at_ms:i.expires||null,configured_devices:i.allowlist,selected_prepared:scope_ok && i.allowlist.includes(i.selected)};
}
type Deps={read:()=>Promise<unknown>;eligible:(sn:string)=>boolean;isOpen:()=>boolean;save:(sn:string,who:string)=>void};
export function createCanaryAdminRoute(deps:Deps){
  const app=new Hono();
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')||'')?.[1]||'';
    if(!isValidToken(token))return c.json({ok:false,error:'unauthorized'},401);
    if(!isAdminRole(token))return c.json({ok:false,error:'forbidden'},403);
    await next();
  });
  app.get('/',async c=>{try{return c.json({ok:true,...await deps.read() as object});}catch{return c.json({ok:false,error:'灰度状态暂不可用，请刷新；未改变任何开关'},503);}});
  app.put('/device',async c=>{
    const raw=await c.req.text();if(raw.length>1024)return c.json({ok:false,error:'请求过大'},413);
    let v;try{v=JSON.parse(raw);}catch{return c.json({ok:false,error:'无效请求'},400);}
    if(!v||Object.keys(v).length!==1||typeof v.sn!=='string'||!/^BJP003\d{14}$/.test(v.sn)||!deps.eligible(v.sn))return c.json({ok:false,error:'请选择已启用且开通服务的完整设备SN'},400);
    if(deps.isOpen())return c.json({ok:false,error:'窗口开启期间不能换设备，请先关闭窗口'},409);
    const token=c.req.header('authorization')!.replace(/^Bearer\s+/i,'');
    deps.save(v.sn,getTokenUser(token)||'admin');
    return c.json({ok:true,selected_sn:v.sn,activated:false});
  });
  return app;
}
