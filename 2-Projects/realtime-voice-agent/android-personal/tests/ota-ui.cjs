// Run against source assets or a directory extracted from the signed APK.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));
const origin = 'http://localhost:13098';
const screen = {width: 412, height: 860};

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:screen, deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const exceptions=[];
    page.on('pageerror',e=>exceptions.push(e.message));
    await page.route(origin+'/**',async route=>{
      const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
      if (!/^[a-z][a-z0-9-]*\.(html|css|js)$/.test(name)) return route.abort();
      let file=path.join(assets,name);
      if(name==='livekit.js')try{await fs.access(file);} catch {
        file=process.env.LIVEKIT_UMD||path.resolve(__dirname,'../../web/personal/node_modules/livekit-client/dist/livekit-client.umd.js');
      }
      return route.fulfill({body:await fs.readFile(file),contentType:name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/javascript'});
    });
    await page.addInitScript(()=>{
      window.baseOta={state:'idle',installedVersionName:'1.1.0',installedVersionCode:10,versionName:'1.2.0',versionCode:11,canInstall:false,canRetry:false,busy:false,downloadedBytes:0,totalBytes:0,percent:-1};
      window.snap={...baseOta}; window.ops=[]; window.notices=0;
      window.NightHost={paired:()=>true,event(){},setCall(){},diagnostics:()=>'技术事件 11 条',
        updateSnapshot:()=>JSON.stringify(snap),checkUpdate(){ops.push('check');},installUpdate(){ops.push('install');},syncDiagnostics(){ops.push('sync');}};
      window.setOta=(delta,notify=true)=>{window.snap={...baseOta,...delta};if(notify)window.dispatchEvent(new Event('night-ota-change'));};
    });
    await page.goto(origin);
    const el=id=>page.locator('#'+id);
    const state=async(value,extra={})=>page.evaluate(([state,fields])=>setOta({state,...fields}),[value,extra]);
    const home=el('ota-home'),panel=el('service-panel'),homeLabel=el('ota-home-text'), progress=el('ota-progress'),transfer=el('ota-transfer');
    async function equalText(id,text){await page.waitForFunction(([id,text])=>document.getElementById(id)?.textContent===text,[id,text],{timeout:4500});}
    assert.ok(await home.isVisible()); await equalText('ota-home-text','等待检查更新');assert.ok(await panel.isHidden());
    for(const [s,text] of Object.entries({checking:'正在检查更新',current:'已是最新版本',available:'发现新版本',ready:'新版已就绪',wait_permission:'等待安装授权',preparing_install:'正在准备安装',pending_confirmation:'等待系统确认',installing:'系统正在安装',success:'升级成功',cancelled:'已取消安装',error:'更新未完成'})){
      await state(s);await equalText('ota-home-text',text);assert.ok(await el('ota-home-progress').isHidden());
      assert.ok(!(await homeLabel.innerText()).includes('%'),s+' must not invent install progress');
    }
    await state('downloading',{busy:true,downloadedBytes:30720,totalBytes:102400,percent:99});
    await equalText('ota-home-text','正在下载 30%');assert.equal(await el('ota-home-progress').getAttribute('value'),'30');
    await home.tap();assert.ok(await panel.isVisible());assert.equal(await home.getAttribute('aria-expanded'),'true');
    assert.equal(await progress.getAttribute('value'),'30');await equalText('ota-bytes','30% · 30.0 KiB / 100.0 KiB');assert.ok(await el('ota-check').isDisabled());
    await state('downloading',{busy:true,downloadedBytes:156,totalBytes:0,percent:-1});assert.equal(await progress.getAttribute('value'),null);await equalText('ota-home-text','已下载 156 B');
    await state('verifying',{busy:true,downloadedBytes:102400,totalBytes:102400,percent:100});await equalText('ota-phase','正在校验安装包');assert.ok(await transfer.isHidden());
    await state('ready',{canInstall:true});await el('ota-install').click();assert.deepEqual(await page.evaluate(()=>ops),['install']);
    await state('wait_permission',{canInstall:true,installPermission:false});await equalText('ota-install','继续授权安装');await el('ota-install').click();
    await state('pending_confirmation',{busy:true});assert.ok(await el('ota-install').isHidden());assert.ok(await el('ota-check').isDisabled());
    await state('installing',{busy:true,percent:87});assert.ok(await transfer.isHidden());assert.ok(await el('ota-check').isDisabled());
    await state('cancelled',{canInstall:true});await equalText('ota-install','重试安装');await el('ota-install').click();
    await state('error',{canRetry:true,message:'网络中断，稍后可重试。'});await equalText('ota-check','重试更新');await el('ota-check').click();
    await state('error',{canInstall:true,canRetry:false});assert.ok(await el('ota-check').isDisabled());await equalText('ota-install','重试安装');
    await state('success',{installedVersionCode:11,installedVersionName:'1.2.0'});await equalText('ota-version','当前 1.2.0');await el('diag-send').click();
    assert.deepEqual(await page.evaluate(()=>ops),['install','install','install','check','sync']);
    await el('service-close').click();assert.ok(await panel.isHidden());
    for(let i=0;i<2;i++)await page.evaluate(()=>dispatchEvent(new Event('night-open-update')));
    assert.ok(await panel.isVisible());await el('service-close').click();
    // Polling also observes native progress if a background event occurred before the page subscribed.
    await page.evaluate(()=>setOta({state:'downloading',downloadedBytes:456,totalBytes:1000,busy:true},false));
    await equalText('ota-home-text','正在下载 45%');
    for(const viewport of [screen,{width:360,height:640},{width:740,height:390}]){
      await page.setViewportSize(viewport);
      await page.evaluate(()=>NightView.render({active:true,paired:true,phase:'speaking',reply:'这是通话中的实时字幕。',mine:'测试通话中依然看得见字幕。'}));
      await state('ready',{canInstall:true});
      await page.evaluate(()=>dispatchEvent(new Event('night-open-update')));assert.ok(await panel.isHidden());
      await home.tap();assert.ok(await panel.isVisible());assert.ok(await el('ota-install').isDisabled());
      const rects=await page.evaluate(()=>['service-panel','subtitles','reply-text','panel-active','btn-stop'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,w:r.width,h:r.height};}));
      for(const r of rects) assert.ok(r.w>0&&r.h>0,r.id);
      assert.ok(rects[0].bottom<=rects[1].top+1,JSON.stringify({viewport,rects}));
      assert.ok(rects[2].bottom<=rects[3].top+1,JSON.stringify({viewport,rects}));
      assert.ok(rects[4].bottom<=viewport.height+1,'hangup stays within viewport');
      await el('service-close').click();
    }
    assert.deepEqual(exceptions,[]);
    console.log('OTA 首页、下载字节、验签、授权/系统确认、安装/取消/重试/成功、事件与轮询、通话字幕与挂断布局通过。');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
