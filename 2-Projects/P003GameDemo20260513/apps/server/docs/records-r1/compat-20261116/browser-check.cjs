// Real-production GET UI check. Only browser CORS headers are added; response bodies stay untouched.
// Token/owner IDs/child text remain in memory; no screenshots, traces, or raw bodies are persisted.
const { chromium } = require('/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve, join, extname, sep } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const DIST = resolve(__dirname, '../../../../miniapp/dist/h5');
const D = '/root/p003-records-compat-20261116';
const API = 'https://kidshub-ai.hahaxiong.cc';
const C = 'dev_50b5415662259045';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function manifest(dir) {
 const out=[]; for(const name of readdirSync(dir).sort()) {
  const p=join(dir,name); if(statSync(p).isDirectory()) out.push(...manifest(p));
  else out.push({path:p.slice(DIST.length+1),sha256:sha(readFileSync(p))});
 } return out;
}
(async()=>{
 const artifact=manifest(DIST), started=Date.now();
 assert(artifact.some(x=>x.path==='index.html'),'fresh H5 artifact missing');
 const token=execFileSync('ssh',['-o','ProxyCommand=none','-o','BatchMode=yes','-o','ConnectTimeout=8','aliyun-hk','cat '+D+'/browser-token.private'],{encoding:'utf8'}).trim();
 const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
 const server=createServer((req,res)=>{
  const p=resolve(DIST,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));
  if(!(p.startsWith(DIST+sep))){res.writeHead(403);return res.end();}
  try {const body=readFileSync(p);res.writeHead(200,{'content-type':types[extname(p)]||'application/octet-stream','cache-control':'no-store'});res.end(body);}
  catch {res.writeHead(404);res.end();}
 });
 let browser, context, cleanup=false;const errors=[],calls=[],snapshots=[];let blockedWrites=0;
 const evidence={started_at_ms:started,pass:false,harness:'fresh live H5; exact production GET response bodies; CORS headers only',real_mobile_login:false,sms_sent:false,business_writes:false,artifact_manifest_sha256:sha(JSON.stringify(artifact)),artifact_files:artifact.length};
 try {
  await new Promise((done,reject)=>{server.once('error',e=>{if(e.code==='EADDRINUSE')server.listen(0,'127.0.0.1',done);else reject(e);});server.listen(18744,'127.0.0.1',done);});
  const port=server.address().port;assert.notEqual(port,18743);evidence.local_port=port;evidence.fresh_server=true;
  browser=await chromium.launch({headless:true,executablePath:'/Users/fu-121/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
  context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(t=>localStorage.setItem('xiaoke.bff.session',JSON.stringify({data:t})),token);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.name));
  await page.route(API+'/**',async route=>{
   const req=route.request();if(!['GET','OPTIONS'].includes(req.method())){blockedWrites++;return route.abort();}
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET'}});
   const res=await route.fetch(),url=new URL(req.url());let value;try{value=await res.json();}catch{}
   calls.push({path:url.pathname,status:res.status()});
   if(url.pathname===`/v1/parent/devices/${C}/conversations`) snapshots.push({cursor:!!url.searchParams.get('cursor'),count:value?.data?.message_count,items:value?.data?.items?.length,has_more:value?.data?.has_more,ids:(value?.data?.items||[]).map(x=>x.id)});
   if(url.pathname===`/v1/parent/devices/${C}/dashboard`){evidence.dashboard_history_count=value?.data?.conversations?.message_count;evidence.usage_today_available=value?.data?.usage?.today?.available;evidence.usage_today_focus_minutes=value?.data?.usage?.today?.focus_minutes??null;}
   await route.fulfill({response:res,headers:{...res.headers(),'access-control-allow-origin':'*'}});
  });
  await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle'});
  await page.getByText('查看历史对话',{exact:true}).waitFor({timeout:20000});
  assert((await page.locator('body').innerText()).includes('今日 暂无数据'),'missing duration preserved');
  assert.equal(evidence.usage_today_available,false,'production usage is unavailable');assert.equal(evidence.usage_today_focus_minutes,null,'production duration is null');
  assert((await page.locator('body').innerText()).includes('已同步 '+evidence.dashboard_history_count+' 条'),'dashboard reflects actual count');
  await page.getByText('查看历史对话',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.live-history-entry').length>0);
  const first=snapshots.find(x=>!x.cursor);assert(first&&Number.isSafeInteger(first.count)&&first.count>0,'real first-page count');
  await page.getByText(new RegExp('本次查询已同步 '+first.count+' 条')).waitFor();
  let clicks=0;
  while(await page.getByText('加载更多',{exact:true}).count()){
   const n=await page.locator('.live-history-entry').count();await page.getByText('加载更多',{exact:true}).click();
   await page.waitForFunction(previous=>document.querySelectorAll('.live-history-entry').length>previous,n);
   clicks++;assert(clicks<=Math.ceil(first.count/20)+1,'pagination bounded by first snapshot');
  }
  assert.equal(await page.locator('.live-history-entry').count(),first.count,'high-watermark snapshot total');
  const firstRun=[...snapshots],ids=firstRun.flatMap(x=>x.ids);assert.equal(new Set(ids).size,first.count,'no duplicate messages');
  const beforeRefresh=snapshots.length;await page.getByText('查询 / 刷新',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.live-history-entry').length===20);
  assert(snapshots.length>beforeRefresh&&!snapshots.at(-1).cursor,'refresh resets cursor');
  await page.getByText('收起对话记录',{exact:true}).click();
  await page.getByText('查看已同步业务流水',{exact:true}).click();
  await page.getByText('暂无符合条件的已同步记录',{exact:true}).waitFor();
  assert.equal(await page.locator('.live-history-entry').count(),0,'business records are truly empty');
  await page.getByText('退出登录',{exact:true}).click();await page.getByText('登录内测账号',{exact:true}).waitFor();
  assert.equal(await page.locator('.live-history-entry').count(),0);assert.equal(await page.getByText('查看历史对话',{exact:true}).count(),0);
  const sessionCleared=await page.evaluate(()=>localStorage.getItem('xiaoke.bff.session')===null);assert(sessionCleared,'logout session cleared');
  assert.deepEqual(errors,[]);assert.equal(blockedWrites,0);assert(calls.every(x=>x.status===200));
  Object.assign(evidence,{pass:true,history_rendered:first.count,history_first_page_total:first.count,history_pages:clicks+1,pagination_no_duplicates:true,refresh_first_page:snapshots.at(-1).items,refresh_total:snapshots.at(-1).count,business_records_empty:true,missing_duration_preserved:true,logout_cleared:true,session_storage_cleared:sessionCleared,page_errors:errors,requests:calls,non_get_requests:blockedWrites});
 } catch(e) {evidence.error_type=e.name;evidence.error_assertion=e instanceof assert.AssertionError?e.message:'browser check failed';process.exitCode=1;}
 finally {
  if(context)await context.close();if(browser)await browser.close();await new Promise(done=>server.close(done));cleanup=true;
  evidence.finished_at_ms=Date.now();evidence.own_server_and_browser_closed=cleanup;
  writeFileSync(__dirname+'/BROWSER-CHECK.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
 }
})().catch(e=>{console.error(e.name+': setup failed');process.exitCode=1;});
