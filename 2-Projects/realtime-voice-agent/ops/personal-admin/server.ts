import {readFileSync} from 'node:fs';
import {createServer, get as httpsGet} from 'node:https';
import {Hono} from 'hono';
import {privateTalk} from './talk-gateway';
import {activateProfile, createProfile, ProviderError, publicView, readDocument, updateProfile, withProviders} from './providers';
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
const upgradeTalk=privateTalk(app,process.env.EDGE_HEALTH_URL);
const sessions=new Map<string,number>();
const lifetime=8*3600;
app.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  c.header('Referrer-Policy','no-referrer');
  c.header('X-Frame-Options','DENY');
  c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
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
interface WorkerSnapshot { status: string; jobs: number | null; capacity: number | null; at: string | null }
function workerSnapshot(): WorkerSnapshot {
  const unknown = (status: string): WorkerSnapshot => ({status,jobs:null,capacity:null,at:null});
  if (!process.env.WORKER_STATUS_FILE) return unknown('未接入状态采样');
  try {
    const sample = JSON.parse(readFileSync(process.env.WORKER_STATUS_FILE,'utf8'));
    const age = Date.now() - sample.sampled_ms;
    if (sample.service !== 'personal-xiaoke' || !Number.isSafeInteger(sample.sampled_ms) ||
        !Number.isSafeInteger(sample.jobs) || !Number.isSafeInteger(sample.capacity) ||
        sample.jobs < 0 || sample.capacity < 1 || sample.jobs > sample.capacity || typeof sample.registered !== 'boolean') return unknown('采样数据异常');
    if (age < -2000 || age > 20000) return unknown('状态采样已过期');
    if (!sample.registered) return unknown('正在连接北京');
    return {status:'北京已注册 · '+sample.jobs+'/'+sample.capacity+' 路占用',jobs:sample.jobs,
      capacity:sample.capacity,at:new Date(sample.sampled_ms).toISOString()};
  } catch { return unknown('尚无有效采样'); }
}
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
async function runtimeStatus() {
  const [brain,ticket] = await Promise.all([brainStatus(),ticketStatus()]);
  const slots = workerSnapshot();
  return {build:process.env.ADMIN_BUILD,worker:slots.status,slots,brain,ticket,sampledAt:new Date().toISOString()};
}
app.get('/api/status',async c=>c.json(await runtimeStatus()));
app.get('/api/settings',async c=>{
  return c.json({
    ...(await runtimeStatus()),
    drafts:Object.fromEntries(HOTWORD_KINDS.map(kind=>[kind,hotwordStore.draftOf(kind)])),
    probabilities:getFillerStyleSettings().probabilities
  });
});
const speechOrigin = process.env.SPEECH_ORIGIN;
const voiceId = (v:unknown):v is string => typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
async function voiceRequest(path:string, method='GET', payload?:object) {
  if (!speechOrigin) throw Error('未配置语音服务');
  return fetch(new URL(path,speechOrigin),{method,redirect:'error',headers:{'Content-Type':'application/json'},
    body:payload ? JSON.stringify(payload) : undefined,signal:AbortSignal.timeout(path.endsWith('preview') ? 30000 : 12000)});
}
app.get('/api/voices',async c=>{
  try {
    const res=await voiceRequest('/v1/voices');
    if (!res.ok) throw Error();
    const data=await res.json();
    if (!Array.isArray(data.voices) || !data.voices.some((v:{id:string})=>v.id===data.active)) throw Error();
    return c.json({active:data.active,voices:data.voices.map((v:{id:string;name:string;description?:string})=>({
      id:v.id,name:v.name,description:v.description||''}))});
  } catch {return c.json({error:'暂时无法读取合成服务的音色'},503);}
});
app.put('/api/voices/active',async c=>{
  const data=await c.req.json().catch(()=>({}));
  if (!voiceId(data.id)||!voiceId(data.previous)) return c.json({error:'音色参数无效'},400);
  if (workerSnapshot().jobs!==0) return c.json({error:'请在 Worker 已注册且通话全部结束后切换音色'},409);
  try {
    const res=await voiceRequest('/v1/voices/active','PUT',{id:data.id,previous:data.previous});
    if (res.status===409) return c.json({error:'当前音色已变化，请重新读取后再应用'},409);
    if ([400,404,422].includes(res.status)) return c.json({error:'该音色不可用'},400);
    if (!res.ok) throw Error();
    const check=await voiceRequest('/v1/voices');
    if (!check.ok || (await check.json()).active!==data.id) throw Error();
    return c.json({active:data.id});
  } catch {return c.json({error:'未取得合成服务的生效确认，请重新读取'},503);}
});
function providerFail(c: {json: (body: object, status: number) => Response}, error: unknown) {
  if (error instanceof ProviderError) {
    return c.json(error.revision === undefined ? {error: error.message} : {error: error.message, revision: error.revision}, error.status);
  }
  return c.json({error:'供应商配置暂时无法处理'}, 503);
}
const providersFile = () => process.env.PERSONAL_PROVIDERS_FILE || '';
app.get('/api/providers', c => {
  const file = providersFile();
  if (!file) return c.json({error:'未配置供应商文件'}, 503);
  try {
    const loaded = readDocument(file);
    return c.json(publicView(loaded.doc, loaded.persisted));
  } catch (error) { return providerFail(c, error); }
});
app.post('/api/providers', async c => {
  const file = providersFile();
  if (!file) return c.json({error:'未配置供应商文件'}, 503);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({error:'请求无效'}, 400);
  try { return c.json(await withProviders(file, doc => createProfile(doc, body as Record<string, unknown>))); }
  catch (error) { return providerFail(c, error); }
});
app.put('/api/providers/active/:kind', async c => {
  const file = providersFile();
  if (!file) return c.json({error:'未配置供应商文件'}, 503);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({error:'请求无效'}, 400);
  try { return c.json(await withProviders(file, doc => activateProfile(doc, c.req.param('kind'), body as Record<string, unknown>, workerSnapshot().jobs === 0))); }
  catch (error) { return providerFail(c, error); }
});
app.put('/api/providers/:id', async c => {
  const file = providersFile();
  if (!file) return c.json({error:'未配置供应商文件'}, 503);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({error:'请求无效'}, 400);
  try { return c.json(await withProviders(file, doc => updateProfile(doc, c.req.param('id'), body as Record<string, unknown>, workerSnapshot().jobs === 0))); }
  catch (error) { return providerFail(c, error); }
});
app.post('/api/voices/preview',async c=>{
  const data=await c.req.json().catch(()=>({}));
  if (!voiceId(data.id)) return c.json({error:'请选择音色'},400);
  try {
    const res=await voiceRequest('/v1/voices/preview','POST',{id:data.id});
    if ([400,404,422].includes(res.status)) return c.json({error:'该音色不可用'},400);
    if (!res.ok || !/^audio\/(x-)?wav/i.test(res.headers.get('content-type')||'')) throw Error();
    return new Response(res.body,{headers:{'Content-Type':'audio/wav','Cache-Control':'no-store'}});
  } catch {return c.json({error:'试听暂时无法生成'},503);}
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
const server=serve({fetch:app.fetch,port:8443,createServer,serverOptions:{cert:readFileSync('/run/private/cert.pem'),key:readFileSync('/run/private/key.pem')}});
if(upgradeTalk) server.on('upgrade',upgradeTalk);
