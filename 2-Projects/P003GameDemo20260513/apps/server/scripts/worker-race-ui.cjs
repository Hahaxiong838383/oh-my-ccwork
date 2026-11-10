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
 let fail=false;let live={LLM_BASE_URL:'https://brain.test/v1',LLM_MODEL:'xiaoke-device',LLM_THINKING:'off',LLM_FALLBACK_PROVIDER:'deepseek',LLM_FALLBACK_ENABLED:'1',LLM_FALLBACK_TRIGGER_MS:'2000',LLM_FALLBACK_DEADLINE_MS:'6000',LLM_FALLBACK_BASE_URL:'https://api.deepseek.com/v1',LLM_FALLBACK_MODEL:'deepseek-v4-flash',LLM_FALLBACK_THINKING:'disabled',LLM_FALLBACK_API_KEY:{set:true,hint:'sk-test…',len:24},AGENT_INSTRUCTIONS:'你是小可'};
 const profiles={deepseek:{model:'deepseek-v4-flash',thinking:'disabled',key_set:true},volc_plan:{model:'doubao-seed-2.0-mini',thinking:'disabled',key_set:true},volc_coding:{model:'doubao-seed-2.0-mini',thinking:'disabled',key_set:false}};
 await page.addInitScript(()=>{localStorage.setItem('kidshub_admin_token','test');localStorage.setItem('kidshub_admin_role','admin');localStorage.setItem('kidshub_admin_username','测试');});
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.hostname==='cdn.jsdelivr.net'){const n=u.pathname.includes('/vue@')?'vue.js':u.pathname.endsWith('index.css')?'element.css':u.pathname.includes('/element-plus@')?'element.js':'echarts.js';return route.fulfill({body:fs.readFileSync(path.join(assets,n)),contentType:n.endsWith('.css')?'text/css':'application/javascript'});}
  if(u.origin!==origin)return route.fulfill({json:{type:'FeatureCollection',features:[]}});
  if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role:'admin'}});
  if(u.pathname==='/api/admin/worker-race'){
   if(route.request().method()==='PUT'){
    const v=route.request().postDataJSON();puts.push(v);
    if(fail)return route.fulfill({status:502,json:{ok:false,error:'配置失败，已回滚'}});
    Object.assign(live,v.values);return route.fulfill({json:{ok:true,applied:Object.keys(v.values),proc:live}});
   }
   return route.fulfill({json:{ok:true,worker:{file:live,proc:live,profiles,unit_active:true,main_pid:123},brain:{provider:'race',main_model:'deepseek-v4-flash',fallback_model:'doubao-seed-2.0-mini'},presets:[],catalog:[{model:'doubao-seed-2.0-mini',tier:'recommended'}]}});
  }
  if(u.pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,items:[],devices:[],sessions:[],themes:[],n:0,won_main:0,won_fallback:0}});
  return route.continue();
 });
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.evaluate(()=>{const p=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;p.handleMenuSelect('worker');p.khSelectNav('race');});
 await page.getByTestId('race-active').waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid="race-active"]').textContent.includes('deepseek-v4-flash'));
 assert((await page.getByTestId('race-active').innerText()).includes('有界灾备已开启'));
 assert.equal(await page.getByTestId('race-trigger').inputValue(),'2000');assert.equal(await page.getByTestId('race-deadline').inputValue(),'6000');
 await page.getByTestId('race-provider').click();await page.getByRole('option',{name:'火山 · Agent Plan',exact:true}).click();
 assert((await page.getByTestId('race-active').innerText()).includes('deepseek-v4-flash'),'unsaved dropdown must not alter active display');
 assert.equal(await page.locator('input[type=password]').filter({visible:true}).count().catch(()=>1),1);
 await page.getByRole('button',{name:'保存并重启主 Worker',exact:true}).click();await page.getByRole('button',{name:'应用',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="race-active"]').textContent.includes('doubao-seed-2.0-mini'));
 assert.equal(puts[0].values.LLM_FALLBACK_PROVIDER,'volc_plan');assert.equal(puts[0].values.LLM_FALLBACK_BASE_URL,'https://ark.cn-beijing.volces.com/api/plan/v3');assert(!('LLM_FALLBACK_API_KEY'in puts[0].values));
 await page.getByTestId('race-enabled').click();await page.getByRole('button',{name:'保存并重启主 Worker',exact:true}).click();await page.getByRole('button',{name:'应用',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="race-active"]').textContent.includes('灾备关闭'));
 assert.equal(puts[1].values.LLM_FALLBACK_ENABLED,'0');
 await page.getByTestId('race-trigger').fill('5000');await page.getByRole('button',{name:'保存并重启主 Worker',exact:true}).click();
 await page.getByText('触发须500~5000ms，总等待至少多2000ms且不超过15000ms',{exact:true}).waitFor();assert.equal(puts.length,2);
 await page.getByTestId('race-trigger').fill('2000');await page.getByTestId('race-provider').click();await page.getByRole('option',{name:'火山 · Coding Plan',exact:true}).click();
 await page.getByRole('button',{name:'保存并重启主 Worker',exact:true}).click();await page.getByText('所选端点还没有密钥，请填写后保存',{exact:true}).waitFor();assert.equal(puts.length,2);
 await page.getByTestId('race-provider').click();await page.getByRole('option',{name:'DeepSeek 官方（默认选择）',exact:true}).click();
 fail=true;await page.getByRole('button',{name:'保存并重启主 Worker',exact:true}).click();await page.getByRole('button',{name:'应用',exact:true}).click();await page.getByText('配置失败，已回滚',{exact:true}).waitFor();assert((await page.getByTestId('race-active').innerText()).includes('doubao-seed-2.0-mini'));
 assert.deepEqual(errors,[]);await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelectorAll('.el-message').length===0);await page.screenshot({path:process.env.SCREENSHOT || '/tmp/p003-worker-race-ui.png',fullPage:true});
 console.log('PASS: production Vue render; active/draft separation; provider key reuse; off switch; invalid budget; missing profile key; failed-save status; no JS errors');
 } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exit(1)});
