// Offline-only HTTP harness: actual Brain authority/router with synthetic registry and model.
// Bundled by build-joint.mjs against the explicitly selected read-only Brain worktree.
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {testAuthority} from '@p003-joint/fixture';
import {createListeningRoute} from '@p003-joint/route';
const f=await testAuthority();
let calls=0;
const app=createListeningRoute(f.authority,{generate:async(input:any)=>{calls++;return input.purpose==='listening_summary'?'小熊和朋友分享苹果。':'你愿意把苹果分给朋友，听起来很温暖。';},personality:async()=> '小可：简短温柔'});
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const b of req){raw+=b;if(raw.length>100000)throw Error('limit');}
  if(req.url==='/test/disable'&&req.headers['x-test-key']==='synthetic-only'){f.settings.disable('offline-fixture');res.end('{}');return;}
  if(req.url==='/test/stats'){res.setHeader('content-type','application/json');res.end(JSON.stringify({calls}));return;}
  const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers as any,body:raw||undefined});
  const reply=await app.fetch(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(await reply.text());
 }catch{res.writeHead(500);res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>{const address=server.address() as any;writeFileSync(process.argv[2],JSON.stringify({url:`http://127.0.0.1:${address.port}/`,metadata:f.metadata,key:f.secrets.serviceKey,token:f.serviceHeaders['x-p003-worker-token']}));});
const close=()=>server.close(()=>{f.cleanup();process.exit(0);});process.on('SIGTERM',close);process.on('SIGINT',close);
