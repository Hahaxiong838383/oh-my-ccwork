import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaceLlmClient } from '../src/providers/race-llm.js';
import { createVolcLlmClient } from '../src/providers/volc-llm.js';
import type { DeepseekLlmClient } from '../src/providers/deepseek-llm.js';

test('invalid subscription is classified without exposing upstream account or credentials', async () => {
 const oldFetch=globalThis.fetch,oldKey=process.env.VOLC_LLM_API_KEY;
 process.env.VOLC_LLM_API_KEY='synthetic-private-key';
 globalThis.fetch=(async()=>new Response(JSON.stringify({error:{code:'InvalidSubscription',message:'account PRIVATE_ACCOUNT has expired; key synthetic-private-key; request PRIVATE_RID'}}),{status:400})) as typeof fetch;
 let failure:Error|undefined;
 try {await createVolcLlmClient().streamChat({systemPrompt:'s',userText:'u',onDelta:()=>assert.fail('no content expected'),onDone:()=>assert.fail('not success'),onError:e=>{failure=e;}});
  assert.ok(failure);assert.equal(failure.message,'模型服务暂时不可用');assert.equal((failure as any).providerCode,'InvalidSubscription');assert.equal((failure as any).httpStatus,400);
  assert.doesNotMatch(failure.message,/PRIVATE_ACCOUNT|synthetic-private-key|PRIVATE_RID/);
 } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.VOLC_LLM_API_KEY;else process.env.VOLC_LLM_API_KEY=oldKey;}
});

test('a failed fallback is observable before the good main finishes, without leaking raw error', async () => {
 const warnings:unknown[][]=[];const old=console.warn;console.warn=(...a)=>{warnings.push(a);};
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let failed!:()=>void;const failureSeen=new Promise<void>(r=>{failed=r;});
 const main:DeepseekLlmClient={abort(){},async streamChat(o){await gate;o.onDelta('正常');o.onDone('正常');}};
 const backup:DeepseekLlmClient={abort(){},async streamChat(o){o.onError(Object.assign(new Error('PRIVATE_KEY user-body'),{httpStatus:400,providerCode:'InvalidSubscription'}));failed();}};
 const output:string[]=[];let externalErrors=0;
 const running=createRaceLlmClient(()=>main,()=>backup).streamChat({systemPrompt:'s',userText:'u',onDelta:d=>output.push(d),onDone(){},onError(){externalErrors++;}});
 try {await failureSeen;assert.equal(warnings.length,1);assert.equal(warnings[0][0],'[race-provider]');
  const payload=JSON.parse(String(warnings[0][1]));assert.equal(payload.route,'fallback');assert.equal(payload.code,'InvalidSubscription');assert.equal(payload.http_status,400);assert.doesNotMatch(JSON.stringify(warnings),/PRIVATE_KEY|user-body/);
 }finally{release();await running;console.warn=old;}
 assert.equal(output.join(''),'正常');assert.equal(externalErrors,0);
});

test('one route calling onError then throwing cannot prematurely report both routes failed', async()=>{
 const main:DeepseekLlmClient={abort(){},async streamChat(o){await new Promise(r=>setTimeout(r,10));o.onDelta('正常');o.onDone('正常');}};
 const backup:DeepseekLlmClient={abort(){},async streamChat(o){const e=new Error('failed');o.onError(e);throw e;}};
 let errors=0,done=0;const deltas:string[]=[];
 await createRaceLlmClient(()=>main,()=>backup).streamChat({systemPrompt:'s',userText:'u',onDelta:d=>deltas.push(d),onDone(){done++;},onError(){errors++;}});
 assert.equal(errors,0);assert.equal(done,1);assert.equal(deltas.join(''),'正常');
});

test('health preserves a failed route, reports recovery and marks stale observations', async()=>{
 const {raceProviderHealth,ProviderHttpError}=await import('../src/providers/provider-health.js');
 let abortFallback=()=>{};
 const failedMain:DeepseekLlmClient={abort(){},async streamChat(o){o.onError(new ProviderHttpError(400,JSON.stringify({error:{code:'InvalidSubscription',message:'PRIVATE'}})));}};
 const workingFallback:DeepseekLlmClient={abort(){},async streamChat(o){await Promise.resolve();o.onDelta('备用正文');o.onDone('备用正文');}};
 await createRaceLlmClient(()=>failedMain,()=>workingFallback).streamChat({systemPrompt:'s',userText:'u',onDelta(){},onDone(){},onError:()=>assert.fail()});
 assert.equal(raceProviderHealth().degraded,true);assert.equal(raceProviderHealth().main.outcome,'failure');
 const workingMain:DeepseekLlmClient={abort(){},async streamChat(o){await Promise.resolve();o.onDelta('主路正文');o.onDone('主路正文');}};
 const cancelledFallback:DeepseekLlmClient={abort(){abortFallback();},async streamChat(o){await new Promise<void>(r=>{abortFallback=r;});o.onError(Object.assign(new Error('PRIVATE cancel'),{name:'AbortError'}));}};
 const warnings:unknown[][]=[];const old=console.warn;console.warn=(...a)=>{warnings.push(a);};
 try{await createRaceLlmClient(()=>workingMain,()=>cancelledFallback).streamChat({systemPrompt:'s',userText:'u',onDelta(){},onDone(){},onError:()=>assert.fail()});}finally{console.warn=old;}
 assert.equal(warnings.length,0);assert.equal(raceProviderHealth().degraded,false);
 assert.equal((raceProviderHealth(Date.now()+300_001).main as any).stale,true);
 const error=new ProviderHttpError(400,JSON.stringify({error:{code:'PRIVATE_TOKEN',message:'PRIVATE_USER_BODY'}}));
 assert.equal(error.providerCode,'UpstreamError');assert.doesNotMatch(error.message,/PRIVATE/);
});

test('standard API model-not-open failure stays distinguishable from subscription expiry', async()=>{
 const {ProviderHttpError}=await import('../src/providers/provider-health.js');
 const failure=new ProviderHttpError(404,'{"error":{"code":"ModelNotOpen","message":"PRIVATE_ACCOUNT"}}');
 assert.equal(failure.providerCode,'ModelNotOpen');assert.equal(failure.httpStatus,404);assert.doesNotMatch(failure.message,/PRIVATE/);
});
