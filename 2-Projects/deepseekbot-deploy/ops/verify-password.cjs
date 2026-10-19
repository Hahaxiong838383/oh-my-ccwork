/* No passwords, tokens, cookies or raw errors in output. Browser profile stays private. */
const fs=require('fs'),path=require('path'),os=require('os');
const {execFileSync}=require('child_process');
const assert=require('assert/strict');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const url='https://cli4.hahaxiong.cc/deepseekbot/';
const output=path.resolve(__dirname,'../output/auth');fs.mkdirSync(output,{recursive:true,mode:0o700});
let phase='read password',context,profile;
const report={};
let latestPage;const responses=[];
(async()=>{
 const air=['-o','HostName=RaymanMacBook-Air.local','-o','HostKeyAlias=10.9.1.110','-o','User=Rayman.Chen','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','air'];
 let password=execFileSync('ssh',[...air,"textutil -convert txt -stdout '/Users/rayman.chen/Documents/陈川个人站/DeepSeek Bot 密码.rtf'"],{stdio:['ignore','pipe','pipe'],timeout:20000}).toString().trim();
 profile=fs.mkdtempSync(path.join(os.tmpdir(),'deepseekbot-auth-'));fs.chmodSync(profile,0o700);
 const options={headless:true,viewport:{width:1280,height:900},proxy:{server:'http://127.0.0.1:9',bypass:'cli4.hahaxiong.cc'}};
 context=await webkit.launchPersistentContext(profile,options);
 let page=await context.newPage();latestPage=page;page.on('response',r=>{if(new URL(r.url()).pathname.includes('_auth'))responses.push({path:new URL(r.url()).pathname,status:r.status(),origin:r.request().headers().origin||'absent'});});
 phase='anonymous login form';
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await page.locator('input[autocomplete="current-password"]').waitFor();
 await page.screenshot({path:path.join(output,'login.png')});
 report.loginForm=true;
 phase='wrong password';
 await page.locator('#password').fill('incorrect-test-'+Date.now());
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'登录',exact:true}).click()]);
 await page.getByRole('alert').waitFor();
 assert(!(await context.cookies()).some(c=>c.name.startsWith('dsh-auth-')));report.wrongPasswordRejected=true;
 phase='real password and native session';
 await page.locator('#password').fill(password);
 const ws=[];page.on('websocket',s=>ws.push(new URL(s.url()).pathname));
 await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.getByRole('button',{name:'登录',exact:true}).click()]);
 password=null;
 assert(!page.url().includes('token='));
 async function ready(){
  for(let i=0;i<12;i++){
   for(const name of ['继续','知道了']){const b=page.getByRole('button',{name,exact:true});if(await b.count()&&await b.first().isVisible())await b.first().click();}
   await page.waitForTimeout(400);
  }
  await page.locator('button[data-channel-id="dm-bot-50008695e5904fb8b843578655ff992c"]:visible').waitFor({timeout:20000});
 }
 await ready();
 const cookies=(await context.cookies()).filter(c=>c.name.startsWith('dsh-auth-'));
 assert.equal(cookies.length,1);const c=cookies[0];
 assert(c.secure&&c.httpOnly&&c.sameSite==='Strict');assert.equal(c.path,'/deepseekbot/');
 assert(c.expires>Date.now()/1000+29*86400&&c.expires<Date.now()/1000+31*86400);
 report.nativeCookie={secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite,path:c.path,lifetimeDays:Math.round((c.expires-Date.now()/1000)/86400)};
 report.botRows=await page.locator('button[data-channel-id^="dm-"]:visible').count();assert.equal(report.botRows,15);
 report.webSocketOpened=ws.length>0;assert(report.webSocketOpened);
 await page.screenshot({path:path.join(output,'authenticated.png')});
 phase='close and reopen browser';
 await context.close();context=await webkit.launchPersistentContext(profile,options);page=await context.newPage();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await ready();
 assert.equal(await page.locator('input[type=password]').count(),0);report.browserRestartRemembered=true;
 phase='logout';
 const logout=await context.request.post(url+'_auth/logout',{headers:{origin:'https://cli4.hahaxiong.cc'},maxRedirects:0});
 assert.equal(logout.status(),303);
 await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('#password').waitFor();report.logout=true;
 report.ok=true;
})().catch(async()=>{report.ok=false;report.failedPhase=phase;report.authResponses=responses;if(latestPage)await latestPage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{
 if(context)await context.close().catch(()=>{});
 if(profile)fs.rmSync(profile,{recursive:true,force:true});
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
});
