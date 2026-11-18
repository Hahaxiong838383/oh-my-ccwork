import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
const key=process.env.LIVEKIT_API_KEY,secret=process.env.LIVEKIT_API_SECRET;assert(key&&secret,'room authority env missing');
const now=Math.floor(Date.now()/1000),b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),unsigned=b({alg:'HS256',typ:'JWT'})+'.'+b({iss:key,nbf:now-10,exp:now+60,video:{roomList:true}});const jwt=unsigned+'.'+createHmac('sha256',secret).update(unsigned).digest('base64url');
const url=(process.env.LIVEKIT_URL||'wss://voice-hk.hahaxiong.cc').replace(/^wss:/,'https:').replace(/^ws:/,'http:').replace(/\/$/,'')+'/twirp/livekit.RoomService/ListRooms';
const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(12000)});assert.equal(res.status,200,'room list unavailable');const data=await res.json();assert(Array.isArray(data.rooms)||Object.keys(data).length===0);const rooms=data.rooms||[];console.log(JSON.stringify({at_ms:Date.now(),verified:true,total_rooms:rooms.length,active_rooms:rooms.filter(r=>Number(r.numParticipants||0)>0).length,idle:rooms.length===0}));
