import assert from 'node:assert/strict';import {test} from 'node:test';
const m:any=await import('../src/tools/search-simple-fallback.js').catch(()=>({}));
const result={text:'查到的简单信息。',sources:[{title:'官方资料',url:'https://www.weather.com.cn/',date:'2026-10-28'}]};
test('R23 one bounded general lookup replaces failed or empty primary, without another foreground dependency',async()=>{
 assert.equal(typeof m.runSearchFallback,'function');
 for(const primary of [async()=>{throw Error('weather_http_429');},async()=>({text:'没有证据',sources:[]})]){
  let calls=0;const r=await m.runSearchFallback({signal:new AbortController().signal,primary,fallback:async()=>{calls++;return result;}});assert.equal(r.text,result.text);assert.equal(calls,1);
 }
 let calls=0;assert.equal((await m.runSearchFallback({signal:new AbortController().signal,primary:async()=>result,fallback:async()=>{calls++;return result;}})).text,result.text);assert.equal(calls,0);
});
test('R23 double failure gives a clear short receipt, no fabricated data; cancellation does not trigger fallback',async()=>{
 assert.equal(typeof m.runSearchFallback,'function');let calls=0;
 const r=await m.runSearchFallback({signal:new AbortController().signal,primary:async()=>{throw Error('private upstream');},fallback:async()=>{calls++;throw Error('private upstream');}});assert.equal(calls,1);assert.equal(r.sources.length,0);assert.match(r.text,/暂时|没能/);assert(!r.text.includes('private'));
 const c=new AbortController();await assert.rejects(m.runSearchFallback({signal:c.signal,primary:async()=>{c.abort();throw c.signal.reason;},fallback:async()=>{calls++;return result;}}));assert.equal(calls,1);
});
test('R23 slow primary leaves fallback time; a slow fallback still terminates',async()=>{
 assert.equal(typeof m.runSearchFallback,'function');
 const slow=(s:AbortSignal)=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));
 const before=performance.now();const r=await m.runSearchFallback({signal:new AbortController().signal,primaryMs:15,fallbackMs:20,primary:slow,fallback:slow});assert.equal(r.sources.length,0);assert(performance.now()-before<400);
});
