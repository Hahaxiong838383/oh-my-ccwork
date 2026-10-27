import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchExecutor } from '../src/tools/search-executor.js';

const stream=(delta:object,finish_reason:string)=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\ndata: [DONE]\n\n');
async function run(version:string, tools=true){
  let plans=0,fetches=0;
  const query='查星河游戏最新正式版本更新了什么';
  const executor=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],tools,grounding:true,
    fetch:(async(url:any,init:any)=>{
      const body=JSON.parse(init.body);
      if(String(url).endsWith('/search'))return Response.json({results:[
        {url:'https://example.org/old',title:'星河游戏 基岩版 26.40 更新公告',summary:'草床能睡过夜晚，只能用一次。',snippet:'草床只能用一次。',date:new Date().toISOString()},
        {url:'https://example.org/new',title:'星河游戏 基岩版 26.50 更新公告',summary:'修复了云朵显示问题。',snippet:'修复云朵。',date:null},
      ]});
      if(String(url).endsWith('/fetch')){fetches++;return Response.json({error:{code:'not_found'}},{status:404});}
      if(body.tools)return plans++===0
        ?stream({tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_web',arguments:JSON.stringify({query})}}]},'tool_calls')
        :stream({tool_calls:[{index:0,id:'fetch',type:'function',function:{name:'fetch_page',arguments:JSON.stringify({url:'https://example.org/old'})}}]},'tool_calls');
      const tables=body.messages.flatMap((m:any)=>{try{const v=JSON.parse(m.content);return v.facts?[v.facts]:[];}catch{return[];}});
      const facts=tables.at(-1);const fact=facts.find((f:any)=>f.source_id===1&&f.quote==='草床能睡过夜晚，只能用一次。');
      assert.ok(fact,'use the original body fact, not a fabricated source');
      return stream({content:JSON.stringify({abstain:false,claims:[{text:`${version}更新有草床，能睡过夜晚，只能用一次。`,fact_ids:[fact.id]}]})},'stop');
    })as typeof fetch});
  const result=await executor.run(query,AbortSignal.timeout(2000),'');return {result,fetches};
}

test('P2 preserves a supported release answer after Fetch failure with the same source title explicitly cited',async()=>{
  const {result,fetches}=await run('26.40');assert.equal(fetches,1);
  assert.match(result.text,/26\.40更新有草床/);assert.match(result.text,/不能确认/);
  const evidence=result.grounding!.claims[0].evidence;
  assert.ok(evidence.some(e=>e.quote==='草床能睡过夜晚，只能用一次。'));
  assert.ok(evidence.some(e=>e.source_id===1&&e.quote==='来源页面标题：星河游戏 基岩版 26.40 更新公告'));
});

test('a version from another search result cannot support the selected body facts',async()=>{
  await assert.rejects(run('26.50'),/invalid_grounding/);
});

test('a fabricated release version is still rejected',async()=>{
  await assert.rejects(run('26.99'),/invalid_grounding/);
});

test('P1 does not acquire the P2 catalog source-context behavior',async()=>{
  await assert.rejects(run('26.40',false),/invalid_grounding/);
});
