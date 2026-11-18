import {assertOrdinaryReply} from './ordinary-reply.mjs';
// Read-only boundary probes; never mint a real device identity or submit Ark data.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
const port=Number(process.env.PORT),secret=process.env.AUTH_JWT_SECRET,key=process.env.CUSTOM_LLM_API_KEY?.trim();
assert(secret&&[3001,3007,3008].includes(port));
const origin='http://127.0.0.1:'+port,rows=[];
async function check(path,status,headers={},body){
 const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body}:{}),signal:AbortSignal.timeout(5000)});
 const json=await r.json();rows.push({path,status:r.status,error:json.error??null});assert.equal(r.status,status);return json;
}
assert.equal((await check('/health',200)).status,'ok');
await check('/v1/internal/search-tasks/',401);
await check('/v1/internal/search-tasks/',port===3001?401:403,{'x-p003-worker-token':'invalid',...(key?{Authorization:'Bearer '+key}:{})});
if(port===3001){
 const r=await fetch(origin+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify({messages:[{role:'user',content:'一加一等于几'}]}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200);const wire=await r.text();assert(wire.includes('[DONE]'));
 const chunks=wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
 const ordinary={clock_response:chunks.some(x=>x.id?.startsWith('chatcmpl-clock-')),spoken:chunks.map(x=>x.choices?.[0]?.delta?.content||'').join('')};assertOrdinaryReply(ordinary);
 rows.push({path:'/v1/chat/completions',status:200,ordinary_content:true,auth_semantics:'optional API key; anonymous ordinary context',chars:ordinary.spoken.length});

 await check('/v1/device/ark/state',401,{},'{}');
 const now=Math.floor(Date.now()/1000),b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const u=b({alg:'HS256',typ:'JWT'})+'.'+b({kind:'p003-device',sub:'BJP00399123199999999',iat:now,exp:now+60});
 const signed=u+'.'+createHmac('sha256',secret).update(u).digest('base64url');
 await check('/v1/device/ark/state',403,{Authorization:'Bearer '+signed},'{}');
} else {
 for(const auth of [undefined,'wrong-key'])await check('/v1/chat/completions',401,auth?{Authorization:'Bearer '+auth}:{},JSON.stringify({messages:[{role:'user',content:'现在几点'}]}));
}
console.log(JSON.stringify({pass:true,at_ms:Date.now(),port,key_configured:Boolean(key),production_data_written:false,rows}));
