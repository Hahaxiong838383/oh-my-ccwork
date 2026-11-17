import assert from 'node:assert/strict';
import {mkdtempSync,appendFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLoadHealthRecorder} from './storage-load-health.js';
const root=mkdtempSync(join(tmpdir(),'p003-t5-health-'));
try{
  const file=join(root,'health.jsonl');const h=createLoadHealthRecorder(x=>appendFileSync(file,JSON.stringify(x)+'\n'),256);
  // Accelerated sample-count test only, NOT a 24-hour soak or memory/CPU test.
  for(let i=0;i<86400;i++)h.record({at:i*1000,status:i===0?503:200,rss_bytes:i===0?999:10,wal_bytes:i===0?888:5,disk_free_bytes:i===0?0:100});
  const s=h.summary(),tail=h.recent();assert.equal(s.samples,86400);assert.equal(tail.length,256);assert(s.truncated);
  assert.equal(tail[0].at,(86400-256)*1000);assert.equal(tail.at(-1).at,86399000);
  assert.equal(s.rss_peak_bytes,999);assert.equal(s.wal_peak_bytes,888);assert.equal(s.disk_free_min_bytes,0);assert.equal(s.failed_samples,1);assert.equal(s.status_counts['503'],1);
  const lines=readFileSync(file,'utf8').trim().split('\n');assert.equal(lines.length,86400);assert.equal(JSON.parse(lines[0]).status,503);assert.equal(JSON.parse(lines.at(-1)!).at,86399000);
  assert(JSON.stringify({summary:s,recent:tail}).length<40000,'summary+tail must stay bounded');
  const empty=createLoadHealthRecorder(()=>{},2);assert.equal(empty.summary().rss_peak_bytes,null);assert.deepEqual(empty.recent(),[]);
  empty.record({at:1,error:'transport',rss_bytes:null,wal_bytes:-1,disk_free_bytes:NaN});assert.equal(empty.summary().rss_peak_bytes,null);assert.equal(empty.summary().disk_free_min_bytes,null);assert.equal(empty.summary().failed_samples,1);
  empty.record({at:2,status:200});assert.deepEqual(empty.recent().map(x=>x.at),[1,2]);empty.record({at:3,status:200});assert.deepEqual(empty.recent().map(x=>x.at),[2,3]);
  const broken=createLoadHealthRecorder(()=>{throw Error('disk full');});assert.throws(()=>broken.record({at:1,status:200}),/disk full/);assert.equal(broken.summary().samples,0);
  for(const cap of [0,-1,1.5,Infinity,4097])assert.throws(()=>createLoadHealthRecorder(()=>{},cap));
  console.log('PASS bounded health evidence: 86400 accelerated samples, complete JSONL, retained out-of-tail failures/extrema, unknown is null, sink failure surfaces');
}finally{rmSync(root,{recursive:true,force:true});}
