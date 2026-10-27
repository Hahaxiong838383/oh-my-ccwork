import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SearchTasks,validateQuery} from '../src/tools/search-tasks.js';
import {p2SourceScope} from '../src/tools/search-source-scope.js';
import {SearchExecutor} from '../src/tools/search-executor.js';

test('R20 public game title includes locative particles without hiding personal data',()=>{
 for(const q of ['我的世界里红石中继器主要有什么用','我的世界里的红石怎么玩','我的世界中村民有什么用'])assert.equal(validateQuery(q),q);
 for(const q of ['我的世界观是什么','我的世界里的人是谁','我的世界里的红石和我的密码','我的世界里同学的电话'])assert.throws(()=>validateQuery(q),/private_query/);
});
test('R20 empty CCTV index falls through once in P2, while P1 keeps its provider contract',async()=>{
 for(const tools of [true,false]){
  let searches=0,pages=0,plans=0;
  const sse=(delta:object,finish_reason:string)=>new Response('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\ndata: [DONE]\n\n');
  const x=new SearchExecutor({apiKey:'synthetic',domains:['cctv.com','xinhuanet.com'],tools,fetch:(async(url,init)=>{
   if(String(url).includes('news.cctv.com')){pages++;return new Response('china({"data":{"list":[]}})');}
   if(String(url).endsWith('/search')){searches++;return Response.json({results:[]});}
   if(plans++)return sse({content:''},'stop');
   return sse({tool_calls:[{index:0,id:'s',type:'function',function:{name:'search_web',arguments:JSON.stringify({query:'最近中国航天新闻'})}}]},'tool_calls');
  })as typeof fetch});
  await x.run('最近中国航天新闻',AbortSignal.timeout(1000),'');
  assert.equal(pages,2);assert.equal(searches,tools?1:0);
 }
});
test('R20 closed sessions cannot read facts; only a current authorized resume grant can',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r20-resume-'));let scope='a:1';
 const owner={subject:'BJP00399999999999901',session:'sn-BJP00399999999999901-1'},next={...owner,session:'sn-BJP00399999999999901-2'};
 const tasks=new SearchTasks({dbPath:join(dir,'task.db'),enabled:()=>true,allowed:()=>true,resumeEnabled:()=>true,resumeScope:()=>scope,execute:async()=>({text:'恐龙灭绝与环境巨变有关。',sources:[{title:'科普',url:'https://cas.cn/dino',date:null}]})});
 try{
  const t=tasks.submit(owner,{turn:'r20',query:'恐龙灭绝原因',protocol:1,phase:'committed'});await new Promise(r=>setImmediate(r));tasks.closeSession(owner);
  assert.equal(tasks.dialogueAnswer(owner,t.id,1),'');
  const grant=tasks.resumeLatest(next,'r20-resume').grant;
  assert.equal(tasks.dialogueAnswer(next,t.id,1,grant),'恐龙灭绝与环境巨变有关。');
  assert.equal(tasks.dialogueAnswer({...next,subject:'BJP00399999999999902'},t.id,1,grant),'');
  scope='a:2';assert.equal(tasks.dialogueAnswer(next,t.id,1,grant),'');scope='a:1';
  tasks.resumeCancel(next);assert.equal(tasks.dialogueAnswer(next,t.id,1,grant),'');
 }finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('R20 music and long source lists retain a bounded relevant site clause',()=>{
 const domains=['weather.com.cn','gov.cn','people.com.cn','xinhuanet.com','cas.cn','cctv.com','chnmuseum.cn','dpm.org.cn','minecraft.net','mc.163.com','pokemon.cn','pokemon.com.cn','bwf.sport','bwfbadminton.com','olympics.com','kepuchina.cn','baike.baidu.com','zh.wikipedia.org','y.qq.com','minecraft.wiki'];
 const q=p2SourceScope('大鱼海棠里大鱼是谁唱的',domains);
 assert.match(q,/site:y.qq.com/);assert.ok([...q].length<=128);assert.doesNotMatch(q,/site:weather/);
 const generic=p2SourceScope('查一份关于深海发光动物为什么会发光以及光对它们有什么作用的公开资料',domains);
 assert.match(generic,/site:/);assert.ok([...generic].length<=128);
 assert.doesNotMatch(p2SourceScope('大鱼是谁唱的',['example.org']),/y.qq.com/);
});
test('R20 follow-up answer is memory-only, claimed, bound, temporary and revoked',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r20-followup-'));let now=1000;let enabled=true;
 const owner={subject:'BJP00399999999999901',session:'sn-BJP00399999999999901-1'};
 const tasks=new SearchTasks({dbPath:join(dir,'task.db'),now:()=>now,enabled:()=>enabled,allowed:s=>s===owner.subject,execute:async()=>({text:'双打发球不能超过双打后发球线。',sources:[{title:'规则',url:'https://bwfbadminton.com/rules',date:null}]})});
 try{
  const t=tasks.submit(owner,{turn:'r20',query:'羽毛球双打后发球线',protocol:1,phase:'committed'});await new Promise(r=>setImmediate(r));
  assert.equal(tasks.dialogueAnswer(owner,t.id,1),'');
  tasks.claim(owner,t.id,'delivery');tasks.receipt(owner,t.id,'delivery','completed');
  assert.equal(tasks.dialogueAnswer(owner,t.id,1),'双打发球不能超过双打后发球线。');
  assert.equal(tasks.dialogueAnswer({...owner,subject:'BJP00399999999999902'},t.id,1),'');
  assert.equal(tasks.dialogueAnswer({...owner,session:owner.session+'2'},t.id,1),'');
  assert.equal(tasks.dialogueAnswer(owner,t.id,2),'');
  enabled=false;assert.equal(tasks.dialogueAnswer(owner,t.id,1),'');enabled=true;
  now+=300001;assert.equal(tasks.dialogueAnswer(owner,t.id,1),'');now=1000;
  tasks.cancel(owner,t.id);assert.equal(tasks.dialogueAnswer(owner,t.id,1),'');
 }finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});
