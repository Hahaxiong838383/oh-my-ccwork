/** Full admin UI against read-only APIs. Credentials arrive through stdin, never argv/logs. */
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.P003_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const local=process.argv.includes('--local');let fixture,browser;
 try{
 const credentials=local?{username:'fixture-admin',password:'fixture-password'}:JSON.parse(fs.readFileSync(0,'utf8'));
 let base=process.env.P003_ADMIN_BASE||'https://kidshub-ai.hahaxiong.cc';
 if(local){
  fixture=spawn(process.execPath,['--experimental-sqlite','--import','tsx',path.join(__dirname,'listening-admin-fixture.ts'),'--full'],{cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','pipe']});
  let stderr='';fixture.stderr.on('data',x=>stderr+=x);
  base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('local fixture timeout '+stderr)),15000);
   fixture.stdout.on('data',x=>{output+=x;for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.url){clearTimeout(timer);resolve(value.url);}}catch{}});
   fixture.on('exit',code=>{clearTimeout(timer);reject(new Error('local fixture exited '+code+' '+stderr));});
  });
 }
 const source=process.env.P003_ADMIN_HTML?fs.readFileSync(process.env.P003_ADMIN_HTML,'utf8'):null;
 if(source)for(const m of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim())new Function(m[1]);
 browser=await chromium.launch({headless:true,...(process.env.P003_CHROME_BIN?{executablePath:process.env.P003_CHROME_BIN}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],blocked=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(base+'/**',route=>{
   const r=route.request();
   if(!['GET','HEAD'].includes(r.method())&&new URL(r.url()).pathname!=='/api/auth/login'){blocked.push(new URL(r.url()).pathname);return route.abort();}
   return route.continue();
  });
  if(source)await page.route(base+'/admin/',route=>route.fulfill({contentType:'text/html',body:source}));
  async function login(){await page.getByPlaceholder('请输入账号').fill(credentials.username);await page.getByPlaceholder('请输入密码').fill(credentials.password);await page.getByRole('button',{name:'登 录'}).click();await page.getByText('Worker 管理 ⚙',{exact:true}).waitFor({timeout:20000});}
  await page.goto(base+'/admin/',{waitUntil:'domcontentloaded',timeout:45000});await login();
  await page.getByText('Worker 管理 ⚙',{exact:true}).click();await page.getByText('Worker Brain',{exact:true}).click();
  const tabs=page.getByRole('tablist',{name:'Worker Brain 功能模块'});
  await tabs.waitFor();assert.equal(await tabs.getByRole('tab').count(),4);
  const pick=async key=>{await page.locator('#brain-tab-'+key).click();await page.locator('#brain-panel-'+key).waitFor();assert.equal(await page.locator('.brain-section-panel:visible').count(),1);};
  await page.locator('#brain-panel-overview').waitFor();
  // A tenant row must drill down into the device section without needing another navigation action.
  await page.locator('#brain-panel-overview .kh-table tbody tr').first().waitFor({timeout:20000});
  await page.locator('#brain-panel-overview .kh-table tbody tr').first().click();
  await page.locator('#brain-panel-devices').waitFor();assert.equal(await page.locator('#brain-tab-devices').getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'📝 编辑',exact:true}).waitFor({timeout:20000});
  await page.getByRole('button',{name:'📝 编辑',exact:true}).click();
  const selected=await page.locator('.brain-device-list > div[style*="rgb(239, 246, 255)"]').innerText();
  await pick('listening');await page.locator('#listening-feedback_max_chars').waitFor({timeout:15000});
  assert(await page.locator('#listening-enabled').isDisabled());await page.locator('#listening-feedback_max_chars').fill('88');
  await pick('extract');const model=page.getByPlaceholder('model（空=该渠道默认）');
  await page.waitForFunction(()=>!document.querySelector('.brain-heading .el-button.is-loading'));
  await model.fill('ui-draft-not-saved');
  await pick('listening');assert.equal(await page.locator('#listening-feedback_max_chars').inputValue(),'88');
  await pick('extract');assert.equal(await model.inputValue(),'ui-draft-not-saved');
  await page.getByRole('button',{name:'刷新当前模块',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'保留修改'}).click();assert.equal(await model.inputValue(),'ui-draft-not-saved');
  await pick('devices');assert.equal(await page.locator('.brain-device-list > div[style*="rgb(239, 246, 255)"]').innerText(),selected);
  assert((await page.getByRole('button',{name:'📝 编辑',exact:true}).getAttribute('class')).includes('el-button--primary'));
  for(const name of ['🔬 拼接可视化','🧠 小可的记忆','💬 聊天记录','🔒 租户隔离','🌱 人格成长'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
  // Keyboard navigation and sticky tabs stay reachable on a long overview.
  await pick('overview');const y=(await tabs.boundingBox()).y;
  await page.locator('#worker-brain').evaluate(e=>e.scrollTop=800);assert(Math.abs((await tabs.boundingBox()).y-y)<3);
  await page.locator('#brain-tab-overview').focus();await page.keyboard.press('End');
  assert.equal(await page.locator('#brain-tab-extract').getAttribute('aria-selected'),'true');await page.keyboard.press('Home');
  assert.equal(await page.locator('#brain-tab-overview').getAttribute('aria-selected'),'true');
  await page.setViewportSize({width:1024,height:800});await pick('listening');
  const boxes=await tabs.getByRole('tab').evaluateAll(es=>es.map(e=>({y:e.getBoundingClientRect().y,height:e.getBoundingClientRect().height})));
  assert(boxes.every(b=>Math.abs(b.y-boxes[0].y)<2));assert(boxes.every(b=>b.height>=40));
  // Expired login while staying on listening must repopulate the same page.
  let injected=false;await page.route('**/api/admin/worker-voice/listening',route=>{
   if(!injected){injected=true;return route.fulfill({status:401,json:{ok:false,error:'unauthorized'}});}return route.continue();
  });
  await page.locator('#listening-feedback_max_chars').fill('80');
  await page.getByRole('button',{name:'重新载入',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'重新载入',exact:true}).click();
  await page.getByPlaceholder('请输入账号').waitFor();await login();
  await page.locator('#listening-feedback_max_chars').waitFor({timeout:15000});
  assert.equal(await page.locator('#brain-tab-listening').getAttribute('aria-selected'),'true');
  await page.setViewportSize({width:1440,height:1050});
  if(process.env.P003_TABS_SCREENSHOT)await page.locator('#worker-brain').screenshot({path:process.env.P003_TABS_SCREENSHOT});
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({four_sections:true,tenant_drilldown:true,device_and_subtab_retained:true,listening_and_llm_drafts_retained:true,refresh_cancel_preserves_draft:true,keyboard:true,sticky:true,width_1024:true,relogin:true,page_errors:0,business_writes:0,html:local?'local SQLite fixture':source?'local candidate':'public deployed'}));
 }finally{if(browser)await browser.close();if(fixture&&fixture.exitCode===null){fixture.kill('SIGTERM');await new Promise(r=>fixture.once('exit',r));}}
})().catch(e=>{console.error(e.name+': '+e.message.slice(0,700));process.exit(1)});
