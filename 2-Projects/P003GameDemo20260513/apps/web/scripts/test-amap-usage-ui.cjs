const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const root=path.resolve(__dirname,'../public/admin');
(async()=>{
 const server=http.createServer((q,r)=>{const f=q.url.startsWith('/admin/vendor/')?path.join(root,q.url.slice('/admin/'.length)):path.join(root,'index.html');r.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');r.end(fs.readFileSync(f));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,browser=await webkit.launch({headless:true});
 try{for(const role of ['admin','editor']){
  const ctx=await browser.newContext({viewport:{width:1450,height:1050}}),errors=[];let remaining=4998,revision=5,fail=false,drop=true,writes=[],seen=new Set();
  const snapshot=()=>({ok:true,remaining,revision,registered_total:remaining+2,weather_requests:2,geocode_requests:2,weather_successes:2,weather_rejected:0,weather_unconfirmed:0,observed_at_ms:Date.now(),history:[],estimate:true,runtime:{enabled:true,key_configured:true}});
  await ctx.addInitScript(role=>{localStorage.setItem('kidshub_admin_token','synthetic');localStorage.setItem('kidshub_admin_role',role);localStorage.setItem('kidshub_admin_username','合成验收');},role);
  await ctx.route('**/api/**',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role,username:'合成验收'}});
   if(u.pathname==='/api/admin/search-canary/amap-usage'){
    if(route.request().method()==='POST'){
     const b=route.request().postDataJSON();writes.push(b);
     if(!seen.has(b.request_id)){assert.equal(b.expected_revision,revision);seen.add(b.request_id);remaining=b.mode==='add'?remaining+b.amount:b.amount;revision++;}
     if(drop){drop=false;return route.abort();}return route.fulfill({json:snapshot()});
    }return route.fulfill({json:fail?{ok:false}:snapshot()});
   }
   if(u.pathname==='/api/admin/search-canary/p1')return route.fulfill({json:{ok:true,observed_at_ms:Date.now(),settings:{enabled:true,scope:'all_registered'},devices:[],tasks:{recent:[]},issues:[]}});
   return route.fulfill({json:{ok:true,items:[],devices:[],profiles:[],themes:[]}});
  });await ctx.route('https://**',r=>r.fulfill({json:{type:'FeatureCollection',features:[]}}));
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/admin/');await page.waitForFunction(()=>document.querySelector('#app').__vue_app__);
  await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('search-canary');});
  if(role==='editor'){assert.equal(await page.locator('[aria-label="高德天气额度"]').count(),0);await ctx.close();continue;}
  const card=page.locator('[aria-label="高德天气额度"]');await card.getByText('4,998 次',{exact:true}).waitFor();
  await page.locator('#amap-adjust-amount').fill('-1');assert(await card.getByRole('button',{name:'登记额度',exact:true}).isDisabled());
  await page.locator('#amap-adjust-amount').fill('1000');await card.getByRole('button',{name:'登记额度',exact:true}).click();
  await card.getByRole('button',{name:'重试本次登记',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._container._vnode.component.proxy.amapUsage.saving);
  assert(await page.locator('#amap-adjust-amount').isDisabled());await card.getByRole('button',{name:'重试本次登记',exact:true}).click();await card.getByText('5,998 次',{exact:true}).waitFor();
  assert.equal(writes.length,2);assert.equal(writes[0].request_id,writes[1].request_id);assert.equal(remaining,5998);
  await page.locator('#amap-adjust-mode').selectOption('set_remaining');await page.locator('#amap-adjust-amount').fill('4800');await card.getByRole('button',{name:'登记额度',exact:true}).click();await card.getByText('4,800 次',{exact:true}).waitFor();
  if(process.env.SCREENSHOT)await card.screenshot({path:process.env.SCREENSHOT});
  await page.setViewportSize({width:430,height:960});assert(await page.locator('#amap-adjust-amount').isVisible());
  fail=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await card.getByRole('alert').waitFor();assert.equal(await card.locator('[data-testid="amap-remaining"]').count(),0);
  assert.deepEqual(errors,[]);await ctx.close();
 }}finally{await browser.close();await new Promise(r=>server.close(r));}
 console.log('PASS quota UI: estimate label, add, lost response/idempotent retry, calibration, invalid input, unavailable clears balance, editor blocked, narrow viewport');
})().catch(e=>{console.error(e);process.exitCode=1;});
