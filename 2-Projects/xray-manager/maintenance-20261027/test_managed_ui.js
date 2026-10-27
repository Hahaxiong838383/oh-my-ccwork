// Offline DOM/interaction contract. No browser dependencies, network or services.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, 'xray-manager.py'), 'utf8');
const script = source.slice(source.indexOf('<script>') + 8, source.indexOf('// ========== 初始化 =========='));
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {textContent:'',innerHTML:'',className:'',hidden:false,disabled:false,title:'',style:{},classList:{add(){},remove(){}}});
  return elements.get(id);
}
let writes = [{disabled:false,title:''}], requests = [], confirmAnswer = false;
const sandbox = {
  document:{getElementById:element,querySelectorAll:selector => selector === '[data-config-write]' ? writes : []},
  fetch:async()=>{throw Error('real network forbidden');},
  confirm:()=>confirmAnswer, setTimeout(){}, setInterval(){},
  location:{port:'8888'}, console,
};
vm.createContext(sandbox);vm.runInContext(script, sandbox);
function run(s) { return vm.runInContext(s, sandbox); }
function render(status) { sandbox.fixture=status;run('renderManagedStatus(fixture)'); }
function fixture() {
  return {schema_version:1,managed:true,overall:{status:'healthy',reason_code:'ok'},
    controller:{process:'running',state_status:'OK',fresh:true,age_seconds:2,selected:'dmit'},
    routing:{available:true,override:'dmit',effective_route:'dmit',source:'override',static_default:'block'},
    routes:[{id:'dmit',fresh:true,service_ok:true,reachable:true,probes:{https:{ok:true,http:'204',kind:'ok'},codex:{ok:true,http:'401',kind:'ok'}}}],
    pin:{active:false,route:'auto'},updater:{pending:false,status:'no_pending_record',applied:null,assets:[]}};
}
let checks=0;
function check(name, fn) {fn();checks++;console.log('PASS '+name);}
(async()=>{
  check('managed controls are locked before first status',()=>{run('applyManagedLocks()');assert(writes[0].disabled);});
  check('healthy route is separate from static blackhole default',()=>{
    render(fixture());assert.match(element('managedHealthText').textContent,/探测正常/);
    assert.match(element('managedRouteText').textContent,/DMIT/);assert.match(element('managedDefaultText').textContent,/阻断/);
    assert(!element('managedRouteText').textContent.includes('cf-block'));assert(writes[0].disabled);
  });
  for(const status of ['degraded','blocked','error','stale','unavailable']) {
    check(status+' never paints healthy',()=>{
      const f=fixture();f.overall.status=status;f.controller.state_status=status==='error'?'CONTROL_ERROR':'DEGRADED';
      if(status==='stale'){f.controller.fresh=false;f.routes[0].fresh=false;}
      render(f);assert(!element('managedHealthDot').className.includes('on'));assert(!element('managedHealthText').textContent.includes('探测正常'));
      if(status==='stale')assert(!element('managedProbeList').innerHTML.includes('probe-pass'));
    });
  }
  check('empty override never claims static default is the actual route',()=>{
    const f=fixture();f.routing={available:true,override:'none',effective_route:'unknown',source:'unknown',static_default:'block'};f.overall.status='unavailable';
    render(f);assert.match(element('managedRouteText').textContent,/未确认/);assert.match(element('managedDefaultText').textContent,/阻断/);
  });
  check('pending persists as unverified rather than applied',()=>{
    const f=fixture();f.updater={pending:true,status:'pending_until_verified',applied:null,assets:['geoip.dat']};render(f);
    assert.match(element('managedUpdaterText').textContent,/已下载.*待确认应用/);assert(!element('managedUpdaterText').textContent.includes('已生效'));
  });
  check('active pin shows requested route separately',()=>{
    const f=fixture();f.pin={active:true,route:'home',remaining_seconds:91};render(f);
    assert.match(element('managedPinText').textContent,/家庭中继/);assert.match(element('managedPinText').textContent,/2 分钟/);
  });
  check('newly rendered write controls inherit lock',()=>{
    render(fixture());writes.push({disabled:false,title:''});run('applyManagedLocks()');assert(writes.every(x=>x.disabled));
    assert.match(run('configWriteAttrs()'),/disabled/);
  });
  check('unmanaged mode restores editable controls',()=>{
    const f=fixture();f.managed=false;render(f);assert(writes.every(x=>!x.disabled));
  });
  sandbox.request=async p=>{requests.push(p);return {success:true,running:true,pid:123};};run('api=request');
  render(fixture());
  for (const name of ['showSubModal','showImportModal','showNodeModal','editNode','deleteNode','saveNode','showPortModal','savePorts','showBalancerModal','editBalancer','deleteBalancer','saveBalancer','showRouteModal','editRoute','saveRoute','importVless','fetchSub','importSub']) await run(`${name}()`);
  assert.deepEqual(requests,[]);checks++;
  check('restart and stop require interruption confirmation',()=>{assert(source.includes('会中断现有连接'));});
  await run('restartXray()');await run('stopXray()');assert.deepEqual(requests,[]);checks++;
  confirmAnswer=true;await run('restartXray()');await run('stopXray()');
  assert(requests.includes('/restart')&&requests.includes('/stop'));checks++;
  sandbox.request=async()=>{throw Error('offline');};run('api=request');await run('refreshManagedStatus()');
  assert(!element('managedHealthDot').className.includes('on'));assert.match(element('managedRouteText').textContent,/未确认/);assert(writes.every(x=>x.disabled));checks++;
  await run('checkStatus()');assert.match(element('statusText').textContent,/未确认/);assert(!element('statusDot').className.includes('on'));checks++;
  render(fixture());run('managedLastReadAt=Date.now()-46000;processLastReadAt=Date.now()-46000;expireManagedStatus()');
  assert(!element('managedHealthDot').className.includes('on'));assert.match(element('statusText').textContent,/过期/);checks++;
  check('routing renderer includes balancer and inbound constraints',()=>{
    const html=run("renderRouteItem({outboundTag:'',balancerTag:'cf-lisa',domains:['domain:fixture.invalid'],ips:[],inboundTags:['cf-probe-home'],sources:[],port:'',network:'tcp'},0)");
    assert(html.includes('cf-lisa'));assert(html.includes('cf-probe-home'));assert(html.includes('配置目标'));
  });
  check('new status content is escaped',()=>{
    const f=fixture();f.controller.error_code='<img src=x onerror=alert(1)>';f.overall.status='error';render(f);
    assert(!element('managedProbeList').innerHTML.includes('<img'));assert(!element('managedHealthText').innerHTML.includes('<img'));
  });
  check('EasyTier insertion anchors remain intact',()=>{
    assert.equal(source.split('<div class="tab" onclick="switchTab(\'logs\')">日志</div>').length-1,1);
    assert(source.includes('  <!-- 节点管理 -->'));assert(source.includes('_extend_easytier_manager(Handler, HTML_PAGE)'));
  });
  console.log(`${checks} managed UI checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
