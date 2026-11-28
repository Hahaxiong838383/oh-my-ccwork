// Runs the staged service and all SQLite stores in a disposable directory, with no network provider.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {DiagnosticSessions} from '../personal-admin/diagnostics.ts';

const dir=mkdtempSync(join(tmpdir(),'owner-console-test-'));
const worker=randomBytes(32).toString('hex'), ownerKey=randomBytes(32).toString('hex');
const keyPath=join(dir,'key');
writeFileSync(keyPath,ownerKey,{mode:0o600});
Object.assign(process.env,{BRAIN_DATA_DIR:dir,BRAIN_OWNER_ID:'test-owner',BRAIN_WORKER_KEY:worker,
  BRAIN_CONSOLE_KEY_FILE:keyPath,BRAIN_UPSTREAM_BASE_URL:'https://model.invalid/v1',
  BRAIN_DEEPSEEK_SEARCH_KEY:'fixture',BRAIN_UPSTREAM_API_KEY:'fixture',BRAIN_UPSTREAM_MODEL:'sample',BRAIN_CPA_WEB_SEARCH:'0'});
const request=globalThis.fetch;
const listen=Server.prototype.listen;
let server,profile,search;
Server.prototype.listen=function (_port,...args){server=this;return listen.call(this,0,'127.0.0.1',...args.slice(1));};
const INDEX_NAMES=[['sh000001', 'c9cfd6a4d6b8cafd'], ['sz399001', 'c9eed6a4b3c9d6b8'], ['sz399006', 'b4b4d2b5b0e5d6b8']];
const prompts=[];
let publicAccess=0;
globalThis.fetch=async (url,init)=>{
  if(new URL(url).hostname==='qt.gtimg.cn') {
    // Tencent encodes these three market names in GB18030.
    const stamp=new Date(Date.now()+8*3_600_000).toISOString().replace(/[-:T]/g,'').slice(0,14);
    const chunks=[];
    for (const [id,name] of INDEX_NAMES) {
      const fields=Array(33).fill('');fields[2]=id.slice(2);fields[3]='3000';fields[30]=stamp;fields[32]='1';
      chunks.push(Buffer.from('v_'+id+'="~'),Buffer.from(name,'hex'),Buffer.from('~'+fields.slice(2).join('~')+'";'));
    }
    return new Response(Buffer.concat(chunks));
  }
  if(new URL(url).hostname!=='model.invalid'){publicAccess++;throw Error('unexpected_public_request');}
  const body=JSON.parse(init.body);
  if(body.stream===false) return Response.json({choices:[{message:{content:'{}'}}]});
  prompts.push(body.messages[0].content);
  const text='从前有一片云朵，太阳给它画了张脸。';
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
};
try {
  await import(pathToFileURL(resolve(process.argv[2])).href);
  while(!server?.listening) await delay(5);
  const base='http://127.0.0.1:'+server.address().port;
  const call=async (path,method='GET',body=undefined,key=ownerKey,status=200)=>{
    const r=await request(base+'/internal/console'+path,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const json=await r.json();
    assert.equal(r.status,status,path+' '+JSON.stringify(json));
    return json;
  };
  const say=async (q,room='pv-'+'1'.repeat(32),store=true)=>{
    const r=await request(base+'/v1/chat/completions?room='+room,{method:'POST',headers:{authorization:'Bearer '+worker,'content-type':'application/json'},
      body:JSON.stringify({store,messages:[{role:'user',content:q}]})});
    const v=await r.json();assert.equal(r.status,200);return v.choices[0].message.content;
  };
  await call('/overview','GET',undefined,worker,401);
  await call('/memories','POST',{text:'记住，我喜欢蒸饺'},worker,401);
  await call('/growth','GET',undefined,'',401);
  const initial=await call('/overview');assert.equal(initial.memoryCount,0);assert.equal(initial.traits.length,5);
  await call('/memories','POST',{text:'记住，我的暗号是青松'});
  assert.match(await say('我的暗号是什么？'),/青松/);
  let row=(await call('/memories')).items[0];assert.equal(row.topic,'暗号');assert.equal(row.value,'青松');assert.match(row.source,/青松/);
  await call('/memories/'+row.id,'PUT',{expected:'错误的',value:'白帆'},ownerKey,409);
  await call('/memories/'+row.id,'PUT',{expected:'青松',value:'白帆'});
  assert.match(await say('我的暗号是什么？','new-room'),/白帆/);
  row=(await call('/memories')).items[0];
  await call('/memories/'+row.id,'DELETE',{expected:'白帆'});
  assert.match(await say('我的暗号是什么？','new-room'),/不记得/);
  await call('/memories','POST',{text:'记住，我的密码是123'},ownerKey,400);
  await call('/memories','POST',{text:'记住，我喜欢奶茶'});
  await call('/memories','POST',{text:'记住，我喜欢茶'});
  let prefs=(await call('/memories')).items;
  const tea=prefs.find(item=>item.topic==='茶');
  await call('/memories/'+tea.id,'DELETE',{expected:'喜欢'});
  assert.match(await say('我喜欢奶茶吗？','different-room'),/喜欢奶茶/);
  assert((await call('/memories')).items.some(item=>item.topic==='奶茶'));
  await call('/memories?limit=1000','GET',undefined,ownerKey,400);
  await call('/style','PUT',{style:'quiet',previous:'default'});
  assert.equal((await call('/overview')).style,'quiet');
  await say('聊聊书');
  assert.match(prompts.at(-1),/安静小可/);
  await call('/style','PUT',{style:'funny',previous:'default'},ownerKey,409);
  await call('/style','PUT',{style:'default',previous:'quiet'});
  const enabled=initial.tools;
  const disabled={search:false,weather:false,clock:false};
  const weatherRoom='pv-'+'3'.repeat(32);
  assert.match(await say('今天天气怎么样',weatherRoom),/哪个城市/);
  await call('/tools','PUT',{...disabled,previous:enabled});
  assert.deepEqual((await call('/overview')).tools,disabled);
  const toolPrompts=prompts.length;
  for (const [q,answer] of [['北京明天天气怎么样','天气查询'],['查一下国内新闻','联网搜索'],['现在几点了','时间查询'],['你能做什么','关闭']]){
    assert.match(await say(q),new RegExp(answer));
  }
  assert.match(await say('就看看北京的呗',weatherRoom),/关闭天气查询/);
  assert.match(await say('取消搜索',weatherRoom),/不继续查询/);
  assert.match(await say('你可以导航吗'),/关闭联网搜索/);
  assert.equal(prompts.length,toolPrompts);assert.equal(publicAccess,0);
  await call('/tools','PUT',{...enabled,previous:enabled},ownerKey,409);
  await call('/tools','PUT',{...enabled,previous:disabled});
  assert.doesNotMatch(await say('现在几点了'),/关闭/);
  const countBefore=(await call('/tools/history')).total;
  await say('现在几点了','temporary-room',false);
  const receipts=await call('/tools/history');
  assert.equal(receipts.total,countBefore);assert(receipts.items.some(i=>i.tool==='clock'&&i.outcome==='handled'&&i.turnMs>=0));
  assert.doesNotMatch(JSON.stringify(receipts),/青松|白帆/);
  profile=new DatabaseSync(join(dir,'profile.sqlite'));
  profile.prepare('INSERT INTO personal_memory_fact VALUES(?,?,?,?,?,?,?)').run('test-owner','fact','测试颜色','红','已经不存在','missing-source',Date.now());
  const orphan=(await call('/memories')).items.find(item=>item.topic==='测试颜色');
  assert.match(orphan.source,/未找到/);assert.match(await say('我的测试颜色是什么？'),/不记得/);
  await call('/memories/'+orphan.id,'DELETE',{expected:'红'});
  assert(!(await call('/memories')).items.some(item=>item.topic==='测试颜色'));
  search=new DatabaseSync(join(dir,'search.sqlite'));
  search.prepare('INSERT INTO tasks(id,dedupe,subject,session,created,body) VALUES(?,?,?,?,?,?)').run('sample','sample','test-owner','sample',100,JSON.stringify({status:'expired',outcome:'answered',readyAt:245,query:'never expose this query',result:{sources:[{url:'https://private.invalid'}]}}));
  let log=await call('/search');assert.equal(log.total,1);assert.equal(log.items[0].durationMs,145);assert.equal(log.items[0].sourceCount,1);assert.doesNotMatch(JSON.stringify(log),/never expose|private.invalid/);
  // The real console and brain share a transient room and conversational context. Only the model is stubbed.
  let now=Date.now();
  const diagnosticRequests=[];
  const diagnostics=new DiagnosticSessions(()=>({url:new URL(base+'/v1/chat/completions'),key:worker}),()=>now,(url,init)=>{
    diagnosticRequests.push({id:init.headers['X-Personal-Session'],body:JSON.parse(init.body)});
    return request(url,init);
  });
  const beforeDiag=await call('/overview');
  const toolsBeforeDiag=(await call('/tools/history')).total;
  assert.match((await diagnostics.ask('login-a','今天天气怎么样')).text,/哪个城市/);
  const firstDiag=diagnosticRequests.at(-1).id;
  await call('/tools','PUT',{...disabled,previous:enabled});
  assert.match((await diagnostics.ask('login-a','就看看北京的呗')).text,/关闭天气查询/);
  assert.equal(diagnosticRequests.at(-1).id,firstDiag);
  assert.deepEqual(diagnosticRequests.at(-1).body.messages.map(m=>m.role),['user','assistant','user']);
  assert.match((await diagnostics.ask('login-b','就看看北京的呗')).text,/云朵/);
  assert.notEqual(diagnosticRequests.at(-1).id,firstDiag);
  assert.equal(diagnosticRequests.at(-1).body.messages.length,1);
  assert.match((await diagnostics.ask('login-a','记住，我的邮筒是蓝色')).text,/不能修改长期记忆/);
  assert.match(await say('记住，我的邮筒是蓝色',firstDiag,true),/不能修改长期记忆/);
  assert.equal((await call('/tools/history')).total,toolsBeforeDiag);
  assert.equal((await call('/overview')).growthCount,beforeDiag.growthCount);
  assert.equal((await call('/overview')).memoryCount,beforeDiag.memoryCount);
  assert(!(await call('/activity')).items.some(x=>x.session===firstDiag));
  for (const [index,id] of ['admin-diagnostic-old',firstDiag].entries()) {
    const key='diagnostic-'+index;
    search.prepare('INSERT INTO tasks(id,dedupe,subject,session,created,body) VALUES(?,?,?,?,?,?)')
      .run(key,key,'test-owner',id,Date.now(),JSON.stringify({status:'ready',outcome:'answered'}));
  }
  assert.equal((await call('/overview')).searchStats.total,1);
  assert.deepEqual((await call('/search')).items.map(x=>x.id),['sample']);
  await call('/tools','PUT',{...enabled,previous:disabled});
  const market=await diagnostics.ask('login-a','查询A股今天的指数行情');
  assert.equal(market.sources.length,3);
  const replay=await diagnostics.ask('login-a','继续刚才的查询结果');
  assert.deepEqual(replay.sources,market.sources);assert.equal(replay.text,market.text);
  assert.equal((await call('/overview')).searchStats.total,1);
  assert.equal((await call('/search')).total,1);
  diagnostics.reset('login-a');
  assert.match((await diagnostics.ask('login-a','继续刚才的查询结果')).text,/没有可以接续/);
  const resetRoom=diagnosticRequests.at(-1);
  assert.notEqual(resetRoom.id,firstDiag);assert.equal(resetRoom.body.messages.length,1);
  now+=30*60_000;
  await diagnostics.ask('login-a','聊聊花');
  assert.notEqual(diagnosticRequests.at(-1).id,resetRoom.id);
  assert.equal(diagnosticRequests.at(-1).body.messages.length,1);
  assert(diagnosticRequests.every(r=>r.body.store===false));
  // Explicit positive feedback must create a prompt example that the owner can revoke.
  const room='pv-'+'2'.repeat(32);
  await say('请给我讲个故事。',room);await say('这种讲法我喜欢。',room);
  let events=(await call('/growth')).items;
  const example=events.find(e=>e.rule==='explicit_style_feedback'),trait=events.find(e=>e.rule==='explicit_story_feedback');
  assert(example?.revertible&&trait?.revertible);assert.match(example.source,/云朵/);
  await say('随便聊点什么吧',room);
  assert.match(prompts.at(-1),/过去有效的相处方式/);
  await call('/growth/'+example.id+'/revoke','POST',{});
  await call('/growth/'+example.id+'/revoke','POST',{});
  await say('继续闲聊',room);assert.doesNotMatch(prompts.at(-1),/过去有效的相处方式/);
  const t=+(await call('/overview')).traits.find(t=>t.key==='storytelling').value;
  assert(t>Number(trait.from));
  await call('/growth/'+trait.id+'/revoke','POST',{});
  assert.equal((await call('/overview')).traits.find(t=>t.key==='storytelling').value,Number(trait.from));
  assert((await call('/growth')).items.filter(e=>e.id===example.id||e.id===trait.id).every(e=>!e.revertible));
  console.log('通过独立管理鉴权、证据、单条纠正/忘记、持久风格、工具开关、成长回滚和脱敏查询验收。');
} finally {
  Server.prototype.listen=listen;globalThis.fetch=request;profile?.close();search?.close();
  server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());
  rmSync(dir,{recursive:true,force:true});
}
