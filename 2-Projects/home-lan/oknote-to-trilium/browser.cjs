const {chromium}=require('/home/hahaxiong83/.npm/_npx/31e32ef8478fbf80/node_modules/playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const base='http://192.168.1.115:38081';
(async()=>{
 const v=JSON.parse(execFileSync('/home/hahaxiong83/.local/bin/vw',['get','item','飞牛2 TriliumNext 登录与维护'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 const token=v.fields.find(x=>x.name==='ETAPI_TOKEN').value;
 const samples=JSON.parse(execFileSync('python3',['/tmp/oknote-trilium-20261023/run.py','/tmp/oknote-trilium-20261023/ui-samples.py'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 if(!Array.isArray(samples))throw Error('samples_unavailable');
 const browser=await chromium.launch({headless:true,executablePath:'/home/hahaxiong83/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome'});
 const results=[];let stage='login';let page;
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==base)return route.abort();
   if(!['GET','HEAD'].includes(req.method())&&!u.pathname.includes('login')&&!['/api/tree/load','/api/notes/metadata'].includes(u.pathname))return route.abort();
   return route.continue();
  });
  page=await ctx.newPage();page.setDefaultTimeout(30000);await page.goto(base,{waitUntil:'domcontentloaded'});
  stage='fill_password';await page.locator('input[type=password]').fill(v.login.password);
  stage='click_login';await page.getByRole('button',{name:/Log in|登录/}).click();
  stage='wait_tree';await page.locator('.tree-wrapper').waitFor({state:'attached',timeout:60000});await page.waitForTimeout(1500);
  console.log(JSON.stringify({stage:'logged_in'}));for(const sample of samples){
   stage='open_sample';await page.goto(base+'/#root/'+sample.id,{waitUntil:'domcontentloaded'});
   const editor=page.locator('.note-detail-editable-text-editor.ck-editor__editable:visible, .note-detail-readonly-text-content:visible').last();
   stage='wait_editor';await editor.waitFor({state:'visible',timeout:60000});
   stage='wait_content';await page.waitForFunction(()=>document.querySelector('.note-detail-editable-text-editor.ck-editor__editable, .note-detail-readonly-text-content')?.textContent?.includes('OK笔记原始正文'),null,{timeout:60000});
   await editor.locator('img').evaluateAll(imgs=>imgs.forEach(i=>i.loading='eager'));
   await page.waitForTimeout(2500);
   const result=await editor.evaluate(el=>({tables:el.querySelectorAll('table').length,images:el.querySelectorAll('img').length,localImages:[...el.querySelectorAll('img')].filter(i=>i.src.includes('/api/attachments/')).length,loadedLocalImages:[...el.querySelectorAll('img')].filter(i=>i.src.includes('/api/attachments/')&&i.complete&&i.naturalWidth>0).length,tasks:el.querySelectorAll('input[type=checkbox]').length,math:el.querySelectorAll('.ck-math-tex, .math-tex').length,nonempty:el.textContent.length>20,internalLinks:el.querySelectorAll('a[href^="#root/"]').length}));
   result.expectedTables=sample.tables;result.expectedImages=sample.images;result.expectedTasks=sample.tasks;result.expectedMath=sample.math;result.passed=result.nonempty&&result.tables===sample.tables&&result.images>=sample.images&&result.loadedLocalImages===result.localImages&&result.tasks===sample.tasks&&result.math>=sample.math;
   results.push(result);console.log(JSON.stringify({stage:'sample',result}));
   if(!result.passed)throw Error('ui_payload_mismatch');
  }
  const report={login:true,readOnly:true,samples:results,complete:true};fs.writeFileSync('/tmp/oknote-trilium-20261023/browser-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(e){console.log(JSON.stringify({failedStage:stage,diagnostic:page?await page.evaluate(()=>({passwordInputs:document.querySelectorAll('input[type=password]').length,treeWrappers:document.querySelectorAll('.tree-wrapper').length,treeLists:document.querySelectorAll('.fancytree-container').length,editors:document.querySelectorAll('.ck-editor__editable').length,invalidPassword:/invalid password|incorrect password|密码错误|密码不正确/i.test(document.body.innerText)})):null}));throw e}finally{await browser.close()}
})().catch(e=>{console.log(JSON.stringify({error:e.name,stage:'browser',reason:['ui_payload_mismatch','samples_unavailable'].includes(e.message)?e.message:'details_suppressed'}));process.exit(1)});
