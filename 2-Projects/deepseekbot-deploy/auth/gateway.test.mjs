import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {randomBytes,scryptSync,randomFillSync} from 'node:crypto';
import {createGateway} from './gateway.mjs';
const origin='https://cli4.hahaxiong.cc';
const password='test-only-'+randomBytes(24).toString('hex');
const salt=randomBytes(16).toString('hex');
const credential={salt,hash:scryptSync(password,salt,64,{N:32768,maxmem:64*1024*1024}).toString('hex')};
let upstream,gateway,port,upstreamPort;
let tokenAvailable=true;
function request(path='/',method='GET',body='',headers={}){
 return new Promise((resolve,reject)=>{
  const r=http.request({host:'127.0.0.1',port,path,method,headers:{host:'cli4.hahaxiong.cc',...headers}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
  });r.on('error',reject);r.end(body);
 });
}
const form=(pw,remember=true)=>new URLSearchParams({password:pw,...remember?{remember:'on'}:{}}).toString();
const login=(pw,remember=true,headers={})=>request('/_auth/login','POST',form(pw,remember),{'content-type':'application/x-www-form-urlencoded',origin,...headers});
before(async()=>{
 upstream=http.createServer((req,res)=>{
  if(req.headers.host!=='cli4.hahaxiong.cc'||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);res.end();return;}
  if(req.url==='/?token=test-token'){
   res.writeHead(303,{'location':'./','set-cookie':'dsh-auth-test=signed; Max-Age=2592000; Path=/; Expires=Mon, 19 Nov 2029 00:00:00 GMT; HttpOnly; SameSite=Strict'});res.end();
  }else if(req.headers.cookie?.includes('dsh-auth-test=signed')){res.setHeader('content-type','text/html');res.end('<main>Bot 模式</main>');}
  else {res.writeHead(401);res.end('authentication required');}
 });
 upstream.on('upgrade',(req,socket)=>{socket.end(req.headers.host==='cli4.hahaxiong.cc'&&req.headers.origin===origin&&req.headers.cookie==='dsh-auth-test=signed'?'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n':'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));upstreamPort=upstream.address().port;
 gateway=createGateway({credential,origin,publicPath:'/deepseekbot/',upstreamPort,readToken:()=>tokenAvailable?'test-token':null});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));port=gateway.address().port;
});
after(async()=>{await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>upstream.close(r))]);});
test('anonymous web gets form; anonymous API remains protected',async()=>{
 const r=await request();assert.equal(r.status,200);assert.match(r.text,/autocomplete="current-password"/);assert.match(r.text,/记住登录/);assert(!r.text.includes('test-token'));assert.match(r.text,/<meta name="referrer" content="same-origin">/);
 assert.equal((await request('/api/botharness/list')).status,401);
});
test('wrong password cannot receive cookie; cross-site login rejected',async()=>{
 const r=await login('wrong');assert.equal(r.status,401);assert(!r.headers['set-cookie']);assert(!r.text.includes('wrong'));
 assert.equal((await login(password,true,{origin:'https://evil.invalid'})).status,403);
 assert.equal((await login(password,true,{origin:'null'})).status,403);
 assert.equal((await request('/','GET','',{host:'evil.invalid'})).status,403);
});
test('remembered login exchanges native cookie without exposing token',async()=>{
 const r=await login(password);assert.equal(r.status,303);assert.equal(r.headers.location,'/deepseekbot/');
 const cookie=r.headers['set-cookie'][0];for(const x of ['HttpOnly','Secure','SameSite=Strict','Max-Age=2592000'])assert(cookie.includes(x));
 assert(!r.text.includes('test-token'));const page=await request('/','GET','',{cookie:cookie.split(';')[0]});assert.equal(page.status,200);assert(!page.text.includes('_mesh/compat'));
});
test('unchecked remember creates session cookie only',async()=>{
 const r=await login(password,false);assert.equal(r.status,303);assert(!/Max-Age|Expires/i.test(r.headers['set-cookie'][0]));
});
test('native token absence fails closed',async()=>{
 tokenAvailable=false;try{const r=await login(password);assert.equal(r.status,503);assert(!r.headers['set-cookie']);}finally{tokenAvailable=true;}
});
test('logout expires native cookie and redirects to password form',async()=>{
 const r=await request('/_auth/logout','POST','',{origin,cookie:'dsh-auth-test=signed'});assert.equal(r.status,303);assert.match(r.headers['set-cookie'][0],/Max-Age=0/);
});
test('WebSocket forwards authenticated handshake; unauthorized remains denied',async()=>{
 const upgrade=cookie=>new Promise((resolve,reject)=>{
  const s=net.connect(port,'127.0.0.1',()=>s.write('GET /api HTTP/1.1\r\nHost: cli4.hahaxiong.cc\r\nOrigin: '+origin+'\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: '+cookie+'\r\n\r\n'));
  s.on('data',b=>{s.destroy();resolve(b.toString());});s.on('error',reject);
 });
 assert.match(await upgrade('dsh-auth-test=signed'),/^HTTP\/1.1 101/);assert.match(await upgrade(''),/^HTTP\/1.1 401/);
});
test('large form rejected without reflecting content',async()=>{
 const r=await request('/_auth/login','POST','x'.repeat(5000),{origin,'content-type':'application/x-www-form-urlencoded'});assert.equal(r.status,413);
});
test('repeated password guesses are rate limited',async()=>{
 let r;for(let i=0;i<8;i++)r=await login('wrong');assert.equal(r.status,429);assert(!r.headers['set-cookie']);
});
test('mesh listener keeps native authentication with a private HTTP cookie',async()=>{
 const meshOrigin='http://10.10.10.11:31982';
 const mesh=createGateway({credential,origin:meshOrigin,publicPath:'/',upstreamPort,readToken:()=> 'test-token',meshOnly:true,upstreamAuthority:'cli4.hahaxiong.cc',upstreamOrigin:origin});
 await new Promise(r=>mesh.listen(0,'127.0.0.1',r));const meshPort=mesh.address().port;
 const call=(method,path,body='',headers={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:meshPort,path,method,headers:{host:'10.10.10.11:31982',origin:meshOrigin,'content-type':'application/x-www-form-urlencoded',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);
 });
 try{
  const r=await call('POST','/_auth/login',form(password));assert.equal(r.status,303);assert.equal(r.headers.location,'/');
  const cookie=r.headers['set-cookie'][0];assert(!/;\s*Secure/i.test(cookie));assert.match(cookie,/HttpOnly/);assert.match(cookie,/Max-Age=2592000/);
  const page=await call('GET','/', '',{cookie:cookie.split(';')[0]});assert.equal(page.status,200);assert.match(page.text,/_mesh\/compat.js/);
  const script=await call('GET','/_mesh/compat.js');assert.equal(script.status,200);
  const crypto={getRandomValues:array=>randomFillSync(array)};vm.runInNewContext(script.text,{crypto,Uint8Array});const id=crypto.randomUUID();assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.notEqual(id,crypto.randomUUID());
  assert.equal((await call('GET','/api', '',{origin:'https://evil.invalid'})).status,403);
  assert.equal((await call('GET','/', '',{host:'192.168.61.66:31982'})).status,403);
  assert.equal((await call('GET','/api')).status,401);
  const upgrade=(cookie,externalOrigin=meshOrigin)=>new Promise((resolve,reject)=>{
   const s=net.connect(meshPort,'127.0.0.1',()=>s.write('GET /api HTTP/1.1\r\nHost: 10.10.10.11:31982\r\nOrigin: '+externalOrigin+'\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: '+cookie+'\r\n\r\n'));
   s.on('data',b=>{s.destroy();resolve(b.toString());});s.on('error',reject);
  });
  assert.match(await upgrade(cookie.split(';')[0]),/^HTTP\/1.1 101/);
  assert.match(await upgrade(''),/^HTTP\/1.1 401/);
  assert.match(await upgrade(cookie.split(';')[0],'https://evil.invalid'),/^HTTP\/1.1 403/);
 }finally{await new Promise(r=>mesh.close(r));}
});
test('plain HTTP is refused unless explicitly scoped to the fixed mesh origin',()=>{
 for(const o of [{origin:'http://public.invalid'}, {origin:'http://10.10.10.11:31982'}, {origin:'http://public.invalid',meshOnly:true}]){
  assert.throws(()=>createGateway({credential,publicPath:'/',upstreamPort,readToken:()=>null,...o}),/mesh|HTTPS/);
 }
});
