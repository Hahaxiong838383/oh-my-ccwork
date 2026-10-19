import http from 'node:http';
import net from 'node:net';
import {scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const derive=promisify(scrypt);
// Private HTTP origins lack randomUUID; getRandomValues remains available.
const meshCompat=`if(globalThis.crypto&&typeof crypto.randomUUID!=='function'){Object.defineProperty(crypto,'randomUUID',{configurable:true,value(){const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}});}`;
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createGateway({credential,origin,publicPath,upstreamPort,readToken,meshOnly=false,upstreamAuthority=new URL(origin).host,upstreamOrigin=origin}) {
 if(!/^[a-f0-9]{32}$/.test(credential.salt)||!/^[a-f0-9]{128}$/.test(credential.hash)) throw new Error('Invalid credential configuration');
 const authority=new URL(origin).host;
 const privateMesh=meshOnly&&origin==='http://10.10.10.11:31982';
 if(new URL(origin).protocol!=='https:'&&!privateMesh)throw new Error('HTTPS required outside fixed private mesh origin');
 const secureCookie=!privateMesh;
 // Validate the external origin before translating it for the fixed native authority.
 const upstreamHeaders=req=>({...req.headers,host:upstreamAuthority,...req.headers.origin?{origin:upstreamOrigin}:{}});
 const expected=Buffer.from(credential.hash,'hex');
 // Personal gateway: global bound deliberately ignores spoofable forwarding headers.
 let failures=0,windowStart=Date.now(),checking=false;
 const secureHeaders={'cache-control':'no-store','referrer-policy':'same-origin','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
 const html=(message='')=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="same-origin"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 DeepSeekBot</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f7f8fa;color:#202124;font:16px system-ui}main{width:min(420px,calc(100% - 32px));padding:36px;background:white;border:1px solid #e4e6eb;border-radius:20px}h1{font-size:27px;margin:0 0 8px}p{color:#687080;line-height:1.6}label{display:block;margin:24px 0 8px}input[type=password]{width:100%;padding:14px;border:1px solid #bfc5d0;border-radius:10px;font:inherit}input:focus-visible,button:focus-visible{outline:3px solid #95b3ff;outline-offset:2px}.remember{display:flex;gap:8px;align-items:center;font-size:14px}button{margin-top:24px;width:100%;padding:14px;background:#3269e8;color:white;border:0;border-radius:10px;font:inherit;cursor:pointer}.error{color:#a52323}</style><main><h1>DeepSeekBot</h1><p>登录你的 Bot 工作台</p>${message?`<p class="error" role="alert">${escape(message)}</p>`:''}<form action="${escape(publicPath)}_auth/login" method="post"><input type="hidden" name="username" value="DeepSeekBot" autocomplete="username"><label for="password">登录密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="1024"><label class="remember"><input type="checkbox" name="remember" checked>记住登录（30 天）</label><button type="submit">登录</button></form><p style="font-size:13px">可使用浏览器的密码管理器保存密码。</p></main></html>`;
 const send=(res,status,body='',headers={})=>{res.writeHead(status,{...secureHeaders,'content-type':'text/html; charset=utf-8',...headers});res.end(body);};
 const exchange=token=>new Promise((resolve,reject)=>{
  const r=http.get({hostname:'127.0.0.1',port:upstreamPort,path:'/?token='+encodeURIComponent(token),headers:{host:upstreamAuthority},timeout:8000},response=>{
   response.resume();const cookies=response.headers['set-cookie']?.filter(x=>/^dsh-auth-[^=]+=/.test(x));
   if(response.statusCode===303&&cookies?.length)resolve(cookies);else reject(new Error('Exchange unavailable'));
  });r.on('timeout',()=>r.destroy());r.on('error',reject);
 });
 const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==authority||(req.headers.origin&&req.headers.origin!==origin))return send(res,403);
  const path=new URL(req.url,origin).pathname;
  if(privateMesh&&path==='/_mesh/compat.js'&&req.method==='GET')return send(res,200,meshCompat,{'content-type':'text/javascript; charset=utf-8'});
  if(path.startsWith('/_auth/')){
   if(req.method!=='POST')return send(res,405,'',{'allow':'POST'});
   if(req.headers.origin!==origin)return send(res,403);
   if(path==='/_auth/logout'){
    const names=(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')[0]).filter(s=>/^dsh-auth-[a-zA-Z0-9_-]+$/.test(s));
    return send(res,303,'',{'location':publicPath,'set-cookie':names.map(n=>`${n}=; Max-Age=0; Path=/; HttpOnly;${secureCookie?' Secure;':''} SameSite=Strict`)});
   }
   if(path!=='/_auth/login')return send(res,404);
   if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return send(res,415);
   let chunks=[],size=0;
   try{for await(const chunk of req){size+=chunk.length;if(size>4096){send(res,413);req.resume();return;}chunks.push(chunk);}}catch{return;}
   if(Date.now()-windowStart>900000){failures=0;windowStart=Date.now();}
   if(failures>=5||checking)return send(res,429,html('尝试过于频繁，请稍后重试。'),{'retry-after':String(Math.ceil((windowStart+900000-Date.now())/1000))});
   const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));chunks=[];
   checking=true;
   try{
    const value=await derive(form.get('password')||'',credential.salt,64,{N:32768,maxmem:64*1024*1024});
    form.delete('password');
    if(!timingSafeEqual(value,expected)){failures++;return send(res,401,html('密码不正确，请重试。'));}
    failures=0;
    const token=await readToken();if(!token)return send(res,503,html('服务正在启动，请稍后重试。'));
    const cookies=(await exchange(token)).map(cookie=>{
     if(form.get('remember')!=='on')cookie=cookie.replace(/;\s*(?:Max-Age|Expires)=[^;]*/gi,'');
     if(secureCookie&&!/;\s*Secure(?:;|$)/i.test(cookie))cookie+='; Secure';
     if(!secureCookie)cookie=cookie.replace(/;\s*Secure(?=;|$)/gi,'');
     return cookie;
    });
    return send(res,303,'',{'location':publicPath,'set-cookie':cookies});
   }catch{return send(res,503,html('服务暂时不可用，请稍后重试。'));}finally{checking=false;}
  }
  const meshDocument=privateMesh&&req.method==='GET'&&path==='/';
  const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,method:req.method,path:req.url,headers:{...upstreamHeaders(req),...meshDocument?{'accept-encoding':'identity'}:{}}},response=>{
   if(req.method==='GET'&&path==='/'&&response.statusCode===401){response.resume();return send(res,200,html());}
   if(meshDocument&&response.statusCode===200&&response.headers['content-type']?.includes('text/html')){
    const chunks=[];let size=0;
    response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){response.destroy();return;}chunks.push(chunk);});
    response.on('error',()=>{if(!res.headersSent)send(res,502);else res.destroy();});
    response.on('end',()=>{
     const source=Buffer.concat(chunks).toString('utf8');
     const script='<script src="/_mesh/compat.js"></script>';
     const body=/<head(?:\s[^>]*)?>/i.test(source)?source.replace(/<head(?:\s[^>]*)?>/i,head=>head+script):script+source;
     const headers={...response.headers,'content-length':Buffer.byteLength(body),'cache-control':'no-store'};
     delete headers['content-encoding'];delete headers['transfer-encoding'];delete headers.etag;
     res.writeHead(200,headers);res.end(body);
    });
    return;
   }
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.headersSent)send(res,502);else res.destroy();});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.on('upgrade',(req,socket,head)=>{
  if(req.headers.host!==authority||(req.headers.origin&&req.headers.origin!==origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  const upstream=net.connect(upstreamPort,'127.0.0.1',()=>{
   const headers=Object.entries(upstreamHeaders(req)).map(([k,v])=>`${k}: ${v}`).join('\r\n');
   upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);if(head.length)upstream.write(head);
   socket.pipe(upstream).pipe(socket);
  });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.umask(0o077);
 const base='/Users/rayman.chen/local/deepseekbot';
 try{
  const file=base+'/auth/credential.json';if(statSync(file).mode&0o077)throw new Error('Credential permissions');
  const credential=JSON.parse(readFileSync(file,'utf8'));
  const readToken=()=>{const log=readFileSync(base+'/logs/host.log','utf8');const urls=[...log.matchAll(/dsh web: (https:\/\/[^\s]+\?token=[^\s]+)/g)];return urls.length?new URL(urls.at(-1)[1]).searchParams.get('token'):null;};
  const meshOnly=process.argv.includes('--mesh');
  const server=createGateway({credential,origin:meshOnly?'http://10.10.10.11:31982':'https://cli4.hahaxiong.cc',publicPath:meshOnly?'/':'/deepseekbot/',upstreamPort:31980,readToken,meshOnly,upstreamAuthority:'cli4.hahaxiong.cc',upstreamOrigin:'https://cli4.hahaxiong.cc'});
  server.on('error',()=>{console.error('Auth gateway listener failed');process.exit(1);});
  server.listen(meshOnly?31982:31981,meshOnly?'10.10.10.11':'127.0.0.1',()=>console.log(meshOnly?'Auth gateway listening on mesh only':'Auth gateway listening on loopback'));
 }catch{console.error('Auth gateway configuration unavailable');process.exit(1);}
}
