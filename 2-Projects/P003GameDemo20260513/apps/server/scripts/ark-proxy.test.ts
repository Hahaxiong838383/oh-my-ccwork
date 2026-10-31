import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arkFactsRoute,ArkFactsProxy} from '../src/ark/proxy.js';
const sn='BJP00399999999999901',secret='a'.repeat(40);
test('proxy requires dedicated token and exact scope; returns bounded trusted facts',async()=>{
 let reads=0;const app=arkFactsRoute({secret:()=>secret,allowed:()=>[sn],facts:async s=>{reads++;assert.equal(s,sn);return {prompt:'家族币余额：0'};}});
 const req=(body:any,token=secret)=>app.request('http://localhost/',{method:'POST',headers:{'X-Ark-Internal-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await req({subject:sn},'bad')).status,401);assert.equal((await req({subject:sn,account_id:'spoof'})).status,403);assert.equal((await req({subject:sn.slice(0,-1)+'2'})).status,403);assert.equal(reads,0);
 assert.equal((await(await req({subject:sn})).json()).prompt,'家族币余额：0');
 const p=new ArkFactsProxy({url:'http://127.0.0.1:8787',secret,allowed:()=>[sn],fetchImpl:async(_url,init)=>req(JSON.parse(init!.body as string),new Headers(init?.headers).get('X-Ark-Internal-Token')!)});
 assert.equal((await p.context(sn)).prompt,'家族币余额：0');assert.equal(reads,2);
});
test('proxy cannot use remote URLs, unknown subjects, redirects, malformed or oversized responses',async()=>{
 let reads=0;const fetchImpl=async()=>{reads++;return Response.json({ok:true,prompt:'bad'});};
 for(const url of ['https://127.0.0.1','http://example.org','http://user@127.0.0.1'])assert.equal((await new ArkFactsProxy({url,secret,allowed:()=>[sn],fetchImpl}).context(sn)).prompt,'');
 assert.equal((await new ArkFactsProxy({url:'http://127.0.0.1',secret,allowed:()=>[],fetchImpl}).context(sn)).prompt,'');assert.equal(reads,0);
 for(const response of [Response.json({ok:true,prompt:77}),new Response('x'.repeat(9000)),new Response('',{status:302})])assert.equal((await new ArkFactsProxy({url:'http://127.0.0.1',secret,allowed:()=>[sn],fetchImpl:async()=>response}).context(sn)).prompt,'');
});
test('proxy total deadline covers slow fetch/body and revocation suppresses in-flight facts',async()=>{
 for(const fetchImpl of [async()=>new Promise<Response>(()=>{}),async()=>new Response(new ReadableStream({start(){}}))]){
  const p=new ArkFactsProxy({url:'http://127.0.0.1',secret,allowed:()=>[sn],fetchImpl});const at=performance.now();assert.equal((await p.context(sn)).prompt,'');assert.ok(performance.now()-at<300);
 }
 let allowed=[sn];const p=new ArkFactsProxy({url:'http://127.0.0.1',secret,allowed:()=>allowed,fetchImpl:async()=>{allowed=[];return Response.json({ok:true,prompt:'secret'});}});assert.equal((await p.context(sn)).prompt,'');
});
test('authority deadline includes facts and client rejects elapsed time even before timers run',async()=>{
 const app=arkFactsRoute({secret:()=>secret,allowed:()=>[sn],facts:async()=>{await new Promise(r=>setTimeout(r,220));return {prompt:'late'};}});
 const at=performance.now();const r=await app.request('http://localhost/',{method:'POST',headers:{'X-Ark-Internal-Token':secret},body:JSON.stringify({subject:sn})});assert.equal(r.status,503);assert.ok(performance.now()-at<210);
 const p=new ArkFactsProxy({url:'http://127.0.0.1',secret,allowed:()=>[sn],fetchImpl:async()=>{const start=performance.now();while(performance.now()-start<175){}return Response.json({ok:true,prompt:'late'});}});assert.equal((await p.context(sn)).prompt,'');
 const blocked=arkFactsRoute({secret:()=>secret,allowed:()=>[sn],facts:async()=>{const start=performance.now();while(performance.now()-start<175){}return {prompt:'late'};}});assert.equal((await blocked.request('http://localhost/',{method:'POST',headers:{'X-Ark-Internal-Token':secret},body:JSON.stringify({subject:sn})})).status,503);
});
