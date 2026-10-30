// Offline-only HTTP harness: actual Brain authority/router with synthetic registry and model.
// Bundled by build-joint.mjs against the explicitly selected read-only Brain worktree.
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {testAuthority} from '@p003-joint/fixture';
import {createListeningRoute} from '@p003-joint/route';
const f=await testAuthority();
const voice=await testAuthority({voiceClient:true,voiceWorker:true,voiceApproved:true});
let calls=0;
const triggers:{scene:string,trigger:string}[]=[];
const app=createListeningRoute(f.authority,{generate:async(input:any)=>{calls++;return input.purpose==='listening_summary'?'小熊和朋友分享苹果。':'你愿意把苹果分给朋友，听起来很温暖。';},personality:async()=> '小可：简短温柔'});
const voiceApp=createListeningRoute(voice.authority,{generate:async(input:any)=>{calls++;return input.purpose==='listening_summary'?'小熊唱了一首歌。':'谢谢你把歌分享给我，我很喜欢这份心意。';},personality:async()=> '小可：简短温柔，不评判音准节奏'});
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const b of req){raw+=b;if(raw.length>100000)throw Error('limit');}
  if(req.url==='/test/disable'&&req.headers['x-test-key']==='synthetic-only'){f.settings.disable('offline-fixture');res.end('{}');return;}
  if(req.url==='/test/stats'){res.setHeader('content-type','application/json');res.end(JSON.stringify({calls,triggers}));return;}
  const voiceRoute=req.url?.startsWith('/voice/');
  if(voiceRoute&&req.url==='/voice/feedback'){const v=JSON.parse(raw);triggers.push({scene:v.scene,trigger:v.trigger});}
  const request=new Request('http://localhost'+(voiceRoute?req.url!.slice('/voice'.length):req.url),{method:req.method,headers:req.headers as any,body:raw||undefined});
  const reply=await (voiceRoute?voiceApp:app).fetch(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(await reply.text());
 }catch{res.writeHead(500);res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>{const address=server.address() as any;writeFileSync(process.argv[2],JSON.stringify({url:`http://127.0.0.1:${address.port}/`,voice:{url:`http://127.0.0.1:${address.port}/voice/`,metadata:voice.metadata,key:voice.secrets.serviceKey,token:voice.serviceHeaders['x-p003-worker-token']},metadata:f.metadata,key:f.secrets.serviceKey,token:f.serviceHeaders['x-p003-worker-token']}));});
const close=()=>server.close(()=>{f.cleanup();voice.cleanup();process.exit(0);});process.on('SIGTERM',close);process.on('SIGINT',close);
