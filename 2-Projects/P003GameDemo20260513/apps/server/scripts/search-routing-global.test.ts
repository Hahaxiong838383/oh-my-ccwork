import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import {RoutingStore} from '../src/tools/search-routing-store.js';
test('P1 default routing reaches newly enrolled SN and has versioned global rollback',()=>{
 const root=mkdtempSync(join(tmpdir(),'p003-routing-global-'));let now=1000;
 const s=new RoutingStore(join(root,'routing.db'),()=>now,{allowGlobal:true} as any) as any;
 try{
  assert.equal(typeof s.publishGlobal,'function');
  const v=s.publishGlobal(0,'synthetic');
  assert.equal(s.snapshot('BJP00326102700100005').version,v);
  const draft=s.state().draft;draft.weather_enabled=!draft.weather_enabled;s.saveDraft(draft,1,'synthetic');
  now=2000;const v2=s.publishGlobal(2,'synthetic');assert.notEqual(v2,v);
  assert.equal(s.resolve('BJP00326102700100005',v).version,v,'in-flight routing grace');
  now=18000;assert.throws(()=>s.resolve('BJP00326102700100005',v),/stale/);
  s.rollbackGlobal(v,3,'synthetic');assert.equal(s.snapshot('BJP00326102700100006').version,v);
  s.ack('BJP00326102700100006',v,'synthetic-room');assert.equal(s.state().loads.length,1);
  assert.equal(s.snapshot('malformed'),null);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
test('P2 routing store cannot publish global even when called directly',()=>{
 const root=mkdtempSync(join(tmpdir(),'p003-routing-canary-'));const s=new RoutingStore(join(root,'routing.db')) as any;
 try{assert.equal(typeof s.publishGlobal,'function');assert.throws(()=>s.publishGlobal(0,'synthetic'),/invalid_scope/);assert.equal(s.state().revision,0);}finally{s.close();rmSync(root,{recursive:true,force:true});}
});
