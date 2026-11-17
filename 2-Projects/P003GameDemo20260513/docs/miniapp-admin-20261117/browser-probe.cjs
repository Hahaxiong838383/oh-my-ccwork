// Read-only actual public admin page. Private token file is deleted after use; no screenshot/body saved.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const D=process.env.P003_MINIAPP_LOCAL_DIR,base='https://kidshub-ai.hahaxiong.cc';
const tokenPath=D?path.join(D,'browser-auth.private'):null;
const result={at_ms:Date.now(),pass:false,public_html:true,real_unbind_performed:false,business_writes:0,reads:[],page_errors:0};
(async()=>{let browser,stage='start';try{
 assert(D,'P003_MINIAPP_LOCAL_DIR required');const {chromium}=require(process.env.P003_PLAYWRIGHT_MODULE||'playwright');const auth=JSON.parse(fs.readFileSync(tokenPath));
 browser=await chromium.launch({headless:true,...(process.env.P003_CHROMIUM_PATH?{executablePath:process.env.P003_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(a=>{localStorage.setItem('kidshub_admin_token',a);localStorage.setItem('kidshub_admin_role','admin');localStorage.setItem('kidshub_admin_username','admin');},auth.admin);
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',()=>result.page_errors++);
 await page.route('**/*',r=>['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
 page.on('response',r=>{const u=new URL(r.url());if(u.pathname.includes('/miniapp/'))result.reads.push({path:u.pathname,status:r.status()});});
 stage='load_public_admin';await page.goto(base+'/admin/',{waitUntil:'domcontentloaded'});
 await page.getByText('Worker 管理 ⚙',{exact:true}).click();await page.getByRole('button',{name:'小程序 Dashboard',exact:true}).click();
 const panel=page.getByRole('region',{name:'小程序 Dashboard',exact:true});
 stage='C_registry';await panel.getByRole('textbox',{name:'搜索设备'}).fill(auth.sn);const dashboardResponse=page.waitForResponse(r=>r.url().includes('/miniapp/dashboard'));await panel.getByRole('button',{name:'查看详情',exact:true}).first().click();assert.equal((await dashboardResponse).status(),200);
 await panel.getByRole('button',{name:'身份与接入',exact:true}).waitFor();
 stage='dashboard_render';await panel.locator('[data-testid="miniapp-today"]').waitFor();assert((await panel.innerText()).includes(auth.sn));
 for(const [title,suffix] of [['业务流水','records'],['历史对话','conversations']]){
  stage='read_'+suffix;const response=page.waitForResponse(r=>r.url().includes('/miniapp/'+suffix));await panel.getByRole('button',{name:title,exact:true}).click();assert.equal((await response).status(),200);
 }
 stage='identity_render';await panel.getByRole('button',{name:'身份与接入',exact:true}).click();assert((await panel.innerText()).includes(auth.public_id));
 assert.equal(result.page_errors,0);assert(result.reads.length>=3&&result.reads.every(r=>r.status===200));result.pass=true;
 }catch(e){result.failed_stage=stage;result.error_type=e.name;process.exitCode=1;}
 finally{try{if(browser)await browser.close();}catch(e){result.pass=false;result.close_error_type=e.name;process.exitCode=1;}finally{if(tokenPath)fs.rmSync(tokenPath,{force:true});if(D)fs.writeFileSync(path.join(D,'PUBLIC-BROWSER.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}}
})();
