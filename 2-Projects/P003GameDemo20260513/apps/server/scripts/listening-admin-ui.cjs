// Run with P003_PLAYWRIGHT_MODULE and P003_CHROME_BIN pointing to installed tooling.
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const {chromium}=require(process.env.P003_PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../web/public/admin/index.html'),'utf8');
 for(const m of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim())new Function(m[1]);
 const fixture=spawn(process.execPath,['--experimental-sqlite','--import','tsx',path.join(__dirname,'listening-admin-fixture.ts')],{cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','pipe']});
 let stderr='';fixture.stderr.on('data',x=>stderr+=x);
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('fixture timeout '+stderr)),15000);fixture.stdout.on('data',x=>{out+=x;for(const l of out.split('\n'))try{const j=JSON.parse(l);if(j.url){clearTimeout(timer);resolve(j.url);}}catch{}});fixture.on('exit',code=>{clearTimeout(timer);reject(new Error('fixture exit '+code+' '+stderr));});});
  browser=await chromium.launch({headless:true,...(process.env.P003_CHROME_BIN?{executablePath:process.env.P003_CHROME_BIN}:{})});
  const page=await browser.newPage({viewport:{width:1180,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});await page.locator('#listening-max_session_sec').waitFor();
  assert.equal(await page.locator('#listening-max_session_sec').inputValue(),'1800');assert(await page.locator('#listening-enabled').isDisabled());
  await page.getByText('暂无运行数据',{exact:false}).waitFor();
  await page.locator('#listening-voice-invitation').uncheck();
  await page.locator('#listening-allowlist').fill('BJP00326070803800006');await page.locator('#listening-feedback_max_chars').fill('100');
  await page.getByRole('button',{name:'保存倾听配置',exact:true}).click();await page.getByText('已保存 v2',{exact:true}).waitFor();
  await page.getByText('配置已保存；运行链路尚未接入，当前未生效',{exact:true}).waitFor();
  await page.getByRole('button',{name:'重新载入',exact:true}).click();assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'100');assert.equal(await page.locator('#listening-voice-invitation').isChecked(),false);
  await page.locator('#listening-feedback_max_chars').fill('90');await page.evaluate(()=>window.listeningTest.load());assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'90');
  await page.evaluate(()=>window.listeningTest.concurrentUpdate());await page.getByRole('button',{name:'保存倾听配置',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'配置已被其他管理员修改'}).waitFor();assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'90');
  await page.getByRole('button',{name:'重新载入',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'重新载入',exact:true}).click();await page.getByText('已保存 v3',{exact:true}).waitFor();assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'110');
  let fail=true;await page.route('**/api/admin/worker-voice/listening',route=>{if(fail&&route.request().method()==='PUT')return route.fulfill({status:503,json:{ok:false,error:'测试存储暂不可用'}});return route.continue();});
  await page.locator('#listening-feedback_max_chars').fill('95');await page.getByRole('button',{name:'保存倾听配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'测试存储暂不可用'}).waitFor();assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'95');fail=false;
  await page.getByRole('button',{name:'保存倾听配置',exact:true}).click();await page.getByText('已保存 v4',{exact:true}).waitFor();
  await page.locator('summary').click();await page.locator('#listening-restore-revision').selectOption('1');await page.getByRole('button',{name:'恢复为新版本'}).click();await page.getByRole('dialog').getByRole('button',{name:'恢复参数',exact:true}).click();await page.getByText('已保存 v5',{exact:true}).waitFor();assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'80');assert.equal(await page.locator('#listening-voice-invitation').isChecked(),true);
  await page.waitForFunction(()=>document.querySelectorAll('.el-message').length===0);
  const screenshot=process.env.P003_LISTENING_SCREENSHOT;if(screenshot)await page.screenshot({path:screenshot,fullPage:true});
  await page.unroute('**/api/admin/worker-voice/listening');
  let release,seenResolve;const seen=new Promise(r=>seenResolve=r);await page.route('**/api/admin/worker-voice/listening',async route=>{seenResolve();await new Promise(r=>release=r);await route.continue();});
  await page.evaluate(()=>{void window.listeningTest.load();});await seen;await page.evaluate(()=>window.listeningTest.logout());release();
  await page.waitForLoadState('networkidle');assert.equal(await page.evaluate(()=>window.listeningTest.state.data),null);assert.equal(await page.evaluate(()=>window.listeningTest.state.loading),false);
  await page.unroute('**/api/admin/worker-voice/listening');
  await page.evaluate(()=>window.listeningTest.login());await page.waitForFunction(()=>window.listeningTest.state.data!==null,{},{timeout:3000});
  assert.deepEqual(errors,[]);console.log('listening UI PASS: actual card/functions + real SQLite/Hono; save/readback, dirty refresh, concurrent conflict, 503, restore, stale logout response, actual re-login lifecycle, no page errors');
 } finally {if(browser)await browser.close();fixture.kill('SIGTERM');await new Promise(r=>fixture.once('exit',r));}
})().catch(e=>{console.error(e.stack);process.exit(1)});
