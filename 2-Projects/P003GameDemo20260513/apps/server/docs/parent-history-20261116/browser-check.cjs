// Read-only real-production UI check. No tokens, device notes, or conversation text in output.
const {chromium}=require('/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const {execFileSync}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const token=execFileSync('ssh',['-o','ProxyCommand=none','-o','BatchMode=yes','aliyun-hk','cat /root/p003-parent-history-20261116/browser-token.private'],{encoding:'utf8'}).trim();
 const browser=await chromium.launch({headless:true,executablePath:'/Users/fu-121/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addInitScript(t=>localStorage.setItem('xiaoke.bff.session',JSON.stringify({data:t})),token);
 const page=await context.newPage();const errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.name));
 // Browser CORS transport harness only: fetch exact production GET bodies, never mock business data.
 await page.route('https://kidshub-ai.hahaxiong.cc/**',async route=>{
  const req=route.request();assert(['GET','OPTIONS'].includes(req.method()),'read-only harness');
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET'}});
  const res=await route.fetch();calls.push({path:new URL(req.url()).pathname,status:res.status()});
  await route.fulfill({response:res,headers:{...res.headers(),'access-control-allow-origin':'*'}});
 });
 try{
  await page.goto('http://127.0.0.1:18743/',{waitUntil:'networkidle'});
  await page.getByText('查看历史对话',{exact:true}).waitFor({timeout:20000});
  const fullText=await page.locator('body').innerText();
  assert(fullText.includes('184 条'),'real historical count');
  assert(fullText.includes('今日 暂无数据'),'missing duration must not be fabricated zero');
  await page.getByText('查看历史对话',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.live-history-entry').length===20);
  let clicks=0;
  while(await page.getByText('加载更多',{exact:true}).count()){
   const n=await page.locator('.live-history-entry').count();
   await page.getByText('加载更多',{exact:true}).click();
   await page.waitForFunction(previous=>document.querySelectorAll('.live-history-entry').length>previous,n);
   clicks++;assert(clicks<11);
  }
  assert.equal(await page.locator('.live-history-entry').count(),184);
  await page.getByText('查询 / 刷新',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.live-history-entry').length===20);
  await page.getByText('收起对话记录',{exact:true}).click();
  await page.getByText('查看已同步业务流水',{exact:true}).click();
  await page.getByText('暂无符合条件的已同步记录',{exact:true}).waitFor();
  await page.getByText('退出登录',{exact:true}).click();
  await page.getByText('登录内测账号',{exact:true}).waitFor();
  assert.equal(await page.locator('.live-history-entry').count(),0);
  assert.equal(await page.getByText('查看历史对话',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);assert(calls.every(x=>x.status===200));
  const result={at_ms:Date.now(),pass:true,harness:'H5 production GET bodies, browser CORS header only',real_mobile_login:false,sms_sent:false,business_writes:false,history_rendered:184,history_pages:clicks+1,refresh_first_page:20,business_records_empty:true,missing_duration_preserved:true,logout_cleared:true,page_errors:errors,requests:calls};
  writeFileSync(__dirname+'/BROWSER-CHECK.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
