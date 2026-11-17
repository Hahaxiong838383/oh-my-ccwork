// Built H5, synthetic identities only; every business request is intercepted locally.
const {chromium}=require(process.env.P003_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const fixture=require('../../web/scripts/fixtures/miniapp-admin/data.cjs');
const root=path.resolve(__dirname,'../dist/h5');
(async()=>{
 const server=http.createServer((req,res)=>{try{const name=decodeURIComponent(req.url.split('?')[0]);const file=path.join(root,name==='/'?'index.html':name);res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webp')?'image/webp':file.endsWith('.png')?'image/png':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,...process.env.P003_CHROMIUM_PATH?{executablePath:process.env.P003_CHROMIUM_PATH}:{}});
  const page=await browser.newPage({viewport:{width:390,height:844}}),requests=[],errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(10000);
  await page.route('https://kidshub-ai.hahaxiong.cc/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'*'}});
   requests.push({path:url.pathname,query:url.search,method:request.method()});let data;
   if(url.pathname==='/api/auth/sms/verify')data={ok:true,token:'synthetic-parent-token'};
   else if(url.pathname==='/api/profile/bound-devices')data={ok:true,devices:[fixture.devices[0]]};
   else if(url.pathname==='/api/auth/wechat/identity')data={ok:true,wechat_identity:fixture.dashboard(fixture.devices[0]).wechat_identity};
   else if(url.pathname.endsWith('/dashboard')){data=fixture.dashboard(fixture.devices[0]);data.data.usage.today.total_seconds=24;data.data.usage.today.focus_minutes=0;data.data.historical_usage.total_seconds=5003;}
   else if(url.pathname.endsWith('/observations'))data=fixture.observations(url.searchParams.get('cursor'));
   else if(url.pathname.endsWith('/conversations'))data=fixture.conversations(url.searchParams.get('cursor'));
   else if(url.pathname.endsWith('/ark/records'))data=fixture.records(url.searchParams.get('cursor'));
   else throw new Error('unexpected business request '+url.pathname);
   return route.fulfill({json:data,headers:{'access-control-allow-origin':'*'}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'networkidle'});
  await page.locator('input[placeholder="请输入手机号"]').fill('13800000001');await page.locator('input[placeholder="6位短信验证码"]').fill('123456');await page.getByText('短信登录',{exact:true}).click();
  await page.getByText('已同步历史 83 分 23 秒',{exact:true}).waitFor();
  const body=await page.locator('body').innerText();
  for(const value of ['今日 24 秒','微信身份已验证','wx_fixture','微信暂未返回 UnionID','历史奖励与道具','history_decor_0','1 → 0','不能据此认定家族币或星尘为 0'])assert(body.includes(value),value);
  assert(!body.includes('微信手机号授权登录'),'H5 不展示微信专属手机号按钮');
  await page.getByText('查看全部已同步历史',{exact:true}).click();await page.getByText('加载更多',{exact:true}).waitFor();
  await page.getByText('加载更多',{exact:true}).click();await page.getByText('已显示本次查询全部已同步记录',{exact:true}).waitFor();
  assert(requests.some(x=>x.path.endsWith('/observations')&&x.query.includes('cursor=observations_next')));
  const evidence=process.env.P003_UI_EVIDENCE_DIR;
  if(evidence){fs.mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'miniapp-h5-history-390.png'),fullPage:true});}
  await page.getByText('退出登录',{exact:true}).click();await page.getByText('短信登录',{exact:true}).waitFor();
  assert(!(await page.locator('body').innerText()).includes('history_decor_0'));
  assert.equal(errors.length,0,errors.join('\n'));
  assert.equal(requests.filter(x=>x.method==='POST').length,1,'仅合成短信验证，不发送短信或微信授权');
  console.log(JSON.stringify({pass:true,requests:requests.length,observations_pages:requests.filter(x=>x.path.endsWith('/observations')).length,page_errors:errors,checks:['built H5','SMS compatibility','shared history and duration DTO','verified identity and optional UnionID','observation pagination','logout clears data','no WeChat phone button in H5']},null,2));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
