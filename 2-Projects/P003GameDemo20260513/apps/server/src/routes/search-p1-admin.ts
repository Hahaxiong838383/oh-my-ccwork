import {Hono}from'hono';import{z}from'zod';import{readFile}from'node:fs/promises';
import{isValidToken,isAdminRole,getTokenUser}from'./auth.js';
import{configStore}from'../config-store.js';import{deviceRegistryStore}from'../device-registry-store.js';import{otaStore}from'../ota-store.js';
import{searchSettings,searchDeviceAllowed,getSearchTasks,searchAudit,getSearchRoutingStore}from'../tools/search-runtime.js';
import{parseSearchDevices}from'../tools/search-enrollment.js';import{boundedSearchBody}from'./search-tasks.js';
import{createRoutingAdminRoute}from'./search-routing-admin.js';import{previewRouting}from'../tools/search-routing-config.js';
import{getDeviceLocationStore}from'../tools/device-location-runtime.js';

export const searchP1AdminRoute=new Hono();
searchP1AdminRoute.use('*',async(c,next)=>{
 c.header('Cache-Control','no-store');const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')??'')?.[1]??'';
 if(!isValidToken(token))return c.json({ok:false,error:'unauthorized'},401);
 if(!isAdminRole(token))return c.json({ok:false,error:'forbidden'},403);
 if(process.env.SEARCH_CANARY_ROOT)return c.json({ok:false,error:'p1_unavailable_on_candidate'},403);
 await next();
});
searchP1AdminRoute.onError((e,c)=>c.json({ok:false,error:e instanceof z.ZodError||e instanceof SyntaxError?'invalid_request':'p1_unavailable'},e instanceof z.ZodError||e instanceof SyntaxError?400:503));
const who=(c:any)=>getTokenUser((c.req.header('authorization')??'').replace(/^Bearer\s+/i,''))??'admin';
searchP1AdminRoute.get('/',async c=>{
 const settings=searchSettings(),versions=new Map(otaStore.listDeviceStatus().map(d=>[d.sn,d]));
 const devices=deviceRegistryStore.list().map(d=>{const v=versions.get(d.sn);return {sn:d.sn,eligible:d.status==='active'&&Boolean(d.account_id),excluded:settings.excluded.includes(d.sn),search_allowed:searchDeviceAllowed(d.sn),version_code:v?.version_code??null,version_name:v?.version_name??null,version_reported_at_ms:v?.last_check_at??null};});
 let release=null;
 try{const path=process.env.SEARCH_P1_RELEASE_FILE;if(path){const raw=await readFile(path,'utf8');if(raw.length<=8192){const r=JSON.parse(raw);release={verified_at_ms:r.verified_at_ms,brain_commit:r.brain_commit,worker_commit:r.worker_commit,worker_sha256:r.worker_sha256};}}}catch{}
 const audit=searchAudit();
 return c.json({ok:true,lane:settings.tools?'p2':'p1',observed_at_ms:Date.now(),settings,devices,release,
  tasks:{loaded:audit.loaded,recent:audit.tasks.map(({id,device_suffix,status,outcome,delivery,error,created_at,execution_ms})=>({id,device_suffix,status,outcome,delivery,error,created_at,execution_ms}))},
  issues:[...(!settings.configured?['服务端配置尚未就绪']:[]),...(!settings.scope_valid?['准入配置无效，已拒绝搜索']:[]),...(!release?['尚无本轮部署核验记录']:[]),'设备实听和持续体验以实际日志与反馈为准'],
  note:'全量内测保留设备原有身份、人格和记忆。新注册且启用服务的设备自动纳入；P2增加后台工具调用与受控网页读取。关闭P2退回P1，总闸关闭或单机排除不关闭普通聊天；独立候选配置另行显示。'});
});
searchP1AdminRoute.put('/tools',async c=>{
 const {enabled}=z.object({enabled:z.boolean()}).strict().parse(await boundedSearchBody(c));
 if(enabled&&!searchSettings().enabled)return c.json({ok:false,error:'search_unavailable'},409);
 configStore.setFlag('p003.search.main.tools',enabled?'1':'0',who(c));
 return c.json({ok:true,settings:searchSettings()});
});
searchP1AdminRoute.put('/enabled',async c=>{
 const {enabled}=z.object({enabled:z.boolean()}).strict().parse(await boundedSearchBody(c));
 const exclusions=parseSearchDevices(configStore.getFlag('p003.search.exclusions')?.value);
 if(enabled&&(!searchSettings().configured||exclusions===null))return c.json({ok:false,error:'unconfigured'},409);
 // A global P1 enrollment is not a wildcard for P2, and doesn't change candidate flags.
 if(enabled)configStore.setFlag('p003.search.scope','all_registered',who(c));
 configStore.setFlag('p003.search.enabled',enabled?'1':'0',who(c));getSearchTasks();
 return c.json({ok:true,settings:searchSettings()});
});
searchP1AdminRoute.put('/devices/:sn',async c=>{
 const {excluded}=z.object({excluded:z.boolean()}).strict().parse(await boundedSearchBody(c));const sn=c.req.param('sn');
 if(!/^BJP003\d{14}$/.test(sn)||!deviceRegistryStore.get(sn))return c.json({ok:false,error:'invalid_device'},400);
 const current=parseSearchDevices(configStore.getFlag('p003.search.exclusions')?.value);if(!current)return c.json({ok:false,error:'invalid_scope'},409);
 const next=excluded?[...new Set([...current,sn])]:current.filter(s=>s!==sn);
 configStore.setFlag('p003.search.exclusions',JSON.stringify(next),who(c));getSearchTasks()?.tick();
 return c.json({ok:true,sn,excluded});
});
searchP1AdminRoute.route('/routing',createRoutingAdminRoute({allowGlobal:true,
 store:()=>{const s=getSearchRoutingStore();if(!s)throw new Error('routing_unavailable');return s;},
 scope:()=>deviceRegistryStore.list().filter(d=>d.status==='active'&&d.account_id).map(d=>d.sn),
 locations:()=>getDeviceLocationStore()?.summary(deviceRegistryStore.list().filter(d=>d.status==='active'&&d.account_id).map(d=>d.sn))??[],
 preview:(c,u)=>previewRouting(c,u,process.env.SEARCH_ROUTE_PREVIEW_BIN??'/opt/p003/server/bin/search-route-preview'),
}));
