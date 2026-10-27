import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as health from '../src/providers/provider-health.js';
import {createRaceLlmClient} from '../src/providers/race-llm.js';
import type {DeepseekLlmClient} from '../src/providers/deepseek-llm.js';

function circuit(now:()=>number){
 const Factory=(health as any).ProviderCircuit;assert.equal(typeof Factory,'function');return new Factory(now);
}
const error=(code:string,status=400)=>new health.ProviderHttpError(status,JSON.stringify({error:{code,message:'PRIVATE'}}));
test('R22 invalid fallback is skipped without delaying or duplicating main, then a single probe can recover',async()=>{
 let now=0,calls=0;const gate=circuit(()=>now);
 const main:DeepseekLlmClient={abort(){},async streamChat(o){await Promise.resolve();o.onDelta('主路正文');o.onDone('主路正文');}};
 const invalid:DeepseekLlmClient={abort(){},async streamChat(o){calls++;o.onError(error('InvalidSubscription'));}};
 async function run(backup:DeepseekLlmClient){let done=0,errors=0,text='';await (createRaceLlmClient as any)(()=>main,()=>backup,gate).streamChat({systemPrompt:'s',userText:'u',onDelta:(d:string)=>text+=d,onDone:()=>done++,onError:()=>errors++});assert.equal(text,'主路正文');assert.equal(done,1);assert.equal(errors,0);}
 await run(invalid);assert.equal(calls,1);assert.equal(gate.snapshot().state,'open');
 for(let i=0;i<3;i++)await run(invalid);assert.equal(calls,1,'blocked fallback must not be called on every turn');
 now=gate.snapshot().retry_at_ms;const ticket=gate.acquire();assert.notEqual(ticket,null);assert.equal(gate.acquire(),null,'one half-open probe');
 gate.content(ticket);gate.release(ticket);assert.equal(gate.snapshot().state,'closed');assert.doesNotMatch(JSON.stringify(gate.snapshot()),/PRIVATE/);
 await run(invalid);assert.equal(calls,2);
});
test('R22 transient failures back off within a cap; cancelled probes release their slot',()=>{
 let now=0;const gate=circuit(()=>now);let previous=0;
 for(let i=0;i<12;i++){
  const t=gate.acquire();assert.notEqual(t,null);gate.failure(t,error('RateLimitExceeded',429));gate.release(t);
  const delay=gate.snapshot().retry_at_ms-now;assert.ok(delay>=previous&&delay<=30000);previous=delay;now+=delay;
 }
 const probe=gate.acquire();assert.notEqual(probe,null);assert.equal(gate.acquire(),null);gate.release(probe);
 assert.equal(gate.acquire(),null,'cancelled probe still obeys cooldown');now=gate.snapshot().retry_at_ms;
 assert.notEqual(gate.acquire(),null,'cancelled losing probe must not wedge circuit');
});
test('R22 half-open provider runs concurrently with main and is aborted when main wins',async()=>{
 let now=0;const gate=circuit(()=>now);const ticket=gate.acquire();gate.failure(ticket,error('ModelNotOpen',404));gate.release(ticket);now=gate.snapshot().retry_at_ms;
 let started=false,cancelled=false,release!:()=>void;
 const fallback:DeepseekLlmClient={abort(){cancelled=true;release?.();},async streamChat(){started=true;await new Promise<void>(r=>release=r);}};
 const main:DeepseekLlmClient={abort(){},async streamChat(o){await Promise.resolve();assert.equal(started,true);o.onDelta('正常');o.onDone('正常');}};
 let text='';await (createRaceLlmClient as any)(()=>main,()=>fallback,gate).streamChat({systemPrompt:'s',userText:'u',onDelta:(d:string)=>text+=d,onDone(){},onError:()=>assert.fail()});
 assert.equal(text,'正常');assert.equal(cancelled,true);assert.notEqual(gate.snapshot().state,'half_open');
});
