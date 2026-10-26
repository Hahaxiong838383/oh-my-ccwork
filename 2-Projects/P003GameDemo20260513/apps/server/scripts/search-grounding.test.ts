import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchExecutor} from '../src/tools/search-executor.js';
const source='小叶闭合与复叶叶柄下垂分别发生在不同部位的叶枕。受到刺激后，细胞水分变化使叶枕发生运动。';
const answer='含羞草受刺激后，叶子基部细胞的水分发生变化，带动小叶合起来。';
const claim={text:answer,fact_ids:[1,2]};
function executor(reply:object){let calls=0;return {get calls(){return calls;},run:new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
 if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/science',title:'含羞草叶枕运动',summary:source,snippet:source,date:null}]});
 calls++;return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(reply)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
})as typeof fetch})};}
test('R16 supported clauses retain exact source excerpts and use bounded existing review',async()=>{
 const e=executor({abstain:false,claims:[claim]});
 const result=await e.run.run('含羞草为什么合叶',AbortSignal.timeout(2000),'');
 assert.equal(e.calls,2);assert.equal(result.text,answer);
 assert.equal(result.grounding?.version,2);assert.equal(result.grounding?.claims[0].text,answer);assert.equal(result.grounding?.claims[0].evidence.map(e=>e.quote).join(''),source);
});
test('R16 links alone, invented excerpts and unaccounted clauses never count as grounded answers',async()=>{
 for(const reply of [
  {text:answer,source_ids:[1]},
  {abstain:false,claims:[{...claim,quote:'invented quotation'}]},
  {abstain:false,text:answer+'这是上部细胞失水。',claims:[claim]},
  {abstain:false,claims:[{...claim,fact_ids:[99]}]},
  {abstain:false,claims:[{...claim,fact_ids:[]}]},
 ]) {const e=executor(reply);await assert.rejects(e.run.run('含羞草为什么合叶',AbortSignal.timeout(2000),''),/invalid_grounding/);assert.equal(e.calls,2);}
});
test('R16 same-source quotes cannot justify extra numbers, anatomy or causal details',async()=>{
 for(const c of [
  {query:'中国第一颗人造卫星叫什么',quote:'1970年4月24日，我国用长征一号运载火箭成功发射第一颗人造卫星东方红一号。',bad:'它叫东方红一号，1970年4月24日发射。',good:'它叫东方红一号。'},
  {query:'含羞草为什么合叶',quote:'叶枕上部的细胞受刺激失水，细胞组织变软，所以出现叶子收拢。',bad:'叶柄基部的叶枕上部细胞失水，叶子合拢。',good:'叶子基部的细胞水分发生变化，叶子就合起来。'},
  {query:'国博预约方式',quote:'官方预约渠道是国家博物馆官网、微信小程序和微信服务号。',bad:'通过官网免费预约，最多提前7天，每天17点放票。',good:'可以通过国家博物馆官网、微信小程序或微信服务号预约。'},
 ]){
  let calls=0;
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any,init:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'资料',summary:c.quote,snippet:c.quote,date:null}]});
   calls++;const text=calls===1?c.bad:c.good;
   if(calls===2)assert.match(JSON.parse(init.body).messages.at(-1).content,/grounding_issues/);
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  const r=await e.run(c.query,AbortSignal.timeout(2000),'');assert(r.text.startsWith(c.good));assert.equal(calls,2);
 }
});

test('R16 malformed first draft can use the single remaining answer budget',async()=>{
 let calls=0,searches=0;
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search')){searches++;return Response.json({results:[{url:'https://cstm.org.cn/a',title:'资料',summary:source,snippet:source,date:null}]});}
  calls++;const content=calls===1?'invalid json':JSON.stringify({abstain:false,claims:[claim]});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 const r=await e.run('含羞草为什么合叶',AbortSignal.timeout(2000),'');assert.equal(r.text,answer);assert.equal(calls,2);assert.equal(searches,1);
});

test('R16 supported direction is valid; invented neighbouring organ is not',async()=>{
 const quote='含羞草在叶子下端有叶枕。受到刺激后，叶枕上部的细胞失水变软，使叶子合拢。';
 for(const [text,valid]of [
  ['含羞草叶子下端有叶枕，受刺激后上部细胞失水变软，叶子就合拢了。',true],
  ['含羞草叶柄基部的上部细胞失水变软，叶子就合拢了。',false],
 ]as const){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'资料',summary:quote,snippet:quote,date:null}]});
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1,2]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  if(valid)assert.equal((await e.run('含羞草为什么合叶',AbortSignal.timeout(2000),'')).text,text);
  else await assert.rejects(e.run('含羞草为什么合叶',AbortSignal.timeout(2000),''),/invalid_grounding/);
 }
});

test('R16 venue clauses can cite all bounded facts and normalize explicit afternoon times',async()=>{
 const quote='旺季4月1日至10月31日。8:30开始入馆。16:00停止入馆。17:00闭馆。除法定节假日外周一闭馆。';
 for(const [text,valid]of [
  ['4月1日到10月31日早上8点半可入馆，下午4点停止入馆，下午5点闭馆，除法定节假日外周一闭馆。',true],
  ['4月1日到10月31日早上8点可入馆，下午4点停止入馆，下午5点闭馆，除法定节假日外周一闭馆。',false],
 ]as const){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'开放安排',summary:quote,snippet:quote,date:null}]});
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1,2,3,4,5]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  if(valid)assert((await e.run('开放时间',AbortSignal.timeout(2000),'')).text.startsWith(text));
  else await assert.rejects(e.run('开放时间',AbortSignal.timeout(2000),''),/invalid_grounding/);
 }
});

test('R16 rejects a review that adds unsupported quantities without discarding a valid original',async()=>{
 let calls=0;
 const original='月亮和太阳的引力让海水涨落，这就是潮汐。';
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'潮汐',summary:original,snippet:original,date:null}]});
  calls++;const text=calls===1?original:original+'每天一定涨落两次。';
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 const r=await e.run('潮汐怎么形成',AbortSignal.timeout(2000),'');assert.equal(r.text,original);assert.equal(calls,2);assert.equal((r.diagnostics as any).answer_review_rejected,true);
});

test('R16 a sourced reference to these two events is not an unasked frequency',async()=>{
 const quote='这两次灾难都会释放出灰尘，造成降温，并释放温室气体，造成长期变暖。';
 const text='这两次灾难都会扬起灰尘，让气温下降，还会释放温室气体，让地球长期变暖。';
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'灾难',summary:quote,snippet:quote,date:null}]});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 assert.equal((await e.run('恐龙为什么灭绝',AbortSignal.timeout(2000),'')).text,text);
});

test('R16 paraphrases may say climate and half-part without inventing scope',async()=>{
 for(const c of [
  {quote:'灰尘造成降温，温室气体造成长期变暖。',text:'灰尘和温室气体让气候发生变化。'},
  {quote:'受到刺激后，上部细胞失水变软，而下半部保持不变，叶子收拢。',text:'受到刺激后，上半部细胞失水变软，下部不变，叶子合拢。'},
 ]){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'原理',summary:c.quote,snippet:c.quote,date:null}]});
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text:c.text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  assert.equal((await e.run('为什么会这样',AbortSignal.timeout(2000),'')).text,c.text);
 }
});

test('R16 age limits retain explicit inclusion at the boundary',async()=>{
 const quote='未满14周岁（含）的未成年人须由成年人代为预约。';
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'预约',summary:quote,snippet:quote,date:null}]});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text:'不满14岁的孩子要大人代为预约。',fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 await assert.rejects(e.run('预约方式',AbortSignal.timeout(2000),''),/invalid_grounding/);
});

test('R16 clock evidence accepts Chinese hours and rejects omitted closing-day exceptions',async()=>{
 for(const c of [
  {query:'今天新闻',quote:'截至10月26日08时00分，共记录到余震2054次。',text:'截至10月26日早上8点，已记录余震2054次。',valid:true},
  {query:'开放时间',quote:"Closed on Mondays (except national holidays), Chinese Lunar New Year's Eve, as well as the first day and the second day of Chinese New Year.",text:'周一闭馆，法定节假日除外。',valid:true,normalized:true},
  {query:'开放时间',quote:"Closed on Mondays (except national holidays), Chinese Lunar New Year's Eve, as well as the first day and the second day of Chinese New Year.",text:'周一闭馆，但法定节假日、除夕、农历正月初一和初二除外。',valid:true,normalized:true},
  {query:'开放时间',quote:"Tuesday to Sunday 9:30-17:00. Closed on Mondays (except national holidays), Chinese Lunar New Year's Eve, as well as the first day and the second day of Chinese New Year.",text:'周一闭馆，但国家法定假日、除夕、农历正月初一和初二除外。',valid:true,normalized:true},
  {query:'开放时间',quote:"Closed on Mondays (except national holidays), Chinese Lunar New Year's Eve, as well as the first day and the second day of Chinese New Year.",text:'周一闭馆，法定节假日除外，除夕、农历正月初一和初二也闭馆。',valid:true},
 ]){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'来源',summary:c.quote,snippet:c.quote,date:new Date().toISOString()}]});
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text:c.text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  if(c.normalized)assert((await e.run(c.query,AbortSignal.timeout(2000),'')).text.startsWith('周一闭馆，国家法定节假日除外。除夕、农历正月初一、农历正月初二也闭馆。'));
  else if(c.valid)assert((await e.run(c.query,AbortSignal.timeout(2000),'')).text.startsWith(c.text));
  else await assert.rejects(e.run(c.query,AbortSignal.timeout(2000),''),/invalid_grounding/);
 }
});

test('R16 a cited quantity is a simplification hint, not a reason to lose the entire answer',async()=>{
 const text='恐龙大约在6600万年前灭绝，可能与火山爆发和小行星撞击有关。';
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'原理',summary:text,snippet:text,date:null}]});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 assert.equal((await e.run('恐龙为什么灭绝',AbortSignal.timeout(2000),'')).text,text);
});

test('R16 age-bounded adult booking cannot become an unqualified rule for all children',async()=>{
 const quote='未满14周岁（含）的未成年人，须由成年人代为预约，并与预约人同步核验入馆。';
 for(const text of ['小孩要大人帮忙约。','小朋友由大人代约。','未成年人需要成年人代为预约。']){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
   if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'预约',summary:quote,snippet:quote,date:null}]});
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text,fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  })as typeof fetch});
  await assert.rejects(e.run('预约方式',AbortSignal.timeout(2000),''),/invalid_grounding/);
 }
});


test('R16 a simple causal explanation must share a supporting source across its claims',async()=>{
 let calls=0;
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any,init:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[
   {url:'https://cstm.org.cn/a',title:'结构',summary:'叶柄和小叶基部都有叶枕。',snippet:'叶柄和小叶基部都有叶枕。',date:null},
   {url:'https://cstm.org.cn/b',title:'闭合',summary:'叶子下端的叶枕受到刺激后细胞水分改变，叶子合起来。',snippet:'叶子下端的叶枕受到刺激后细胞水分改变，叶子合起来。',date:null},
  ]});
  calls++;
  if(calls===2)assert.match(JSON.parse(init.body).messages.at(-1).content,/causal_source_scope/);
  const claims=calls===1?[{text:'叶柄和小叶基部有叶枕。',fact_ids:[1]},{text:'受到刺激后细胞水分改变，叶子合起来。',fact_ids:[2]}]:[{text:'叶子下端的叶枕受刺激，细胞水分改变，叶子就合起来。',fact_ids:[2]}];
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 const r=await e.run('含羞草为什么会合叶',AbortSignal.timeout(2000),'');assert.equal(calls,2);assert.equal(r.sources.length,1);assert.equal(r.sources[0].url,'https://cstm.org.cn/b');
});


test('R16 a common explanatory source may retain corroboration from a second source',async()=>{
 let calls=0;
 const a='光在水滴里拐弯，形成彩虹。';const b='光在水滴里拐弯。不同颜色拐弯程度不同，颜色分开。';
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],grounding:true,fetch:(async(url:any)=>{
  if(String(url).endsWith('/search'))return Response.json({results:[{url:'https://cstm.org.cn/a',title:'资料甲',summary:a,snippet:a,date:null},{url:'https://cstm.org.cn/b',title:'资料乙',summary:b,snippet:b,date:null}]});
  calls++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({abstain:false,claims:[{text:'光在水滴里拐弯。',fact_ids:[1,2]},{text:'不同颜色拐弯程度不同，颜色分开。',fact_ids:[3]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 })as typeof fetch});
 const r=await e.run('彩虹为什么有不同颜色',AbortSignal.timeout(2000),'');assert.equal(calls,2);assert.equal(r.sources.length,2);
});
