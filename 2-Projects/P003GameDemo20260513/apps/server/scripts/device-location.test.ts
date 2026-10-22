import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const m:any=await import('../src/tools/device-location.js').catch(()=>({}));
assert.equal(typeof m.trustedDeviceIp,'function','automatic weather must use the authenticated device ingress, not Worker egress');
const sample='58.30.0.0',sn='BJP00326060100100004',room='sn-'+sn+'-1';
assert.equal(m.trustedDeviceIp('127.0.0.1','kidshub-ai.hahaxiong.cc',sample),sample);
assert.equal(m.trustedDeviceIp('::ffff:127.0.0.1','kidshub-ai.hahaxiong.cc',sample),sample);
for(const args of [['8.8.8.8','kidshub-ai.hahaxiong.cc',sample],['127.0.0.1','other.example',sample],['127.0.0.1','kidshub-ai.hahaxiong.cc',sample+', 8.8.8.8']])assert.equal(m.trustedDeviceIp(...args),null);
for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','100.64.0.1','169.254.1.2','192.0.2.3','198.18.0.1','224.1.1.1','::1','fc00::1','fe80::1','2001:db8::1','::ffff:8.8.8.8','garbage'])assert.equal(m.publicIp(ip),null,ip);
assert.equal(m.publicIp('240E:001F:0001::1'),'240e:1f:1::1');
const payload=(ip=sample)=>({ret:200,data:{ip,country:'中国',country_code:'cn',prov:'北京',city:'北京'}});
let calls=0,now=10000;
const provider=new m.Ip9Location({now:()=>now,fetch:async(url:string,options:any)=>{calls++;assert.equal(new URL(url).searchParams.get('ip'),sample);assert.equal(options.redirect,'error');return new Response(JSON.stringify(payload()));}});
const [a,b]=await Promise.all([provider.lookup(sample),provider.lookup(sample)]);assert.equal(a.city,'北京市');assert.deepEqual(a,b);assert.equal(calls,1);
await provider.lookup(sample);assert.equal(calls,1);now+=6*3600000+1;await provider.lookup(sample);assert.equal(calls,2);
for(const bad of [{...payload(),ret:500},{ret:200,data:{...payload().data,ip:'8.8.8.8'}},{ret:200,data:{...payload().data,prov:'上海'}},{ret:200,data:{...payload().data,country_code:'us'}},{ret:200,data:{...payload().data,city:''}}]) {
 const p=new m.Ip9Location({fetch:async()=>new Response(JSON.stringify(bad))});await assert.rejects(p.lookup(sample));
}
let failCalls=0;const failed=new m.Ip9Location({fetch:async()=>{failCalls++;return new Response('',{status:429});}});await assert.rejects(failed.lookup(sample));await assert.rejects(failed.lookup(sample));assert.equal(failCalls,1);
await assert.rejects(new m.Ip9Location({fetch:async()=>new Response('x'.repeat(16385))}).lookup(sample),/body_limit/);
const timeout=new m.Ip9Location({timeoutMs:20,fetch:async(_u:any,o:any)=>new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('test_timeout_failed')),500);o.signal.addEventListener('abort',()=>{clearTimeout(t);reject(o.signal.reason);},{once:true});})});await assert.rejects(timeout.lookup(sample),/timeout|aborted/i);
const dir=mkdtempSync(join(tmpdir(),'p003-location-'));let time=10000;
const store=new m.DeviceLocationStore(join(dir,'location.db'),()=>time);
try {
 const first=store.begin(sn,room,20000);assert.equal(store.get(sn,room).state,'pending');
 assert.equal(store.get('BJP00326070803800006',room).state,'unknown');
 assert.equal(store.get(sn,room+'2').state,'unknown');
 const second=store.begin(sn,room,20000);store.finish(first,{city:'北京市',province:'北京',provider:'ip9'});assert.equal(store.get(sn,room).state,'pending');
 store.finish(second,a);assert.equal(store.get(sn,room).city,'北京市');
 const aborted=new AbortController();aborted.abort();await assert.rejects(store.wait(sn,room,aborted.signal));
 time=20001;assert.equal(store.get(sn,room).state,'expired');assert.equal(store.summary([sn])[0].state,'expired');
 assert(!readFileSync(join(dir,'location.db')).includes(Buffer.from(sample)),'raw IP must not be stored');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
console.log('location: trusted ingress, IPv4/IPv6, no server fallback, provider bounds/cache, session isolation/expiry passed');
