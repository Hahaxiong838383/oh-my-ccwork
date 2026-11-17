import assert from 'node:assert/strict';
import {readFileSync,statfsSync} from 'node:fs';
import {join} from 'node:path';

export function parseLinuxResources(stat:string,meminfo:string){
 const cpu=stat.split('\n')[0].trim().split(/\s+/);assert.equal(cpu.shift(),'cpu');
 const ticks=cpu.slice(0,8).map(Number);assert.equal(ticks.length,8);assert(ticks.every(n=>Number.isSafeInteger(n)&&n>=0));
 const mem=Object.fromEntries(meminfo.split('\n').map(line=>line.match(/^(MemTotal|MemAvailable):\s+(\d+) kB$/)).filter(Boolean).map(m=>[m![1],Number(m![2])*1024]));
 assert(mem.MemTotal>0&&Number.isFinite(mem.MemAvailable)&&mem.MemAvailable>=0&&mem.MemAvailable<=mem.MemTotal,'Linux memory evidence required');
 return {cpu_total:ticks.reduce((a,b)=>a+b,0),cpu_idle:ticks[3]+ticks[4],mem_total_bytes:mem.MemTotal,mem_available_bytes:mem.MemAvailable};
}

/** Observation only. Non-Linux evidence is explicitly unavailable, never a pass. */
export function linuxResources(root:string){
 if(process.platform!=='linux')return {supported:false,platform:process.platform,reason:'Linux /proc and cgroup evidence required'};
 const read=(p:string)=>readFileSync(p,'utf8');
 const resources=parseLinuxResources(read('/proc/stat'),read('/proc/meminfo'));
 const disk=statfsSync(root),path=read('/proc/self/cgroup').split('\n').find(x=>x.startsWith('0::'))?.slice(3);
 assert(path&&!path.split('/').includes('..'),'cgroup v2 evidence required');
 const group=join('/sys/fs/cgroup',path);
 const events=Object.fromEntries(read(join(group,'memory.events')).trim().split('\n').map(x=>{const [k,v]=x.split(' ');return [k,Number(v)];}));
 assert(['oom','oom_kill'].every(k=>Number.isSafeInteger(events[k])&&events[k]>=0),'OOM evidence required');
 const cpu=Object.fromEntries(read(join(group,'cpu.stat')).trim().split('\n').map(x=>{const [k,v]=x.split(' ');return [k,Number(v)];}));
 const max=read(join(group,'memory.max')).trim(),[quota,period]=read(join(group,'cpu.max')).trim().split(' ');
 assert(Number.isSafeInteger(cpu.usage_usec)&&cpu.usage_usec>=0,'cgroup CPU evidence required');
 return {supported:true,...resources,boot_id:read('/proc/sys/kernel/random/boot_id').trim(),pid:process.pid,cgroup:path,cgroup_memory_bytes:Number(read(join(group,'memory.current')).trim()),cgroup_memory_limit_bytes:max==='max'?null:Number(max),cgroup_cpu_usage_usec:cpu.usage_usec,cgroup_cpu_quota_cores:quota==='max'?null:Number(quota)/Number(period),oom:events.oom,oom_kill:events.oom_kill,disk_free_bytes:Number(disk.bavail)*Number(disk.bsize)};
}

/** Bounded totals and extrema; raw samples are persisted by the caller. */
export function createResourceRecorder(){
 let first:any,last:any,samples=0,unavailable=0,cpuBusy=0,cpuTotal=0,minMemory:number|null=null,minDisk:number|null=null,identityChanged=false,oom=false,maxGap=0,groupMissing=0,groupMemoryMax=0,groupUsec=0,groupWallMs=0;
 return {record(sample:any){
  samples++;if(sample.supported!==true){unavailable++;return;}
  assert(Number.isFinite(sample.monotonic_ms)&&sample.monotonic_ms>=0);
  assert(Number.isFinite(sample.mem_available_bytes)&&sample.mem_total_bytes>0&&sample.disk_free_bytes>=0,'invalid resource sample');
  if(!first)first=sample;
  const groupValid=Number.isFinite(sample.cgroup_memory_bytes)&&sample.cgroup_memory_bytes>=0&&Number.isFinite(sample.cgroup_memory_limit_bytes)&&sample.cgroup_memory_limit_bytes>0&&Number.isSafeInteger(sample.cgroup_cpu_usage_usec)&&sample.cgroup_cpu_usage_usec>=0&&Number.isFinite(sample.cgroup_cpu_quota_cores)&&sample.cgroup_cpu_quota_cores>0;
  if(!groupValid)groupMissing++;
  else groupMemoryMax=Math.max(groupMemoryMax,sample.cgroup_memory_bytes/sample.cgroup_memory_limit_bytes);
  if(last){
   const total=sample.cpu_total-last.cpu_total,idle=sample.cpu_idle-last.cpu_idle,gap=sample.monotonic_ms-last.monotonic_ms;
   assert(total>=0&&idle>=0&&idle<=total&&gap>=0,'resource counters regressed');
   cpuTotal+=total;cpuBusy+=total-idle;maxGap=Math.max(maxGap,gap);
   if(groupValid&&Number.isSafeInteger(last.cgroup_cpu_usage_usec)){const usec=sample.cgroup_cpu_usage_usec-last.cgroup_cpu_usage_usec;assert(usec>=0,'cgroup CPU counter regressed');groupUsec+=usec;groupWallMs+=gap;}
  }
  identityChanged ||= ['boot_id','pid','cgroup','cgroup_memory_limit_bytes','cgroup_cpu_quota_cores'].some(k=>sample[k]!==first[k]);
  oom ||= sample.oom>first.oom||sample.oom_kill>first.oom_kill;
  minMemory=Math.min(minMemory??1,sample.mem_available_bytes/sample.mem_total_bytes);
  minDisk=Math.min(minDisk??Infinity,sample.disk_free_bytes);last=sample;
 },summary(requiredMs:number){
  const elapsed=first&&last?last.monotonic_ms-first.monotonic_ms:0,avg=cpuTotal?100*cpuBusy/cpuTotal:null;
  const groupAvg=groupWallMs&&first?.cgroup_cpu_quota_cores>0?100*groupUsec/(groupWallMs*1000*first.cgroup_cpu_quota_cores):null;
  const complete=requiredMs>=86400000&&elapsed>=requiredMs&&samples>1&&unavailable===0&&groupMissing===0&&maxGap<=10000&&avg!==null&&!identityChanged&&!oom;
  return {samples,unavailable_samples:unavailable,cgroup_missing_samples:groupMissing,observed_ms:elapsed,required_ms:requiredMs,max_sample_gap_ms:maxGap,cpu_average_percent:avg,mem_available_min_fraction:minMemory,cgroup_memory_peak_fraction:groupMissing+unavailable===samples?null:groupMemoryMax,cgroup_cpu_average_one_core_percent:groupWallMs?100*groupUsec/(groupWallMs*1000):null,cgroup_cpu_average_quota_percent:groupAvg,cgroup_cpu_quota_cores:last?.cgroup_cpu_quota_cores??null,disk_free_min_bytes:minDisk,identity_changed:identityChanged,oom_seen:oom,complete_24h_evidence:complete,local_resource_gate:complete&&avg!<70&&groupAvg!==null&&groupAvg<70&&groupMemoryMax<=.8&&minMemory!>=.2&&minDisk!>=4.5*1024**3,not_covered:['NAS budget','voice A/B','maintenance backlog','external service restart counters']};
 }};
}
