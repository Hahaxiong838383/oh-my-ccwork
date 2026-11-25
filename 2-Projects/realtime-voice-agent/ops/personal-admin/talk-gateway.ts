import {readFileSync} from 'node:fs';
import {request} from 'node:https';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import type {Hono} from 'hono';

const rtc = /^\/rtc(?:\/v1)?(?:\/validate)?$/;
const files = new Set(['', 'index.html', 'voice.js', 'style.css', 'livekit.js', 'LIVEKIT-LICENSE']);

// The browser trusts the private Lucky site. The NAS independently authenticates
// the fixed Beijing gateway with its pilot CA. Media still flows directly to Beijing.
export function privateTalk(app: Hono, health?: string) {
  const site = process.env.TALK_SITE_ORIGIN;
  if (!health || !site) return;
  const origin = new URL(site);
  const edge = new URL(health);
  if (origin.protocol !== 'https:' || edge.protocol !== 'https:') throw Error('Private talk requires TLS');
  const ca = readFileSync('/run/private/edge-ca.crt');
  const wss = 'wss://' + origin.host;
  const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(self)',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self' " + wss + "; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"};

  async function exchange(path: string, method='GET', extra: Record<string,string>={}) {
    return await new Promise<{status:number,body:Buffer,type:string,retry?:string}>((resolve,reject)=>{
      const req = request(edge.origin + path, {method, ca, headers:extra, signal:AbortSignal.timeout(15000)}, res=>{
        const chunks:Buffer[]=[];
        let received=0;
        res.on('data',(chunk:Buffer)=>{received+=chunk.length; if(received>2*1024*1024) req.destroy(Error('Oversized response')); else chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',()=>resolve({status:res.statusCode || 502,body:Buffer.concat(chunks),type:res.headers['content-type'] || 'application/octet-stream',retry:res.headers['retry-after']}));
      });
      req.on('error',reject).end();
    });
  }

  app.get('/talk',c=>c.redirect('/talk/',308));
  app.get('/talk/*',async c=>{
    const file=c.req.path.slice('/talk/'.length);
    if (!files.has(file)) return c.notFound();
    try {
      const res=await exchange('/talk/'+file);
      return new Response(new Uint8Array(res.body),{status:res.status,headers:{...headers,'Content-Type':res.type}});
    } catch {return c.text('北京对话页面暂不可达',502);}
  });
  app.post('/api/voice/ticket',async c=>{
    if(c.req.header('Origin') !== origin.origin) return c.json({error:'invalid_origin'},403);
    const token=c.req.header('Authorization') || '';
    if(!/^Bearer pv1_[a-f0-9]{64}$/.test(token)) return c.json({error:'invalid_device'},401);
    if(c.req.header('Transfer-Encoding') || (c.req.header('Content-Length') || '0') !== '0' || (await c.req.raw.body?.getReader().read())?.value?.length) return c.json({error:'empty_body_required'},400);
    try {
      const res=await exchange('/api/voice/ticket','POST',{Authorization:token,Origin:edge.origin,'Content-Length':'0'});
      const data=JSON.parse(res.body.toString('utf8'));
      if(res.status===200) {
        if(typeof data.token!=='string' || typeof data.room!=='string') return c.json({error:'invalid_upstream'},502);
        data.url=wss;
      }
      return new Response(JSON.stringify(data),{status:res.status,headers:{...headers,'Content-Type':'application/json',...(res.retry?{'Retry-After':res.retry}:{})}});
    } catch {return c.json({error:'ticket_unavailable'},502);}
  });
  app.get('/rtc/*',async c=>{
    if(!rtc.test(c.req.path)) return c.notFound();
    try {
      const url=new URL(c.req.url);
      const auth=c.req.header('Authorization');
      const res=await exchange(url.pathname+url.search,'GET',auth?{Authorization:auth}:{});
      return new Response(new Uint8Array(res.body),{status:res.status,headers:{...headers,'Content-Type':res.type}});
    } catch { return c.text('信令暂不可用',502); }
  });

  return (req: IncomingMessage, client: Duplex, head: Buffer)=>{
    const url=req.url || '';
    if (!rtc.test(url.split('?')[0]) || req.headers.origin !== origin.origin || req.headers.upgrade?.toLowerCase()!=='websocket') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const pass: Record<string,string>={Connection:'Upgrade',Upgrade:'websocket',Origin:edge.origin};
    for(const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions','authorization']) {
      const val=req.headers[name]; if(typeof val==='string') pass[name]=val;
    }
    const upstream=request(edge.origin+url,{ca,headers:pass});
    const timer=setTimeout(()=>upstream.destroy(Error('handshake timeout')),12000);
    upstream.on('upgrade',(res,socket,rest)=>{
      clearTimeout(timer);
      const handshake=['HTTP/1.1 101 Switching Protocols','Connection: Upgrade','Upgrade: websocket'];
      for(const name of ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions']){
        const val=res.headers[name]; if(typeof val === 'string') handshake.push(name+': '+val);
      }
      client.write(handshake.join('\r\n')+'\r\n\r\n');
      if(rest.length) client.write(rest);
      if(head.length) socket.write(head);
      socket.on('error',()=>client.destroy()); client.on('error',()=>socket.destroy());
      socket.on('close',()=>client.destroy()); client.on('close',()=>socket.destroy());
      client.pipe(socket).pipe(client);
    });
    upstream.on('response',res=>{clearTimeout(timer);res.resume();client.end('HTTP/1.1 '+(res.statusCode||502)+' Rejected\r\nConnection: close\r\n\r\n');});
    upstream.on('error',()=>{clearTimeout(timer);client.destroy();});
    client.on('error',()=>upstream.destroy()); client.on('close',()=>upstream.destroy());
    upstream.end();
  };
}
