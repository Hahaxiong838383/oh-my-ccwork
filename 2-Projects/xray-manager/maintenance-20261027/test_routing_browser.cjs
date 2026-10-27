// Real Chromium fixture acceptance. Every request is intercepted; no production access.
// Uses an existing Playwright install via NODE_PATH and PLAYWRIGHT_EXECUTABLE_PATH.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');

const source = path.join(__dirname, 'xray-manager.py');
const extracted = spawnSync('python3', ['-c', "import ast,sys; t=ast.parse(open(sys.argv[1]).read()); print(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='HTML_PAGE' for x in n.targets)))", source], {encoding:'utf8'});
assert.equal(extracted.status, 0, extracted.stderr);
const managed = {
  schema_version:1,managed:true,overall:{status:'healthy'},
  controller:{process:'running',state_status:'OK',fresh:true,age_seconds:1},
  routing:{effective_route:'dmit',override:'dmit',static_default:'block'},
  routes:[],pin:{active:false},updater:{pending:false,assets:[]}
};
const policy = {
  schema_version:1,revision:'revision-1',
  groups:[
    {tag:'cf-lisa',enabled:true,protected:true,rule_indices:[0],nodeTags:['cf-block'],strategy:'random'},
    {tag:'fixture-group',enabled:true,protected:false,rule_indices:[1],fallback:null,nodeTags:['backup-fixture'],strategy:'leastPing'}
  ],
  audit:{issues:[{severity:'warning',code:'partial_overlap',message:'合成规则部分条件重叠',rules:[1,2]}],counts:{error:0,warning:1,info:0}},
  publication:{state:'unverified',verified_at:null},fallbacks:[{tag:'backup-fixture',protocol:'vless'}]
};
const config = {
  nodes:[],inbounds:[{tag:'socks',protocol:'mixed',listen:'127.0.0.1',port:10808}],
  routes:[
    {outboundTag:'',balancerTag:'cf-lisa',domains:['domain:protected.invalid'],ips:[],inboundTags:[],sources:[]},
    {outboundTag:'',balancerTag:'fixture-group',domains:['domain:fixture.invalid'],ips:[],inboundTags:[],sources:[]}
  ],
  balancers:policy.groups.map(g=>({...g,domains:['domain:fixture.invalid'],ips:[],probeInterval:'60s'}))
};

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:1050}});
    const errors=[],posts=[],unexpected=[];const plans=new Map();let nextPlan=0,nextRevision=1,mode='normal';
    let holdConfig=false,failConfigCountdown=0;
    const heldConfig=[];
    const awaitHeld=async count=>{
      const deadline=Date.now()+5000;
      while(heldConfig.length<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(heldConfig.length,count,'expected deferred configuration reads');
    };
    const releaseConfig=async(item,data=item.data)=>{await item.route.fulfill({json:data});item.done();};
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),endpoint=url.pathname;
      if(req.method()==='GET'){
        if(endpoint==='/')return route.fulfill({contentType:'text/html',body:extracted.stdout});
        if(endpoint==='/api/config'&&holdConfig){
          await new Promise(done=>heldConfig.push({route,data:structuredClone(config),done}));return;
        }
        if(endpoint==='/api/config'&&failConfigCountdown>0&&--failConfigCountdown===0)return route.fulfill({status:503,json:{error:'fixture_config_refresh_failed'}});
        const fixtures={
          '/api/status':{running:true,pid:123},'/api/sysproxy':{supported:true,enabled:true,server:'127.0.0.1',port:10808},
          '/api/config':config,'/api/managed-status':managed,'/api/routing-policy':policy,'/api/logs':{logs:'fixture'}
        };
        if(endpoint in fixtures)return route.fulfill({json:fixtures[endpoint]});
        return route.fulfill({status:404,json:{error:'fixture_not_found'}});
      }
      const body=req.postDataJSON();posts.push({method:req.method(),endpoint,body});
      if(req.method()==='POST'&&endpoint==='/api/routing-policy/preview'){
        const id='fixture-preview-'+(++nextPlan);
        const blocked=mode==='blocked';
        const preview={success:true,preview_id:id,revision:policy.revision,
          expires_at:Date.now()/1000+(mode==='expired'?-1:60),
          changes:[{kind:body.action,rule:1,message:body.action==='normalize'?'按原位置整理合成重复规则':body.enabled?'恢复原规则条件和位置':'原规则保持条件并显式转向 '+body.fallback}],
          audit:{issues:blocked?[{severity:'error',code:'fixture_conflict',message:'合成冲突：禁止发布',rules:[1,2]}]:[]},
          can_apply:!blocked,requires_restart:true};
        plans.set(id,{request:body,preview});return route.fulfill({json:preview});
      }
      if(req.method()==='POST'&&endpoint==='/api/routing-policy/apply'){
        if(Object.keys(body).length!==1||typeof body.preview_id!=='string'||!plans.has(body.preview_id)){
          unexpected.push('apply must contain only known preview_id');return route.fulfill({status:422,json:{error:'fixture_bad_apply'}});
        }
        const plan=plans.get(body.preview_id);
        if(!plan.preview.can_apply||plan.preview.revision!==policy.revision||plan.preview.expires_at<=Date.now()/1000){
          unexpected.push('unusable preview was submitted');return route.fulfill({status:409,json:{error:'fixture_preview_invalid'}});
        }
        if(plan.request.action==='toggle'){
          const group=policy.groups.find(g=>g.tag===plan.request.tag);
          if(!group||group.protected){unexpected.push('protected or unknown group applied');return route.fulfill({status:422,json:{error:'fixture_protected'}});}
          group.enabled=plan.request.enabled;group.fallback=group.enabled?null:plan.request.fallback;
          config.routes[1]={...config.routes[1],outboundTag:group.enabled?'':group.fallback,balancerTag:group.enabled?group.tag:''};
        }
        policy.revision='revision-'+(++nextRevision);policy.publication={state:'applied',verified_at:Date.now()/1000};
        return route.fulfill({json:{success:true,state:'applied',message:'合成发布已验证',applied_at:Date.now()/1000,revision:policy.revision}});
      }
      unexpected.push(req.method()+' '+endpoint);return route.fulfill({status:409,json:{error:'fixture_other_write_denied'}});
    });
    const countApply=()=>posts.filter(x=>x.endpoint.endsWith('/apply')).length;
    const row=tag=>page.locator('#balancerList .node-item').filter({has:page.locator('.node-tag').filter({hasText:new RegExp('^'+tag+'$')})});
    const waitSettled=()=>page.waitForFunction(()=>routingBusy===false&&networkOperationBusy===false&&routingFetchPromise===null);
    const closePreview=()=>page.locator('#routingPreviewModal').getByRole('button',{name:'取消',exact:true}).click();

    await page.goto('http://routing-fixture.invalid/',{waitUntil:'networkidle'});
    await page.getByText('均衡组',{exact:true}).click();await waitSettled();
    assert.equal(await row('cf-lisa').getByRole('button',{name:'受保护',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('[data-config-write]:not([disabled])').count(),0);
    assert.match(await page.locator('#balancerPublicationText').innerText(),/运行状态未确认/);

    // Ordinary disable: choosing a fallback is required, preview is a separate step.
    await row('fixture-group').getByRole('button',{name:'停用…',exact:true}).click();
    const beforePreview=posts.length;
    await page.locator('#groupPreviewBtn').click();
    assert.equal(posts.length,beforePreview);assert.match(await page.locator('#toast').innerText(),/选择明确的备用出口/);
    await page.locator('#routingFallback').selectOption('backup-fixture');
    await page.locator('#groupPreviewBtn').click();await page.locator('#routingPreviewModal.show').waitFor();await waitSettled();
    assert.deepEqual(posts.at(-1).body,{action:'toggle',tag:'fixture-group',enabled:false,fallback:'backup-fixture'});
    assert.equal(countApply(),0);assert.match(await page.locator('#routingPreviewSummary').innerText(),/尚未应用/);
    assert.match(await page.locator('#routingPreviewChanges').innerText(),/规则 2.*backup-fixture/);
    assert.equal(await page.locator('#routingApplyBtn').isEnabled(),true);
    const disableId=await page.evaluate(()=>routingPreview.preview_id);
    // Delay reads begun before publication and all post-publication list refreshes.
    holdConfig=true;
    await page.evaluate(()=>{window.prePublishReads=Promise.all([loadNodes(),loadRoutes(),loadBalancers()]);});
    await awaitHeld(3);const oldReads=heldConfig.splice(0);
    await page.locator('#routingApplyBtn').click();await awaitHeld(3);
    for(const item of oldReads){
      const old={...item.data,nodes:[{tag:'obsolete-response',address:'fixture.invalid',port:443}],
        routes:[{outboundTag:'obsolete-response',domains:[],ips:[]}],balancers:[{tag:'obsolete-response',nodeTags:[],domains:[],ips:[]}]};
      await releaseConfig(item,old);
    }
    await page.evaluate(()=>window.prePublishReads);
    for(const id of ['nodeList','routeList','balancerList'])assert.doesNotMatch(await page.locator('#'+id).textContent(),/obsolete-response/);
    assert.equal(await page.evaluate(()=>routingBusy),true);
    assert.equal(await page.locator('#normalizePreviewBtn').isDisabled(),true);
    const freshReads=heldConfig.splice(0);
    await releaseConfig(freshReads[0]);await releaseConfig(freshReads[1]);
    assert.equal(await page.evaluate(()=>routingBusy),true,'the remaining list must keep publication locked');
    holdConfig=false;await releaseConfig(freshReads[2]);await waitSettled();
    assert.equal(countApply(),1);assert.deepEqual(posts.find(x=>x.endpoint.endsWith('/apply')).body,{preview_id:disableId});
    assert.match(await row('fixture-group').innerText(),/已配置：停用/);assert.match(await row('fixture-group').innerText(),/显式备用：backup-fixture/);
    assert.equal(config.balancers.filter(x=>x.tag==='fixture-group').length,1);
    assert.match(await page.locator('#balancerPublicationText').innerText(),/最近发布已验证/);

    // Enable uses stored original conditions, with no newly invented fallback.
    await row('fixture-group').getByRole('button',{name:'启用…',exact:true}).click();
    assert.equal(await page.locator('#routingFallbackField').isVisible(),false);
    await page.locator('#groupPreviewBtn').click();await page.locator('#routingPreviewModal.show').waitFor();await waitSettled();
    assert.deepEqual(posts.at(-1).body,{action:'toggle',tag:'fixture-group',enabled:true});
    assert.equal(countApply(),1);failConfigCountdown=2;
    await page.locator('#routingApplyBtn').click();await waitSettled();
    assert.equal(countApply(),2);assert.match(await row('fixture-group').innerText(),/已配置：启用/);
    assert.match(await page.locator('#routeList').textContent(),/刷新失败/);
    assert.equal(await page.locator('#routeList .route-item').count(),0);
    assert.match(await page.locator('#toast').innerText(),/刷新失败/);

    // Normalize reports conflicts and cannot apply a blocked plan.
    await page.getByText('路由规则',{exact:true}).first().click();await waitSettled();
    await page.waitForFunction(()=>document.querySelectorAll('#routeList .route-item').length===2);
    assert.doesNotMatch(await page.locator('#routeList').innerText(),/刷新失败/);
    assert.match(await page.locator('#routingAuditList').innerText(),/规则 2、3/);
    mode='blocked';await page.locator('#normalizePreviewBtn').click();await page.locator('#routingPreviewModal.show').waitFor();await waitSettled();
    assert.deepEqual(posts.at(-1).body,{action:'normalize'});assert.match(await page.locator('#routingPreviewIssues').innerText(),/阻断.*合成冲突/);
    assert.equal(await page.locator('#routingApplyBtn').isDisabled(),true);assert.equal(countApply(),2);await closePreview();

    mode='expired';await page.locator('#normalizePreviewBtn').click();await page.locator('#routingPreviewModal.show').waitFor();await waitSettled();
    assert.equal(await page.locator('#routingApplyBtn').isDisabled(),true);assert.match(await page.locator('#routingPreviewValidity').innerText(),/预览已过期/);await closePreview();

    mode='normal';await page.locator('#normalizePreviewBtn').click();await page.locator('#routingPreviewModal.show').waitFor();await waitSettled();
    assert.equal(await page.locator('#routingApplyBtn').isEnabled(),true);
    policy.revision='external-fixture-revision';await page.evaluate(()=>loadRoutingPolicy());
    assert.equal(await page.locator('#routingApplyBtn').isDisabled(),true);assert.match(await page.locator('#routingPreviewValidity').innerText(),/配置已变化/);
    assert.equal(countApply(),2);assert.equal(await page.locator('[data-config-write]:not([disabled])').count(),0);
    assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    console.log('PASS: Chromium click flow preserves protected routing, ignores pre-publication responses, locks through delayed refreshes, clears failed lists and recovers on retry; two fixture-only applies, zero unexpected writes/page errors');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
