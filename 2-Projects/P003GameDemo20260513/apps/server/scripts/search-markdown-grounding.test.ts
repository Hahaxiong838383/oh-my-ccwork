import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchExecutor } from '../src/tools/search-executor.js';

async function run(version:string, quote=String.raw`蓝星游戏正式版26\.50增加了滑翔玩法。`,text=`蓝星游戏正式版${version}增加了滑翔玩法。`){
  const executor=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],grounding:true,
    fetch:(async(url:any)=>{
      if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://example.org/release',title:'合成更新说明',summary:quote,snippet:quote,date:null}]});
      const content=JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]});
      return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    })as typeof fetch});
  return executor.run('查蓝星游戏正式版的滑翔玩法',AbortSignal.timeout(2000),'');
}

test('Markdown-escaped decimal punctuation does not reject a supported version; raw quote remains unchanged',async()=>{
  const result=await run('26.50');
  assert.match(result.text,/26\.50/);
  assert.match(result.grounding!.claims[0].evidence[0].quote,/26\\\.50/);
});

test('normalizing Markdown punctuation does not authorize a different version',async()=>{
  await assert.rejects(run('26.60'),/invalid_grounding/);
});

test('an explicit English use count may be translated, but not increased',async()=>{
  const quote='The cushion can only be used once and is destroyed after use.';
  assert.match((await run('',quote,'这个垫子只能用一次，用完就会损坏。')).text,/一次/);
  await assert.rejects(run('',quote,'这个垫子能用两次，用完就会损坏。'),/invalid_grounding/);
});

test('a spacecraft crew designator retains its number when the name is expanded',async()=>{
  const quote='神二十三乘组继续开展科学实验。';
  assert.match((await run('',quote,'神舟二十三号乘组继续开展科学实验。')).text,/二十三号/);
  await assert.rejects(run('',quote,'神舟二十四号乘组继续开展科学实验。'),/invalid_grounding/);
});
