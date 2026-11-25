import {readFileSync} from 'node:fs';
import {createServer, get as httpsGet} from 'node:https';
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
async function brainStatus() {
  if (!process.env.BRAIN_HEALTH_URL) return '未接入状态采样';
  try {
    const response = await fetch(process.env.BRAIN_HEALTH_URL, {signal: AbortSignal.timeout(1800)});
    const data = await response.json();
    return response.ok && data.service === 'personal-brain' && data.ok === true ? '在线' : '健康响应异常';
  } catch { return '暂时不可达'; }
}
async function ticketStatus() {
  if (!process.env.EDGE_HEALTH_URL) return '未接入状态采样';
  try {
    const ca = readFileSync('/run/private/edge-ca.crt');
    return await new Promise<string>((resolve) => {
      const request = httpsGet(process.env.EDGE_HEALTH_URL!, {ca, signal: AbortSignal.timeout(1800)}, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
        response.on('error', () => resolve('暂时不可达'));
        response.on('end', () => {
          try { resolve(response.statusCode === 200 && JSON.parse(body).service === 'personal-edge-ticket' ? '在线' : '健康响应异常'); }
          catch { resolve('健康响应异常'); }
        });
      });
      request.on('error', () => resolve('暂时不可达'));
    });
  } catch { return '暂时不可达'; }
}
app.get('/api/settings',async c=>{
  const [brain, ticket] = await Promise.all([brainStatus(), ticketStatus()]);
  return c.json({
    build:process.env.ADMIN_BUILD,worker:'未接入状态采样',brain,ticket,
    sampledAt:new Date().toISOString(),
    drafts:Object.fromEntries(HOTWORD_KINDS.map(kind=>[kind,hotwordStore.draftOf(kind)])),
    probabilities:getFillerStyleSettings().probabilities
  });
});
let testingBrain = false;
app.post('/api/diagnostics/chat', async c => {
  if (!process.env.BRAIN_HEALTH_URL) return c.json({error:'个人大脑尚未接入'},503);
  const input = await c.req.json().catch(() => ({}));
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 600) {
    return c.json({error:'请输入 1 至 600 字的试问'},400);
  }
  if (testingBrain) return c.json({error:'已有试问运行中'},429);
  testingBrain = true;
  try {
    const key = readFileSync('/run/brain-access.env','utf8').match(/^LLM_API_KEY=([a-f0-9]{64})$/m)?.[1];
    if (!key) return c.json({error:'大脑诊断授权未配置'},503);
    const response = await fetch(new URL('/v1/chat/completions',process.env.BRAIN_HEALTH_URL),{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,
        'X-Personal-Session':'admin-diagnostic-'+crypto.randomUUID()},
      body:JSON.stringify({model:'personal-brain',stream:false,store:false,messages:[{role:'user',content:input.question.trim()}]}),
      signal:AbortSignal.timeout(45000)
    });
    if (!response.ok) return c.json({error:'大脑暂时无法完成试问'},502);
    const result = await response.json();
    const text = result.choices?.[0]?.message?.content;
    if (typeof text!=='string' || !text.trim()) return c.json({error:'大脑没有返回正文'},502);
    const sources = (Array.isArray(result.sources)?result.sources:[]).slice(0,10)
      .filter((s: {url?:string})=>typeof s.url==='string' && /^https?:\/\//.test(s.url))
      .map((s: {title?:string;url:string})=>({title:s.title||s.url,url:s.url}));
    return c.json({text,tool:typeof result.tool==='string'?result.tool:null,sources});
  } catch { return c.json({error:'大脑连接失败或试问超时'},502); }
  finally { testingBrain = false; }
});
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
