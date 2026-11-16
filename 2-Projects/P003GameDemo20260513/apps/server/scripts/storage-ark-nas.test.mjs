import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {test} from 'node:test';
import * as nas from './storage-nas-verify.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const snap=JSON.parse(fs.readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
const envelope=()=>({format_version:1,record_id:1,sn:'BJP00399999999999901',account_id:'synthetic-device',epoch:1,grant_id:'test-grant',source_mode:snap.source_mode,received_at_ms:1794830000000,body_hash:hash(canonical(snap)),snapshot:structuredClone(snap)});
function fixture(){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ark-nas-')));let id=0;return {root,async put(lines,patch={}){const data=lines.map(x=>JSON.stringify(x)+'\n').join('');const m={schema_version:1,archive_id:(++id).toString(16).padStart(32,'0'),kind:'ark_checkpoint',created_at_ms:1794830000000,record_count:lines.length,bytes:Buffer.byteLength(data),sha256:hash(data),source_range:{format:'ark_jsonl',format_version:1,lines:lines.length,first_id:1,last_id:lines.length},...patch};const file=path.join(root,'input.json');fs.writeFileSync(file,JSON.stringify(m));const p=nas.prepare(root,file);fs.writeFileSync(p.payload,data);return m;},done(){fs.rmSync(root,{recursive:true,force:true});}};}
test('NAS refuses correct file hash with invalid Ark inner body hash',async()=>{const f=fixture();try{const e=envelope();e.body_hash='a'.repeat(64);const m=await f.put([e]);await assert.rejects(nas.finalize(f.root,m.archive_id),/ARK_/);}finally{f.done();}});
test('NAS validates full snapshot, identity, strict keys, mode and ordered IDs',async()=>{const f=fixture();try{
 for(const mutate of [e=>e.epoch=0,e=>e.sn='wrong',e=>e.source_mode='invalid',e=>e.extra='bad',e=>e.snapshot.wallets.family_coin=-1,e=>e.snapshot.progress.next_reward.item_id='unknown',e=>e.snapshot.boot_started_at_ms=e.snapshot.captured_at_ms+1,e=>e.snapshot.logical_day='2026-02-30']){
  const e=envelope();mutate(e);e.body_hash=hash(canonical(e.snapshot));const m=await f.put([e]);await assert.rejects(nas.finalize(f.root,m.archive_id),/ARK_/);
 }
 const dup=await f.put([envelope(),envelope()]);await assert.rejects(nas.finalize(f.root,dup.archive_id),/ARK_/);
 const mismatched=await f.put([envelope()],{record_count:2});await assert.rejects(nas.finalize(f.root,mismatched.archive_id),/ARK_/);
 const valid=await f.put([envelope()]);assert.equal((await nas.finalize(f.root,valid.archive_id)).record_count,1);
}finally{f.done();}});
test('90-day Ark retention only removes exact acknowledged old packets, independent of backup rotation',async()=>{const f=fixture();try{
 assert.equal(typeof nas.rotateArk,'function');const now=1794830000000,day=86400000;
 const old=await f.put([envelope()],{created_at_ms:now-91*day});await nas.finalize(f.root,old.archive_id);
 const fresh=await f.put([envelope()],{created_at_ms:now-90*day});await nas.finalize(f.root,fresh.archive_id);
 const pending=await f.put([envelope()],{created_at_ms:now-100*day});await nas.finalize(f.root,pending.archive_id);
 for(const m of [old,fresh])nas.acknowledge(f.root,m.archive_id,{archive_id:m.archive_id,sha256:m.sha256,bytes:m.bytes,record_count:m.record_count,verified_at_ms:now-89*day});
 const r=await nas.rotateArk(f.root,{nowMs:now});assert.deepEqual(r.removed,[old.archive_id]);assert.ok(fs.existsSync(path.join(f.root,'packages',pending.archive_id)));assert.ok(fs.existsSync(path.join(f.root,'packages',fresh.archive_id)));assert.deepEqual((await nas.rotateArk(f.root,{nowMs:now})).removed,[]);
}finally{f.done();}});
