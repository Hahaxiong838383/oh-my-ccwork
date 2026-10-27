const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const root=path.resolve(__dirname,'../public/admin'),sn='BJP00326070803800006',other='BJP00326060100200003';
(async()=>{
 const server=http.createServer((q,r)=>{const f=q.url.startsWith('/admin/vendor/')?path.join(root,q.url.slice('/admin/'.length)):path.join(root,'index.html');r.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');r.end(fs.readFileSync(f));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port,browser=await webkit.launch({headless:true});
 try{
  for(const role of ['admin','editor']){
   const ctx=await browser.newContext({viewport:{width:1450,height:1050}});let selected=sn,fail=false,writes=[],p1Enabled=true,p1Excluded=false,p1Writes=[];const errors=[];
   await ctx.addInitScript(role=>{localStorage.setItem('kidshub_admin_token','synthetic');localStorage.setItem('kidshub_admin_role',role);localStorage.setItem('kidshub_admin_username','合成验收');},role);
   const payload=()=>({ok:true,observed_at_ms:Date.now(),selected_sn:selected,prepared_sn:sn,devices:[sn,other].map(sn=>({sn,eligible:true,version_code:353,version_name:'synthetic-version',version_reported_at_ms:Date.now()})),summary:{state:'closed',health_ok:true,lease_ok:true,dispatch_requested:false,expires_at_ms:null,configured_devices:[]},release:{verified_at_ms:Date.now(),brain_commit:'synthetic',worker_commit:'synthetic',worker_sha256:'a'.repeat(64),worker_tests:354},issues:[{title:'同机基线待取证',detail:'合成场景',status:'待真机'}],acceptance:'待真机验收',window_started_at_ms:null});
   await ctx.route('**/api/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role,username:'合成验收'}});if(u.pathname==='/api/admin/search-canary/p1')return route.fulfill({json:{ok:true,lane:'p1',observed_at_ms:Date.now(),settings:{enabled:p1Enabled,configured:true,scope:'all_registered',tools:false},devices:[{sn,eligible:true,excluded:p1Excluded,search_allowed:p1Enabled&&!p1Excluded,version_code:353,version_name:'synthetic',version_reported_at_ms:Date.now()}],release:null,issues:['合成待验项目'],tasks:{loaded:false,recent:[]}}});if(u.pathname.startsWith('/api/admin/search-canary/p1/')&&route.request().method()==='PUT'){const b=route.request().postDataJSON();p1Writes.push(b);if(u.pathname.endsWith('/enabled')){assert.deepEqual(Object.keys(b),['enabled']);p1Enabled=b.enabled;}else{assert.deepEqual(Object.keys(b),['excluded']);p1Excluded=b.excluded;}return route.fulfill({json:{ok:true}});}if(u.pathname==='/api/admin/search-canary/device'){const b=route.request().postDataJSON();assert.deepEqual(Object.keys(b),['sn']);selected=b.sn;writes.push(b);return route.fulfill({json:{ok:true,selected_sn:selected,activated:false}});}if(u.pathname==='/api/admin/search-canary')return route.fulfill({json:fail?{ok:false,error:'测试不可用'}:payload()});return route.fulfill({json:{ok:true,items:[],devices:[],profiles:[],themes:[]}});});
   await ctx.route('https://**',route=>route.fulfill({json:{type:'FeatureCollection',features:[]}}));
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/admin/');await page.waitForFunction(()=>document.querySelector('#app').__vue_app__);
   await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('search-canary');});
   if(role!=='admin'){assert.equal(await page.locator('.canary-panel').count(),0);await ctx.close();continue;}
   await page.getByText('P1 开放范围',{exact:true}).waitFor();
   assert.equal(await page.locator('#canary-device').count(),0,'P2 controls must not appear on P1');
   await page.getByRole('button',{name:'排除搜索',exact:true}).click();await page.getByText('单机已排除',{exact:true}).waitFor();assert.equal(p1Writes.length,1);assert.equal(writes.length,0);
   await page.getByRole('button',{name:'关闭 P1 搜索',exact:true}).click();await page.getByText('P1 搜索未开启',{exact:true}).waitFor();assert.equal(p1Writes.length,2);assert.equal(writes.length,0);
   await page.getByRole('button',{name:'P2 双设备灰度',exact:true}).click();
   await page.getByText('正式窗口未开启',{exact:true}).waitFor();assert.equal(await page.locator('#canary-device').inputValue(),sn);
   await page.locator('#canary-device').selectOption(other);await page.getByRole('button',{name:'保存待测设备',exact:true}).click();await page.waitForFunction(s=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.canary.data.selected_sn===s,other);assert.equal(writes.length,1);assert.equal(writes[0].sn,other);
   await page.locator('#canary-device').selectOption(sn);await page.getByRole('button',{name:'保存待测设备',exact:true}).click();await page.waitForFunction(s=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.canary.data.selected_sn===s,sn);
   if(process.env.SCREENSHOT)await page.locator('.canary-panel').screenshot({path:process.env.SCREENSHOT});
   await page.setViewportSize({width:430,height:960});assert(await page.locator('#canary-device').isVisible());
   fail=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'测试不可用'}).waitFor();assert.equal(await page.getByText('正式窗口未开启',{exact:true}).count(),0);
   assert.deepEqual(errors,[]);await ctx.close();
  }
  console.log('PASS P1/P2 UI: separate tabs, P1 master/exclusion do not write P2, full Vue render, default device, manual save, no activation payload, error clears stale state, editor denied, narrow viewport');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
