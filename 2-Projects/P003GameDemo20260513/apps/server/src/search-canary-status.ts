import {DeviceLocationStore} from './tools/device-location.js';
import {RoutingStore} from './tools/search-routing-store.js';
import {previewRouting} from './tools/search-routing-config.js';
import {createRoutingAdminRoute} from './routes/search-routing-admin.js';
// Admin-only observation. No search executor import, SSH or runtime activation.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {configStore} from './config-store.js';
import {deviceRegistryStore} from './device-registry-store.js';
import {otaStore} from './ota-store.js';
import {createCanaryAdminRoute,DEFAULT_CANARY_SN,summarizeCanary} from './routes/search-canary-admin.js';
const root=()=>process.env.SEARCH_CANARY_OBSERVER_ROOT||'/opt/p003/search-canary-20261021/brain';
const flag=(k:string)=>configStore.getFlag('p003.search.canary.'+k)?.value;
function array(s:string|undefined):string[]{try{const a=JSON.parse(s||'[]');return Array.isArray(a)&&a.every(x=>typeof x==='string')?a:[];}catch{return [];}}
async function json(path:string){try{const raw=await readFile(path,'utf8');return raw.length<=32768?JSON.parse(raw):null;}catch{return null;}}
async function status(){
  const now=Date.now(),selected=flag('selected_sn')||DEFAULT_CANARY_SN;
  const [lease,release,health]=await Promise.all([
    json(process.env.SEARCH_CANARY_HEALTH_FILE||root()+'/health.json'),json(root()+'/release-status.json'),
    fetch('http://127.0.0.1:3007/health',{signal:AbortSignal.timeout(1200),redirect:'error'}).then(r=>r.ok?r.json():null).catch(()=>null),
  ]);
  let settings:{allowlist:string[];enabled?:boolean;tools?:boolean}|null=null;
  try{const db=new DatabaseSync(root()+'/data/config.db',{readOnly:true});try{
    const get=(k:string)=>(db.prepare('SELECT value FROM runtime_flag WHERE key=?').get('p003.search.'+k) as {value:string}|undefined)?.value;
    settings={allowlist:array(get('allowlist')),enabled:get('enabled')==='1',tools:get('tools')==='1'};
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
    {title:'普通聊天对照改由其他设备提供',detail:'按持有人授权，目标设备直接体验搜索；其他设备对照单列，不能充当严格同机性能结论。',status:'待对照'},
    {title:'首句、插话与本地回复语需现场回归',detail:'候选关闭搜索时回归普通对话；随后P1验证补播、续讲、取消、改查和退出重连。',status:'待真机'},
    {title:'P2与全天稳定性未验收',detail:'本次仅授权名单内设备测试至明确截止；先验P1，P1通过后另行开放P2，不自动扩大设备范围。',status:'未验证'},
  ];
  if(!summary.health_ok)issues.unshift({title:'候选健康检查未通过',detail:'当前无法确认候选在线，请勿依据历史部署记录开窗。',status:'阻塞'});
  if(!summary.lease_ok)issues.unshift({title:'当前无可用派单租约',detail:'可能满载、心跳过期或未注册；不等同于设备离线。',status:'阻塞'});
  if(!summary.selected_prepared)issues.unshift({title:'所选设备尚未完成隔离准备',detail:'已保存待测选择，实际派单未改变；需为该设备准备独立数据与三侧一致名单。',status:'待准备'});
  return {observed_at_ms:now,selected_sn:selected,prepared_sn:summary.scope_ok?summary.configured_devices.join('、'):'待核对',devices,summary,
    release:release?{verified_at_ms:release.verified_at_ms,brain_commit:release.brain_commit,worker_commit:release.worker_commit,worker_sha256:release.worker_sha256,worker_tests:release.worker_tests}:null,
    operator_confirmation:confirmed?{sn:selected,version_code:confirmation.version_code,version_name:confirmation.version_name,at_ms:confirmation.at_ms}:null,
    issues,acceptance:'待真机验收',window_started_at_ms:Number(flag('started_at_ms'))||null,
    note:'保存待测设备不会开窗或修改实际派单。部署核验记录与本次实时健康检查分开显示。'};
}
export const canaryAdminRoute=createCanaryAdminRoute({read:status,eligible:sn=>{const d=deviceRegistryStore.get(sn);return d?.status==='active'&&Boolean(d.account_id);},isOpen:()=>flag('enabled')==='1',save:(sn,who)=>configStore.setFlag('p003.search.canary.selected_sn',sn,who,'后台待测设备选择；不激活派单')});

let routes:RoutingStore|null=null;
let locationStore:DeviceLocationStore|null=null;
canaryAdminRoute.route('/routing',createRoutingAdminRoute({store:()=>routes??=new RoutingStore(root()+'/data/search-routing.db'),scope:()=>array(flag('allowlist')).filter(sn=>{const d=deviceRegistryStore.get(sn);return d?.status==='active'&&Boolean(d.account_id);}),locations:()=>{locationStore??=new DeviceLocationStore(root()+'/data/device-location.db');return locationStore.summary(array(flag('allowlist')));},preview:(c,u)=>previewRouting(c,u,root()+'/bin/search-route-preview')}));
