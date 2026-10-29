import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AmapUsageStore} from '../src/tools/amap-usage.js';

test('weather budget persists, separates geocoding, counts attempts conservatively and survives reconnect',()=>{
 const dir=mkdtempSync(join(tmpdir(),'amap-budget-')),path=join(dir,'usage.db');
 let s=new AmapUsageStore(path),other=new AmapUsageStore(path);
 try {
  assert.equal(s.snapshot().remaining,0);
  const request_id=randomUUID(),credit={request_id,mode:'add' as const,amount:2,expected_revision:0};
  s.adjust(credit,'admin');s.adjust(credit,'admin');assert.equal(s.snapshot().remaining,2);
  assert.throws(()=>s.adjust({...credit,amount:3},'admin'),/idempotency_conflict/);
  const geo=s.reserve('geocode');s.finish(geo,'success');assert.equal(s.snapshot().remaining,2);
  const one=s.reserve('weather');s.finish(one,'success');
  const two=other.reserve('weather');other.finish(two,'rejected','10003');
  assert.equal(s.snapshot().remaining,0);assert.throws(()=>s.reserve('weather'),/quota_exhausted/);
  assert.throws(()=>s.adjust({request_id:randomUUID(),mode:'set_remaining',amount:10,expected_revision:1},'admin'),/revision_conflict/);
  s.close();s=new AmapUsageStore(path);const snap=s.snapshot();
  assert.equal(snap.weather_requests,2);assert.equal(snap.geocode_requests,1);assert.equal(snap.weather_successes,1);assert.equal(snap.weather_rejected,1);
  s.adjust({request_id:randomUUID(),mode:'set_remaining',amount:5,expected_revision:snap.revision},'admin');assert.equal(other.snapshot().remaining,5);
  const pending=s.reserve('weather');assert.equal(s.snapshot().weather_unconfirmed,1);
  s.finish(pending,'success');s.finish(pending,'success');assert.equal(s.snapshot().remaining,4);
  assert.equal(s.snapshot().history.length,2);
 } finally {s.close();other.close();rmSync(dir,{recursive:true,force:true});}
});

test('invalid manual amounts do not change accounting',()=>{
 const s=new AmapUsageStore(':memory:');try{
  for(const amount of [-1,1.1,NaN,Infinity,100000001])assert.throws(()=>s.adjust({request_id:randomUUID(),mode:'add',amount,expected_revision:0},'admin'));
  assert.equal(s.snapshot().remaining,0);assert.equal(s.snapshot().revision,0);
 }finally{s.close();}
});
