// Production GET-only verification. Conversation text and tokens never leave this process/output.
import {DatabaseSync} from 'node:sqlite';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const sn='BJP00326081002000031',d=new DatabaseSync('./data/devices.db',{readOnly:true});
const identity=d.prepare('SELECT public_id,parent_account_id,account_id FROM device_registry WHERE sn=?').get(sn);
const a=new DatabaseSync('./data/accounts.db',{readOnly:true});
const other=a.prepare("SELECT id FROM account WHERE role='parent' AND id<>? LIMIT 1").get(identity.parent_account_id);
const secret=new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
const token=async(id,role='parent')=>new SignJWT({accountId:id,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('10m').sign(secret);
const parent=await token(identity.parent_account_id),wrong=other?await token(other.id):null;
const result={at_ms:Date.now(),identity:'server_signed_read_only_probe_not_mobile_login',sn,results:[],real_phone_verified:false};
const canonical=rows=>JSON.stringify(rows.map(x=>({id:x.id,role:x.role,text:x.text,ts:x.ts})));
const sha=s=>createHash('sha256').update(s).digest('hex');
const db=new DatabaseSync('./data/conversation.db',{readOnly:true});
const stored=db.prepare('SELECT id,role,text,ts FROM conversation WHERE account_id=? ORDER BY ts DESC,id DESC').all(identity.account_id);
for(const base of ['http://127.0.0.1:3001','https://kidshub-ai.hahaxiong.cc']){
 const get=async(path,bearer=parent)=>{const r=await fetch(base+path,{headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(15000)});let body={};try{body=await r.json();}catch{}return {status:r.status,cache:r.headers.get('cache-control'),body};};
 const path=`/v1/parent/devices/${identity.public_id}`;
 const dashboard=await get(path+'/dashboard');
 const first=await get(path+'/conversations?limit=20');let page=first,all=[],pages=0;
 while(page.status===200){all.push(...page.body.data.items);pages++;if(!page.body.data.has_more)break;if(pages>=100)throw Error('page limit exceeded');page=await get(path+'/conversations?limit=20&cursor='+encodeURIComponent(page.body.data.next_cursor));}
 const denied=wrong?await get(path+'/conversations',wrong):null;
 const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 const filtered=await get(path+'/conversations?limit=50&from_day='+today+'&to_day='+today);
 result.results.push({base,dashboard_status:dashboard.status,summary:dashboard.body.data?.conversations,
  history_status:first.status,cache:first.cache,pages,message_count:all.length,unique_ids:new Set(all.map(x=>x.id)).size,
  metadata:first.body.data?{message_count:first.body.data.message_count,user_message_count:first.body.data.user_message_count,assistant_message_count:first.body.data.assistant_message_count,first_message_at_ms:first.body.data.first_message_at_ms,last_message_at_ms:first.body.data.last_message_at_ms,history_complete:first.body.data.history_complete}:null,
  exact_db_match:first.status===200&&canonical(stored)===canonical(all),content_sha256:sha(canonical(all)),wrong_owner_status:denied?.status??null,
  today_filter_status:filtered.status,today_message_count:filtered.body.data?.message_count??null,
  legacy_sha256:Object.fromEntries(['ark','records','usage','device','today','week'].map(k=>[k,sha(JSON.stringify(dashboard.body.data?.[k]??null))]))});
}
const roomToken=await new SignJWT({video:{roomList:true}}).setProtectedHeader({alg:'HS256'}).setIssuer(process.env.LIVEKIT_API_KEY).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(process.env.LIVEKIT_API_SECRET));
const rr=await fetch(process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:')+'/twirp/livekit.RoomService/ListRooms',{method:'POST',headers:{authorization:`Bearer ${roomToken}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(!rr.ok)throw Error('room check unavailable');const rooms=(await rr.json()).rooms??[];
result.room_check={at_ms:Date.now(),rooms:rooms.length,idle:rooms.length===0};
d.close();a.close();db.close();
if(process.argv.includes('--browser-token'))writeFileSync('/root/p003-parent-history-20261116/browser-token.private',parent,{mode:0o600});
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
