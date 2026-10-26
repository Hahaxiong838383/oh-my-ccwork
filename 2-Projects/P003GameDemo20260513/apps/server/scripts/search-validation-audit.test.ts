import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchExecutor} from '../src/tools/search-executor.js';
function run(replies:unknown[],query='月亮为什么会发光') {
 const audit:unknown[]=[];let calls=0;
 const executor=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],grounding:true,
  validationAudit:(v:unknown)=>audit.push(v),
  fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://example.org/a',title:'合成资料',summary:'月亮反射太阳的光。',snippet:'月亮反射太阳的光。',date:null}]});
   const reply=replies[Math.min(calls++,replies.length-1)];const content=typeof reply==='string'?reply:JSON.stringify(reply);
   return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
 return{audit,get calls(){return calls;},result:executor.run(query,AbortSignal.timeout(2000),'')};
}
const good={abstain:false,claims:[{text:'月亮反射太阳的光。',fact_ids:[1]}]};
test('validation audit distinguishes malformed draft and repair without retaining model text',async()=>{
 const r=run(['{"private":"synthetic-sensitive-marker"}',{abstain:false,claims:[{text:'合成正文',fact_ids:[99]}]}]);
 await assert.rejects(r.result,/invalid_grounding/);assert.equal(r.calls,2);
 assert.deepEqual(r.audit,[{phase:'draft',codes:['schema']},{phase:'repair',codes:['fact_reference']}]);
 assert(!JSON.stringify(r.audit).includes('synthetic-sensitive-marker'));assert(!JSON.stringify(r.audit).includes('合成正文'));
});
test('valid draft survives an unsupported numeric review with a safe specific diagnostic',async()=>{
 const r=run([good,{abstain:false,claims:[{text:'月亮每年反射2次太阳的光。',fact_ids:[1]}]}]);
 assert.equal((await r.result).text,'月亮反射太阳的光。');assert.equal(r.calls,2);
 assert.deepEqual(r.audit,[{phase:'review',codes:['unquoted_number']}]);
});
test('length and prohibited output are distinct, bounded diagnostics',async()=>{
 for(const[text,code]of [['光'.repeat(151),'answer_length'],['http://example.org/private?token=synthetic','unsafe_text']]as const){
  const r=run([{abstain:false,claims:[{text,fact_ids:[1]}]}]);await assert.rejects(r.result,/invalid_answer/);
  assert.deepEqual(r.audit,[{phase:'draft',codes:[code]},{phase:'repair',codes:[code]}]);
 }
});
test('JSON parse failure is reported without the parser exception or source contents',async()=>{
 const r=run(['{ "sensitive-marker":',good]);assert.equal((await r.result).text,'月亮反射太阳的光。');
 assert.deepEqual(r.audit,[{phase:'draft',codes:['json']}]);assert.equal(r.calls,2);
});
