/* Read-only browser acceptance. Never log URLs, cookies, response bodies, or secrets. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const privateDir = path.join(process.env.HOME, '.local/share/deepseekbot');
const output = path.resolve(process.env.UI_OUTPUT || path.join(__dirname, '../output/ui'));
fs.mkdirSync(output, {recursive:true, mode:0o700});
let phase = 'init';
(async () => {
 const access = fs.readFileSync(path.join(privateDir, 'access.html'), 'utf8');
 const url = JSON.parse(access.match(/location\.replace\((.+)\)<\/script>/)[1]);
 const browser = await webkit.launch({headless:true, proxy:{server:'http://127.0.0.1:9',bypass:'cli4.hahaxiong.cc'}});
 const context = await browser.newContext({viewport:{width:1440,height:1000}});
 const page = await context.newPage();
 let navigating=false; const errors = []; const navigationErrors=[]; page.on('pageerror', e => (navigating ? navigationErrors : errors).push(e.name));
 const networkFailures=[]; page.on('requestfailed',r=>networkFailures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
 const report = {openedBots:[], groups:[], errors,navigationErrors,networkFailures};
 try {
  if(process.env.PREVIEW_JS){
   const original = fs.readFileSync(process.env.ORIGINAL_JS, 'utf8').split('//# sourceMappingURL=')[0].trim();
   const patched = fs.readFileSync(process.env.PREVIEW_JS, 'utf8').split('//# sourceMappingURL=')[0].trim();
   await page.route('**/plugins/**', async route => {
    if(!route.request().url().includes('@botharness/ui/client.js')) return route.continue();
    try {
     const response = await route.fetch(); const body = await response.text();
     assert(body.includes(original), 'original bundle not found');
     await route.fulfill({response,body:body.replace(original,()=>patched)});
    }catch(e){errors.push('PreviewRouteFailure');await route.abort().catch(()=>{});}
   });
  }
  phase = 'login and default Bot mode';
  await page.goto(url, {waitUntil:'domcontentloaded',timeout:45000});
  for(let i=0;i<12;i++){
   for(const name of ['继续','知道了']){
    const b=page.getByRole('button',{name,exact:true});
    if(await b.count() && await b.first().isVisible()) await b.first().click();
   }
   await page.waitForTimeout(500);
  }
  const row = id => page.locator('button[data-channel-id="'+id+'"]:visible');
  const chief='dm-bot-50008695e5904fb8b843578655ff992c';
  await row(chief).waitFor({state:'visible',timeout:12000});
  const reply=page.getByText('我是幕僚长，已在 Mac mini 的 DeepSeekBot 恢复。',{exact:true});
  await reply.last().waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('[data-workspace-enabled]').count(),0);
  report.defaultDmVisible=true;
  await page.screenshot({path:path.join(output,'dm.png')});
  phase='all bot navigation';
  const rows=await page.locator('button[data-channel-id]:visible').evaluateAll(xs=>xs.map(x=>({id:x.dataset.channelId,name:x.querySelector('.bh-name')?.textContent})));
  assert.equal(rows.filter(x=>x.id.startsWith('dm-')).length,15);
  assert.equal(rows.filter(x=>x.id.startsWith('group-')).length,2);
  for(const r of rows.filter(x=>x.id.startsWith('dm-'))){
   phase="open bot: "+r.name;
   await row(r.id).click();
   await page.locator('.bh-chat-pane:visible').getByText(r.name,{exact:true}).first().waitFor({state:'visible',timeout:15000});
   await page.locator('.bh-chat-pane:visible [role="textbox"]').last().waitFor({state:'visible',timeout:15000});
   await page.waitForTimeout(700);
   report.openedBots.push(r.name);
  }
  phase='group members and sessions';
  for(const [id,count] of [['group-3462aef4-5e94-4283-a446-e196d1627134',3],['group-8638dc31-4593-4ac7-9936-56f891e963b0',6]]){
   await row(id).click();
   const sidebar=page.locator('#bh-channel-sidebar:visible');
   await sidebar.locator('.bh-member-open-dm').first().waitFor({state:'visible',timeout:15000});
   assert.equal(await sidebar.locator('.bh-member-open-dm').count(),count);
   await sidebar.getByText('会话',{exact:true}).first().waitFor({state:'visible',timeout:5000});
   await sidebar.getByText('这个群让 Bot 做的任务会显示在这里。',{exact:true}).waitFor({state:'visible',timeout:15000});
   await page.locator('.bh-chat-pane:visible [role="textbox"]').last().waitFor({state:'visible',timeout:15000});
   await page.waitForTimeout(500);
   report.groups.push({id,members:count,sessionsVisible:true});
  }
  await page.screenshot({path:path.join(output,'group.png')});
  phase='daily URL and refresh';
  navigating=true;
  await page.goto('https://cli4.hahaxiong.cc/deepseekbot/',{waitUntil:'domcontentloaded'});
  await reply.last().waitFor({state:'visible',timeout:20000});
  await page.reload({waitUntil:'domcontentloaded'});
  await reply.last().waitFor({state:'visible',timeout:20000});
  report.dailyUrlAndReload=true;
  await page.waitForTimeout(1000); navigating=false;
  for(const size of [{width:1280,height:800},{width:2048,height:1156}]){
   await page.setViewportSize(size);
   await page.waitForTimeout(400);
   const bounds=await page.locator('.bh-chat-pane:visible [role="textbox"]').last().boundingBox();
   assert(bounds && bounds.x>=0 && bounds.x+bounds.width<=size.width+1 && bounds.y+bounds.height<=size.height+1);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  report.desktopViewportChecks=true;
  phase='mobile viewport'; navigating=true;
  await page.setViewportSize({width:390,height:844});
  await page.reload({waitUntil:'domcontentloaded'});
  await reply.last().waitFor({state:'visible',timeout:20000});
  await page.waitForTimeout(1000); navigating=false;
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const mobileComposer=await page.locator('.bh-chat-pane:visible [role="textbox"]').last().boundingBox();
  assert(mobileComposer && mobileComposer.x>=0 && mobileComposer.x+mobileComposer.width<=391 && mobileComposer.y+mobileComposer.height<=845);
  report.mobileViewportCheck=true;
  await page.screenshot({path:path.join(output,'mobile.png')});
  report.cleanUrl=!page.url().includes('token=');
  assert.equal(errors.length,0);
  report.passed=true;
  console.log(JSON.stringify(report));
 } catch(e) {
  report.passed=false;report.failedPhase=phase;report.errorType=e.name;
  console.log(JSON.stringify(report));process.exitCode=1;
 } finally {
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  await page.screenshot({path:path.join(output,'last.png')}).catch(()=>{});
  await page.unrouteAll({behavior:'ignoreErrors'});
  await context.close();await browser.close();
 }
})().catch(e=>{console.log(JSON.stringify({phase,errorType:e.name}));process.exitCode=1;});
