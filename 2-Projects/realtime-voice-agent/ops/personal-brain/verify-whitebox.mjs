// Verify the production bundle's authenticated HTTP paths using private temporary storage.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

const dir=mkdtempSync(join(tmpdir(),'whitebox-')), owner='whitebox-owner';
const key=randomBytes(32).toString('hex'),worker=randomBytes(32).toString('hex');
const keys=join(dir,'console.key');writeFileSync(keys,key,{mode:0o600});
Object.assign(process.env,{BRAIN_DATA_DIR:dir,BRAIN_OWNER_ID:owner,BRAIN_WORKER_KEY:worker,BRAIN_CONSOLE_KEY_FILE:keys,
  BRAIN_UPSTREAM_BASE_URL:'https://whitebox.invalid/v1',BRAIN_UPSTREAM_API_KEY:'fixture',BRAIN_UPSTREAM_MODEL:'fixture'});
const listen=Server.prototype.listen, fetchLocal=globalThis.fetch;
let server,chat;
Server.prototype.listen=function(_port,...args){server=this;return listen.call(this,0,'127.0.0.1',...args.slice(1));};
globalThis.fetch=async(input,init)=>{
  assert.equal(new URL(input).hostname,'whitebox.invalid');
  const body=JSON.parse(init.body);
  if(body.stream===false)return Response.json({choices:[{message:{content:'{}'}}]});
  const data=JSON.stringify({choices:[{delta:{content:'从前，一朵小浪花找到了灯塔。'},finish_reason:'stop'}]});
  return new Response('data: '+data+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
try {
  await import(pathToFileURL(resolve(process.argv[2])).href);while(!server.listening)await wait(5);
  const base='http://127.0.0.1:'+server.address().port;
  const first='pv-'+randomBytes(16).toString('hex'),next='pv-'+randomBytes(16).toString('hex');
  async function say(room,text,turn,byHeader=false){
    const r=await fetchLocal(base+'/v1/chat/completions?room='+room,{method:'POST',headers:{authorization:'Bearer '+worker,
      'content-type':'application/json','x-personal-turn':String(turn),...(byHeader?{'x-personal-session':room}:{})},
      body:JSON.stringify({store:true,messages:[{role:'user',content:text}]})});
    assert.equal(r.status,200);return (await r.json()).choices[0].message.content;
  }
  async function white(room,query=''){
    const r=await fetchLocal(base+'/internal/console/whitebox/'+room+query,{headers:{authorization:'Bearer '+key}});
    assert.equal(r.status,200);return r.json();
  }
  const missing=await fetchLocal(base+'/internal/console/whitebox/other',{headers:{authorization:'Bearer '+key}});assert.equal(missing.status,404);
  const unauthorized=await fetchLocal(base+'/internal/console/whitebox/'+first);assert.equal(unauthorized.status,401);
  await say(first,'记住，我的书签是月牙。',3);
  await say(first,'只这次简短点，给我讲个故事。',6);
  await say(first,'这种讲法我喜欢。',7);
  await say(next,'我今天拿到好消息了。',1);
  await say(next,'你记得我的书签是什么吗？',2);
  await say(next,'北京现在几点了？',5);
  let a=await white(first),b=await white(next);
  assert.equal(a.total,3);assert.equal(b.total,3);
  const [fact,story,approval]=a.turns,[good,recall,clock]=b.turns;
  assert.equal(fact.voiceTurn,3);assert.equal(fact.route,'memory_action');assert.equal(fact.memories[0].value,'月牙');
  assert.equal(fact.memories[0].source.id,fact.user.id);
  assert.equal(story.route,'model');assert.match(story.style,/仅本轮/);assert.deepEqual(story.recall.items,[]);
  assert.equal(story.voiceTurn,6);assert.equal(story.ordinal,2);assert.equal(story.tool,null);
  const growth=approval.growth.find(e=>e.module==='trait');assert.equal(growth.reply.id,story.reply.id);
  assert.equal(growth.feedback.id,approval.user.id);assert.equal(story.attributedGrowth.find(e=>e.id===growth.id).to,growth.to);
  assert.deepEqual(good.growth,[]);assert.deepEqual(good.attributedGrowth,[]);
  assert.equal(recall.route,'memory');assert.equal(recall.recall.mode,'direct');assert.equal(recall.recall.items[0].id,fact.memories[0].id);
  assert.equal(recall.recall.items[0].source.id,fact.user.id);assert.equal(clock.tool.tool,'clock');assert.equal(clock.voiceTurn,5);
  assert.deepEqual((await white(next,'?offset=1&limit=1')).turns.map(x=>x.reply.id),[recall.reply.id]);
  await say(next,'忘记我的书签。',6);
  const retired=(await white(next)).turns[1];assert.deepEqual(retired.recall.items,[{id:null,topic:'旧版本',value:'',source:null}]);
  assert(!JSON.stringify(await white(first)).includes('月牙'));assert(!JSON.stringify(await white(next)).includes('月牙'));
  await say(next,'北京现在几点了？',10,true);
  assert.equal((await white(next)).turns.at(-1).voiceTurn,null);
  // A reconnect can reuse the native counter. Both candidate replies must lose their timing join, even across pages.
  await say(first,'北京现在几点了？',3);
  const recentDuplicate=(await white(first,'?offset=0&limit=1')).turns[0];
  const earlierDuplicate=(await white(first,'?offset=3&limit=1')).turns[0];
  assert.equal(recentDuplicate.voiceTurn,null);assert.equal(recentDuplicate.tool.tool,'clock');
  assert.equal(earlierDuplicate.voiceTurn,null);assert.equal(earlierDuplicate.reply.id,fact.reply.id);
  chat=new DatabaseSync(join(dir,'conversations.sqlite'));
  for(const [id,role,text] of [['old-u','user','旧问题'],['old-a','assistant','旧回答']]){
    chat.prepare('INSERT INTO conversation(id,session_id,account_id,role,text,ts) VALUES(?,?,?,?,?,?)').run(id,'historical',owner,role,text,Date.now());
  }
  const old=(await white('historical')).turns[0];
  assert.equal(old.user,null);assert.equal(old.route,null);assert.equal(old.recall,null);assert.equal(old.tool,null);assert.equal(old.voiceTurn,null);
  console.log('PASS whitebox: 2 independent rooms; exact voice IDs; tool, source, growth and recall receipts; pagination and duplicate native counters; erased versions; missing legacy anchors; owner authentication.');
} finally {
  globalThis.fetch=fetchLocal;Server.prototype.listen=listen;chat?.close();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
}
process.exit(0);
