// Exercise the real administrator page against a disposable private-data fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const source = await fs.readFile(path.join(__dirname,'index.html'),'utf8');
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors=[], unknown=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    let logged=false, value='红茶', exists=true, reverted=false, style='default', tools={search:true,weather:true,clock:true};
    let previousQuestion='',failReset=true;
    let cues={revision:0,chat:['我来看看这个。'],search:['等我查一下哦。'],chatWaitMs:180,searchWaitMs:200};
    const now=Date.now(), timestamp=new Date(now).toISOString();
    const status={build:'fixture',slots:{jobs:0,capacity:5,at:timestamp},worker:'北京已注册',brain:'在线',ticket:'在线',sampledAt:timestamp};
    const hostile='<img src=x onerror="window.injected=true">';
    await page.route('https://private.test/**',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname,m=req.method();
      if(p==='/')return route.fulfill({contentType:'text/html',body:source});
      const out=(v,status=200)=>route.fulfill({status,json:v});
      const body=req.postData()?req.postDataJSON():undefined;
      requests.push([p,m]);
      if(p==='/api/login'){logged=true;return out({ok:true});}
      if(!logged)return out({error:'请登录'},401);
      if(m!=='GET')assert.equal(req.headers()['x-voice-admin'],'1');
      if(p==='/api/settings')return out({...status,drafts:{},probabilities:{default:.5,quiet:0,funny:.6,chatty:1}});
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
      if(p==='/api/brain/overview')return out({style,traits:[{key:'story',label:'故事倾向',value:.4,baseline:.5}],relationship:null,tools,searchStats:{total:1,answered:1,failed:0,noEvidence:0},memoryCount:exists?1:0,growthCount:1});
      if(p==='/api/brain/memories'&&m==='GET')return out({total:exists?1:0,items:exists?[{id:'1',kind:'fact',topic:'饮品',value,source:hostile,updatedAt:now,editable:true,manageable:true}]:[]});
      if(p==='/api/brain/memories'&&m==='POST'){assert.equal(body.text,'记住，我喜欢咖啡');exists=true;value='咖啡';return out({ok:true});}
      if(p==='/api/brain/memories/1'){assert.equal(body.expected,value);if(m==='PUT')value=body.value;else if(m==='DELETE')exists=false;else throw Error(m);return out({ok:true});}
      if(p==='/api/brain/growth')return out({total:1,items:[{id:'g1',at:now,module:'style',dimension:'讲法',reason:'同轮反馈',revertible:!reverted,revokeReason:reverted?'已经撤销':''}]});
      if(p==='/api/brain/growth/g1/revoke'){assert.equal(m,'POST');reverted=true;return out({ok:true});}
      if(p==='/api/brain/style'){assert.equal(body.previous,style);style=body.style;return out({ok:true});}
      if(p==='/api/brain/tools'){assert.deepEqual(body.previous,tools);tools={search:body.search,weather:body.weather,clock:body.clock};return out({ok:true});}
      if(p==='/api/brain/search')return out({total:1,items:[{id:'s1',at:now,status:'completed',outcome:'answered',sourceCount:2,durationMs:280}]});
      if(p==='/api/brain/tools/history')return out({total:1,items:[{id:1,at:now,tool:'weather',outcome:'with_sources',sourceCount:1,turnMs:400}]});
      if(p==='/api/brain/activity')return out({total:1,days:[{date:'2026-01-02',turns:1,growth:1,extractions:0}],extraction:{available:true,lastAt:null,lastStatus:null},items:[{session:'abc',firstAt:now,lastAt:now,messages:2}]});
      if(p==='/api/brain/conversations/abc')return out({total:2,items:[{id:'u',role:'user',text:hostile,at:now},{id:'a',role:'assistant',text:'收到',at:now}]});
      if(p==='/api/brain/voice-cues'){if(m==='PUT'){assert.equal(body.revision,cues.revision);cues={...body,revision:1};}return out(cues);}
      if(p==='/api/logout'){logged=false;return out({ok:true});}
      unknown.push(p);return out({error:'未知路径'},404);
    });
    const id=n=>page.locator('#'+n);
    const view=name=>id('mobileView').selectOption(name);
    const has=async(idName,t)=>{await page.waitForFunction(([k,x])=>document.getElementById(k).textContent.includes(x),[idName,t]);};
    await page.goto('https://private.test/');await id('pass').fill('fixture');await page.locator('#signin button').click();
    await has('overviewSummary','长期记忆');await has('overviewProviders','本地测试');
    await view('memories');await has('memoryRows',hostile);assert.equal(await page.locator('#memoryRows img').count(),0);
    await page.getByRole('button',{name:'纠正',exact:true}).click();await page.getByRole('textbox',{name:'纠正后的内容'}).fill('绿茶');await page.getByRole('button',{name:'保存纠正'}).click();
    await has('memoryRows','绿茶');await page.getByRole('button',{name:'忘记',exact:true}).click();await has('memoryRows','暂无长期记忆');
    await id('memoryText').fill('记住，我喜欢咖啡');await page.locator('#newMemory button').click();await has('memoryRows','咖啡');
    await view('growth');await has('growthRows','同轮反馈');await id('styleChoice').selectOption('quiet');await id('saveStyle').click();await has('msg','已保存');
    await page.getByRole('button',{name:'撤回这次学习'}).click();await has('growthRows','已经撤销');
    await view('tools');await has('searchRows','有来源的回答');await has('historyRows','天气查询');
    await page.locator('[data-tool=weather]').uncheck();await id('saveTools').click();await has('msg','已保存');assert.equal(tools.weather,false);
    await view('activity');await has('activityRows','条消息');assert.equal(requests.filter(([p])=>p.includes('/conversations/')).length,0);
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
    for(const width of [360,390,768,1280]){
      await page.setViewportSize({width,height:844});
      for(const name of ['overview','growth','activity','tools','operations','devices','providers','voice','hotwords','filler','diagnostics']){
        if(width<=850)await view(name);else await page.locator('[data-view="'+name+'"]').click();
        assert.ok(await id(name).isVisible(),name);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+': '+name);
      }
    }
    await id('logout').click();await id('login').waitFor({state:'visible'});
    assert.deepEqual(unknown,[]);assert.deepEqual(errors,[]);console.log('PASS 私人维护台 · 记忆增改忘记、反馈撤回、工具/风格回读、按需通话原文、设备统计与回传去重、连续试问与重开、衔接语、手机/桌面布局。');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
