import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readCgroupV1,createResourceRecorder} from './storage-load-resources.js';

test('NAS cgroup v1 reads the container subtree, including child processes, without claiming v2 acceptance',()=>{
 const group='/docker/test-container';
 const proc=['memory','cpu','cpuacct'].map((c,i)=>`${i+1}:${c}:${group}`).join('\n');
 const mounts=['memory','cpu','cpuacct'].map((c,i)=>`${i+1} 1 0:${i+1} ${group} /sys/fs/cgroup/${c} ro - cgroup none rw,${c}`).join('\n');
 const values:Record<string,string>={
  '/sys/fs/cgroup/memory/memory.stat':'inactive_file 1\ndirty 0\nwriteback 0\ntotal_inactive_file 82\ntotal_dirty 7\ntotal_writeback 1\n',
  '/sys/fs/cgroup/memory/memory.oom_control':'oom_kill_disable 0\nunder_oom 0\noom_kill 0\n',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes':'100',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes':'805306368',
  '/sys/fs/cgroup/memory/memory.failcnt':'0',
  '/sys/fs/cgroup/cpu/cpu.cfs_quota_us':'50000',
  '/sys/fs/cgroup/cpu/cpu.cfs_period_us':'100000',
  '/sys/fs/cgroup/cpuacct/cpuacct.usage':'36173800',
 };
 const read=(p:string)=>{assert(p in values,p);return values[p];};
 const sample=readCgroupV1(proc,mounts,read);
 assert.equal(sample.cgroup_cpu_quota_cores,.5);assert.equal(sample.cgroup_cpu_usage_usec,36173);
 assert.equal(sample.cgroup_inactive_file_bytes,82);assert.equal(sample.cgroup_file_dirty_bytes,7);
 assert.equal(sample.cgroup_file_writeback_bytes,1);assert.equal(sample.cgroup_version,1);
 assert.equal(sample.resource_acceptance_supported,false);
 assert.throws(()=>readCgroupV1(proc,mounts.replaceAll(group,'/different-container'),read));
 const missing={...values};delete missing['/sys/fs/cgroup/memory/memory.oom_control'];
 assert.throws(()=>readCgroupV1(proc,mounts,p=>missing[p]));
 const r=createResourceRecorder();
 for(let n=0;n<=8640;n++)r.record({...sample,supported:true,pid:1,boot_id:'synthetic',monotonic_ms:n*10000,cpu_total:n*1000,cpu_idle:n*900,mem_total_bytes:1e9,mem_available_bytes:5e8,disk_free_bytes:10*1024**3,cgroup_cpu_usage_usec:n*1e6});
 const report=r.summary(86400000);assert.equal(report.complete_24h_evidence,false);assert.equal(report.local_resource_gate,false);
 assert.equal(report.acceptance_unsupported_samples,8641);
});
