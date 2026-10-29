import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SearchExecutor} from '../src/tools/search-executor.js';
import {runSearchFallback} from '../src/tools/search-simple-fallback.js';

const stream=(text:string)=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
async function scenario(query:string,profile:'p1'|'p2',claim='公告介绍了滑翔玩法。'){
 let searches=0,tools=0;const audits:any[]=[];
 const executor=new SearchExecutor({apiKey:'synthetic',domains:['example.org'],tools:false,profile,grounding:true,audit:s=>audits.push(s),
  fetch:(async(url:any,init:any)=>{
   const body=JSON.parse(init.body);
   if(body.tools)tools++;
   if(String(url).endsWith('/search')){searches++;return Response.json({results:[{url:'https://example.org/release',title:'蓝星游戏正式版本公告',summary:'正式版本增加了滑翔玩法。',snippet:'正式版本增加了滑翔玩法。',date:new Date(Date.now()-30*86400000).toISOString()}]});}
   const facts=body.messages.flatMap((m:any)=>{try{return JSON.parse(m.content).facts??[];}catch{return[];}});
   const fact=facts.find((f:any)=>f.quote==='正式版本增加了滑翔玩法。');assert.ok(fact);
   return stream(JSON.stringify({abstain:false,claims:[{text:claim,fact_ids:[fact.id]}]}));
  })as typeof fetch});
 const result=await runSearchFallback({signal:AbortSignal.timeout(2000),primary:async()=>{throw Error('invalid_answer');},fallback:s=>executor.run(query,s,'')});
 return {result,audits,searches,tools};
}
test('P2 fallback retains older catalog evidence with a freshness caveat and no Tool Calls',async()=>{
 const r=await scenario('查蓝星游戏最近的正式更新','p2');
 assert.equal(r.result.sources.length,1);assert.match(r.result.text,/滑翔/);assert.match(r.result.text,/是否为最新版本.*不能确认/);
 assert.equal(r.searches,1);assert.equal(r.tools,0);assert.equal(r.audits[0].rejected_date,0);
});
test('P1 keeps its previous date policy',async()=>{
 const r=await scenario('查蓝星游戏最近的正式更新','p1');assert.equal(r.result.sources.length,0);assert.equal(r.audits[0].rejected_date,1);
});
test('P2 fallback still rejects old news and unsupported numbers',async()=>{
 const news=await scenario('查今天的科技新闻','p2');assert.equal(news.result.sources.length,0);assert.equal(news.audits[0].rejected_date,1);
 const madeUp=await scenario('查蓝星游戏最近的正式更新','p2','正式版本增加了99个新玩法。');assert.equal(madeUp.result.sources.length,0);
});
test('repeated unverified freshness degrades to an attributed source title, never a model claim',async()=>{
 const r=await scenario('查蓝星游戏最近的正式更新','p2','当前最新版本增加了滑翔玩法。');
 assert.equal(r.result.sources.length,1);assert.match(r.result.text,/来源页面标题.*蓝星游戏正式版本公告/);
 assert.match(r.result.text,/是否为最新版本.*不能确认/);assert.doesNotMatch(r.result.text,/增加了滑翔|当前最新版本/);
 assert.equal(r.result.diagnostics?.catalog_title_fallback,true);
});
