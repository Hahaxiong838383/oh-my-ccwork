// Production acceptance: login + GET only. Never unbind a real device or persist response bodies.
import {SignJWT} from 'jose';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const D=process.env.P003_MINIAPP_TASK_DIR||'/root/p003-history-identity-fix-20261117';
const base=process.env.P003_MINIAPP_PROBE_BASE||'https://kidshub-ai.hahaxiong.cc';
const sn='BJP00326081002000031';
const result={at_ms:Date.now(),pass:false,base,checks:{},requests:[],business_writes:0,real_unbind_performed:false};
let stage='start';
function check(v,name){stage=name;result.checks[name]=!!v;if(!v)throw new Error(name);}
function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
function withoutCursor(data){const {next_cursor,...other}=data;return {...other,has_next_cursor:!!next_cursor};}
async function request(path,token,body){
 stage=path;
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();result.requests.push({path,status:r.status,no_store:r.headers.get('cache-control')?.includes('no-store')??false});return {status:r.status,data,noStore:r.headers.get('cache-control')?.includes('no-store')??false};
}
try{
 const login=await request('/api/auth/login',null,{username:process.env.STUDIO_USER,password:process.env.STUDIO_PASS});
 check(login.status===200&&login.data.role==='admin'&&typeof login.data.token==='string','admin_login');
 const token=login.data.token;
 const devices=await request('/api/admin/devices',token);
 check(devices.status===200&&Array.isArray(devices.data.devices),'existing_devices_endpoint');
 const device=devices.data.devices.find(d=>d.sn===sn);check(device?.public_id&&device?.parent_account_id,'C_current_binding');
 result.binding_version=device.binding_version;
 const adminPath='/api/admin/devices/'+encodeURIComponent(sn)+'/miniapp';
 const parentPath='/v1/parent/devices/'+encodeURIComponent(device.public_id);
 const parentToken=await new SignJWT({accountId:device.parent_account_id,role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 let ad,pa;
 for(let attempt=0;attempt<3;attempt++){
  ad=await request(adminPath+'/dashboard',token);pa=await request(parentPath+'/dashboard',parentToken);
  if(ad.status===200&&pa.status===200&&canonical(ad.data.data)===canonical(pa.data.data))break;
 }
 check(ad.status===200&&pa.status===200,'admin_and_parent_dashboard_200');
 check(ad.noStore&&pa.noStore,'dashboard_no_store');
 check(ad.data.binding.public_id===device.public_id&&ad.data.binding.parent_account_id===device.parent_account_id&&ad.data.binding.binding_version===device.binding_version,'binding_matches_registry');
 check(canonical(ad.data.data)===canonical(pa.data.data),'dashboard_exact_same_source_data');
 result.observation={conversation_messages:ad.data.data.conversations.message_count??ad.data.data.conversations.total_messages??null,
  today_usage_available:ad.data.data.usage.today.available,today_focus_minutes:ad.data.data.usage.today.focus_minutes,
  reported_version:ad.data.integration.reported_version.version_name,upload_configured:ad.data.integration.upload_config.ark_records?.configured_enabled??null,
  upload_effective:ad.data.integration.upload_config.ark_records?.effective_enabled??null};
 for(const [label,a,p] of [['observations',adminPath+'/observations?limit=20',parentPath+'/observations?limit=20'],['records',adminPath+'/records?limit=20',parentPath+'/ark/records?limit=20'],['conversations',adminPath+'/conversations?limit=20',parentPath+'/conversations?limit=20']]){
  let x,y;
  for(let attempt=0;attempt<3;attempt++){x=await request(a,token);y=await request(p,parentToken);if(x.status===200&&y.status===200&&canonical(withoutCursor(x.data.data))===canonical(withoutCursor(y.data.data)))break;}
  check(x.status===200&&y.status===200,label+'_both_200');check(x.noStore&&y.noStore,label+'_no_store');
  check(canonical(withoutCursor(x.data.data))===canonical(withoutCursor(y.data.data)),label+'_same_ids_and_fields');
  result[label]={page_items:x.data.data.items.length,has_more:x.data.data.has_more,body_sha256:createHash('sha256').update(canonical(withoutCursor(x.data.data))).digest('hex')};
 }
 const history=ad.data.data.historical_usage,observations=ad.data.data.observations;
 check(history?.available===true&&history.total_seconds>0,'historical_usage_positive');
 check(history.daily.some(x=>x.date==='2026-11-06'&&x.total_seconds>=902),'historic_reward_seconds_included');
 check(ad.data.data.usage.today.available===true&&ad.data.data.usage.today.total_seconds>0,'current_C_usage_visible');
 check(observations?.available===true&&observations.counts.rewards>0&&observations.counts.inventory>0,'historical_rewards_inventory_visible');
 check(observations.origin_verified===false&&observations.coverage.complete===false,'partial_history_truthful');
 check(ad.data.data.ark.wallets.family_coin===null&&ad.data.data.ark.wallets.stardust===null,'missing_wallets_not_fabricated');
 result.history={counts:observations.counts,coverage:observations.coverage,total_seconds:history.total_seconds,observed_seconds:history.observed_seconds,estimated_seconds:history.estimated_seconds,days:history.daily.map(x=>({date:x.date,total_seconds:x.total_seconds,source:x.source})),method:history.method};
 const wc=await request('/api/auth/wechat/config');
 check(wc.status===200&&wc.noStore&&wc.data.app_id==='wx8b0ce82f18ab2f29','actual_wechat_app_id_configured');
 const wi=await request('/api/auth/wechat/identity',parentToken);
 check(wi.status===200&&wi.noStore,'parent_wechat_identity_read');
 check(canonical(wi.data.wechat_identity)===canonical(ad.data.wechat_identity),'admin_parent_identity_equal');
 result.wechat={configured:wc.data.configured,configuration_status:wc.data.configuration_status,state:wi.data.wechat_identity.state,openid_saved:!!wi.data.wechat_identity.openid,unionid_saved:!!wi.data.wechat_identity.unionid,real_wechat_authorization_performed:false};
 check((await request('/api/auth/wechat/identity')).status===401,'identity_auth_enforced');
 const denied=await request(adminPath+'/dashboard');check(denied.status===401&&denied.noStore,'unauthenticated_denied_no_store');
 const invalid=await request(adminPath+'/records?limit=0',token);check(invalid.status===400&&invalid.noStore,'invalid_query_400');
 const html=await fetch(base+'/admin/',{cache:'no-store',signal:AbortSignal.timeout(15000)});const bytes=Buffer.from(await html.arrayBuffer());
 const expected=JSON.parse(readFileSync(D+'/MANIFEST.json')).files.find(f=>f.target==='/opt/p003/web/dist/admin/index.html').after_sha256;
 result.admin_html_sha256=createHash('sha256').update(bytes).digest('hex');check(html.status===200&&result.admin_html_sha256===expected,'public_admin_exact_bytes');
 if(process.argv.includes('--browser-token'))writeFileSync(D+'/browser-auth.private',JSON.stringify({admin:token,public_id:device.public_id,sn}),{mode:0o600});
 result.pass=true;
}catch(e){result.failed_stage=stage;result.error_type=e.name;process.exitCode=1;}
writeFileSync(D+'/POST-RELEASE-PROBE.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:result.pass,checks:result.checks,failed_stage:result.failed_stage}));
