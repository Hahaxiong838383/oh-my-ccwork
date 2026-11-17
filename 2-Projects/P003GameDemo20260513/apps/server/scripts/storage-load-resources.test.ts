import assert from 'node:assert/strict';
import {parseLinuxResources,createResourceRecorder,linuxResources} from './storage-load-resources.js';
const parsed=parseLinuxResources('cpu  10 0 20 70 10 0 0 0 0 0\n','MemTotal: 1000 kB\nMemAvailable: 400 kB\n');
assert.equal(parsed.cpu_total,110);assert.equal(parsed.cpu_idle,80);assert.equal(parsed.mem_available_bytes,409600);
assert.throws(()=>parseLinuxResources('cpu 1 2','MemTotal: 100 kB'));
assert.throws(()=>parseLinuxResources('cpu 1 2 3 4 5 6 7 8','MemTotal: 100 kB'));
const base={supported:true,boot_id:'synthetic',pid:123,cgroup:'/synthetic',mem_available_bytes:400,mem_total_bytes:1000,disk_free_bytes:10*1024**3,oom:0,oom_kill:0};
// Accelerated counter test, explicitly not a real-day durability result.
for(const kind of ['good','oom','restart','low-memory','high-cpu','disk-low','missing','gap','short']){
 const r=createResourceRecorder();
 for(let n=0;n<=(kind==='short'?86399:86400);n++){
  if(kind==='gap'&&n>100&&n<120)continue;
  r.record({...base,monotonic_ms:n*1000,cpu_total:n*100,cpu_idle:n*(kind==='high-cpu'?20:80),...(n===1?{...(kind==='oom'?{oom:1,oom_kill:1}:{}),...(kind==='restart'?{pid:456}:{}),...(kind==='low-memory'?{mem_available_bytes:199}:{}),...(kind==='disk-low'?{disk_free_bytes:1}:{}),...(kind==='missing'?{supported:false}:{})}:{})});
 }
 assert.equal(r.summary(86400000).local_resource_gate,kind==='good',kind);
 if(kind==='good'){assert.equal(r.summary(86400000).cpu_average_percent,20);assert.equal(r.summary(3600000).complete_24h_evidence,false);}
}
if(process.platform!=='linux')assert.equal(linuxResources('/tmp').supported,false);
console.log('PASS resource parser/counters: exact CPU weights, OOM/restart/gap/short/unknown/memory/disk fail closed; accelerated only, not 24h');
