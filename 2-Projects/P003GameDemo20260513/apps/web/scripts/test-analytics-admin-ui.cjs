/* Read-only browser acceptance. No real credentials, device writes or API mutations.
 * node apps/web/scripts/test-analytics-admin-ui.cjs
 * Uses existing PLAYWRIGHT_MODULE (or local cached module), and ASSET_DIR containing
 * vue.js 3.4.21, element.js/css 2.9.1, echarts.js 5.5.0 downloaded from production CDN URLs.
 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),http=require('http');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE || '/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const assetDir=process.env.ASSET_DIR || '/tmp/p003-analytics-ui-assets';
const html=fs.readFileSync(path.resolve(__dirname,'../public/admin/index.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(match[1].trim())new vm.Script(match[1]);
const health={ok:true,alive:true,ready:true,dependencies_ready:true,storage_ready:true,gate_enabled:false,control_valid:true,allowlist_count:0,in_flight:0,requests:0,storage_failures:0,sql_busy:0,rss_bytes:1000,wal_bytes:0,disk_free_bytes:null,disk_warning:false,processing_p95_ms:null,processing_p99_ms:null,last_rollup_success_ms:null,last_rollup_attempt_ms:null,last_rollup_partial_ms:null,rollup_status:null,rollup_failed_days:0,rollup_remaining_dirty_days:0,last_backup_success_ms:null};
function overview(q,n=0){return {ok:true,from:q.get('from'),to:q.get('to'),dimension:q.get('dimension'),devices:[{device_alias:'设备-012345abcdef'}],event_count:n,active_devices:0,receiving_devices:0,batches:0,accepted:0,duplicated:0,rejected:0,clock_suspicious_events:0,allowlist_count:0,receiving_allowlisted_devices:0,receiving_coverage:null,data_cutoff_ms:null,last_received_at_ms:null,client_pending_known:false};}
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await webkit.launch({headless:true});let checks=0;
 try{
  async function session(role){
   const context=await browser.newContext({viewport:{width:1500,height:1000}}), state={mode:'empty',seen:[],errors:[]};
   if(role)await context.addInitScript(role=>{localStorage.setItem('kidshub_admin_token','ui-stub-token');localStorage.setItem('kidshub_admin_role',role);localStorage.setItem('kidshub_admin_username','验收账号');},role);
   await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.hostname==='cdn.jsdelivr.net'){let name=u.pathname.includes('/vue@')?'vue.js':u.pathname.endsWith('index.css')?'element.css':u.pathname.includes('/element-plus@')?'element.js':'echarts.js';return route.fulfill({body:fs.readFileSync(path.join(assetDir,name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});}
    if(u.origin!==origin)return route.fulfill({json:{type:'FeatureCollection',features:[]}});
    if(!u.pathname.startsWith('/api/'))return route.continue();
    state.seen.push({path:u.pathname,query:u.search,method:req.method()});
    if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role}});
    if(!u.pathname.startsWith('/api/admin/analytics/'))return route.fulfill({json:{ok:true,items:[],devices:[],sessions:[],themes:[]}});
    if(role!=='admin')return route.fulfill({status:403,json:{ok:false,error:'FORBIDDEN'}});
    const kind=u.pathname.split('/').pop(),q=u.searchParams;
    if(state.mode==='error' && kind==='overview')return route.fulfill({status:503,json:{ok:false,error:'analytics_unavailable'}});
    if(state.mode==='unauthorized' && kind==='overview')return route.fulfill({status:401,json:{ok:false}});
    if(kind==='overview'){
     let n=0;if(state.mode==='race'){n=q.get('dimension')==='occurred'?111:222;await new Promise(resolve=>setTimeout(resolve,n===111?350:30));}
     return route.fulfill({json:overview(q,n)});
    }
    if(kind==='daily')return route.fulfill({json:{ok:true,items:state.mode==='daily'?[{day:'2026-10-13',event_count:11,event_counts:{'g1.command_failed':1},active_devices:2,sessions:3,reward_grant_events:4,unique_reward_instances:2,explicit_gm_events:1,unclassified_traffic_events:10,clock_suspicious_events:0,updated_at_ms:Date.now(),groups:{activity:{'app.session_started':3},g1_flow:{'g1.experience_started':2},logical_day_ecotank:{'g1.ecotank_selected':1},rewards_makeup:{'g1.reward_granted':4},settings:{'settings.opened':1},voice_state:{'voice.session_state_changed':2},command_failures:[{command:'advance',error_code:'INVALID_STATE',count:1}]}},{day:'2026-10-12',event_count:5,active_devices:2,sessions:3,reward_grant_events:1,unique_reward_instances:1,updated_at_ms:Date.now(),groups:{}}]:[]}});
    if(kind==='health')return route.fulfill({json:health});
    if(kind==='batches')return route.fulfill({json:{ok:true,limit:25,offset:Number(q.get('offset')),items:[{attempt_id:'attempt-1',request_id:'request-1',batch_id:'batch-1',received_at_ms:Date.now(),sent_at_ms:Date.now(),accepted:1,duplicated:0,rejected:0,device_alias:'设备-012345abcdef',http_status:200,processing_ms:1,sent_received_skew_ms:0,upload_client:{product:'KidsHubAI-VoiceKit',component:'uploader',protocol_version:'1',content_version:'v1'}}]}});
    if(kind==='events')return route.fulfill({json:{ok:true,id_digest:'safe-digest',events:[],settlements:[{attempt_id:'attempt-1',request_id:'request-1',received_at_ms:Date.now(),device_alias:'设备-012345abcdef',outcome:'rejected',reason:'INVALID_SCHEMA'}]}});
    if(kind==='registry')return route.fulfill({json:{ok:true,event_count:57,schema_version:1,items:[{event_name:'g1.reward_granted',group:'reward',properties_schema:{type:'object',description:'<img src=x onerror=alert(1)>'}}]}});
    if(kind==='collection-config')return route.fulfill({json:{ok:true,server_gate:{enabled:false,valid:state.mode!=='invalid-config'},allowlist_count:0,global:{event_upload_enabled:false,daily_upload_hour_cst:0},device_defaults:{event_upload_enabled:false,daily_upload_hour_cst:23},items:[]}});
   });
   const page=await context.newPage();page.on('pageerror',e=>state.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')state.errors.push(m.text());});await page.goto(origin);await page.waitForFunction(()=>typeof Vue!=='undefined' && document.querySelector('#app').__vue_app__);
   const compile=await page.evaluate(source=>{const dom=new DOMParser().parseFromString(source,'text/html');const template=dom.querySelector('#app').innerHTML;Vue.compile(template);return template.length;},html);assert(compile>100000);checks++;
   return {context,page,state};
  }
  const guest=await session(null);assert.equal(await guest.page.locator('.login-card').count(),1);assert.equal(await guest.page.locator('.login-card input').count(),2);assert.deepEqual(guest.state.errors,[]);checks++;await guest.context.close();
  const admin=await session('admin'),{page,state}=admin;
  const run=fn=>page.evaluate(fn);
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});
  await page.getByRole('heading',{name:'所选接收窗口尚未接收到设备批次'}).waitFor();assert(await page.locator('.analytics-panel').innerText().then(t=>t.includes('待灰度接收')&&t.includes('未知，需端侧审计')));checks++;await page.screenshot({path:'/tmp/p003-analytics-ui-empty.png',fullPage:true});
  state.mode='error';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.locator('.analytics-panel .an-error').filter({hasText:'采集服务暂时不可用'}).waitFor();assert.equal(await page.getByRole('heading',{name:'所选接收窗口尚未接收到设备批次'}).count(),0);checks++;
  state.mode='race';await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.dimension='occurred';p.analyticsRefresh();p.analyticsFilters.dimension='received';});await page.waitForTimeout(500);assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data.event_count),222);checks++;
  state.mode='daily';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.getByText('2 台 / 3 会话',{exact:true}).waitFor();assert.equal(await page.locator('.analytics-panel .an-group').count(),7);await page.locator('.analytics-panel .an-group').filter({hasText:'奖励与补签'}).click();assert((await page.locator('.analytics-panel').innerText()).includes('当日去重奖励实例：2'));await page.locator('.analytics-panel .an-group').filter({hasText:'命令失败'}).click();assert((await page.locator('.analytics-panel').innerText()).includes('advance · INVALID_STATE'));await page.screenshot({path:'/tmp/p003-analytics-ui-daily.png',fullPage:true});checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.from='2026-02-30';});await page.locator('.analytics-panel .an-error').filter({hasText:'筛选无效'}).first().waitFor();assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.overview.data),null);checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.analyticsFilters.from='2026-10-01';p.analyticsFilters.to='2026-10-13';p.analyticsSetTab('batches');});await page.getByText('attempt-1',{exact:true}).waitFor();assert(state.seen.filter(r=>r.path.endsWith('/batches')).every(r=>r.query.includes('dimension=received')));await page.getByText('查看摘要',{exact:true}).click();assert(await page.locator('.analytics-panel').innerText().then(t=>t.includes('KidsHubAI-VoiceKit')));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('events'));await page.locator('.analytics-panel input').fill('private-test-event');await page.getByRole('button',{name:'查询事件',exact:true}).click();await page.getByText('safe-digest',{exact:false}).waitFor();assert.equal(await page.locator('.analytics-panel input').inputValue(),'');assert(!(await page.locator('.analytics-panel').innerText()).includes('private-test-event'));assert(!(await run(()=>JSON.stringify(localStorage))).includes('private-test-event'));assert(!page.url().includes('private-test-event'));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('registry'));await page.getByText('查看 JSON Schema',{exact:true}).click();assert.equal(await page.locator('.analytics-panel pre img').count(),0);assert((await page.locator('.analytics-panel pre').innerText()).includes('<img'));checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('config'));await page.getByRole('heading',{name:'设备上传默认值 · CST'}).waitFor();assert((await page.locator('.analytics-panel').innerText()).includes('23:00'));assert((await page.locator('.analytics-panel').innerText()).includes('00:00'));assert(!state.seen.some(r=>r.path.includes('/analytics/')&&r.method!=='GET'));checks++;
  state.mode='invalid-config';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsRefresh());await page.locator('.analytics-panel .an-error').filter({hasText:'采集控制配置无效'}).waitFor();checks++;
  await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.handleMenuSelect('kidshub'));assert.equal(await page.locator('.analytics-panel').count(),0);assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.khNav),'board');checks++;
  await run(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');});state.mode='unauthorized';await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analyticsSetTab('overview'));await page.locator('.login-card').waitFor();assert.equal(await run(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.analytics.eventQuery),'');checks++;
  assert.deepEqual(state.errors.filter(e=>!/^Failed to load resource:.*status of (503|401) /.test(e)),[]);await admin.context.close();
  for(const role of ['editor','guest']){const s=await session(role);await s.page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('analytics');p.analyticsRefresh();});assert.equal(await s.page.locator('.analytics-panel').count(),0);assert(!s.state.seen.some(r=>r.path.includes('/analytics/')));assert.equal(await s.page.getByRole('button',{name:'数据埋点',exact:true}).count(),0);assert.deepEqual(s.state.errors,[]);checks++;await s.context.close();}
  console.log('PASS: inline JS, entire browser-parsed #app production Vue compile, production Vue/Element Plus mount; '+checks+' acceptance checks');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
