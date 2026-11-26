/* Production room smoke test. Takes the device credential on stdin and two local,
 * synthetic Mandarin WAV inputs. Only the test page's microphone is synthetic. */
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assets=path.resolve(__dirname,'../assets'),sdk=process.env.LIVEKIT_UMD,site='https://pa.hahaxiong.cc:8666';
const first=fs.readFileSync(process.env.LONG_WAV).toString('base64'),second=fs.readFileSync(process.env.NEXT_WAV).toString('base64');
const key=fs.readFileSync(0,'utf8').trim();
async function ticket(){
 return new Promise((resolve,reject)=>{
  const req=https.request(site+'/api/voice/ticket',{method:'POST',headers:{Origin:site,Authorization:'Bearer '+key,'Content-Length':'0'},timeout:13000},r=>{
   if(r.statusCode!==200){r.resume();reject(Error('ticket HTTP '+r.statusCode));return;}
   let chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(Error('ticket JSON'));}});
  }); req.on('error',()=>reject(Error('ticket network')));req.on('timeout',()=>req.destroy());req.end();
 });
}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage']});
 try {
  const p=await browser.newPage({viewport:{width:412,height:850}});
  await p.route(site+'/night-app/**',r=>{const name=new URL(r.request().url()).pathname.split('/').pop()||'index.html';
   if(!['index.html','livekit.js','night.css','orb-reference.js','orb-motion.js','orb-surface.js','orb-input.js','night.js','session.js'].includes(name))return r.abort();
   return r.fulfill({path:name==='livekit.js'?sdk:path.join(assets,name),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  p.on('pageerror',e=>console.error('page error',e.name,String(e.message).slice(0,110)));
  await p.exposeFunction('nativeTicket',ticket);
  await p.addInitScript(()=>{
   window.NightHost={paired:()=>true,setCall(){},event(){},micPermission:id=>setTimeout(()=>Voice.onPermission(id,true),0),ticket:id=>window.nativeTicket().then(t=>Voice.onTicket(id,t)).catch(()=>Voice.onTicket(id,{error:'签票失败'}))};
   window.micSetup=()=>{if(!window.inputCtx){window.inputCtx=new AudioContext();window.virtualMic=inputCtx.createMediaStreamDestination();}return inputCtx.resume();};
   navigator.mediaDevices.getUserMedia=async()=>{await micSetup();return new MediaStream(virtualMic.stream.getAudioTracks().map(t=>t.clone()));};
   window.say=async function(b64){await micSetup();const buf=await inputCtx.decodeAudioData(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)).buffer);const src=inputCtx.createBufferSource();src.buffer=buf;src.connect(virtualMic);src.start();};
  });
  await p.goto(site+'/night-app/index.html');
  await p.evaluate(()=>{
   window.audit={shows:[],levels:[],events:[]};const render=NightView.render,level=NightView.level;
   NightView.render=s=>{audit.shows.push({t:performance.now(),mine:s.mine,reply:s.reply,phase:s.phase,status:s.status,muted:s.muted});return render(s);};
   NightView.level=v=>{if(v>.035)audit.levels.push(performance.now());return level(v);};
   NightHost.event=e=>audit.events.push(e);
  });
  async function until(fn,n=30000){try{await p.waitForFunction(fn,null,{timeout:n});}catch(e){console.log(await p.evaluate(()=>({last:audit.shows.slice(-4).map(x=>[x.status,x.mine?.length,x.reply?.length]),audio:audit.levels.length,events:[...new Set(audit.events)]})));throw e;}}
  await p.locator('#btn-start').click();
  await until(()=>audit.shows.some(s=>s.status==='小可在听'||s.status==='小可在说'));console.log('live personal Worker ready');
  await p.locator('#btn-mute').click();await until(()=>audit.shows.at(-1).muted);await p.locator('#btn-mute').click();await until(()=>!audit.shows.at(-1).muted);
  await p.waitForTimeout(1200);
  await p.evaluate(b=>say(b),first);
  await until(()=>audit.shows.some(s=>s.mine?.includes('故事')||s.mine?.includes('科技')||s.mine?.includes('新闻')),35000);
  await until(()=>{const s=audit.shows.at(-1);return s.reply?.length>=5&&audit.levels.at(-1)>performance.now()-180;},55000);
  const before=await p.evaluate(()=>({old:audit.shows.at(-1).reply,started:performance.now(),n:audit.levels.length}));
  await p.evaluate(old=>{window.oldReply=old;window.breakStart=performance.now();},before.old);
  await p.evaluate(b=>say(b),second);
  await until(()=>audit.shows.some(s=>s.mine?.includes('北京')||s.mine?.includes('几点')),30000);
  await until(()=>{const s=audit.shows.at(-1);return /北京.{0,12}(时间|点|时)|现在.{0,15}(点|时)|[零一二三四五六七八九十0-9]{1,4}[点时].{0,8}分/.test(s.reply)&&s.reply!==window.oldReply&&s.t>window.breakStart&&audit.levels.at(-1)>performance.now()-200;},50000);
  await p.locator('#btn-interrupt').click();
  await until(()=>audit.events.includes('cancel_ack'),6000);
  await p.locator('#btn-stop').click();
  const res=await p.evaluate(()=>({bargeDuringOutput:true,clockReplyHeard:true,levels:audit.levels.length,events:[...new Set(audit.events)],ended:audit.shows.at(-1).status,active:document.querySelectorAll('audio').length}));
  assert(res.levels>before.n);assert.equal(res.active,0);assert.equal(res.ended,'通话已结束');console.log(JSON.stringify(res));
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
