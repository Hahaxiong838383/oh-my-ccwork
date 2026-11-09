// Full production Vue template with isolated API fixtures; never calls a production API.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),vm=require('node:vm');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE);
const html=fs.readFileSync(path.resolve(__dirname,'../public/admin/index.html'),'utf8');
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
const at=Date.now()-3600000;
const base={note:'验收夹具',parent_phone:null,status:'active',credential_expires_at:null,credential_issued_at:null,credential_source:null,last_active_at:at,session_count:11};
const status=(state,issued=at,available=true)=>({state:available?'available':'unavailable',issued_at_ms:issued,authenticated_at_ms:issued?at+1000:null,pairing:available?{state,bound_at_ms:at+2000,claim_deadline_ms:at+602000,claimed_at_ms:state==='waiting_auth'||state==='authenticated'?at+3000:null,authenticated_at_ms:state==='authenticated'?at+4000:null}:null});
const rows=[
 {...base,sn:'BJP00326110900000031',binding_policy:'ble-key-v1',ble_status:status('claim_expired')},
 {...base,sn:'BJP00326110900000032',binding_policy:'legacy',credential_source:'registry',credential_expires_at:Date.now()+86400000,ble_status:null},
 {...base,sn:'BJP00326110900000033',binding_policy:'ble-key-v1',ble_status:status('none',null,false)},
 {...base,sn:'BJP00326110900000034',binding_policy:'ble-key-v1'},
 ...['none','waiting_claim','waiting_auth','authenticated','revoked'].map((s,i)=>({...base,sn:'BJP0032611090000004'+i,binding_policy:'ble-key-v1',ble_status:status(s,s==='none'||s==='waiting_claim'?null:at)})),
];
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;let browser;const errors=[],writes=[];
 try {
  browser=await webkit.launch({headless:true});const page=await browser.newPage({viewport:{width:2160,height:1300},timezoneId:'Asia/Shanghai'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('kidshub_admin_token','isolated-ui-token');localStorage.setItem('kidshub_admin_role','admin');localStorage.setItem('kidshub_admin_username','隔离验收');});
  await page.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.hostname==='cdn.jsdelivr.net'){
    const name=u.pathname.includes('/vue@')?'vue.js':u.pathname.endsWith('index.css')?'element.css':u.pathname.includes('/element-plus@')?'element.js':'echarts.js';
    return route.fulfill({body:fs.readFileSync(path.join(process.env.ASSET_DIR,name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});
   }
   if(u.origin!==origin)return route.fulfill({json:{type:'FeatureCollection',features:[]}});
   if(!u.pathname.startsWith('/api/')&&!u.pathname.startsWith('/v1/'))return route.continue();
   if(req.method()!=='GET')writes.push({path:u.pathname,method:req.method()});
   if(u.pathname==='/api/auth/check')return route.fulfill({json:{ok:true,role:'admin'}});
   if(u.pathname==='/api/admin/devices')return route.fulfill({json:{ok:true,devices:rows,env_allow:[],stats:{today_ok:11,today_rejected:0}}});
   return route.fulfill({json:{ok:true,items:[],devices:[],sessions:[],themes:[],machines:[],breakdown:[],stats:{}}});
  });
  await page.goto(origin,{waitUntil:'networkidle'});await page.getByText('Worker 管理 ⚙',{exact:true}).click();
  const row=page.locator('.el-table__body tr').filter({hasText:'BJP00326110900000031'}).first();await row.waitFor();
  const text=await row.innerText();assert(text.includes('已有自动领证记录'));assert(text.includes('到期时间未记录'));assert(text.includes('领证窗口已过期'));assert(!text.includes('未签发'));assert(!text.includes('本轮已认证'));
  const legacy=await page.locator('.el-table__body tr').filter({hasText:'BJP00326110900000032'}).first().innerText();assert(legacy.includes('至 '));assert(!legacy.includes('到期时间未记录'));
  for(const sn of ['00000033','00000034']){const t=await page.locator('.el-table__body tr').filter({hasText:'BJP003261109'+sn}).first().innerText();assert(t.includes('领证状态暂不可查'));assert(t.includes('配对状态暂不可查'));assert(!t.includes('未签发'));}
  for(const label of ['暂无配对记录','已绑定 · 待设备领证','已领证 · 待设备认证','本轮已认证','本轮已撤销'])assert(await page.getByText(label,{exact:true}).count()>0,label);
  assert(await page.getByText('设备凭据',{exact:true}).count()>0);assert(await page.getByText('本轮配对',{exact:true}).count()>0);assert(await page.getByText('累计场次',{exact:true}).count()>0);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  console.log('PASS 18 UI checks: full Vue/WebKit, C reproduction, legacy, missing/unavailable data, all pairing states, columns retained, zero page errors, zero write requests');
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
