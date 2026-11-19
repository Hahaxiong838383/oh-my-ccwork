const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const root=path.resolve(__dirname,'../public/admin'),sn='BJP00326060100100004';
const lane=process.env.SEARCH_TEST_LANE==='p1'?'p1':'p2',endpoint='/api/admin/search-canary'+(lane==='p1'?'/p1':'')+'/routing';
const defaults=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../server/src/tools/search-routing-defaults.json'),'utf8'));
(async()=>{
 const server=http.createServer((q,r)=>{const f=q.url.startsWith('/admin/vendor/')?path.join(root,q.url.slice(7)):path.join(root,'index.html');r.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');r.end(fs.readFileSync(f));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await webkit.launch({headless:true});
 try{
  const ctx=await browser.newContext({viewport:{width:1450,height:1050}});await ctx.addInitScript(()=>{localStorage.setItem('kidshub_admin_token','synthetic');localStorage.setItem('kidshub_admin_role','admin');});
  let state={ok:true,revision:0,draft:defaults,eligible_sns:[sn],versions:[],targets:[],loads:[],history:[],locations:[{sn,state:'ready',city:'北京市',provider:'ip9',observed_at:Date.now(),expires_at:Date.now()+60000}]},writes=[],fail=false;
  await ctx.route('**/api/**',async route=>{
   const u=new URL(route.request().url()),method=route.request().method();
   if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role:'admin',username:'合成验收'}});
   if(u.pathname==='/api/admin/search-canary')return route.fulfill({json:{ok:true,selected_sn:sn,devices:[{sn,eligible:true}],summary:{state:'p1',health_ok:true,lease_ok:true,configured_devices:[sn],dispatch_requested:true},prepared_sn:sn,issues:[],acceptance:'待真机验收'}});
   if(u.pathname==='/api/admin/search-canary/p1')return route.fulfill({json:{ok:true,observed_at_ms:Date.now(),settings:{configured:true,enabled:true,scope:'all_registered'},devices:[],release:null,tasks:{loaded:false,recent:[]},issues:[]}});
   if(u.pathname.startsWith(endpoint)){
    if(fail)return route.fulfill({json:{ok:false,error:'synthetic-unavailable'}});
    if(method==='GET')return route.fulfill({json:state});
    const body=route.request().postDataJSON();writes.push({path:u.pathname,body});
    if(u.pathname.endsWith('/preview'))return route.fulfill({json:{ok:true,decisions:body.utterances.map(u=>u.text.includes('画了一只猫')?{action:'chat',rule_id:'protected',reason:'普通聊天或保护表达'}:{action:'search',rule_id:'natural-weather',reason:'命中路由',weather:{city_name:'北京市',day_offset:0}})}});
    assert.equal(body.expected_revision,state.revision);
    if(u.pathname.endsWith('/draft'))state.draft=body.config;
    if(u.pathname.endsWith(lane==='p1'?'/publish-all':'/publish')){if(lane==='p1')assert.deepEqual(Object.keys(body),['expected_revision']);else assert.deepEqual(body.sns,[sn]);state.versions=[{version:'r7-'+'a'.repeat(24),created_at:Date.now()}];state.targets=[{sn:lane==='p1'?'*':sn,version:state.versions[0].version}];}
    state.revision++;return route.fulfill({json:state});
   }
   return route.fulfill({json:{ok:true,items:[],devices:[],profiles:[],themes:[]}});
  });
  await ctx.route('https://**',r=>r.fulfill({json:{type:'FeatureCollection',features:[]}}));
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/admin/');await page.waitForFunction(()=>document.querySelector('#app').__vue_app__);
  await page.evaluate(lane=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('search-canary');p.setSearchLane(lane);},lane);
  await page.getByText('尚未发布，Worker 使用保守内置路由。',{exact:true}).waitFor();
  await page.getByText(/已定位（城市级估计）.*北京市/).waitFor();
  await page.getByLabel('未指定城市时按设备网络自动定位（IP9）',{exact:true}).check();
  await page.getByLabel('触发表达 extra-explicit',{exact:true}).fill('帮我了解一下、帮我打听一下');
  assert.equal(await page.getByRole('button',{name:'校验并发布路由',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'预览路由（不执行搜索）',exact:true}).click();await page.getByText('预览完成，没有执行搜索',{exact:true}).waitFor();assert.equal(state.revision,0);
  await page.getByRole('button',{name:'保存路由草稿',exact:true}).click();await page.getByText('草稿已保存，运行版本未改变',{exact:true}).waitFor();assert.equal(state.revision,1);assert.equal(state.draft.auto_location_enabled,true);
  await page.getByRole('button',{name:'校验并发布路由',exact:true}).click();await page.getByText('路由已发布；等待 Worker 加载确认，不等于真机实听通过',{exact:true}).waitFor();assert.equal(state.revision,2);
  await page.getByLabel('历史路由版本',{exact:true}).selectOption(state.versions[0].version);await page.getByRole('button',{name:lane==='p1'?'回滚全量路由':'回滚所选设备',exact:true}).click();await page.getByText(lane==='p1'?'全量路由已回滚发布，等待 Worker 确认':'所选设备已回滚发布，等待 Worker 确认',{exact:true}).waitFor();assert.equal(state.revision,3);
  if(process.env.SCREENSHOT)await page.locator('.routing-panel').screenshot({path:process.env.SCREENSHOT});
  await page.setViewportSize({width:430,height:960});assert(await page.getByLabel('触发表达 natural-weather',{exact:true}).isVisible());
  fail=true;await page.getByRole('button',{name:'刷新路由状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'synthetic-unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'校验并发布路由',exact:true}).count(),0);
  assert.equal(writes.length,4);assert(writes.every(w=>w.path.startsWith(endpoint)));if(lane==='p1')assert.deepEqual(Object.keys(writes[3].body).sort(),['expected_revision','version']);assert.deepEqual(errors,[]);console.log(lane,'PASS routing UI: edit/preview without task/save/publish/rollback/narrow/error state');await ctx.close();
 } finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
