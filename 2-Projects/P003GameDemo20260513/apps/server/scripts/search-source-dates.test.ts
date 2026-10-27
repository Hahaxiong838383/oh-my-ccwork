import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchExecutor } from '../src/tools/search-executor.js';

const stream=(delta:object,finish_reason:string)=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\ndata: [DONE]\n\n');
async function scenario(query:string, claim:string, publication='2026-09-15T00:00:00Z') {
  let planning=0;
  const executor=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],tools:true,grounding:true,
    fetch:(async(url:any,init:any)=>{
      const body=JSON.parse(init.body);
      if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://example.org/release',title:'合成游戏正式版公告',summary:'蓝星游戏正式版增加了滑翔玩法。',snippet:'蓝星游戏正式版增加了滑翔玩法。',date:publication}]});
      if(body.tools){
        if(planning++)return stream({content:''},'stop');
        return stream({tool_calls:[{index:0,id:'c',type:'function',function:{name:'search_web',arguments:JSON.stringify({query})}}]},'tool_calls');
      }
      const facts=body.messages.map((m:any)=>{try{return JSON.parse(m.content).facts;}catch{return undefined;}}).filter(Boolean).at(-1);
      assert.ok(facts.some((f:any)=>/发布日期.*2026年9月15日/.test(f.quote)),'source publication metadata must be available as a separate citable fact');
      return stream({content:JSON.stringify({abstain:false,claims:[{text:claim,fact_ids:facts.map((f:any)=>f.id)}]})},'stop');
    })as typeof fetch});
  return executor.run(query,AbortSignal.timeout(2000),'');
}

test('P2 can cite publication metadata without inventing an event date',async()=>{
  const r=await scenario('查蓝星游戏正式版公告的发布日期和新玩法','这份公告标注的发布日期是2026年9月15日，增加了滑翔玩法。');
  assert.equal(r.sources.length,1);
  assert.match(r.text,/2026年9月15日/);
});

test('a latest-release question can describe an older official release with an explicit freshness limit',async()=>{
  const r=await scenario('查蓝星游戏最新正式版本更新了什么','我查到的正式版公告介绍了滑翔玩法。');
  assert.equal(r.sources.length,1);
  assert.match(r.text,/是否为最新版本.*不能确认/);
});

test('older catalog evidence cannot support an unqualified latest-version assertion',async()=>{
  await assert.rejects(scenario('查蓝星游戏最新正式版本更新了什么','最新版本增加了滑翔玩法。'),/invalid_answer/);
});
