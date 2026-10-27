import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SearchExecutor} from '../src/tools/search-executor.js';
const stream=(delta:object,finish_reason:string)=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\ndata: [DONE]\n\n');

for(const fetched of [false,true])test(`P2 answer and reviewer know evidence is ${fetched?'a fetched excerpt':'a search summary after Fetch failure'}`,async()=>{
  let plans=0,answers=0;const coverage:unknown[]=[];const query='查星河游戏草床有什么用';
  const expected=fetched?'草床只能使用一次。':'草床可以睡过夜晚。';
  const ex=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],tools:true,grounding:true,fetch:(async(url:any,init:any)=>{
    const body=JSON.parse(init.body);
    if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://example.org/game',title:'草床介绍',summary:'草床可以睡过夜晚。',snippet:'草床介绍',date:null}]});
    if(String(url).endsWith('/fetch'))return fetched?Response.json({content:'草床只能使用一次。'}):new Response('',{status:404});
    if(body.tools)return plans++===0
      ?stream({tool_calls:[{index:0,id:'s',type:'function',function:{name:'search_web',arguments:JSON.stringify({query})}}]},'tool_calls')
      :stream({tool_calls:[{index:0,id:'f',type:'function',function:{name:'fetch_page',arguments:JSON.stringify({url:'https://example.org/game'})}}]},'tool_calls');
    answers++;const payload=JSON.parse(body.messages.at(-1).content);
    coverage.push(payload.sources[0].coverage);
    const fact=payload.facts.find((f:any)=>f.quote===expected);assert.ok(fact,'Fetch failure preserves the summary; success supplies the fetched passage');
    return stream({content:JSON.stringify({abstain:false,claims:[{text:expected,fact_ids:[fact.id]}]})},'stop');
  })as typeof fetch});
  assert.equal((await ex.run(query,AbortSignal.timeout(2000),'')).text,expected);
  assert.equal(answers,2,'both drafting and review must receive the coverage metadata');
  assert.deepEqual(coverage,Array(2).fill(fetched?'fetched_excerpt':'search_summary'));
});
