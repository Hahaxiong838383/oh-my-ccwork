// Run from the deployed server with its existing env. Never prints credentials or writes business data.
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sn='BJP00326081002000031';
const devices=new DatabaseSync('./data/devices.db',{readOnly:true});
const ark=new DatabaseSync('./data/ark.db',{readOnly:true});
const d=devices.prepare('SELECT public_id,parent_account_id FROM device_registry WHERE sn=?').get(sn);
if(!d?.parent_account_id)throw Error('target missing');
const secret=new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
const parent=await new SignJWT({accountId:d.parent_account_id,role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('2m').sign(secret);
const other=await new SignJWT({accountId:'records-summary-read-only-negative',role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('2m').sign(secret);
const result={at_ms:Date.now(),sn,identity:'server_signed_read_only_probe_not_mobile_login',record_count:ark.prepare('SELECT COUNT(*) n FROM ark_record WHERE sn=?').get(sn).n,results:[],real_device_e2e:false};
for(const base of ['http://127.0.0.1:3001','https://kidshub-ai.hahaxiong.cc']){
 const get=async(path,token=parent)=>{const r=await fetch(base+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});return {status:r.status,cache_control:r.headers.get('cache-control'),body:await r.json()};};
 const prefix=`/v1/parent/devices/${d.public_id}`;
 const dashboard=await get(prefix+'/dashboard?timezone=Asia/Shanghai');
 const page=await get(prefix+'/ark/records');
 const denied=await get(prefix+'/ark/records',other);
 const legacy=Object.fromEntries(['ark','usage','device','today','week'].map(k=>[k,createHash('sha256').update(JSON.stringify(dashboard.body.data?.[k]??null)).digest('hex')]));
 result.results.push({base,dashboard_status:dashboard.status,dashboard_cache:dashboard.cache_control,records:dashboard.body.data?.records,page_status:page.status,page_ids:page.body.data?.items?.map(x=>x.record_id),wrong_owner_status:denied.status,legacy_sha256:legacy});
}
const lkToken=await new SignJWT({video:{roomList:true}}).setProtectedHeader({alg:'HS256'}).setIssuer(process.env.LIVEKIT_API_KEY).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(process.env.LIVEKIT_API_SECRET));
const roomResponse=await fetch(process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:')+'/twirp/livekit.RoomService/ListRooms',{method:'POST',headers:{authorization:`Bearer ${lkToken}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(!roomResponse.ok)throw Error('room check unavailable');
const rooms=(await roomResponse.json()).rooms??[];
result.room_check={at_ms:Date.now(),rooms:rooms.length,participants:rooms.reduce((n,r)=>n+Number(r.numParticipants??r.num_participants??0),0),idle:rooms.length===0};
devices.close();ark.close();
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
