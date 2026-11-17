// Read-only production probe for the already-built H5. No business fixtures, screenshots, or raw payload artifacts.
// Auth JSON is {parent, public_id, sn}; the short-lived server validation session is deleted in finally.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require(process.env.P003_PLAYWRIGHT_MODULE||'/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const taskDir=process.env.P003_TASK_DIR||'/Users/fu-121/.local/state/p003-history-identity-fix-20261117';
const app=process.env.P003_MINIAPP_DIR||path.resolve(process.cwd(),'2-Projects/P003GameDemo20260513/apps/miniapp');
const authPath=path.join(taskDir,'h5-auth.private'),base='https://kidshub-ai.hahaxiong.cc';
const evidence={pass:false,at:new Date().toISOString(),session_type:'short-lived server validation session, not real human login',business_writes:0,attempted_business_writes:0,response_body_replacements:0,page_errors:0,requests:[],checks:{},screenshots_saved:0};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let stage='initialization',browser,server,auth,latestDashboard,identity,configuration,observationPages=[],networkErrors=0;
function check(name,value){evidence.checks[name]=Boolean(value);if(!value)throw new Error(name);}
const duration=n=>n<60?`${Math.floor(n)} 秒`:n%60?`${Math.floor(n/60)} 分 ${Math.floor(n%60)} 秒`:`${Math.floor(n/60)} 分钟`;
(async()=>{
 try {
  auth=JSON.parse(fs.readFileSync(authPath,'utf8'));
  check('auth_file_valid',typeof auth.parent==='string'&&Boolean(auth.public_id)&&Boolean(auth.sn));
  const storage=fs.readFileSync(path.join(app,'node_modules/@tarojs/taro-h5/dist/api/storage/index.js'),'utf8');
  check('storage_format_verified_in_installed_taro',storage.includes('obj = { data };')&&storage.includes('localStorage.setItem(key, JSON.stringify(obj))'));
  const root=path.join(app,'dist/h5');
  evidence.index_sha256=sha(fs.readFileSync(path.join(root,'index.html')));
  server=http.createServer((req,res)=>{try{
   if(req.method!=='GET'){res.writeHead(405);return res.end();}
   const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname),file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
   if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
   const ext=path.extname(file),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
   res.setHeader('content-type',types[ext]||'application/octet-stream');res.end(fs.readFileSync(file));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.P003_CHROMIUM_PATH||'/Users/fu-121/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.addInitScript(({origin,session})=>{if(location.origin===origin)localStorage.setItem('xiaoke.bff.session',JSON.stringify({data:session}));},{origin:local,session:auth.parent});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',()=>evidence.page_errors++);
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),method=request.method();
   if(url.origin===local&&method==='GET')return route.continue();
   if(url.origin!==base){networkErrors++;return route.abort();}
   if(method==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,OPTIONS','access-control-allow-headers':'*'}});
   if(method!=='GET'){evidence.attempted_business_writes++;return route.abort();}
   try{
    const reqHeaders=await request.allHeaders();const headers={accept:'application/json'};
    if(reqHeaders.authorization)headers.authorization=reqHeaders.authorization;
    if(reqHeaders['x-request-id'])headers['x-request-id']=reqHeaders['x-request-id'];
    const upstream=await fetch(request.url(),{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    const bytes=Buffer.from(await upstream.arrayBuffer()),json=JSON.parse(bytes.toString('utf8'));
    const entry={path:url.pathname,has_cursor:url.searchParams.has('cursor'),method,status:upstream.status,no_store:(upstream.headers.get('cache-control')||'').includes('no-store'),body_sha256:sha(bytes)};
    evidence.requests.push(entry);
    if(url.pathname===`/v1/parent/devices/${auth.public_id}/dashboard`)latestDashboard=json.data;
    if(url.pathname==='/api/auth/wechat/identity')identity=json.wechat_identity;
    if(url.pathname==='/api/auth/wechat/config')configuration=json;
    if(url.pathname===`/v1/parent/devices/${auth.public_id}/observations`){observationPages.push(json.data);entry.items=json.data?.items?.length;entry.has_more=json.data?.has_more;}
    // Pass upstream bytes unchanged; the only HTTP metadata addition is CORS for this local harness.
    const responseHeaders=Object.fromEntries(upstream.headers);delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];delete responseHeaders['transfer-encoding'];
    responseHeaders['access-control-allow-origin']='*';
    await route.fulfill({status:upstream.status,headers:responseHeaders,body:bytes});
   }catch{networkErrors++;await route.abort().catch(()=>{});}
  });
  stage='load frozen H5 and production dashboard';
  await page.goto(local+'/',{waitUntil:'networkidle'});
  const selected=page.locator('.live-device-row').filter({hasText:'设备尾号 '+auth.sn.slice(-6)});
  await selected.waitFor();if(!(await selected.getAttribute('class')).includes('selected'))await selected.click();
  await page.getByText('历史奖励与道具',{exact:true}).waitFor();
  check('production_C_dashboard_loaded',Boolean(latestDashboard));
  const data=latestDashboard,body=await page.locator('body').innerText();
  evidence.usage={today_seconds:data.usage.today.total_seconds,historical_seconds:data.historical_usage.total_seconds};
  check('today_duration_matches_production',body.includes('今日 '+duration(data.usage.today.total_seconds)));
  check('historical_duration_matches_production',body.includes('已同步历史 '+duration(data.historical_usage.total_seconds)));
  const card=page.locator('.card').filter({has:page.getByText('历史奖励与道具',{exact:true})});
  const historyBody=await card.innerText();
  evidence.observation_counts=data.observations.counts;
  for(const [label,key] of [['奖励记录','rewards'],['库存变化','inventory'],['补勤卡变化','makeup_cards']])check('history_count_'+key,historyBody.includes(label)&&historyBody.includes(data.observations.counts[key]+' 条'));
  check('history_rewards_and_inventory_visible',data.observations.counts.rewards>0&&data.observations.counts.inventory>0&&(await card.locator('.live-history-entry').count())>=2);
  check('wallet_unknown_note',body.includes('不能据此认定家族币或星尘为 0'));
  check('partial_history_note',body.includes('历史可能不完整，记录数不是累计获得数量'));
  check('current_wallet_not_fabricated',!(data.ark.available&&data.ark.source_mode==='normal')||data.ark.wallets?.family_coin===null&&data.ark.wallets?.stardust===null);
  check('wechat_configuration_pending_visible',body.includes('微信登录配置待完成')&&body.includes('服务端微信登录凭据待配置；已有设备数据仍可查看'));
  check('wechat_app_id_visible',body.includes('wx8b0ce82f18ab2f29'));
  check('H5_no_wechat_phone_authorization_button',!body.includes('微信手机号授权登录'));
  stage='read real WeChat configuration';
  await page.evaluate(async base=>{const r=await fetch(base+'/api/auth/wechat/config');await r.arrayBuffer();},base);
  check('wechat_config_actual_app_id',configuration?.app_id==='wx8b0ce82f18ab2f29');
  check('wechat_missing_app_secret',configuration?.configuration_status==='missing_app_secret'&&configuration?.configured===false);
  evidence.wechat={app_id:configuration.app_id,configured:configuration.configured,configuration_status:configuration.configuration_status,state:identity?.state,real_wechat_authorization_performed:false};
  stage='native observations pagination';
  await page.getByText('查看全部已同步历史',{exact:true}).click();
  await page.getByText('加载更多',{exact:true}).waitFor();
  let previousCount=0;
  while(true){
   const last=observationPages.at(-1);check('observations_page_received',Boolean(last));
   check('observation_rows_match_loaded_pages',(await page.locator('.live-history .live-history-entry').count())===observationPages.reduce((s,p)=>s+p.items.length,0));
   if(!last.has_more)break;
   check('pagination_bounded',observationPages.length<12);
   previousCount=observationPages.length;
   await page.getByText('加载更多',{exact:true}).click();
   await page.waitForFunction(()=>!document.body.innerText.includes('正在读取记录…'));
   await page.waitForTimeout(100);
   check('pagination_new_page',observationPages.length>previousCount);
  }
  await page.getByText('已显示本次查询全部已同步记录',{exact:true}).waitFor();
  check('independent_observations_endpoint_and_cursor',evidence.requests.some(x=>x.path.endsWith('/observations')&&x.has_cursor));
  const ids=observationPages.flatMap(p=>p.items.map(x=>x.event_id));
  check('observations_no_duplicate_records',new Set(ids).size===ids.length);
  evidence.observations={pages:observationPages.length,displayed_records:ids.length,final_has_more:observationPages.at(-1).has_more};
  stage='logout and final safety assertions';
  await page.getByText('退出登录',{exact:true}).click();await page.getByText('短信登录',{exact:true}).waitFor();
  check('logout_clears_displayed_history',!(await page.locator('body').innerText()).includes('历史奖励与道具'));
  check('logout_clears_taro_session',await page.evaluate(()=>localStorage.getItem('xiaoke.bff.session')===null));
  check('all_production_responses_200',evidence.requests.every(x=>x.status===200));
  check('no_network_failures',networkErrors===0);check('no_page_errors',evidence.page_errors===0);check('no_attempted_business_writes',evidence.attempted_business_writes===0);
  evidence.pass=true;
 }catch(error){evidence.failure={stage,type:error.name,check:error.name==='Error'?error.message:'browser verification step failed'};process.exitCode=1;}
 finally{
  await browser?.close().catch(()=>{});if(server)await new Promise(resolve=>server.close(resolve));
  fs.rmSync(authPath,{force:true});evidence.auth_file_removed=!fs.existsSync(authPath);evidence.production_http_gets=evidence.requests.length;
  fs.writeFileSync(path.join(taskDir,'LIVE-H5-PROBE.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(evidence,null,2));
 }
})();
