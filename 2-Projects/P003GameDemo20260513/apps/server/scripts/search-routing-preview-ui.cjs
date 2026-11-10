// Real production Vue/ElementPlus page with isolated API fixtures; never touches production.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE || '/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const assets=process.env.ASSET_DIR || '/Users/fu-121/.local/state/p003-admin-credential-view-20261109/assets';
const html=fs.readFileSync(path.resolve(__dirname,'../../web/public/admin/index.html'),'utf8');
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new Function(m[1]);
(async()=>{
 const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;const browser=await webkit.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors=[],puts=[];page.on('pageerror',e=>errors.push(e.message));

 const catalog={count:3220,sha256:'a'.repeat(64)};
 const draft={schema:1,rules:[],weather_enabled:true,baidu_weather_enabled:true,auto_location_enabled:false};
 let reply={ok:true,weather_catalog:catalog,decisions:[{action:'search',rule_id:'weather',reason:'天气词命中',place_weather:{place:'深圳',day_offset:1,metric:'forecast'},place_inspection:{status:'unique',candidates:[{label:'广东深圳',station:'101280601'}]}}]};let failure=null;const mutations=[];
 const state=()=>({ok:true,draft,revision:0,eligible_sns:[],locations:[],targets:[],versions:[{version:'r7-'+'a'.repeat(24)}]});
 await page.addInitScript(()=>{localStorage.setItem('kidshub_admin_token','test');localStorage.setItem('kidshub_admin_role','admin');localStorage.setItem('kidshub_admin_username','测试');});
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.hostname==='cdn.jsdelivr.net'){const n=u.pathname.includes('/vue@')?'vue.js':u.pathname.endsWith('index.css')?'element.css':u.pathname.includes('/element-plus@')?'element.js':'echarts.js';return route.fulfill({body:fs.readFileSync(path.join(assets,n)),contentType:n.endsWith('.css')?'text/css':'application/javascript'});}
  if(u.origin!==origin)return route.fulfill({json:{type:'FeatureCollection',features:[]}});
  if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role:'admin'}});
  if(u.pathname.endsWith('/routing/preview'))return route.fulfill(failure?{status:failure.status,json:{ok:false,error:failure.error}}:{json:reply});
  if(u.pathname.includes('/routing/')){mutations.push(u.pathname);return route.fulfill({json:state()});}
  if(u.pathname.endsWith('/routing'))return route.fulfill({json:state()});
  if(u.pathname.endsWith('/amap-usage'))return route.fulfill({status:503,json:{ok:false,error:'isolated_no_account'}});
  if(u.pathname==='/api/admin/search-canary/p1')return route.fulfill({json:{ok:true,settings:{enabled:true,scope:'all_registered',configured:true},devices:[],issues:[],tasks:{loaded:true,recent:[]}}});
  if(u.pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,items:[],devices:[],sessions:[],themes:[],n:0,won_main:0,won_fallback:0}});
  return route.continue();
 });
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('search-canary');p.setSearchLane('p1');});
 const input=page.locator('#routing-utterances'),preview=page.getByTestId('weather-preview');try{await input.waitFor({timeout:5000});}catch(e){console.error('PAGE_ERRORS',errors);console.error((await page.locator('body').innerText()).slice(-9000));throw e;}
 const run=async()=>{await input.fill('深圳明天天气');await page.getByRole('button',{name:'预览路由（不执行搜索）',exact:true}).click();await preview.waitFor();};
 await run();let text=await preview.innerText();assert(text.includes('地点唯一'));assert(text.includes('天气站 101280601'));assert(text.includes('明天 · 天气预报'));assert(text.includes(catalog.sha256));
 reply.decisions[0].place_weather.place='朝阳';reply.decisions[0].place_inspection={status:'ambiguous',candidates:[{label:'北京朝阳',station:'101010300'},{label:'辽宁朝阳',station:'101071201'}]};await run();assert((await preview.innerText()).includes('请明确省市'));assert((await preview.innerText()).includes('辽宁朝阳'));
 reply.decisions[0].place_weather.place='北京大学';reply.decisions[0].place_inspection={status:'unknown',candidates:[]};await run();assert((await preview.innerText()).includes('不会自动替换为本地天气'));
 reply.decisions[0].place_weather.place='<img src=x onerror=window.xss=1>';reply.decisions[0].place_inspection={status:'invalid',candidates:[]};await run();assert((await preview.innerText()).includes('<img'));assert.equal(await preview.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.xss),undefined);
 delete reply.decisions[0].place_inspection;delete reply.weather_catalog;await run();assert((await preview.innerText()).includes('本版本未提供地点详情'));assert(!(await preview.innerText()).includes('SHA256'));
 reply.decisions=[{action:'chat',rule_id:'protected',reason:'普通聊天'}];await run();assert((await preview.innerText()).includes('普通聊天'));assert(!(await preview.innerText()).includes('提取地点'));
 for(const [status,error,expected] of [[503,'preview_unavailable','预览'],[409,'revision_conflict','配置']]){failure={status,error};await input.fill('故障测试');await page.getByRole('button',{name:'预览路由（不执行搜索）',exact:true}).click();await page.waitForFunction(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;return !p.routing.busy&&!!p.routing.error;});assert.equal(await preview.count(),0);}
 failure=null;
 await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.publishRouting();});await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._container._vnode.component.proxy.routing.busy);assert(mutations.some(x=>x.endsWith('/publish-all')));
 await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.routing.rollbackVersion='r7-'+'a'.repeat(24);p.rollbackRouting();});await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._container._vnode.component.proxy.routing.busy);assert(mutations.some(x=>x.endsWith('/rollback-all')));
 await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.routing.draft.weather_enabled=false;p.routingDirty();});await run();assert((await preview.innerText()).includes('普通聊天'));
 reply={ok:true,weather_catalog:catalog,decisions:[{action:'search',rule_id:'weather',reason:'天气词命中',place_weather:{place:'深圳',day_offset:1,metric:'forecast'},place_inspection:{status:'unique',candidates:[{label:'广东深圳',station:'101280601'}]}}]};await run();
 assert.deepEqual(errors,[]);await page.screenshot({path:process.env.SCREENSHOT||'/tmp/p003-weather-preview-ui.png',fullPage:true});console.log('PASS: production Vue unique/ambiguous/unknown/invalid/XSS/legacy/chat/errors/publish/rollback/disabled; no JS errors. API fixtures, not live provider.');
 } finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exit(1)});
