// Optional browser regression: uses an existing Playwright installation only.
// NODE_PATH=/path/to/node_modules PLAYWRIGHT_EXECUTABLE_PATH=/path/to/browser node test_browser_ui.cjs
// Every request is intercepted; this test never contacts or changes production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const source = path.join(__dirname, 'xray-manager.py');
const extracted = spawnSync('python3', ['-c', "import ast,sys; t=ast.parse(open(sys.argv[1]).read()); print(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='HTML_PAGE' for x in n.targets)))", source], {encoding:'utf8'});
assert.equal(extracted.status, 0, extracted.stderr);
const base = {
  schema_version:1, managed:true, overall:{status:'healthy'},
  controller:{process:'running',state_status:'OK',fresh:true,age_seconds:2},
  routing:{effective_route:'dmit',override:'dmit',static_default:'block'},
  pin:{active:false},updater:{pending:false,assets:[]},
  routes:['dmit','zgo','home'].map(id=>({id,fresh:true,service_ok:true,reachable:true,
    probes:{https:{ok:true,http:'204'},codex:{ok:true,http:'401'}}}))
};
const config = {
  nodes:[{tag:'fixture',protocol:'vless',address:'fixture.invalid',port:443,network:'tcp',security:'tls'}],
  inbounds:[{tag:'socks',protocol:'mixed',listen:'127.0.0.1',port:10808}],
  routes:[{balancerTag:'cf-lisa',inboundTags:['fixture-inbound'],domains:['domain:fixture.invalid']}],
  balancers:[{tag:'cf-lisa',strategy:'random',nodeTags:['cf-block'],domains:[]}]
};
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:1000}});
    let data=structuredClone(base), fail=false; const errors=[], writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*', async route=>{
      const req=route.request(), url=new URL(req.url());
      if(req.method()!=='GET'){writes.push(req.method()+' '+url.pathname); return route.fulfill({status:409,json:{error:'fixture_write_denied'}});}
      if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:extracted.stdout});
      if(url.pathname==='/api/managed-status') return route.fulfill({status:fail?503:200,json:fail?{error:'fixture_unavailable'}:data});
      const fixtures={'/api/status':{running:true,pid:123},'/api/sysproxy':{supported:true,enabled:true,server:'127.0.0.1',port:10808},'/api/config':config,'/api/logs':{logs:'fixture'}};
      return route.fulfill({json:fixtures[url.pathname]||{}});
    });
    await page.goto('http://fixture.invalid/',{waitUntil:'networkidle'});
    assert.match(await page.locator('#managedRouteText').innerText(),/DMIT/);
    assert.match(await page.locator('#managedDefaultText').innerText(),/不代表当前出口/);
    assert.equal(await page.locator('#managedHealthDot').getAttribute('class'),'dot on');
    const locked=async()=>assert.equal(await page.locator('[data-config-write]:not([disabled])').count(),0);
    await locked();
    await page.evaluate(async()=>{await loadNodes();await loadRoutes();await loadBalancers();});
    await locked();
    assert.match(await page.locator('#routeList').innerText(),/cf-lisa/);
    assert.match(await page.locator('#routeList').innerText(),/fixture-inbound/);
    assert.match(await page.locator('#balancerList').innerText(),/非实际出口/);
    for(const status of ['degraded','stale','error','blocked','unavailable']){
      data={...structuredClone(base),overall:{status}};
      await page.evaluate(()=>refreshManagedStatus());
      assert.notEqual(await page.locator('#managedHealthDot').getAttribute('class'),'dot on');
      await locked();
    }
    data={...structuredClone(base),updater:{pending:true,assets:['geoip.dat']}};
    await page.evaluate(()=>refreshManagedStatus());
    assert.match(await page.locator('#managedUpdaterText').innerText(),/已下载，待确认应用/);
    assert.match(await page.locator('#managedUpdaterText').innerText(),/未自动重启/);
    fail=true;
    await page.evaluate(()=>refreshManagedStatus());
    assert.notEqual(await page.locator('#managedHealthDot').getAttribute('class'),'dot on');
    await locked();
    fail=false;data=structuredClone(base);await page.evaluate(()=>refreshManagedStatus());
    await page.evaluate(()=>{managedLastReadAt=Date.now()-46000;processLastReadAt=Date.now()-46000;expireManagedStatus();});
    assert.notEqual(await page.locator('#managedHealthDot').getAttribute('class'),'dot on');
    assert.match(await page.locator('#statusText').innerText(),/过期/);
    await locked();
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    if(process.env.XRAY_UI_SCREENSHOT){data=structuredClone(base);await page.evaluate(()=>refreshManagedStatus());await page.locator('#managedCard').screenshot({path:process.env.XRAY_UI_SCREENSHOT});}
    console.log('PASS: real-browser states, pending, request failure, expiry, dynamic edit locks, routing labels; zero writes and page errors');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
