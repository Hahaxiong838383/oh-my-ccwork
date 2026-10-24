import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SearchTasks } from '../src/tools/search-tasks.js';

const owner = { subject:'BJP00326060100100004',session:'sn-BJP00326060100100004-1' };
const next = { ...owner,session:'sn-BJP00326060100100004-2' };
const text = '火星呈现红色。表面有氧化铁。';
const hash = createHash('sha256').update(text).digest('hex');
const request = (turn='a')=>({protocol:1,phase:'committed',turn,query:'火星为什么是红色'});
const flush=()=>new Promise<void>(r=>setImmediate(r));
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'search-r14-'));let now=1_800_000_000_000,scope='account-A:epoch-1',enabled=true;
 const options={dbPath:join(dir,'tasks.db'),execute:async()=>({text,sources:[]}),now:()=>now,enabled:()=>enabled,allowed:(s:string)=>s===owner.subject,
 resumeEnabled:()=>true,resumeScope:()=>scope,windowDeadline:()=>1_800_000_500_000};
 const tasks=new SearchTasks(options);
 return {tasks,options,advance:(n:number)=>{now+=n;tasks.tick();},scope:(s:string)=>{scope=s;},disable:()=>{enabled=false;tasks.tick();},close:()=>{tasks.close();rmSync(dir,{recursive:true,force:true});}};
}
test('R14 28秒重连只显式续讲，旧session仍不能跨会话读取，进度只跳完整句',async()=>{
 const f=fixture();try{
 const t=f.tasks.submit(owner,request());await flush();f.tasks.claim(owner,t.id,'d1');
 f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:1,sequence:1});
 assert.throws(()=>f.tasks.resumeLatest(next,'r1'),/previous_session_closing/);
 f.tasks.closeSession(owner);f.advance(28_785);
 assert.equal(f.tasks.list(next).length,0);
 assert.throws(()=>f.tasks.playback(next,t.id),/not_found/);
 const r=f.tasks.resumeLatest(next,'r1');assert.equal(r.text,'表面有氧化铁。');assert.equal(r.complete_sentences,1);
 assert.equal(f.tasks.resumeLatest(next,'r1').grant,r.grant);assert.equal(r.valid_for_ms,271_215);
 assert.throws(()=>f.tasks.resumePlayback({...next,session:next.session+'9'},r.grant),/not_found/);
 f.tasks.closeSession(owner);assert.equal(f.tasks.resumePlayback(next,r.grant).text,r.text,'late old close cannot revoke new grant');
 assert.throws(()=>f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:2,sequence:2}),/session_closed/);
 f.tasks.resumeReceipt(next,r.grant,'interrupted',{protocol:1,text_digest:hash,complete_sentences:1,sequence:2});
 f.tasks.closeSession(next);f.advance(271_215);
 assert.throws(()=>f.tasks.resumeLatest({...next,session:next.session+'3'},'r2'),/not_ready/);
 }finally{f.close();}
});
test('R14 progress rejects wrong digest, overrun, regression and cancelled delivery',async()=>{
 const f=fixture();try{const t=f.tasks.submit(owner,request());await flush();f.tasks.claim(owner,t.id,'d1');
 for(const v of [{text_digest:'0'.repeat(64),complete_sentences:1,sequence:1},{text_digest:hash,complete_sentences:3,sequence:1}])assert.throws(()=>f.tasks.progress(owner,t.id,'d1',{protocol:1,...v}),/invalid_progress/);
 f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:1,sequence:2});
 assert.throws(()=>f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:0,sequence:3}),/invalid_progress/);
 f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:0,sequence:1});
 f.tasks.cancel(owner,t.id);assert.throws(()=>f.tasks.progress(owner,t.id,'d1',{protocol:1,text_digest:hash,complete_sentences:2,sequence:4}),/not_ready/);
 f.tasks.closeSession(owner);assert.throws(()=>f.tasks.resumeLatest(next,'r1'),/not_ready/);
 }finally{f.close();}
});
test('R14 binding epoch, gate, replacement and restart invalidate recovery without weakening owner checks',async()=>{
 for(const why of ['binding','disable','replacement','restart','foreign'] as const){const f=fixture();try{
 const t=f.tasks.submit(owner,request());await flush();f.tasks.closeSession(owner);
 if(why==='binding')f.scope('account-A:epoch-3');
 if(why==='disable')f.disable();
 if(why==='replacement'){f.tasks.submit(next,request('b'));await flush();}
 if(why==='restart'){f.tasks.close();const reboot=new SearchTasks(f.options);assert.throws(()=>reboot.resumeLatest(next,'r1'),/not_ready/);reboot.close();continue;}
 assert.throws(()=>f.tasks.resumeLatest(why==='foreign'?{subject:'BJP00326070803800006',session:'sn-BJP00326070803800006-2'}:next,'r1'),/disabled|not_ready|previous_session_closing/);
 }finally{f.close();}}
});

test('R14 immutable expiry, one live session, eight claims and close tombstone',async()=>{
 const f=fixture();try{const t=f.tasks.submit(owner,request());await flush();f.tasks.closeSession(owner);
 assert.throws(()=>f.tasks.claim(owner,t.id,'late'),/not_ready/);assert.throws(()=>f.tasks.playback(owner,t.id),/not_ready/);
 let o=next;
 for(let i=0;i<8;i++){
  const r=f.tasks.resumeLatest(o,'request-'+i);assert.equal(r.valid_for_ms,300000-i*1000);
  const competing={...o,session:o.session+'9'};assert.throws(()=>f.tasks.resumeLatest(competing,'other'),/previous_session_closing/);
  f.tasks.closeSession(o);f.advance(1000);o={...o,session:o.session+'3'};
 }
 assert.throws(()=>f.tasks.resumeLatest(o,'ninth'),/not_ready/);
 }finally{f.close();}
});
test('R14 window deadline wins over five-minute TTL and is never refreshed by replay',async()=>{
 const f=fixture();try{f.options.windowDeadline=()=>1_800_000_030_000;const t=f.tasks.submit(owner,request());await flush();f.tasks.closeSession(owner);
 const r=f.tasks.resumeLatest(next,'r1');assert.equal(r.valid_for_ms,30000);f.advance(29999);assert.equal(f.tasks.resumePlayback(next,r.grant).valid_for_ms,1);f.advance(1);assert.throws(()=>f.tasks.resumePlayback(next,r.grant),/not_ready/);
 }finally{f.close();}
});
test('R14 two-minute and last-second recovery preserve the original deadline; cancellation revokes the new grant',async()=>{
 for(const elapsed of [120000,299000]){
  const f=fixture();try{
   const t=f.tasks.submit(owner,request());await flush();f.tasks.closeSession(owner);f.advance(elapsed);
   const r=f.tasks.resumeLatest(next,'late-recovery');assert.equal(r.valid_for_ms,300000-elapsed);
   assert.equal(f.tasks.resumePlayback(next,r.grant).text,text);
   f.tasks.resumeCancel(next);
   assert.throws(()=>f.tasks.resumePlayback(next,r.grant),/not_ready/);
   assert.throws(()=>f.tasks.resumeLatest({...next,session:next.session+'3'},'after-cancel'),/not_ready/);
  }finally{f.close();}
 }
});
