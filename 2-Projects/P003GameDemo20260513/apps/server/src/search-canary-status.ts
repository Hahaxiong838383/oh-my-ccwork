import {DeviceLocationStore} from './tools/device-location.js';
import {RoutingStore} from './tools/search-routing-store.js';
import {previewRouting} from './tools/search-routing-config.js';
import {createRoutingAdminRoute} from './routes/search-routing-admin.js';
import {searchP1AdminRoute} from './routes/search-p1-admin.js';
import {AmapUsageStore} from './tools/amap-usage.js';
import {createAmapUsageAdminRoute} from './routes/amap-usage-admin.js';
// Admin-only observation. No search executor import, SSH or runtime activation.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {configStore} from './config-store.js';
import {deviceRegistryStore} from './device-registry-store.js';
import {otaStore} from './ota-store.js';
import {createCanaryAdminRoute,DEFAULT_CANARY_SN,summarizeCanary} from './routes/search-canary-admin.js';
const root=()=>process.env.SEARCH_CANARY_OBSERVER_ROOT||'/opt/p003/search-canary-20261021/brain';
const healthUrl=()=>{const u=new URL(process.env.SEARCH_CANARY_OBSERVER_BASE_URL||'http://127.0.0.1:3007');if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('invalid observer loopback URL');return new URL('/health',u);};
const flag=(k:string)=>configStore.getFlag('p003.search.canary.'+k)?.value;
function array(s:string|undefined):string[]{try{const a=JSON.parse(s||'[]');return Array.isArray(a)&&a.every(x=>typeof x==='string')?a:[];}catch{return [];}}
async function json(path:string){try{const raw=await readFile(path,'utf8');return raw.length<=32768?JSON.parse(raw):null;}catch{return null;}}
async function status(){
  const now=Date.now(),selected=flag('selected_sn')||DEFAULT_CANARY_SN;
  const [lease,release,health]=await Promise.all([
    json(process.env.SEARCH_CANARY_OBSERVER_HEALTH_FILE||process.env.SEARCH_CANARY_HEALTH_FILE||root()+'/health.json'),json(root()+'/release-status.json'),
    fetch(healthUrl(),{signal:AbortSignal.timeout(1200),redirect:'error'}).then(r=>r.ok?r.json():null).catch(()=>null),
  ]);
  let settings:{allowlist:string[];enabled?:boolean;tools?:boolean}|null=null;
  try{const db=new DatabaseSync(root()+'/data/config.db',{readOnly:true});try{
    const get=(k:string)=>(db.prepare('SELECT value FROM runtime_flag WHERE key=?').get('p003.search.'+k) as {value:string}|undefined)?.value;
    settings={allowlist:array(get('allowlist')),enabled:get('enabled')==='1',tools:get('tools')==='1'};
  }finally{db.close();}}catch{}
  let recent_tasks:unknown[]|null=null;
  try{const db=new DatabaseSync(root()+'/data/search.db',{readOnly:true});try{
    recent_tasks=db.prepare("SELECT json_extract(body,'$.id') id,substr(subject,-8) device_suffix,json_extract(body,'$.status') status,json_extract(body,'$.outcome') outcome,json_extract(body,'$.delivery') delivery,json_extract(body,'$.createdAt') created_at,json_extract(body,'$.failure') failure,json_extract(body,'$.diagnostics') diagnostics FROM tasks ORDER BY json_extract(body,'$.createdAt') DESC LIMIT 20").all().map((r:any)=>{let d,f;try{d=JSON.parse(r.diagnostics??'null');f=JSON.parse(r.failure??'null');}catch{}return {id:r.id,device_suffix:r.device_suffix,status:r.status,outcome:r.outcome,delivery:r.delivery,created_at:r.created_at,failure:f&&['search','answer','tools','fetch','weather','task'].includes(f.stage)&&['transport','timeout','aborted','http','invalid_json','invalid_response','invalid_stream','invalid_answer','invalid_result','unasked_quantity','configuration','unknown'].includes(f.reason)?{stage:f.stage,reason:f.reason}:null,mode:d?.mode??'unknown',tools:Array.isArray(d?.tool_calls)?d.tool_calls.filter((t:any)=>['search_web','fetch_page','unknown'].includes(t?.name)&&['succeeded','rejected','failed'].includes(t?.outcome)).slice(0,8).map((t:any)=>({name:t.name,outcome:t.outcome})):[]};});
  }finally{db.close();}}catch{}
  const versions=new Map(otaStore.listDeviceStatus().map(d=>[d.sn,d]));
  const devices=deviceRegistryStore.list().map(d=>{const v=versions.get(d.sn);return {sn:d.sn,eligible:d.status==='active'&&Boolean(d.account_id),status:d.status,version_code:v?.version_code??null,version_name:v?.version_name??null,version_reported_at_ms:v?.last_check_at??null};});
  const summary=summarizeCanary({now,selected,enabled:flag('enabled')==='1',expires:Number(flag('expires_at_ms')||0),allowlist:array(flag('allowlist')),lease,health,settings});
  const confirmation=(Array.isArray(release?.operator_confirmations)?release.operator_confirmations:[release?.operator_confirmation]).find((v:any)=>v?.sn===selected);
  const confirmed=confirmation && Number.isInteger(confirmation.version_code) && confirmation.version_code>0
    && typeof confirmation.version_name==='string' && confirmation.version_name.length<=100
    && Number.isFinite(confirmation.at_ms);
  const issues=[
    ...(confirmed ? [{title:'设备身份与版本已由持有人确认',detail:`完整SN及v${confirmation.version_code}（${confirmation.version_name}）已在记录时间确认；云端后续上报另显示时间。`,status:'已确认'}] : [{title:'所选设备现场身份与版本待确认',detail:'云端自报版本带时间显示；需核对现场SN与安装版本。',status:'待确认'}]),
    {title:'P1与P2分开发布',detail:'P1是否开启及全量范围请看P1页；本页仅观察独立P2候选。P2未开启时，状态会明确显示仅P1。',status:'范围说明'},
    {title:'首句、插话与本地回复语需现场回归',detail:'候选关闭搜索时回归普通对话；随后P1验证补播、续讲、取消、改查和退出重连。',status:'待真机'},
    {title:'P2真人体验待验收',detail:'仅当前名单内的灰度设备测试Tool Calls与受控网页抓取，截止时间不因P1全量而延长；到期退出重进回P1。',status:'待真机'},
  ];
  if(flag('agent')==='p003-search-listening-20261030'){issues.splice(1,3,{title:'倾听与方舟单机联调',detail:'本页观察当前倾听候选；范围、到期时间以实时配置为准。语音进入、安静倾听、反馈后恢复仍需设备实测。',status:'待真机'});}
  if(lease?.cleanup?.healthy===false)issues.unshift({title:'候选关房补偿未就绪',detail:'关房控制请求待补偿，或补偿心跳缺失/过期；已停止新增灰度派单。',status:'阻塞'});
  if(!summary.health_ok)issues.unshift({title:'候选健康检查未通过',detail:'当前无法确认候选在线，请勿依据历史部署记录开窗。',status:'阻塞'});
  if(!summary.lease_ok)issues.unshift({title:'当前无可用派单租约',detail:'可能满载、心跳过期或未注册；不等同于设备离线。',status:'阻塞'});
  if(!summary.selected_prepared)issues.unshift({title:'所选设备尚未完成隔离准备',detail:'已保存待测选择，实际派单未改变；需为该设备准备独立数据与三侧一致名单。',status:'待准备'});
  return {observed_at_ms:now,selected_sn:selected,prepared_sn:summary.scope_ok?summary.configured_devices.join('、'):'待核对',devices,summary,
    release:release?{verified_at_ms:release.verified_at_ms,brain_commit:release.brain_commit,worker_commit:release.worker_commit,worker_sha256:release.worker_sha256,worker_tests:release.worker_tests}:null,
    operator_confirmation:confirmed?{sn:selected,version_code:confirmation.version_code,version_name:confirmation.version_name,at_ms:confirmation.at_ms}:null,
    recent_tasks,issues,acceptance:'待真机验收',window_started_at_ms:Number(flag('started_at_ms'))||null,
    note:'保存待测设备不会开窗或修改实际派单。部署核验记录与本次实时健康检查分开显示。'};
}
export const canaryAdminRoute=createCanaryAdminRoute({read:status,eligible:sn=>{const d=deviceRegistryStore.get(sn);return d?.status==='active'&&Boolean(d.account_id);},isOpen:()=>flag('enabled')==='1',save:(sn,who)=>configStore.setFlag('p003.search.canary.selected_sn',sn,who,'后台待测设备选择；不激活派单')});
canaryAdminRoute.route('/p1',searchP1AdminRoute);
let amapUsage:AmapUsageStore|null=null;
canaryAdminRoute.route('/amap-usage',createAmapUsageAdminRoute({
 store:()=>amapUsage??=new AmapUsageStore(root()+'/data/amap-usage.db'),
 runtime:async()=>{try{const r=await fetch(healthUrl(),{signal:AbortSignal.timeout(1200),redirect:'error'});if(!r.ok)return null;const h=await r.json() as any;return typeof h.amap?.enabled==='boolean'&&typeof h.amap?.key_configured==='boolean'?{enabled:h.amap.enabled,key_configured:h.amap.key_configured}:null;}catch{return null;}},
}));

let routes:RoutingStore|null=null;
let locationStore:DeviceLocationStore|null=null;
canaryAdminRoute.route('/routing',createRoutingAdminRoute({store:()=>routes??=new RoutingStore(root()+'/data/search-routing.db'),scope:()=>array(flag('allowlist')).filter(sn=>{const d=deviceRegistryStore.get(sn);return d?.status==='active'&&Boolean(d.account_id);}),locations:()=>{locationStore??=new DeviceLocationStore(root()+'/data/device-location.db');return locationStore.summary(array(flag('allowlist')));},preview:(c,u)=>previewRouting(c,u,root()+'/bin/search-route-preview')}));
