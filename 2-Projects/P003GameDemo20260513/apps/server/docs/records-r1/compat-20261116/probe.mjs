// Production verification: GETs and intentionally empty/invalid POSTs only.
// No synthetic business records. Tokens/parent IDs/child text never leave this process.
import {DatabaseSync} from 'node:sqlite';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
const D='/root/p003-records-compat-20261116';
const scope=JSON.parse(readFileSync(D+'/scope-private.json','utf8'));
const db=new DatabaseSync('./data/devices.db',{readOnly:true});
const current=db.prepare('SELECT d.sn,d.public_id,d.account_id,d.parent_account_id,d.binding_version,e.epoch FROM device_registry d JOIN ark_device_epoch e ON e.sn=d.sn WHERE d.sn=? AND d.status=?').get(scope.sn,'active');
if(!current||Object.entries(current).some(([k,v])=>scope[k]!==v))throw Error('scope drift');
const accounts=new DatabaseSync('./data/accounts.db',{readOnly:true}),ark=new DatabaseSync('./data/ark.db',{readOnly:true});
const other=accounts.prepare("SELECT id FROM account WHERE role='parent' AND id<>? LIMIT 1").get(scope.parent_account_id);
const secret=new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
const sign=async(payload,parent=false)=>{
 let j=new SignJWT(payload).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('5m');
 if(parent)j=j.setIssuer('p003').setAudience('kidshub');return j.sign(secret);
};
const device=await sign({kind:'p003-device',sub:scope.sn,binding_version:scope.binding_version});
const parent=await sign({accountId:scope.parent_account_id,role:'parent'},true);
const wrong=other?await sign({accountId:other.id,role:'parent'},true):null;
const stale=await sign({kind:'p003-device',sub:scope.sn,binding_version:scope.binding_version+1});
const result={at_ms:Date.now(),sn:scope.sn,probe:'server_signed_not_device_or_phone',synthetic_business_writes:0,real_device_upload_verified:false,real_phone_verified:false,results:[]};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
for(const base of ['http://127.0.0.1:3001','https://kidshub-ai.hahaxiong.cc']){
 const req=async(path,bearer=parent,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});let value={};try{value=await r.json();}catch{}return {status:r.status,cache:r.headers.get('cache-control'),body:value};};
 const path='/v1/parent/devices/'+scope.public_id;
 const config=await req('/v1/device/config',device),dashboard=await req(path+'/dashboard'),page=await req(path+'/ark/records?limit=20');
 const history=await req(path+'/conversations?limit=20');
 const invalid={schema_version:1,contract_id:'p003-ark-records-r1',batch_id:'empty-validation-no-business',save_id:'no-business',coverage_from_ms:0,dropped_records:0,records:[]};
 const empty=await req('/v1/device/ark/records:batch',device,invalid),denied=await req('/v1/device/ark/records:batch',stale,invalid);
 const wrongOwner=wrong?await req(path+'/ark/records',wrong):null;
 const row={base,config_status:config.status,revision:config.body.revision,ark_records:config.body.ark_records,
  dashboard_status:dashboard.status,page_status:page.status,cache:page.cache,page_count:page.body.data?.items?.length??null,
  records_summary:dashboard.body.data?.records,history_status:history.status,history_message_count:history.body.data?.message_count??null,
  usage:dashboard.body.data?.usage,empty_post_status:empty.status,empty_post_error:empty.body.error,stale_credential_status:denied.status,wrong_parent_status:wrongOwner?.status??null,
  original_domains_sha256:Object.fromEntries(['device','ark','usage','today','week','conversations'].map(k=>[k,hash(dashboard.body.data?.[k]??null)]))};
 result.results.push(row);
 if(config.status!==200||config.body.ark_records?.enabled!==true||config.body.ark_records?.contract_id!=='p003-ark-records-r1'||dashboard.status!==200||page.status!==200||page.cache!=='no-store'||history.status!==200||empty.status!==400||denied.status!==401||(wrong&&wrongOwner.status!==404))throw Error('production compatibility verification failed');
}
result.record_counts={v1:Number(ark.prepare('SELECT COUNT(*) n FROM ark_record WHERE sn=?').get(scope.sn).n),legacy:Number(ark.prepare('SELECT COUNT(*) n FROM ark_record_legacy WHERE sn=?').get(scope.sn).n)};
result.pass=true;db.close();accounts.close();ark.close();
writeFileSync(D+'/POST-RELEASE-PROBE.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
