// Exercise the real administrator page against a disposable private-data fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const source = await fs.readFile(path.join(__dirname,'index.html'),'utf8');
  const {privateWordsJs}=await import('./private-words-ui.ts');
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors=[], unknown=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    let logged=false, reverted=false, style='default', tools={search:true,weather:true,clock:true};
    let previousQuestion='',failReset=true;
    let cues={revision:0,chat:['我来看看这个。'],search:['等我查一下哦。'],chatWaitMs:180,searchWaitMs:200};
    const now=Date.now(), timestamp=new Date(now).toISOString();
    const status={build:'fixture',slots:{jobs:0,capacity:5,at:timestamp},worker:'北京已注册',brain:'在线',ticket:'在线',sampledAt:timestamp};
    const hostile='<img src=x onerror="window.injected=true">';
    const quote='以后周末泡茶的时候，我喜欢和朋友一起喝红茶。';
    const sourceTurn={session:'abc',id:'u1',role:'user',text:quote,at:now};
    const use={session:'abc',id:'a',at:now};
    const make=(id,topic,value,kind='fact',state='verified')=>({id,topic,value,kind,state,source:'主人在通话中明确说明',updatedAt:now,manageable:true,editable:state==='verified',canApprove:state==='pending',usageCount:id==='1'?1:0,lastUsedAt:id==='1'?now:null});
    const peer='3'.repeat(64);
    const memories=[make('1','周末茶饮','朋友来访时泡红茶'),make('2','周末散步','沿着河岸慢慢走'),make(peer,'手冲咖啡','喜欢','preference'),make('4','故事风格','偏爱简短的悬疑故事'),make('5','称呼','阿澄','name'),make('6','户外午餐','喜欢','preference'),make('7','阅读时间','晚上九点以后'),make('8','待核验条目','我不喜欢手冲咖啡','preference','pending'),make('9','待核验条目','下次试试茉莉花茶','fact','pending'),make('10','历史条目','习惯早上七点晨跑','fact','inactive')];
    Object.assign(memories[7],{proposed:{kind:'preference',topic:'手冲咖啡',value:'不喜欢'},conflict:{id:peer,topic:'手冲咖啡',kind:'preference',value:'喜欢'}});
    let staleEdit=true,draft=null,wordRevision=2,liveWords=[],published=0;
    const sampleExtractions=Array.from({length:10},(_,i)=>({id:'x'+i,at:now-i*900000,ok:i!==2,llmMs:i===2?null:126+i*7,candidates:[3,2,0,1,4,3,1,0,3,2][i],added:[1,0,0,1,3,2,0,0,1,1][i],rejected:i===1?'与已有条目重复':'',note:i===2?'模型未返回结果':'',sourceTurn:i===0?sourceTurn:null}));
    const dataOf=()=>memories.filter(x=>x.state==='verified');
    await page.route('https://private.test/**',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname,m=req.method();
      if(p==='/assets/private-words.js')return route.fulfill({contentType:'application/javascript',body:privateWordsJs});
      if(p==='/')return route.fulfill({contentType:'text/html',body:source});
      const out=(v,status=200)=>route.fulfill({status,json:v});
      const body=req.postData()?req.postDataJSON():undefined;
      requests.push([p,m]);
      if(p==='/api/login'){logged=true;return out({ok:true});}
      if(!logged)return out({error:'请登录'},401);
      if(m!=='GET')assert.equal(req.headers()['x-voice-admin'],'1');
      if(p==='/api/settings')return out({...status,drafts:draft?{asr:draft}:{},probabilities:{default:.5,quiet:0,funny:.6,chatty:1}});
      if(p==='/api/status')return out(status);
      if(p==='/api/voices')return out({active:'v',voices:[{id:'v',name:'测试音色'}]});
      if(p==='/api/providers')return out({revision:0,fields:{},profiles:[],fallback:{llm:'本地测试',asr:'飞牛',tts:'飞牛'},active:{}});
      if(p==='/api/devices')return out({devices:[{device:'demo-s24',versionCode:3,lastSeen:now/1000,phase:'idle',muted:false,revision:2,appliedRevision:2,accent:'#3141CA',events:[]}]});
      if(p.endsWith('/demo-s24/diagnostics')){
        const days=Number(url.searchParams.get('days'));
        return out({state:'ready',days,total:days,through:timestamp,from:timestamp,uploads:{batches:days+2,submitted:days*3,inserted:days,repeats:days*2,lastAt:timestamp},counts:[{kind:'call_start',count:days}],recent:[{kind:'call_start',at:timestamp,receivedAt:timestamp,versionCode:3}]});
      }
      if(p==='/api/diagnostics/chat'){
        assert.equal(m,'POST');assert.deepEqual(Object.keys(body),['question']);
        const text=previousQuestion?'上一问：'+previousQuestion:'新的对话';previousQuestion=body.question;
        return out({text,tool:'clock',sources:[{title:hostile,url:'https://example.org/'},{title:'危险链接',url:'javascript:void(0)'}]});
      }
      if(p==='/api/diagnostics/reset'){
        assert.equal(m,'POST');if(failReset){failReset=false;return out({error:'试问运行中'},429);}
        previousQuestion='';return out({ok:true});
      }
      if(p==='/api/operations')return out({sampledAt:timestamp,ota:{state:'ready',versionName:'V3',versionCode:3},speech:{state:'ready',voice:'local'},brain:{state:'ready',revision:0,llmModel:'test-chat'},backup:{state:'unreported'}});
      if(p==='/api/brain/overview')return out({style,traits:[{key:'story',label:'故事倾向',value:.4,baseline:.5}],relationship:null,tools,searchStats:{total:1,answered:1,failed:0,noEvidence:0},memoryCount:dataOf().length,growthCount:1});
      if(p==='/api/word-publications'){
        if(m==='POST'){assert.equal(body.previous,wordRevision);assert.equal(body.token,draft.token);wordRevision++;published++;liveWords=draft.words;}
        return out({current:{revision:wordRevision,words:{asr:liveWords}},drafts:draft?{asr:draft}:{},history:[],last:null});
      }
      if(p==='/api/drafts/asr'){assert.equal(m,'PUT');draft={id:12,token:'fixture-draft',words:body.words,created_at:now};return out(draft);}
      if(p==='/api/turn-timing')return out({items:[{room:'测试通话',turn:1,at:now,commit:220,asr_final:null,speakable:590,first_audio:920,post_filler_audio:null}]});
      if(p==='/api/brain/memories'&&m==='GET'){
        const q=url.searchParams.get('q')||'',k=url.searchParams.get('kind'),state=url.searchParams.get('state');
        const count=st=>memories.filter(x=>x.state===st).length;
        const items=memories.filter(x=>(state==='conflict'?x.state==='pending'&&x.conflict:x.state===state)&&(!k||x.kind===k)&&(x.topic+x.value).includes(q));
        return out({total:items.length,counts:{verified:count('verified'),pending:count('pending'),inactive:count('inactive'),conflicts:memories.filter(x=>x.conflict&&x.state==='pending').length},kinds:[...new Set(memories.map(x=>x.kind))],items});
      }
      if(p==='/api/brain/memories'&&m==='POST'){
        if(body.text){assert.equal(body.text,'记住，我喜欢咖啡');memories.unshift(make('11','咖啡','喜欢','preference'));}
        else memories.unshift(make('12',body.topic,body.value,body.kind));
        return out({ok:true});
      }
      const match=p.match(/^\/api\/brain\/memories\/([0-9]+)(\/review)?$/);
      if(match){
        const row=memories.find(x=>x.id===match[1]);assert.ok(row);
        if(m==='GET')return out({item:row,sourceTurn:row.id==='1'?sourceTurn:null,uses:row.id==='1'?[use]:[],usageSince:now});
        assert.equal(body.expected,row.value);
        if(match[2]){
          assert.equal(body.expectedPeer??null,row.conflict?.id??null);
          if(body.action==='approve'){row.state='verified';row.canApprove=false;row.editable=true;Object.assign(row,{kind:body.kind,topic:body.topic,value:body.value});delete row.conflict;}
          else row.state='inactive';
        }else if(m==='PUT'){if(staleEdit){staleEdit=false;row.value='周末喝岩茶';return out({error:'条目已被修改，请重读'},409);}row.value=body.value;}
        else if(m==='DELETE'){row.state='inactive';row.manageable=row.editable=false;}
        return out({ok:true});
      }
      if(p==='/api/brain/extractions')return out({service:{configured:true,provider:'deepseek',pending:1,lastAt:now,lastOk:true,lastFailure:{at:now-1800000,reason:'模型未返回结果'}},items:sampleExtractions,total:sampleExtractions.length,summary:{runs:10,failed:1,candidates:19,added:9}});
      if(p==='/api/brain/memory-preview'){assert.equal(body.text,'周末喝茶');return out({state:'preview',items:[{id:'1',topic:'周末茶饮',value:'朋友来访时泡红茶',reason:'主题匹配'}]});}
      if(p==='/api/brain/turns/a/memories')return out({state:'model',items:[{id:'1',topic:'周末茶饮',value:'朋友来访时泡红茶',reason:'提示词选取'}],at:now});
      if(p==='/api/brain/growth/snapshots')return out({dimensions:[{key:'story',label:'故事倾向'}],items:[{day:'2026-11-26',traits:{story:.48},relation:null},{day:'2026-11-27',traits:{story:.56},relation:{tier:'熟悉',sessionCount:8,daysKnown:12,mood:'安静'}}]});
      if(p==='/api/brain/growth')return out({total:1,items:[{id:'g1',at:now,module:'style',dimension:'讲法',reason:'同轮反馈',revertible:!reverted,revokeReason:reverted?'已经撤销':''}]});
      if(p==='/api/brain/growth/g1/revoke'){assert.equal(m,'POST');reverted=true;return out({ok:true});}
      if(p==='/api/brain/style'){assert.equal(body.previous,style);style=body.style;return out({ok:true});}
      if(p==='/api/brain/tools'){assert.deepEqual(body.previous,tools);tools={search:body.search,weather:body.weather,clock:body.clock};return out({ok:true});}
      if(p==='/api/brain/search')return out({total:1,items:[{id:'s1',at:now,status:'completed',outcome:'answered',sourceCount:2,durationMs:280}]});
      if(p==='/api/brain/tools/history')return out({total:1,items:[{id:1,at:now,tool:'weather',outcome:'with_sources',sourceCount:1,turnMs:400}]});
      if(p==='/api/brain/activity')return out({total:1,days:[{date:'2026-01-02',turns:1,growth:1,extractions:0}],extraction:{available:true,lastAt:null,lastStatus:null},items:[{session:'abc',firstAt:now,lastAt:now,messages:2}]});
      if(p==='/api/brain/conversations/abc')return out({total:3,offset:0,items:[sourceTurn,{id:'u',role:'user',text:hostile,at:now},{id:'a',role:'assistant',text:'收到',at:now}]});
      if(p==='/api/brain/voice-cues'){if(m==='PUT'){assert.equal(body.revision,cues.revision);cues={...body,revision:1};}return out(cues);}
      if(p==='/api/logout'){logged=false;return out({ok:true});}
      unknown.push(p);return out({error:'未知路径'},404);
    });
    const id=n=>page.locator('#'+n);
    const view=name=>id('mobileView').selectOption(name);
    const has=async(idName,t)=>{await page.waitForFunction(([k,x])=>document.getElementById(k).textContent.includes(x),[idName,t]);};
    await page.goto('https://private.test/');await id('pass').fill('fixture');await page.locator('#signin button').click();
    await has('overviewSummary','长期记忆');await has('overviewProviders','本地测试');
    const btn=label=>page.getByRole('button',{name:label,exact:true});
    const pick=async key=>{await page.locator('#memoryRows [data-memory="'+key+'"]').click();await has('memDetail','来源依据');};
    const screenshot=async name=>{
      if(!process.env.MEMORY_SCREENSHOT_DIR)return;
      await fs.mkdir(process.env.MEMORY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.MEMORY_SCREENSHOT_DIR,name+'.png')});
    };
    await view('memories');await has('memoryRows','周末茶饮');await screenshot('mobile-library');
    assert.equal(await id('memDetail').isVisible(),false);await pick('1');await has('memDetail',quote);
    await page.evaluate(()=>document.querySelector('#memories').scrollIntoView());await screenshot('mobile-detail');
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));await screenshot('desktop-library');
    assert.equal(await id('memoryRows').isVisible(),true);
    await id('extractTab').click();await has('extractService','DeepSeek');await has('extractService','排队 1 轮');await has('extractRows','与已有条目重复');await has('extractRows','模型未返回结果');
    assert.equal(await page.locator('#extractChart .mem-bar').count(),10);await screenshot('desktop-extractions');
    await page.setViewportSize({width:390,height:844});await id('previewTab').click();await id('previewQuestion').fill('周末喝茶');await btn('预览选取结果').click();await has('previewResults','主题匹配');
    await btn('查看条目').click();await has('memDetail',quote);await btn('查看来源通话').click();await has('turnRows',quote);
    assert.equal(await page.locator('#turnRows .mem-highlight .turn-text').textContent(),quote);
    await btn('查看本轮带入的记忆').click();await has('turnRows','提示词选取');await btn('查看条目').click();await has('memDetail',quote);
    await btn('纠正').click();await page.getByRole('textbox',{name:'纠正后的内容'}).fill('周末泡绿茶');await btn('保存纠正').click();await has('memDetail','条目已被修改');
    await btn('重新读取此条').click();await has('memDetail','周末喝岩茶');await btn('纠正').click();await page.getByRole('textbox',{name:'纠正后的内容'}).fill('周末泡绿茶');await btn('保存纠正').click();await has('memoryRows','周末泡绿茶');
    await page.reload();await has('overviewSummary','长期记忆');await view('memories');await has('memoryRows','周末泡绿茶');await pick('1');await btn('忘记').click();await has('msg','已忘记');
    await page.locator('[data-state=inactive]').first().click();await has('memoryRows','周末泡绿茶');
    await page.locator('[data-state=conflict]').first().click();await pick('8');await has('memDetail','同一主题出现不同偏好');
    await btn('采用或改写新值').click();assert.equal(await page.getByLabel('主题',{exact:true}).inputValue(),'手冲咖啡');assert.equal(await page.getByLabel('内容',{exact:true}).inputValue(),'不喜欢');
    await btn('保存并确认').click();await has('msg','已确认');assert.equal(memories[7].state,'verified');
    await page.locator('[data-state=pending]').first().click();await pick('9');await btn('忽略该条').click();await has('memoryRows','暂无待核验');
    await id('startMemory').click();await id('memoryText').fill('记住，我喜欢咖啡');await btn('记住这条').click();await has('memoryRows','咖啡');
    await id('startMemory').click();await id('memoryMode').selectOption('fact');await id('structuredFields').getByLabel('主题').fill('示例设备');await id('structuredFields').getByLabel('内容').fill('深绿色');await btn('记住这条').click();await has('memoryRows','深绿色');
    await id('memorySearch').fill('示例');await page.waitForFunction(()=>document.querySelectorAll('#memoryRows [data-memory]').length===1);await id('memoryKind').selectOption('name');await has('memoryRows','没有匹配');
    await view('growth');await has('growthRows','同轮反馈');await has('snapshotCompare','+0.08');await page.getByLabel('查看日').selectOption('2026-11-26');await has('snapshotCompare','无采样');await id('styleChoice').selectOption('quiet');await id('saveStyle').click();await has('msg','已保存');
    await page.getByRole('button',{name:'撤回这次学习'}).click();await has('growthRows','已经撤销');
    await view('tools');await has('searchRows','有来源的回答');await has('historyRows','天气查询');await has('turnTiming','920 ms');await has('turnTiming','—');
    await page.locator('[data-tool=weather]').uncheck();await id('saveTools').click();await has('msg','已保存');assert.equal(tools.weather,false);
    const transcriptReads=requests.filter(([p])=>p.includes('/conversations/')).length;await view('activity');await has('activityRows','条消息');assert.equal(requests.filter(([p])=>p.includes('/conversations/')).length,transcriptReads);
    await page.getByRole('button',{name:'查看本通原文'}).click();await has('turnRows',hostile);assert.equal(await page.locator('#turnRows img').count(),0);
    await view('operations');await has('opsBackup','尚无回执');assert.equal(await id('turnRows').textContent(),'');
    await view('providers');await has('providerRevision','大脑已读到该修订');
    await view('devices');await has('deviceSummary','1 台设备');await page.locator('#deviceHistory summary').click();await has('diagHeadline','共 7 个事件');
    await has('diagUploads','投递批次（含重投）9');await has('diagUploads','提交事件21');await has('diagUploads','重复事件14');
    await id('diagDays').selectOption('1');await has('diagHeadline','共 1 个事件');await has('diagEvents','开始通话');await has('diagUploads','提交事件3');await has('diagUploads','新增入库1');
    await view('diagnostics');await id('question').fill('第一问');await id('ask').click();await has('testTurns','新的对话');
    await id('question').fill('能接着说吗');await id('ask').click();await has('testTurns','上一问：第一问');
    assert.equal(await page.locator('#testTurns article').count(),2);assert.equal(await page.locator('#testTurns img').count(),0);
    assert.equal(await page.locator('#testTurns a').count(),2);assert.equal(await page.locator('#testTurns a').first().getAttribute('href'),'https://example.org/');
    await id('resetTest').click();await has('testStatus','试问运行中');assert.equal(await page.locator('#testTurns article').count(),2);
    await id('resetTest').click();await has('testStatus','新试问已开始');assert.equal(await id('testTurns').textContent(),'');
    await id('question').fill('还有印象吗');await id('ask').click();await has('testTurns','新的对话');assert.equal(await id('testTurns').textContent().then(t=>t.includes('第一问')),false);
    await view('filler');await has('cueState','修订 0');await id('chatWait').fill('300');await id('saveCues').click();await has('cueState','修订 1');assert.equal(cues.chatWaitMs,300);
    await view('hotwords');await has('privateWordsPanel','版本 2');await id('words').fill('测试热词');await id('saveWords').click();await has('privateWordsPanel','草稿将新增：测试热词');await btn('将此草稿用于下一通').click();await has('privateWordsPanel','版本 3');assert.equal(published,1);
    for(const width of [360,390,768,1280]){
      await page.setViewportSize({width,height:844});
      for(const name of ['overview','memories','growth','activity','tools','operations','devices','providers','voice','hotwords','filler','diagnostics']){
        if(width<=850)await view(name);else await page.locator('[data-view="'+name+'"]').click();
        assert.ok(await id(name).isVisible(),name);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+': '+name);
      }
    }
    await id('logout').click();await id('login').waitFor({state:'visible'});
    assert.deepEqual(unknown,[]);assert.deepEqual(errors,[]);console.log('PASS 私人维护台 · 记忆分栏/分类/搜索、旧值冲突重读、增改忘记、跨通话双向证据、确认与忽略、抽取负例和快照、反馈撤回、工具/风格回读、按需通话原文、设备统计与回传去重、轮次时序、连续试问与重开、衔接语、热词发布回读、四种视宽。');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
