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
  const page=await browser.newPage({viewport:{width:390,height:844}}),requests=[],errors=[];let dashboardReads=0;
  page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(10000);
  await page.route('https://kidshub-ai.hahaxiong.cc/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'*'}});
   requests.push({path:url.pathname,query:url.search,method:request.method()});let data;
   if(url.pathname==='/api/auth/sms/verify')data={ok:true,token:'synthetic-parent-token'};
   else if(url.pathname==='/api/profile/bound-devices')data={ok:true,devices:[fixture.devices[0]]};
   else if(url.pathname==='/api/auth/wechat/identity')data={ok:true,wechat_identity:fixture.dashboard(fixture.devices[0]).wechat_identity};
   else if(url.pathname.endsWith('/dashboard')){
    data=fixture.dashboard(fixture.devices[0]);data.data.usage.today.total_seconds=24;data.data.usage.today.focus_minutes=0;data.data.historical_usage.total_seconds=5003;
    Object.assign(data.data.device,{color_mode:'warm',led_enabled:true,focus_active:false});
    data.data.ark={available:false,reason:'non_normal',reported_state:{source:'device.ark.state',source_mode:'gm',snapshot_id:'synthetic-snapshot',logical_day:'2026-11-08',captured_at_ms:1794898399000,received_at_ms:1794898400000,wallets:{family_coin:123+(dashboardReads++),stardust:0},inventory:{'M-CARD-001':2},progress:{timer_state:'paused',claimable_count:1,next_reward:{status:'claimable',kind:'currency',item_id:'C-FAMILY-001',stage_id:'REGULAR-05',remaining_seconds:0}}}};
    data.data.records.recent_activity={available:true,reason:'partial_history',items:[{record_id:'synthetic-realtime-grant',save_id:'synthetic-save',sequence:2,source_mode:'gm',reason:'gm_adjustment',logical_day:'2026-11-08',occurred_at_ms:1794898399000,received_at_ms:1794898400000,time_status:'reported',resource_changes:[],item_changes:[],grants:[{reward_instance_id:'synthetic-grant',source_kind:'progress_stage',source_id:'REGULAR-05',logical_day:'2026-11-08',resolved_rewards:[{item_id:'synthetic-new-decoration',quantity:1,kind:'decoration'}]}],inventory_changes:[{item_id:'synthetic-new-decoration',before:null,after:{quantity:1,status:'pending_activation'}}]}],has_more:false,next_cursor:null};
   }
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
  for(const value of ['暖光','已开灯','未计时','测试来源（GM）','游戏日 2026-11-08','不计入正常收益','可领取 · REGULAR-05','上报时距下一奖励 0 秒','实时业务记录','夜间同步的历史观测','synthetic-new-decoration × 1','库存 · synthetic-new-decoration：0 → 1'])assert(body.includes(value),value);
  await page.getByText('刷新',{exact:true}).click();
  await page.getByText('124',{exact:true}).waitFor();assert.equal(dashboardReads,2,'刷新重新查询最新游戏快照');
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
  console.log(JSON.stringify({pass:true,requests:requests.length,dashboard_reads:dashboardReads,observations_pages:requests.filter(x=>x.path.endsWith('/observations')).length,page_errors:errors,checks:['built H5','SMS compatibility','shared history and duration DTO','verified identity and optional UnionID','color and lighting','reported GM assets and game state separated from normal income','realtime grants and inventory alongside nightly observations','refresh updates reported state','observation pagination','logout clears data','no WeChat phone button in H5']},null,2));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
