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
  const issues=[
    {title:'当前设备版本与持有人参与待确认',detail:'云端自报版本带时间显示；请现场核对“关于”页和SN，不能用历史版本代替。',status:'待真机'},
    {title:'同机普通聊天基线尚待取证',detail:'先在现役链路完成30轮普通聊天，服务端负责日志和延迟统计。',status:'待真机'},
    {title:'首句、插话与本地回复语需现场回归',detail:'候选关闭搜索时回归普通对话；随后P1验证补播、续讲、取消、改查和退出重连。',status:'待真机'},
    {title:'P2和两小时长稳未验收',detail:'先验P1；P1通过后再受控开放工具调用与网页抓取，不自动扩设备或延长窗口。',status:'未验证'},
  ];
  if(!summary.health_ok)issues.unshift({title:'候选健康检查未通过',detail:'当前无法确认候选在线，请勿依据历史部署记录开窗。',status:'阻塞'});
  if(!summary.lease_ok)issues.unshift({title:'当前无可用派单租约',detail:'可能满载、心跳过期或未注册；不等同于设备离线。',status:'阻塞'});
  if(!summary.selected_prepared)issues.unshift({title:'所选设备尚未完成隔离准备',detail:'已保存待测选择，实际派单未改变；需为该设备准备独立数据与三侧一致名单。',status:'待准备'});
  return {observed_at_ms:now,selected_sn:selected,prepared_sn:DEFAULT_CANARY_SN,devices,summary,
    release:release?{verified_at_ms:release.verified_at_ms,brain_commit:release.brain_commit,worker_commit:release.worker_commit,worker_sha256:release.worker_sha256,worker_tests:release.worker_tests}:null,
    issues,acceptance:'待真机验收',window_started_at_ms:Number(flag('started_at_ms'))||null,
    note:'保存待测设备不会开窗或修改实际派单。部署核验记录与本次实时健康检查分开显示。'};
}
export const canaryAdminRoute=createCanaryAdminRoute({read:status,eligible:sn=>{const d=deviceRegistryStore.get(sn);return d?.status==='active'&&Boolean(d.account_id);},isOpen:()=>flag('enabled')==='1',save:(sn,who)=>configStore.setFlag('p003.search.canary.selected_sn',sn,who,'后台待测设备选择；不激活派单')});
