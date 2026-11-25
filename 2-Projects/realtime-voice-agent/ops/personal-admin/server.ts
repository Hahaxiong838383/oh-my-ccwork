import {readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {bodyLimit} from 'hono/body-limit';
import {authRoute} from '../../../P003GameDemo20260513/apps/server/src/routes/auth';
import {HOTWORD_KINDS,hotwordStore,validateWords} from '../../../P003GameDemo20260513/apps/server/src/hotword-store';
import {getFillerStyleSettings,saveFillerStyleSettings,validFillerProbabilities} from '../../../P003GameDemo20260513/apps/server/src/filler-policy';

process.env.STUDIO_USER='owner';
process.env.STUDIO_PASS=readFileSync('/run/private/password','utf8').trim();
if (process.env.STUDIO_PASS.length<20) throw Error('Missing owner credential');
process.env.STUDIO_GUEST_USER='';
process.env.STUDIO_EDITOR_USERS='';
const page=readFileSync('/app/index.html','utf8');
const app=new Hono();
const sessions=new Map<string,number>();
const lifetime=8*3600;
app.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  c.header('Referrer-Policy','no-referrer');
  c.header('X-Frame-Options','DENY');
  c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  if (c.req.method!=='GET' && c.req.header('X-Voice-Admin')!=='1') return c.json({error:'请求来源无效'},403);
  await next();
});
app.use('/api/*',bodyLimit({maxSize:16384}));
app.get('/',c=>c.html(page));
app.get('/health',c=>c.json({service:'personal-voice-admin',ok:true}));
app.post('/api/login',async c=>{
  const body=await c.req.json().catch(()=>({}));
  const login=await authRoute.request('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password: body.password})});
  const result=await login.json();
  if (!result.ok || result.role!=='admin') return c.json({error:'登录失败，请检查口令或稍后重试'},login.status===429?429:401);
  for(const [key,until] of sessions) if(until<=Date.now()) sessions.delete(key);
  sessions.set(result.token,Date.now()+lifetime*1000);
  setCookie(c,'voice_owner',result.token,{path:'/',httpOnly:true,secure:true,sameSite:'Strict',maxAge:lifetime});
  return c.json({ok:true});
});
app.use('/api/*',async(c,next)=>{
  if ((sessions.get(getCookie(c,'voice_owner')||'')||0)<=Date.now()) return c.json({error:'请登录'},401);
  await next();
});
app.get('/api/design',c=>{
  c.header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  return c.html(readFileSync('/app/design.html','utf8'));
});
app.post('/api/logout',c=>{sessions.delete(getCookie(c,'voice_owner')!);deleteCookie(c,'voice_owner',{path:'/'});return c.json({ok:true});});
app.get('/api/settings',c=>c.json({
  build:process.env.ADMIN_BUILD,worker:'未接入',brain:'未接入',ticket:'未接入',
  drafts:Object.fromEntries(HOTWORD_KINDS.map(kind=>[kind,hotwordStore.draftOf(kind)])),
  probabilities:getFillerStyleSettings().probabilities
}));
app.put('/api/drafts/:kind',async c=>{
  const kind=HOTWORD_KINDS.find(k=>k===c.req.param('kind'));
  if (!kind) return c.json({error:'无此词表'},404);
  const body=await c.req.json().catch(()=>({}));
  const parsed=validateWords(kind,body.words);
  if(!parsed.ok) return c.json({error:parsed.error},400);
  if ((hotwordStore.draftOf(kind)?.id??null)!==body.previous) return c.json({error:'词表已更新，请刷新后再保存'},409);
  return c.json(hotwordStore.saveDraft(kind,parsed.words,'owner'));
});
app.put('/api/probabilities',async c=>{
  const body=await c.req.json().catch(()=>({}));
  if(!validFillerProbabilities(body.probabilities)) return c.json({error:'各项须为 0–100%'},400);
  return c.json(saveFillerStyleSettings(body.probabilities,'owner'));
});
serve({fetch:app.fetch,port:8443,createServer,serverOptions:{cert:readFileSync('/run/private/cert.pem'),key:readFileSync('/run/private/key.pem')}});
