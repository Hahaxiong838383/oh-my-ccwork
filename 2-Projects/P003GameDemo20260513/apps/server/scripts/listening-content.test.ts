import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { testAuthority } from './lib/listening-test.js';
import { createListeningRoute } from '../src/routes/listening.js';
async function setup(generate:any=async()=> '小熊愿意分享最后的苹果，让人感到温暖。'){
 const f=await testAuthority();const offered=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});
 await f.authority.lease(f.headers,{...f.base,request_id:'applied',applied_snapshot_sha256:offered.snapshot.sha256});
 let personaReads=0,calls=0;const inputs:any[]=[];
 const app=new Hono().route('/v1/internal/listening',createListeningRoute(f.authority,{generate:async(o:any)=>{calls++;inputs.push(o);return generate(o);},personality:async()=>{personaReads++;return '小可：温柔简短的方舟伙伴。';}}));
 const content={...f.base,snapshot_revision:offered.snapshot.revision,snapshot_sha256:offered.snapshot.sha256};
 const feedback={...content,request_id:'feedback-1',summary:'',recent:'小熊分享苹果。',question:'你觉得呢？',has_gap:false,trigger:'button'};
 const summary={...content,request_id:'summary-1',previous_summary:'',base_summary_version:0,has_gap:false,segments:[{seq:1,revision:1,text:'小熊分享苹果。'}]};
 const call=(path:string,body:any,headers:any=f.headers,signal?:AbortSignal)=>app.request('/v1/internal/listening'+path,{method:'POST',signal,headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 return {...f,call,feedback,summary,counts:()=>({calls,personaReads}),inputs};
}
test('real route authentication, replay and cooldown do not generate another feedback',async()=>{const f=await setup();try{
 assert.equal((await f.call('/feedback',f.feedback,{})).status,401);assert.equal(f.counts().calls,0);
 const first=await f.call('/feedback',f.feedback);assert.equal(first.status,200);const json=await first.json();assert.equal(json.max_chars,80);assert.equal(json.max_duration_ms,12000);
 assert.deepEqual(await (await f.call('/feedback',f.feedback)).json(),json);assert.equal(f.counts().calls,1);
 assert.equal((await f.call('/feedback',{...f.feedback,request_id:'feedback-again'})).status,409);
 assert.equal((await f.call('/feedback',{...f.feedback,recent:'修改过的正文'})).status,409);
}finally{f.cleanup();}});
test('summary echoes CAS coverage, gap and base version without reading personality',async()=>{const f=await setup(async()=> '小熊分享了苹果。');try{
 const response=await f.call('/summary',{...f.summary,has_gap:true,base_summary_version:4});assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.base_summary_version,4);assert.equal(body.has_gap,true);assert.deepEqual(body.covered,[{seq:1,revision:1}]);assert.match(body.source_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(f.counts(),{calls:1,personaReads:0});assert.equal((await f.call('/summary',{...f.summary,segments:[{seq:1,revision:2,text:'变更原文'}]})).status,409);
}finally{f.cleanup();}});
test('disabled scene, oversized question or device-command output rejected',async()=>{const f=await setup(async()=> '[[DEV:2]]打开灯');try{
 assert.equal((await f.call('/feedback',f.feedback)).status,502);
 assert.equal((await f.call('/feedback',{...f.feedback,question:'甲'.repeat(501)})).status,400);
 const cfg=f.settings.read().config;f.settings.save(cfg.revision,{enabled:cfg.enabled,allowlist:cfg.allowlist,scenes:['sharing'],tuning:cfg.tuning},'synthetic');
 assert.equal((await f.call('/summary',f.summary)).status,403);
}finally{f.cleanup();}});
test('gate revoke while model pending discard result',async()=>{let finish:(s:string)=>void=()=>{};const f=await setup(()=>new Promise<string>(r=>{finish=r;}));try{
 const pending=f.call('/feedback',f.feedback);await new Promise(r=>setTimeout(r,30));
 assert.equal((await f.call('/summary',f.summary)).status,409);
 f.settings.disable('operator');finish('小熊很愿意分享。');assert.equal((await pending).status,403);
 assert.equal(f.counts().calls,1);
}finally{f.cleanup();}});

test('already cancelled HTTP request never invokes model or personality',async()=>{const f=await setup();try{
 const controller=new AbortController();controller.abort();
 assert.equal((await f.call('/feedback',f.feedback,f.headers,controller.signal)).status,409);assert.deepEqual(f.counts(),{calls:0,personaReads:0});
}finally{f.cleanup();}});
test('mode epoch invalidates pending output and old-epoch replay',async()=>{let done:(s:string)=>void=()=>{};const f=await setup(()=>new Promise<string>(r=>{done=r;}));try{
 const pending=f.call('/summary',f.summary);while(f.counts().calls===0)await new Promise(r=>setTimeout(r,1));
 await f.authority.lease(f.headers,{...f.base,request_id:'epoch-2',mode_epoch:2,applied_snapshot_sha256:f.summary.snapshot_sha256});
 done('摘要完成');assert.equal((await pending).status,409);
 assert.equal((await f.call('/summary',f.summary)).status,409);
}finally{f.cleanup();}});
test('singing allows button only and voice invitation flag is actually consumed',async()=>{for(const scene of ['singing','story']){const f=await setup();try{
 await f.authority.close(f.headers,{...f.base,request_id:'close'});
 if(scene==='story'){const cfg=f.settings.read().config;const {schema_version,revision,...editable}=cfg;f.settings.save(revision,{...editable,tuning:{...editable.tuning,voice_invitation_enabled:false}},'synthetic');}
 const next={...f.base,listening_id:f.base.session.trace_id+':2',request_id:'next-offer',scene,mode_epoch:2};
 const offer=await f.authority.lease(f.headers,{...next,applied_snapshot_sha256:null});
 await f.authority.lease(f.headers,{...next,request_id:'next-apply',applied_snapshot_sha256:offer.snapshot.sha256});
 const feedback={...f.feedback,...next,request_id:'voice',snapshot_revision:offer.snapshot.revision,snapshot_sha256:offer.snapshot.sha256,trigger:'voice_invitation'};
 assert.equal((await f.call('/feedback',feedback)).status,403);assert.equal(f.counts().calls,0);
 assert.equal((await f.call('/feedback',{...feedback,request_id:'button',trigger:'button'})).status,200);
}finally{f.cleanup();}}});

test('abandoned task cannot revive after durable timeout recovery',async()=>{const completions:Array<(s:string)=>void>=[];const f=await setup(()=>new Promise<string>(r=>completions.push(r)));try{
 const old=f.call('/summary',f.summary);while(completions.length<1)await new Promise(r=>setTimeout(r,1));f.advance(8001);
 const next=f.call('/summary',{...f.summary,request_id:'summary-next'});while(completions.length<2)await new Promise(r=>setTimeout(r,1));
 completions[0]('旧任务结果');assert.equal((await old).status,409);completions[1]('新任务结果');assert.equal((await next).status,200);
}finally{f.cleanup();}});
test('model timeout spends RID and aborts work, without retrying generation',async()=>{let signal:AbortSignal|undefined;const f=await setup((o:any)=>{signal=o.signal;return new Promise(()=>{});});try{
 assert.equal((await f.call('/summary',f.summary)).status,504);assert.equal(signal?.aborted,true);
 assert.equal((await f.call('/summary',f.summary)).status,409);assert.equal(f.counts().calls,1);
}finally{f.cleanup();}});
