// Read-only health and LiveKit room-list check; keys stay inside this process.
import {SignJWT} from 'jose';
import {writeFileSync} from 'node:fs';
const D=process.env.P003_MINIAPP_TASK_DIR||'/root/p003-history-identity-fix-20261117';
const result={at_ms:Date.now(),production_mutations:false,health:[],room_check:null};
for(const base of ['http://127.0.0.1:3001']){
 try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(10000)});const b=await r.json();result.health.push({base,http_status:r.status,status:b.status??null});}
 catch(e){result.health.push({base,http_status:null,error_type:e.name});}
}
try{
 const token=await new SignJWT({video:{roomList:true}}).setProtectedHeader({alg:'HS256'}).setIssuer(process.env.LIVEKIT_API_KEY).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(process.env.LIVEKIT_API_SECRET));
 const r=await fetch(process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:')+'/twirp/livekit.RoomService/ListRooms',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error('room_list_failed');
 const rooms=(await r.json()).rooms??[];result.room_check={at_ms:Date.now(),http_status:r.status,rooms:rooms.length,idle:rooms.length===0,verified:true};
}catch(e){result.room_check={at_ms:Date.now(),idle:false,verified:false,error_type:e.name};}
writeFileSync(D+'/PRE-RELEASE-READONLY.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
