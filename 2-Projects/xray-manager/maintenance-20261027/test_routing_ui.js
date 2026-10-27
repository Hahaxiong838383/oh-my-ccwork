// Pure UI contract; all API requests and time are synthetic.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(process.argv[2]||path.join(__dirname,'xray-manager.py'),'utf8');
const script=source.slice(source.indexOf('<script>')+8,source.indexOf('// ========== 初始化 =========='));
let clock=Date.now();
class TestDate extends Date { static now(){return clock;} }
const elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',hidden:false,disabled:false,value:'',style:{},dataset:{},className:'',classList:{add(){},remove(){}}});return elements.get(id);}
let calls=[],request;
const sandbox={Date:TestDate,document:{getElementById:el,querySelectorAll:()=>[]},setTimeout(){},setInterval(){},confirm:()=>true,location:{port:'8888'},console,fetch:()=>{throw Error('network forbidden');}};
vm.createContext(sandbox);vm.runInContext(script,sandbox);
const run=s=>vm.runInContext(s,sandbox);
const groups=[{tag:'cf-lisa',enabled:true,protected:true,rule_indices:[3],nodeTags:['cf-block'],strategy:'random'},
 {tag:'fixture',enabled:true,protected:false,rule_indices:[4,8],nodeTags:['backup'],strategy:'leastPing'},
 {tag:'disabled',enabled:false,protected:false,rule_indices:[5],fallback:'backup',nodeTags:['backup'],strategy:'leastPing'}];
const policy={schema_version:1,revision:'baseline',groups,audit:{issues:[{severity:'warning',code:'overlap',message:'部分条件重叠',rules:[4,8]}]},publication:{state:'unverified'},fallbacks:[{tag:'backup',protocol:'vless'}]};
const config={inbounds:[],nodes:[],routes:[],balancers:groups.map(g=>({...g,domains:[],ips:[],probeInterval:'60s'}))};
function preview(extra={}){return {success:true,preview_id:'server-preview',revision:'baseline',expires_at:clock/1000+60,changes:[{kind:'toggle',rule:4,message:'保留条件，改为显式备用'}],audit:{issues:[]},can_apply:true,requires_restart:true,...extra};}
function health(age=0){return {schema_version:1,managed:true,overall:{status:'healthy'},controller:{process:'running',state_status:'OK',fresh:true,age_seconds:age},routing:{effective_route:'dmit',override:'dmit',static_default:'block'},routes:[],pin:{active:false},updater:{pending:false}};}
function installRequest(fn){request=fn;sandbox.dispatch=async(...args)=>{calls.push(args);return request(...args);};run('api=dispatch');}
function standard(p){if(p==='/routing-policy')return policy;if(p==='/config')return config;if(p==='/managed-status')return health();if(p==='/status')return {running:true,pid:123};if(p==='/routing-policy/preview')return preview();if(p==='/routing-policy/apply')return {success:true,state:'applied',message:'fixture applied'};throw Error('unexpected '+p);}
let checks=0;function ok(name,fn){fn();checks++;console.log('PASS '+name);}
(async()=>{
 installRequest(standard);await run('loadRoutingPolicy()');
 ok('audit keeps rule positions and separates publication evidence',()=>{assert.match(el('routingAuditList').innerHTML,/规则 5、9/);assert.match(el('routingPublicationText').textContent,/运行状态未确认/);});
 sandbox.configFixture=config;run('currentConfig=configFixture;renderBalancerList(configFixture.balancers)');
 ok('protected group has no ordinary toggle and disabled group retains definition',()=>{assert(el('balancerList').innerHTML.includes('受保护'));assert(el('balancerList').innerHTML.includes('已配置：停用'));assert(el('balancerList').innerHTML.includes('显式备用：backup'));});
 run('routingToggle=null;showGroupToggle(0)');ok('cf-lisa cannot open generic toggle',()=>assert.equal(run('routingToggle'),null));
 run('showGroupToggle(1)');calls=[];await run('previewGroupToggle()');ok('disable needs explicit fallback before any request',()=>assert.equal(calls.length,0));
 el('routingFallback').value='backup';await run('previewGroupToggle()');
 ok('disable preview carries tag and fallback without full config',()=>{assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])),{action:'toggle',tag:'fixture',enabled:false,fallback:'backup'});assert(!calls.some(x=>x[0].endsWith('/apply')));});
 ok('preview exposes changes and requires a separate apply click',()=>{assert.match(el('routingPreviewSummary').textContent,/尚未应用/);assert.match(el('routingPreviewChanges').innerHTML,/规则 5/);assert.equal(el('routingApplyBtn').disabled,false);});
 calls=[];await run('applyRoutingPreview()');
 ok('apply sends only the server preview ID and refreshes all status/config views',()=>{const applied=calls.find(x=>x[0].endsWith('/apply'));assert.deepEqual(JSON.parse(JSON.stringify(applied[2])),{preview_id:'server-preview'});assert(calls.some(x=>x[0]==='/routing-policy'));assert(calls.some(x=>x[0]==='/config'));});
 calls=[];await run('previewNormalize()');ok('normalize is preview-only',()=>{assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])),{action:'normalize'});assert(!calls.some(x=>x[0].endsWith('/apply')));});
 calls=[];clock+=61000;await run('applyRoutingPreview()');ok('expired preview cannot apply',()=>assert.equal(calls.length,0));
 installRequest(p=>p.endsWith('/preview')?preview({can_apply:false}):standard(p));await run('previewNormalize()');calls=[];await run('applyRoutingPreview()');ok('blocked preview cannot apply',()=>assert.equal(calls.length,0));
 installRequest(standard);run('showGroupToggle(2)');calls=[];await run('previewGroupToggle()');ok('enable restores stored rules without inventing fallback',()=>assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])),{action:'toggle',tag:'disabled',enabled:true}));
 installRequest(()=>{throw Error('status unavailable');});await run('loadRoutingPolicy()');ok('status failure locks controlled preview',()=>{assert(el('normalizePreviewBtn').disabled);assert.match(el('routingPublicationText').textContent,/未确认/);});
 sandbox.h=health(40);run('managedLastReadAt=Date.now();renderManagedStatus(h)');clock+=6000;run('expireManagedStatus()');ok('sample age is not reset by a fresh HTTP read',()=>assert(!el('managedHealthDot').className.includes('on')));
 sandbox.h=health();run('renderManagedStatus(h)');installRequest(()=>({running:false}));await run('checkStatus()');ok('known stopped main process invalidates network green immediately',()=>assert(!el('managedHealthDot').className.includes('on')));
 let release;
 installRequest(p=>p==='/managed-status'?new Promise(resolve=>{release=resolve;}):{running:false});
 run('primaryObservedRunning=true;managedInFlight=null');const inFlight=run('refreshManagedStatus()');await run('checkStatus()');release(health());await inFlight;
 ok('response started before known stop cannot revive old green',()=>assert(!el('managedHealthDot').className.includes('on')));

 // Deferred config responses reproduce the real post-publish refresh race.
 const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
 const tick=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
 const marked=label=>({...config,nodes:[{tag:label,address:'fixture.invalid',port:443,network:'tcp',security:'tls'}],
   routes:[{outboundTag:label,domains:[],ips:[]}],balancers:[{tag:label,nodeTags:[],domains:[],ips:[],strategy:'random'}]});
 for(const [loader,id] of [['loadNodes','nodeList'],['loadRoutes','routeList'],['loadBalancers','balancerList']]){
   const pending=[];installRequest(p=>p==='/config'?(()=>{const d=deferred();pending.push(d);return d.promise;})():standard(p));
   const first=run(loader+'()');await tick();const second=run(loader+'()');await tick();
   assert.equal(pending.length,2);pending[1].resolve(marked('latest-config'));await second;
   pending[0].resolve(marked('obsolete-config'));await first;
   ok(loader+' rejects a late older response',()=>{assert.match(el(id).innerHTML,/latest-config/);assert.doesNotMatch(el(id).innerHTML,/obsolete-config/);});
 }
 installRequest(standard);await run('loadRoutingPolicy()');await run('previewNormalize()');
 const beforeApply=[];installRequest(p=>p==='/config'?(()=>{const d=deferred();beforeApply.push(d);return d.promise;})():standard(p));
 const staleReads=['loadNodes','loadRoutes','loadBalancers'].map(name=>run(name+'()'));await tick();
 assert.equal(beforeApply.length,3);
 const applyResponse=deferred(),refreshes=[];
 installRequest(p=>p==='/routing-policy/apply'?applyResponse.promise:p==='/config'?(()=>{const d=deferred();refreshes.push(d);return d.promise;})():standard(p));
 const applying=run('applyRoutingPreview()');await tick();
 for(const d of beforeApply)d.resolve(marked('before-publish-config'));await Promise.all(staleReads);
 ok('all pre-publish responses are ignored while apply is pending',()=>{for(const id of ['nodeList','routeList','balancerList'])assert.doesNotMatch(el(id).innerHTML,/before-publish-config/);});
 applyResponse.resolve({success:true,state:'applied',message:'fixture applied'});await tick();
 assert.equal(refreshes.length,3);
 ok('routing controls remain locked until every config list finishes refreshing',()=>{assert.equal(run('routingBusy'),true);assert.equal(el('normalizePreviewBtn').disabled,true);});
 refreshes[0].resolve(marked('after-publish-config'));refreshes[1].resolve(marked('after-publish-config'));await tick();
 ok('the last unfinished list still keeps routing controls locked',()=>assert.equal(run('routingBusy'),true));
 refreshes[2].resolve(marked('after-publish-config'));await applying;
 ok('controls reopen only with the refreshed config lists',()=>{assert.equal(run('routingBusy'),false);for(const id of ['nodeList','routeList','balancerList'])assert.match(el(id).innerHTML,/after-publish-config/);});
 installRequest(standard);await run('previewNormalize()');
 installRequest(p=>{if(p==='/config')throw Error('fixture_config_refresh_failed');return standard(p);});
 await run('applyRoutingPreview()');await run('loadRoutingPolicy()');
 ok('refresh failure clears every old list and remains explicit after policy refresh',()=>{for(const id of ['nodeList','routeList','balancerList']){assert.match(el(id).innerHTML,/刷新失败/);assert.doesNotMatch(el(id).innerHTML,/after-publish-config/);}assert.match(el('toast').textContent,/刷新失败/);assert.equal(el('portInfo').innerHTML,'');});
 console.log(`${checks} routing UI checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
