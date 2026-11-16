// Metadata-only measurement: no claim of payload, throughput, or 50-device capacity.
// Run beside a frozen storage-nas-verify.mjs, under an isolated writable directory.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {queue,rotateArk} from './storage-nas-verify.mjs';
const base=process.argv[2];assert.ok(base&&path.isAbsolute(base));
const root=fs.mkdtempSync(path.join(base,'metadata-only-')),now=Date.now(),count=10000;
try{
 for(const name of ['packages','receipts'])fs.mkdirSync(path.join(root,name));
 for(let i=0;i<count;i++){
  const id=(i+1).toString(16).padStart(32,'0'),p=path.join(root,'packages',id);fs.mkdirSync(p);
  const m={schema_version:1,archive_id:id,kind:'ark_checkpoint',created_at_ms:now-91*86400000+i,record_count:1,bytes:1,sha256:'a'.repeat(64),source_range:{synthetic_metadata_only:true}};
  fs.writeFileSync(path.join(p,'manifest.json'),JSON.stringify(m));
  if(i>=20)fs.writeFileSync(path.join(p,'receipt.json'),JSON.stringify({archive_id:id,bytes:1,record_count:1,sha256:m.sha256,verified_at_ms:now-86400000}));
 }
 const list=path.join(root,'source-list.json');fs.writeFileSync(list,'[]');
 const q0=performance.now(),ids=queue(root,list),qms=performance.now()-q0;assert.equal(ids.length,20);
 assert.deepEqual(ids,Array.from({length:20},(_,i)=>(i+1).toString(16).padStart(32,'0')));
 const g0=performance.now(),r=await rotateArk(root,{nowMs:now}),gms=performance.now()-g0;assert.equal(r.removed.length,100);
 for(const id of ids)assert.ok(fs.existsSync(path.join(root,'packages',id)));
 console.log(JSON.stringify({metadata_only:true,entries:count,queued:ids.length,gc_removed:r.removed.length,pending_preserved:true,queue_ms:qms,gc_ms:gms,rss_bytes:process.memoryUsage().rss,node:process.version}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
