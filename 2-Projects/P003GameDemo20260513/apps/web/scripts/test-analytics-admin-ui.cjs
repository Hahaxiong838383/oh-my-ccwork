/* Browser acceptance with fully stubbed APIs. No real credentials or device writes.
 * node apps/web/scripts/test-analytics-admin-ui.cjs
 * Uses existing PLAYWRIGHT_MODULE (or local cached module), and ASSET_DIR containing
 * vue.js 3.4.21, element.js/css 2.9.1, echarts.js 5.5.0 downloaded from production CDN URLs.
 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),http=require('http');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE || '/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const assetDir=process.env.ASSET_DIR || '/tmp/p003-analytics-ui-assets';
const html=fs.readFileSync(process.env.ANALYTICS_ADMIN_HTML||path.resolve(__dirname,'../public/admin/index.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(match[1].trim())new vm.Script(match[1]);
const health={ok:true,alive:true,ready:true,dependencies_ready:true,storage_ready:true,gate_enabled:false,control_valid:true,allowlist_count:0,in_flight:0,requests:0,storage_failures:0,sql_busy:0,rss_bytes:1000,wal_bytes:0,disk_free_bytes:null,disk_warning:false,processing_p95_ms:null,processing_p99_ms:null,last_rollup_success_ms:null,last_rollup_attempt_ms:null,last_rollup_partial_ms:null,rollup_status:null,rollup_failed_days:0,rollup_remaining_dirty_days:0,last_backup_success_ms:null};
function overview(q,n=0){return {ok:true,from:q.get('from'),to:q.get('to'),dimension:q.get('dimension'),devices:[{device_alias:'设备-012345abcdef'}],event_count:n,active_devices:0,receiving_devices:0,batches:0,accepted:0,duplicated:0,rejected:0,clock_suspicious_events:0,allowlist_count:0,receiving_allowlisted_devices:0,receiving_coverage:null,data_cutoff_ms:null,last_received_at_ms:null,last_batch_received_at_ms:null,rollup:{complete:true,dirty_days:0,clock_dirty_days:0,summary_days:n?1:0,clock_summary_days:n?1:0,updated_at_ms:null,data_cutoff_ms:null,clock_data_cutoff_ms:null},client_pending_known:false};}
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await webkit.launch({headless:true});let checks=0;
 try{
  async function session(role){
   const context=await browser.newContext({viewport:{width:1500,height:1000}}), state={mode:'empty',seen:[],errors:[],control:{revision:0,enabled:true,subjects:['BJP00326070803800006'],hour:23}};
   if(role)await context.addInitScript(role=>{localStorage.setItem('kidshub_admin_token','ui-stub-token');localStorage.setItem('kidshub_admin_role',role);localStorage.setItem('kidshub_admin_username','验收账号');},role);
   await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.hostname==='cdn.jsdelivr.net'){let name=u.pathname.includes('/vue@')?'vue.js':u.pathname.endsWith('index.css')?'element.css':u.pathname.includes('/element-plus@')?'element.js':'echarts.js';return route.fulfill({body:fs.readFileSync(path.join(assetDir,name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});}
    if(u.origin!==origin)return route.fulfill({json:{type:'FeatureCollection',features:[]}});
    if(!u.pathname.startsWith('/api/')&&!u.pathname.startsWith('/v1/'))return route.continue();
    state.seen.push({path:u.pathname,query:u.search,method:req.method()});
    if(u.pathname.startsWith('/v1/device/ark/admin/')){
      if(role!=='admin')return route.fulfill({status:403,json:{ok:false}});
      if(u.pathname.endsWith('/authorize')){state.arkAuthorized=true;state.arkGrantBody=req.postDataJSON();return route.fulfill({json:{ok:true}});}
      if(u.pathname.endsWith('/preview')){const reply=()=>route.fulfill({json:{ok:true,prompt:state.arkAuthorized?'家族币余额：0；数据时间已标注':''}});if(state.mode==='ark-delay'){state.releaseArk=reply;state.pendingReady();return;}return reply();}
    }
    if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role}});
    if(u.pathname==='/api/auth/login')return route.fulfill({json:{ok:true,token:state.loginToken||'new-ui-stub-token',role:'admin'}});
    if(!u.pathname.startsWith('/api/admin/analytics/'))return route.fulfill({json:{ok:true,items:[],devices:[],sessions:[],themes:[]}});
    if(role!=='admin')return route.fulfill({status:403,json:{ok:false,error:'FORBIDDEN'}});
    if(u.pathname.includes('/analytics/tiering/')){
      const sn=u.pathname.split('/')[5];
      state.tiers ||= {};
      const data=state.tiers[sn] ||= {ok:true,sn,revision:1,analytics:{request_gzip_enabled:false,tiering_enabled:false,aggregate_upload_enabled:false,aggregate_period_days:7,aggregate_retention_days:90,aggregate_max_buckets:2048,on_demand_capture_enabled:false,on_demand_upload_enabled:false,on_demand_request_id:'',on_demand_retention_days:3,on_demand_max_events:1000,on_demand_max_bytes:2097152},requests:[],allowed_event_names:['settings.opened'],runtime:{upload_allowed:true,layers:[],transport:[],recent:[],request_usage:[]},client_applied:false};
      if(req.method()==='PUT'){Object.assign(data.analytics,req.postDataJSON().settings);data.revision++;}
      if(req.method()==='POST'){const b=req.postDataJSON();data.requests.push({id:'diag-ui-test',expires_at_ms:Date.now()+60000,revoked_at_ms:null,max_events:b.max_events});data.analytics.on_demand_request_id='diag-ui-test';data.analytics.on_demand_upload_enabled=true;data.revision++;}
      if(req.method()==='DELETE'){data.requests[0].revoked_at_ms=Date.now();data.analytics.on_demand_upload_enabled=false;data.analytics.on_demand_request_id='';data.revision++;}
      if(state.mode==='tier-delay'&&req.method()==='GET'){state.releaseTier=()=>route.fulfill({json:data});state.pendingReady();return;}
      return route.fulfill({json:{...data,runtime:state.mode==='tier-offline'?null:data.runtime}});
    }
    const kind=u.pathname.split('/').pop(),q=u.searchParams;
    if(state.mode==='late401' && kind==='overview'){state.release401=()=>route.fulfill({status:401,json:{ok:false}});state.pendingReady();return;}
    if(state.mode==='error' && kind==='overview')return route.fulfill({status:503,json:{ok:false,error:'analytics_unavailable'}});
    if(state.mode==='unauthorized' && kind==='overview')return route.fulfill({status:401,json:{ok:false}});
    if(kind==='overview'){
     if(state.mode==='finalwave'){
      const cutoff=Date.parse('2026-10-13T02:00:00Z'),batch=Date.parse('2026-10-13T04:00:00Z');let data={...overview(q,4),active_devices:1,batches:1,accepted:0,rejected:2,data_cutoff_ms:cutoff,last_received_at_ms:cutoff,last_batch_received_at_ms:batch,rollup:{complete:true,dirty_days:0,clock_dirty_days:0,summary_days:1,clock_summary_days:1,updated_at_ms:cutoff,data_cutoff_ms:cutoff,clock_data_cutoff_ms:cutoff}};
      if(state.waveCase==='dirty')data={...data,event_count:0,active_devices:0,accepted:3,rejected:0,data_cutoff_ms:null,last_received_at_ms:null,rollup:{complete:false,dirty_days:2,clock_dirty_days:1,summary_days:0,clock_summary_days:0,updated_at_ms:null,data_cutoff_ms:null,clock_data_cutoff_ms:null}};
      if(state.waveCase==='legacy')delete data.rollup;return route.fulfill({json:data});
     }
     if(state.mode==='candidate-error' && q.get('dimension')==='received')return route.fulfill({status:503,json:{ok:false,error:'analytics_unavailable'}});
     if(state.mode==='alias-race' && q.get('dimension')==='received' && q.get('from')==='2026-10-12'){state.pendingCandidates.push(route);state.pendingReady();return;}
     if(['aliases','alias-race','candidate-error'].includes(state.mode))return route.fulfill({json:{...overview(q),devices:q.get('dimension')==='occurred'?[]:[{device_alias:q.get('from')==='2026-10-12'?'设备-111111111111':'设备-abcdef012345'}]}});
     let n=0;if(state.mode==='race'){n=q.get('dimension')==='occurred'?111:222;await new Promise(resolve=>setTimeout(resolve,n===111?350:30));}
     return route.fulfill({json:overview(q,n)});
    }
    if(kind==='daily')return route.fulfill({json:{ok:true,items:state.mode==='daily'?[{day:'2026-10-13',event_count:11,event_counts:{'g1.command_failed':1},active_devices:2,sessions:3,reward_grant_events:4,unique_reward_instances:2,explicit_gm_events:1,unclassified_traffic_events:10,clock_suspicious_events:0,updated_at_ms:Date.now(),groups:{activity:{'app.session_started':3},g1_flow:{'g1.experience_started':2},logical_day_ecotank:{'g1.ecotank_selected':1},rewards_makeup:{'g1.reward_granted':4},settings:{'settings.opened':1},voice_state:{'voice.session_state_changed':2},command_failures:[{command:'advance',error_code:'INVALID_STATE',count:1}]}},{day:'2026-10-12',event_count:5,active_devices:2,sessions:3,reward_grant_events:1,unique_reward_instances:1,updated_at_ms:Date.now(),groups:{}}]:[]}});
    if(kind==='health')return route.fulfill({json:health});
    if(kind==='batches')return route.fulfill({json:{ok:true,limit:25,offset:Number(q.get('offset')),items:[{attempt_id:'attempt-1',request_id:'request-1',batch_id:'batch-1',received_at_ms:Date.now(),sent_at_ms:Date.now(),accepted:1,duplicated:0,rejected:0,device_alias:state.mode==='candidate-error'?'设备-fedcba987654':['aliases','alias-race'].includes(state.mode)?'设备-abcdef012345':'设备-012345abcdef',http_status:200,processing_ms:1,sent_received_skew_ms:0,upload_client:{product:'KidsHubAI-VoiceKit',component:'uploader',protocol_version:'1',content_version:'v1'}}]}});
    if(kind==='events')return route.fulfill({json:{ok:true,id_digest:'safe-digest',events:[],settlements:[{attempt_id:'attempt-1',request_id:'request-1',received_at_ms:Date.now(),device_alias:'设备-012345abcdef',outcome:'rejected',reason:'INVALID_SCHEMA'}]}});
    if(kind==='registry')return route.fulfill({json:{ok:true,event_count:57,schema_version:1,items:[{event_name:'g1.reward_granted',group:'reward',properties_schema:{type:'object',description:'<img src=x onerror=alert(1)>'}}]}});
    if(kind==='storage'){
      state.storage ||= {version:1,revision:0,target_devices:50,archive_enabled:false};
      if(req.method()==='PUT'){const body=req.postDataJSON();state.storagePut=body;if(body.expected_revision!==state.storage.revision)return route.fulfill({status:409,json:{ok:false,error:'STORAGE_POLICY_CONFLICT'}});state.storage={...state.storage,revision:state.storage.revision+1,target_devices:body.target_devices};return route.fulfill({json:{ok:true,policy:state.storage}});}
      const reply=()=>route.fulfill({json:{ok:true,policy:state.storage,profile:{analytics_devices:14,ark_devices:0},enabled:{analytics:1,ark:3},ark_capacity:{max_enabled_devices:3},archive:{enabled:false,state:'not_implemented'}}});
      if(state.mode==='storage-delay'){state.releaseStorage=reply;state.pendingReady();return;}return reply();
    }
    if(kind==='control'){
      if(req.method()==='PUT'){const body=req.postDataJSON();if(body.enabled&&body.subjects.length>1)return route.fulfill({status:409,json:{ok:false,error:'CAPACITY_LIMIT'}});state.control={...body,revision:state.control.revision+1};return route.fulfill({json:{ok:true,policy:state.control}});}
      if(state.mode==='control-delay'){await new Promise(resolve=>{state.releaseControl=resolve;state.pendingReady();});}
      const valid=state.mode!=='invalid-config';return route.fulfill({json:{ok:true,runtime_available:state.mode!=='control-offline',policy:{...state.control,valid,emergency_gate:{enabled:valid,valid}},devices:['BJP00326070803800006','BJP00326081002000026'].map(sn=>({sn,note:sn.endsWith('26')?'另一台测试机':'已有测试机',status:state.mode==='disabled-selected'&&sn.endsWith('26')?'disabled':'active',upload_allowed:state.mode==='control-offline'?null:state.control.enabled&&state.control.subjects.includes(sn)})),capacity:{target_devices:state.storage?.target_devices||50,target_devices_fit:false,target_devices_bytes:(state.storage?.target_devices||50)*123456789,validated_device_limit:14,horizon_days:30,fact_growth_days:30,max_enabled_devices:1,free_bytes:10641600512,db_bytes:106422272,twenty_devices_fit:false,twenty_devices_bytes:115700000000,daily_events_per_device:9000,maintenance_ok:true,checked_at_ms:Date.now()}}});
    }
    if(kind==='collection-config')return route.fulfill({json:{ok:true,server_gate:{enabled:false,valid:state.mode!=='invalid-config'},allowlist_count:0,global:{event_upload_enabled:false,daily_upload_hour_cst:0},device_defaults:{event_upload_enabled:false,daily_upload_hour_cst:23},items:[]}});
   });
   const page=await context.newPage();page.on('pageerror',e=>state.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')state.errors.push(m.text());});await page.goto(origin);await page.waitForFunction(()=>typeof Vue!=='undefined' && document.querySelector('#app').__vue_app__);
   const compile=await page.evaluate(source=>{const dom=new DOMParser().parseFromString(source,'text/html');const template=dom.querySelector('#app').innerHTML;Vue.compile(template);return template.length;},html);assert(compile>100000);checks++;
   return {context,page,state};
  }
  // Final wave: rejected-only receipts advance batch watermark without event cutoff;
  // dirty zero-summary and missing freshness must not present complete zero counts.
  const wave=await session('admin');wave.state.mode='finalwave';wave.state.waveCase='rejected';
  await wave.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});
  await wave.page.waitForFunction(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data);
  const batchNote=wave.page.locator('.analytics-panel .an-note').filter({hasText:'最近批次：'});
  assert.match(await batchNote.innerText(),/最近批次：[^\n]*12:00:00/,'M1: rejected-only batch must advance the independent receipt watermark');
  assert.equal(await wave.page.getByRole('heading',{name:'所选接收窗口尚未接收到设备批次'}).count(),0);checks++;
  wave.state.waveCase='dirty';await wave.page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());
  await wave.page.waitForFunction(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data?.rollup?.dirty_days===2);
  assert((await wave.page.locator('.analytics-panel').innerText()).includes('汇总待更新'),'dirty aggregate must be explicitly pending');
  assert.equal(await wave.page.locator('.analytics-panel .an-stat-value').nth(0).innerText(),'—');assert.equal(await wave.page.locator('.analytics-panel .an-stat-value').nth(1).innerText(),'—');
  assert((await wave.page.locator('.analytics-panel').innerText()).includes('所选维度待更新 2 日'));assert((await wave.page.locator('.analytics-panel').innerText()).includes('可疑时钟接收维度待更新 1 日'));checks++;
  wave.state.waveCase='legacy';await wave.page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());
  await wave.page.waitForFunction(()=>{const d=document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data;return d && !d.rollup;});
  assert((await wave.page.locator('.analytics-panel').innerText()).includes('汇总状态未知'),'missing rollup must not default to complete');assert.equal(await wave.page.locator('.analytics-panel .an-stat-value').nth(1).innerText(),'—');checks++;
  assert.deepEqual(wave.state.errors,[]);await wave.context.close();
  if(process.env.ANALYTICS_REGRESSION_ONLY==='finalwave'){console.log('PASS: finalwave batch watermark, dirty zero-summary pending and unknown freshness');return;}
  // I1 regression: a response from a logged-out session must not revoke a new login.
  // Cover both a changed token and token reuse: epoch must isolate both cases.
  for(const newToken of ['replacement-ui-token','ui-stub-token']){
   const s=await session('admin');s.state.mode='late401';s.state.loginToken=newToken;
   const held=new Promise(resolve=>{s.state.pendingReady=resolve;});
   await s.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});await held;
   await s.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleDropdown('logout');p.loginForm.username='new-stub-account';p.loginForm.password='stub-password';p.handleLogin();});
   await s.page.waitForFunction(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;return p.isLoggedIn && p.currentUser.username==='new-stub-account';});
   const late=s.page.waitForResponse(r=>r.url().includes('/analytics/overview') && r.status()===401);await s.state.release401();await late;await s.page.waitForTimeout(100);
   assert.equal(await s.page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.isLoggedIn),true,'I1: late 401 revoked the new session');
   assert.equal(await s.page.evaluate(()=>localStorage.getItem('kidshub_admin_token')),newToken);
   assert.equal(await s.page.locator('.login-card').count(),0);assert.deepEqual(s.state.errors.filter(e=>!/^Failed to load resource:.*status of 401 /.test(e)),[]);checks++;await s.context.close();
  }
  if(process.env.ANALYTICS_REGRESSION_ONLY==='i1'){console.log('PASS: I1 changed-token and reused-token late 401 isolation');return;}
  // I2 regression: receipt-date candidates are independent of occurred-date facts.
  const aliases=await session('admin');aliases.state.mode='aliases';
  await aliases.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.from='2026-10-13';p.analyticsFilters.to='2026-10-13';p.handleMenuSelect('worker');p.khSelectNav('analytics');});
  await aliases.page.waitForFunction(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;return p.analytics.overview.data && p.analytics.overview.data.devices.length===0;});
  await aliases.page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('batches'));await aliases.page.getByText('attempt-1',{exact:true}).waitFor();
  const aliasLabel=aliases.page.locator('.analytics-panel label').filter({hasText:'设备别名'});
  await aliases.page.waitForTimeout(100);assert.equal(await aliasLabel.locator('option[value="设备-abcdef012345"]').count(),1,'I2: receiving device missing from batch alias candidates');checks++;
  aliases.state.mode='alias-race';aliases.state.pendingCandidates=[];const heldCandidate=new Promise(resolve=>{aliases.state.pendingReady=resolve;});
  await aliases.page.evaluate(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsFilters.from='2026-10-12';});await heldCandidate;
  await aliases.page.evaluate(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsFilters.from='2026-10-13';});
  await aliasLabel.locator('option[value="设备-abcdef012345"]').waitFor({state:'attached'});
  for(const route of aliases.state.pendingCandidates)await route.fulfill({json:{ok:true,devices:[{device_alias:'设备-111111111111'}]}});await aliases.page.waitForTimeout(100);
  assert.equal(await aliasLabel.locator('option[value="设备-abcdef012345"]').count(),1);assert.equal(await aliasLabel.locator('option[value="设备-111111111111"]').count(),0);checks++;
  aliases.state.mode='candidate-error';await aliases.page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());
  await aliases.page.locator('.analytics-panel .an-error').filter({hasText:'设备候选'}).waitFor();assert.equal(await aliasLabel.locator('option').count(),0,'failed candidates must not reuse an old list');
  const aliasQuery=aliases.page.waitForRequest(r=>r.url().includes('/analytics/batches') && new URL(r.url()).searchParams.get('device_alias')==='设备-fedcba987654');
  await aliasLabel.locator('input').fill('设备-fedcba987654');await aliasLabel.locator('input').press('Tab');await aliasQuery;
  assert(aliases.state.seen.some(r=>r.path.endsWith('/batches') && new URLSearchParams(r.query).get('device_alias')==='设备-fedcba987654'),'rejected-only alias must remain queryable');checks++;
  const validRequestCount=aliases.state.seen.filter(r=>r.path.endsWith('/batches')).length;
  await aliasLabel.locator('input').fill('unsafe-full-sn');await aliasLabel.locator('input').press('Tab');await aliases.page.locator('.analytics-panel .an-error').filter({hasText:'筛选无效'}).first().waitFor();
  assert.equal(aliases.state.seen.filter(r=>r.path.endsWith('/batches')).length,validRequestCount,'invalid aliases must never be sent');assert.deepEqual(aliases.state.errors.filter(e=>!/^Failed to load resource:.*status of 503 /.test(e)),[]);checks++;
  assert(aliases.state.seen.filter(r=>r.path.endsWith('/overview') && new URLSearchParams(r.query).get('dimension')==='received').every(r=>!new URLSearchParams(r.query).has('device_alias')));
  await aliases.context.close();
  if(process.env.ANALYTICS_REGRESSION_ONLY==='i2'){console.log('PASS: I2 receipt-date candidates, late candidate isolation and direct alias after candidate failure');return;}
  // v375 real browser controls; all API data here is synthetic.
  const tier=await session('admin'),tp=tier.page;
  const trun=fn=>tp.evaluate(fn);
  await trun(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');p.analyticsSetTab('tiering');});
  await tp.getByRole('button',{name:'保存并回读',exact:true}).waitFor();
  assert.equal(await tp.getByRole('button',{name:'创建并启用短期请求',exact:true}).isDisabled(),true);
  assert(!tier.state.seen.some(r=>r.path.includes('/tiering/')&&r.method!=='GET'));checks++;
  assert((await tp.locator('.analytics-panel').innerText()).includes('创建请求不会立即上传'));checks++;
  await trun(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.anTier.draft.request_gzip_enabled=true;p.anTier.draft.tiering_enabled=true;p.anTier.draft.aggregate_upload_enabled=true;});
  await tp.getByRole('button',{name:'保存并回读',exact:true}).click();
  await tp.waitForFunction(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anTier.data?.revision===2);
  assert((await tp.locator('.analytics-panel').innerText()).includes('设备配置应用与真实上传仍待核验'));checks++;
  await tp.getByRole('button',{name:'创建并启用短期请求',exact:true}).click();await tp.waitForFunction(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anTier.data?.requests.length===1);
  await tp.getByRole('button',{name:'撤销',exact:true}).click();await tp.getByText('已撤销',{exact:false}).waitFor();checks++;
  tier.state.mode='tier-offline';await tp.getByRole('button',{name:'重新读取',exact:true}).click();await tp.getByText('接收服务暂不可达，不能新增开启；仍可保存关闭设置。',{exact:true}).waitFor();
  assert.equal(await tp.getByRole('button',{name:'创建并启用短期请求',exact:true}).isDisabled(),true);
  await tp.screenshot({path:'/tmp/p003-v375-tiering-ui.png',fullPage:true});checks++;
  tier.state.mode='tier-delay';const pendingTier=new Promise(resolve=>tier.state.pendingReady=resolve);await trun(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.loadAnalyticsTier();});await pendingTier;
  await trun(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.handleDropdown('logout'));await tier.state.releaseTier();await tp.waitForTimeout(100);
  assert.equal(await trun(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anTier.data),null);assert.deepEqual(tier.state.errors,[]);checks++;await tier.context.close();
  const guest=await session(null);assert.equal(await guest.page.locator('.login-card').count(),1);assert.equal(await guest.page.locator('.login-card input').count(),2);assert.deepEqual(guest.state.errors,[]);checks++;await guest.context.close();
  const admin=await session('admin'),{page,state}=admin;
  const run=fn=>page.evaluate(fn);
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});
  await page.getByRole('heading',{name:'所选接收窗口尚未接收到设备批次'}).waitFor();assert(await page.locator('.analytics-panel').innerText().then(t=>t.includes('待灰度接收')&&t.includes('未知，需端侧审计')));assert.equal(await page.locator('.analytics-panel .an-stat-value').nth(0).innerText(),'0');assert.equal(await page.locator('.analytics-panel .an-stat-value').nth(1).innerText(),'0');checks++;await page.screenshot({path:'/tmp/p003-analytics-ui-empty.png',fullPage:true});
  state.mode='error';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.locator('.analytics-panel .an-error').filter({hasText:'采集服务暂时不可用'}).waitFor();assert.equal(await page.getByRole('heading',{name:'所选接收窗口尚未接收到设备批次'}).count(),0);checks++;
  state.mode='race';await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.dimension='occurred';p.analyticsRefresh();p.analyticsFilters.dimension='received';});await page.waitForTimeout(500);assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data.event_count),222);checks++;
  state.mode='daily';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.getByText('2 台 / 3 会话',{exact:true}).waitFor();assert.equal(await page.locator('.analytics-panel .an-group').count(),7);await page.locator('.analytics-panel .an-group').filter({hasText:'奖励与补签'}).click();assert((await page.locator('.analytics-panel').innerText()).includes('当日去重奖励实例：2'));await page.locator('.analytics-panel .an-group').filter({hasText:'命令失败'}).click();assert((await page.locator('.analytics-panel').innerText()).includes('advance · INVALID_STATE'));await page.screenshot({path:'/tmp/p003-analytics-ui-daily.png',fullPage:true});checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.from='2026-02-30';});await page.locator('.analytics-panel .an-error').filter({hasText:'筛选无效'}).first().waitFor();assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data),null);checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.from='2026-10-01';p.analyticsFilters.to='2026-10-13';p.analyticsSetTab('batches');});await page.getByText('attempt-1',{exact:true}).waitFor();assert(state.seen.filter(r=>r.path.endsWith('/batches')).every(r=>r.query.includes('dimension=received')));await page.getByText('查看摘要',{exact:true}).click();assert(await page.locator('.analytics-panel').innerText().then(t=>t.includes('KidsHubAI-VoiceKit')));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('events'));await page.locator('.analytics-panel input').fill('private-test-event');await page.getByRole('button',{name:'查询事件',exact:true}).click();await page.getByText('safe-digest',{exact:false}).waitFor();assert.equal(await page.locator('.analytics-panel input').inputValue(),'');assert(!(await page.locator('.analytics-panel').innerText()).includes('private-test-event'));assert(!(await run(()=>JSON.stringify(localStorage))).includes('private-test-event'));assert(!page.url().includes('private-test-event'));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('registry'));await page.getByText('查看 JSON Schema',{exact:true}).click();assert.equal(await page.locator('.analytics-panel pre img').count(),0);assert((await page.locator('.analytics-panel pre').innerText()).includes('<img'));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('config'));await page.getByRole('heading',{name:'上传控制',exact:true}).waitFor();assert((await page.locator('.analytics-panel').innerText()).includes('当前安全开启上限'));assert((await page.locator('.analytics-panel').innerText()).includes('未来30天新增数据'));assert((await page.locator('.analytics-panel').innerText()).includes('事实仍保留90天')); assert(!state.seen.some(r=>r.path.includes('/analytics/')&&r.method!=='GET'));checks++;
  await page.getByLabel('规划设备上限').waitFor();assert.equal(await page.getByLabel('规划设备上限').inputValue(),'50');checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.anControl.hour=22;p.anControl.dirty=true;});
  const uploadBefore=JSON.stringify(state.control);await page.getByLabel('规划设备上限').fill('100');await page.getByRole('button',{name:'保存规划配额',exact:true}).click();await page.getByRole('status').filter({hasText:'规划配额已保存'}).waitFor();assert.equal(state.storage.target_devices,100);assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anControl.hour),22);assert.equal(JSON.stringify(state.control),uploadBefore);assert.deepEqual(Object.keys(state.storagePut).sort(),['expected_revision','target_devices']);checks++;
  await page.getByRole('heading',{name:'存储与设备配额',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:process.env.STORAGE_UI_SCREENSHOT||'/tmp/p003-storage-quota.png',fullPage:false});
  assert((await page.locator('.analytics-panel').innerText()).includes('尚未完成规模验证'));assert((await page.locator('.analytics-panel').innerText()).includes('尚未接入'));checks++;
  await page.getByPlaceholder('SN、末8位或设备备注').fill('02000026');await page.getByRole('button',{name:'全选筛选结果',exact:true}).click();await page.getByRole('button',{name:'保存上传设置',exact:true}).click();await page.getByRole('alert').filter({hasText:'超过当前容量上限'}).waitFor();assert.equal(state.control.subjects.length,1);assert.equal(state.errors.filter(e=>e.includes('409 (Conflict)')).length,1);state.errors=state.errors.filter(e=>!e.includes('409 (Conflict)'));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsControlToggle('BJP00326070803800006',false));await page.getByRole('button',{name:'保存上传设置',exact:true}).click();await page.getByRole('status').filter({hasText:'上传设置已保存'}).waitFor();assert.deepEqual(state.control.subjects,['BJP00326081002000026']);checks++;
  await page.getByRole('button',{name:'关闭全部上传',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anControl.data?.policy.enabled===false);assert.equal(state.control.enabled,false);checks++;
  // Pending GET freezes draft edits, and a disabled selected device can be removed.
  state.mode='control-delay';const heldControl=new Promise(resolve=>state.pendingReady=resolve);
  await run(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.loadAnalyticsControl();});await heldControl;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsControlToggle('BJP00326070803800006',true));
  assert.deepEqual(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anControl.subjects),['BJP00326081002000026']);
  state.mode='disabled-selected';state.releaseControl();await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anControl.loading);
  const disabledRow=page.locator('.an-table tbody tr').filter({hasText:'BJP00326081002000026'});assert(!(await disabledRow.locator('.el-switch').getAttribute('class')).includes('is-disabled'));
  await page.getByRole('button',{name:'清空筛选结果',exact:true}).click();assert.deepEqual(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anControl.subjects),[]);assert((await disabledRow.locator('.el-switch').getAttribute('class')).includes('is-disabled'));checks++;
  state.mode='control-offline';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.loadAnalyticsControl());await page.getByText('上传服务暂不可达，显示已保存配置，实际准入状态未知；仍可关闭上传。',{exact:true}).waitFor();assert.equal(await page.getByText(/运维保护闸关闭或配置异常/).count(),0);assert.equal(await page.getByRole('button',{name:'关闭全部上传',exact:true}).isDisabled(),false);checks++;
  // Real /v1 Ark controls: preview and authorize cannot race; authorize reads fresh facts.
  state.mode='ark-delay';await run(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anArk.sn='BJP00326081002000026';});
  const heldArk=new Promise(resolve=>state.pendingReady=resolve);await page.getByRole('button',{name:'查看小可可读事实',exact:true}).click();await heldArk;
  assert.equal(await page.getByRole('button',{name:'启用该设备游戏数据问答',exact:true}).isDisabled(),true);
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.authorizeAnalyticsArk());assert.equal(state.arkAuthorized,undefined);
  state.mode='empty';await state.releaseArk();await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._container._vnode.component.proxy.anArk.loading);
  await page.getByRole('button',{name:'启用该设备游戏数据问答',exact:true}).click();await page.getByText('家族币余额：0；数据时间已标注',{exact:true}).waitFor();assert.deepEqual(state.arkGrantBody,{});assert.equal(state.seen.filter(r=>r.path.endsWith('/authorize')).length,1);checks++;
  await page.screenshot({path:process.env.ANALYTICS_UI_SCREENSHOT||'/tmp/p003-analytics-control-ui.png',fullPage:false});
  state.mode='invalid-config';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.locator('.analytics-panel .an-error').filter({hasText:'运维保护闸关闭或配置异常'}).waitFor();checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.handleMenuSelect('kidshub'));assert.equal(await page.locator('.analytics-panel').count(),0);assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.khNav),'board');checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});state.mode='unauthorized';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('overview'));await page.locator('.login-card').waitFor();assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.eventQuery),'');checks++;
  assert.deepEqual(state.errors.filter(e=>!/^Failed to load resource:.*status of (503|401) /.test(e)),[]);await admin.context.close();
  for(const role of ['editor','guest']){const s=await session(role);await s.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');p.analyticsRefresh();});assert.equal(await s.page.locator('.analytics-panel').count(),0);assert(!s.state.seen.some(r=>r.path.includes('/analytics/')));assert.equal(await s.page.getByRole('button',{name:'数据埋点',exact:true}).count(),0);assert.deepEqual(s.state.errors,[]);checks++;await s.context.close();}
  console.log('PASS: inline JS, entire browser-parsed #app production Vue compile, production Vue/Element Plus mount; '+checks+' acceptance checks');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
