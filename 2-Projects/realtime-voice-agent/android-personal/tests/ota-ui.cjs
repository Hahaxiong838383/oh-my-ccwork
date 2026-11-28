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
      window.baseOta={state:'idle',installedVersionName:'1.1.0',installedVersionCode:10,versionName:'1.2.0',versionCode:11,canInstall:false,canRetry:false,busy:false,downloadedBytes:0,totalBytes:0,percent:-1,updatedAt:100};
      window.snap={...baseOta}; window.ops=[]; window.notices=0;
      window.NightHost={paired:()=>true,event(){},setCall(){},diagnostics:()=>'技术事件 11 条',
        updateSnapshot:()=>JSON.stringify(snap),checkUpdate(){ops.push('check');},installUpdate(){ops.push('install');},syncDiagnostics(){ops.push('sync');}};
      window.setOta=(delta,notify=true)=>{window.snap={...baseOta,updatedAt:(window.snap.updatedAt||100)+1,...delta};if(notify)window.dispatchEvent(new Event('night-ota-change'));};
    });
    await page.goto(origin);
    const el=id=>page.locator('#'+id);
    const state=async(value,extra={})=>page.evaluate(([state,fields])=>setOta({state,...fields}),[value,extra]);
    const home=el('ota-home'),panel=el('service-panel'),homeLabel=el('ota-home-text'),progress=el('ota-progress'),transfer=el('ota-transfer');
    const card=el('ota-card'),cardProgress=el('ota-card-progress'),cardNote=el('ota-card-note'),cardPrimary=el('ota-card-primary'),cardSecondary=el('ota-card-secondary');
    async function equalText(id,text){await page.waitForFunction(([id,text])=>document.getElementById(id)?.textContent===text,[id,text],{timeout:4500});}

    // 1. Quiet states stay in topbar pill without cluttering the home stage.
    assert.ok(await home.isVisible()); await equalText('ota-home-text','等待检查更新');
    assert.ok(await panel.isHidden()); assert.ok(await card.isHidden());
    for (const [s,text] of Object.entries({checking:'正在检查更新',current:'已是最新版本'})) {
      await state(s,{percent:55});
      await equalText('ota-home-text',text);
      assert.ok(await card.isHidden(), s+' stays quiet on home');
      assert.ok(await el('ota-home-progress').isHidden());
      assert.ok(!(await homeLabel.innerText()).includes('%'), s+' must not show fake percent');
    }

    // 2. Non-downloading actionable/in-flight states surface prominent card and NEVER invent percentages.
    for (const [s,text] of Object.entries({available:'发现新版本',verifying:'正在校验安装包',ready:'新版已就绪',wait_permission:'等待安装授权',preparing_install:'正在准备安装',pending_confirmation:'等待系统确认',installing:'系统正在安装',success:'升级成功',cancelled:'已取消安装',error:'更新未完成'})) {
      await state(s,{percent:87,canInstall:['ready','wait_permission','cancelled'].includes(s),canRetry:s==='error',busy:['verifying','preparing_install','pending_confirmation','installing'].includes(s)});
      await equalText('ota-home-text',text);
      assert.ok(await card.isVisible(), s+' shows home update card');
      assert.ok(await el('ota-home-progress').isHidden());
      assert.ok(!(await homeLabel.innerText()).includes('%'), s+' home pill must not invent progress');
      assert.ok(!(await card.innerText()).includes('%'), s+' home card must not invent progress');
    }

    // 3. Available -> immediate check/download feedback & dismiss/reappear behavior.
    await state('available',{message:'发现新版本 1.2.0，建议立即下载。'});
    assert.ok(await card.isVisible());
    await equalText('ota-card-version','当前 1.1.0  →  新版 1.2.0');
    await equalText('ota-card-primary','立即下载');
    await cardPrimary.click();
    assert.deepEqual(await page.evaluate(()=>ops),['check']);
    assert.ok(await cardPrimary.isDisabled());
    await equalText('ota-card-primary','正在连接…');
    assert.equal(await cardProgress.getAttribute('value'),null);
    // Dismissing available collapses card back to topbar pill and returns focus.
    await state('available',{});
    await cardSecondary.click();
    assert.ok(await card.isHidden());
    assert.ok(await home.evaluate(b=>b===document.activeElement));

    // 4. Downloading: real byte progress (determinate) vs unknown total (indeterminate, no fake %).
    await state('downloading',{busy:true,downloadedBytes:30720,totalBytes:102400,percent:99});
    assert.ok(await card.isVisible());
    await equalText('ota-home-text','正在下载 30%');
    assert.equal(await el('ota-home-progress').getAttribute('value'),'30');
    assert.equal(await cardProgress.getAttribute('value'),'30');
    await equalText('ota-card-meta','30% · 30.0 KiB / 100.0 KiB');
    assert.equal(await card.locator('[data-step=download]').getAttribute('data-status'),'active');
    await home.tap();
    assert.ok(await panel.isVisible()); assert.ok(await card.isHidden());
    assert.equal(await home.getAttribute('aria-expanded'),'true');
    assert.equal(await progress.getAttribute('value'),'30');
    await equalText('ota-bytes','30% · 30.0 KiB / 100.0 KiB');
    assert.ok(await el('ota-check').isDisabled());
    await state('downloading',{busy:true,downloadedBytes:156,totalBytes:0,percent:-1});
    assert.equal(await progress.getAttribute('value'),null);
    await equalText('ota-home-text','已下载 156 B');
    assert.ok(!(await el('ota-bytes').innerText()).includes('%'));

    // 5. Verifying: indeterminate activity in both panel and home card, no byte transfer or %.
    await state('verifying',{busy:true,downloadedBytes:102400,totalBytes:102400,percent:100});
    await equalText('ota-phase','正在校验安装包');
    assert.ok(await transfer.isHidden());
    assert.ok(await el('ota-activity').isVisible());
    assert.equal(await el('ota-activity-progress').getAttribute('value'),null);
    assert.ok(!(await panel.innerText()).includes('%'));
    await el('service-close').click();
    assert.ok(await card.isVisible());
    assert.equal(await cardProgress.getAttribute('value'),null);
    assert.equal(await card.locator('[data-step=verify]').getAttribute('data-status'),'active');

    // 6. Ready: clear pre-install exit & return guidance, finger-sized CTA, instant tap feedback (anti-freeze).
    await state('ready',{canInstall:true});
    assert.ok(await card.isVisible());
    assert.ok(await cardNote.isVisible());
    const readyNote = await cardNote.innerText();
    assert.ok(readyNote.includes('短暂退出') && readyNote.includes('小可 · 暗夜剧场') && readyNote.includes('通知栏'), readyNote);
    const primaryBox = await cardPrimary.boundingBox();
    assert.ok(primaryBox.height >= 48, 'primary CTA meets 48dp touch target: ' + primaryBox.height);
    // Tap install on home card: instant non-frozen feedback BEFORE native changes state, and blocks double tap.
    await cardPrimary.click();
    assert.deepEqual(await page.evaluate(()=>ops),['check','install']);
    assert.equal(await card.getAttribute('aria-busy'),'true');
    assert.ok(await cardPrimary.isDisabled());
    await equalText('ota-card-primary','正在准备安装…');
    assert.ok(await el('ota-card-spinner').isVisible());
    assert.ok(await cardProgress.isVisible());
    assert.equal(await cardProgress.getAttribute('value'),null);
    await page.evaluate(()=>dispatchEvent(new Event('night-ota-change')));
    assert.ok(await cardPrimary.isDisabled(), 'a duplicate native notification cannot reopen the install action');
    await cardPrimary.click({force:true});
    assert.deepEqual(await page.evaluate(()=>ops),['check','install'],'double tap while pending must not duplicate install');

    // 7. Wait permission -> preparing -> pending confirmation -> installing: indeterminate progress, clear return guide, no %.
    await state('wait_permission',{canInstall:true,installPermission:false});
    assert.equal(await card.getAttribute('data-tone'),'warn');
    await equalText('ota-card-primary','继续授权安装');
    assert.ok((await cardNote.innerText()).includes('短暂退出'));
    await cardPrimary.click();
    assert.deepEqual(await page.evaluate(()=>ops),['check','install','install']);
    await equalText('ota-card-primary','正在打开授权…');

    await state('preparing_install',{busy:true,percent:42});
    assert.equal(await card.getAttribute('aria-busy'),'true');
    assert.equal(await cardProgress.getAttribute('value'),null);
    assert.ok((await cardNote.innerText()).includes('短暂退出'));
    assert.ok(!(await card.innerText()).includes('%'));

    await state('pending_confirmation',{busy:true,percent:66});
    assert.equal(await card.getAttribute('data-tone'),'warn');
    assert.equal(await cardProgress.getAttribute('value'),null);
    assert.ok((await cardNote.innerText()).includes('小可 · 暗夜剧场'));
    assert.ok(!(await card.innerText()).includes('%'));
    await home.tap();
    assert.ok(await el('ota-install').isHidden());
    assert.ok(await el('ota-check').isDisabled());
    assert.ok(await el('ota-activity').isVisible());
    assert.ok(await el('ota-install-note').isVisible());
    await el('service-close').click();

    await state('installing',{busy:true,percent:87});
    assert.equal(await card.getAttribute('aria-busy'),'true');
    assert.equal(await cardProgress.getAttribute('value'),null);
    assert.equal(await card.locator('[data-step=install]').getAttribute('data-status'),'active');
    const installNoteText = await cardNote.innerText();
    assert.ok(installNoteText.includes('短暂退出') && installNoteText.includes('小可更新完成'), installNoteText);
    assert.ok(!(await card.innerText()).includes('%'));
    await home.tap();
    assert.ok(await transfer.isHidden());
    assert.ok(await el('ota-activity').isVisible());
    assert.ok(await el('ota-check').isDisabled());

    // 8. Cancelled & error retry flows inside service panel & card.
    await state('cancelled',{canInstall:true});
    await equalText('ota-install','重试安装');
    await el('ota-install').click();
    await state('error',{canRetry:true,message:'网络中断，稍后可重试。'});
    await equalText('ota-check','重试更新');
    await el('ota-check').click();
    await state('error',{canInstall:true,canRetry:false});
    assert.ok(await el('ota-check').isDisabled());
    await equalText('ota-install','重试安装');

    // 9. Reopened after update: success card welcomes user back and persists acknowledgment.
    await state('success',{installedVersionCode:11,installedVersionName:'1.2.0',versionCode:11,versionName:'1.2.0'});
    await equalText('ota-version','当前 1.2.0');
    await el('diag-send').click();
    assert.deepEqual(await page.evaluate(()=>ops),['check','install','install','install','check','sync']);
    await el('service-close').click();
    assert.ok(await panel.isHidden());
    assert.ok(await card.isVisible());
    assert.equal(await card.getAttribute('data-tone'),'success');
    assert.ok((await el('ota-card-body').innerText()).includes('1.2.0'));
    await equalText('ota-card-primary','知道了');
    await cardPrimary.click();
    assert.ok(await card.isHidden());
    // Same success version stays acknowledged, while a newer upgraded version surfaces again.
    await state('success',{installedVersionCode:11,installedVersionName:'1.2.0',versionCode:11,versionName:'1.2.0'});
    assert.ok(await card.isHidden());
    await state('success',{installedVersionCode:12,installedVersionName:'1.3.0',versionCode:12,versionName:'1.3.0'});
    assert.ok(await card.isVisible());

    // 10. Notification open event and background polling fallback.
    for(let i=0;i<2;i++)await page.evaluate(()=>dispatchEvent(new Event('night-open-update')));
    assert.ok(await panel.isVisible()); await el('service-close').click();
    await page.evaluate(()=>setOta({state:'downloading',downloadedBytes:456,totalBytes:1000,busy:true},false));
    await equalText('ota-home-text','正在下载 45%');

    // 11. Appearance picker coexistence: opening appearance hides OTA card cleanly.
    await state('ready',{canInstall:true});
    assert.ok(await card.isVisible());
    await el('btn-palette').click();
    assert.ok(await card.isHidden());
    assert.ok(await el('color-popover').isVisible());
    const popBox = await el('color-popover').boundingBox(), palBox = await el('btn-palette').boundingBox();
    const below = popBox.y - palBox.y - palBox.height;
    assert.ok(below >= 0 && below <= 16, 'appearance still opens directly below trigger: ' + below);
    await el('appearance-done').click();
    assert.ok(await card.isVisible());

    // 12. Reduced motion stops spinner and indeterminate progress animation.
    await page.emulateMedia({reducedMotion:'reduce'});
    await state('installing',{busy:true});
    assert.equal(await el('ota-card-spinner').evaluate(e=>getComputedStyle(e).animationName),'none');
    assert.equal(await cardProgress.evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});

    // 13. Responsive idle home layout with OTA card AND call-safe layout across portrait & landscape.
    const opsBeforeCall = await page.evaluate(()=>ops.length);
    for(const viewport of [screen,{width:360,height:640},{width:740,height:390}]){
      await page.setViewportSize(viewport);
      await page.evaluate(()=>NightView.render({active:false,paired:true,phase:'idle',reply:'',mine:''}));
      await state('ready',{canInstall:true});
      assert.ok(await card.isVisible(), 'idle ready card visible on '+JSON.stringify(viewport));
      const idleRects = await page.evaluate(()=>['ota-card','panel-active','btn-call'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,w:r.width,h:r.height};}));
      for(const r of idleRects) assert.ok(r.w>0&&r.h>0,r.id);
      assert.ok(idleRects[0].bottom<=idleRects[1].top+1,JSON.stringify({viewport,idleRects}));
      assert.ok(idleRects[2].bottom<=viewport.height+1,'idle call button stays within viewport');

      // During a call: card NEVER steals screen, never auto-installs, night-open-update stays quiet.
      await page.evaluate(()=>NightView.render({active:true,paired:true,phase:'speaking',reply:'这是通话中的实时字幕。',mine:'测试通话中依然看得见字幕。'}));
      await state('ready',{canInstall:true});
      assert.ok(await card.isHidden(), 'OTA card must stay hidden during a call');
      await page.evaluate(()=>dispatchEvent(new Event('night-open-update')));
      assert.ok(await panel.isHidden()); assert.ok(await card.isHidden());
      await home.tap();
      assert.ok(await panel.isVisible());
      assert.ok(await el('ota-install').isDisabled());
      assert.ok((await el('ota-install-note').innerText()).includes('通话中不会自动安装'));
      const rects=await page.evaluate(()=>['service-panel','subtitles','reply-text','panel-active','btn-call'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,w:r.width,h:r.height};}));
      for(const r of rects) assert.ok(r.w>0&&r.h>0,r.id);
      assert.ok(rects[0].bottom<=rects[1].top+1,JSON.stringify({viewport,rects}));
      assert.ok(rects[2].bottom<=rects[3].top+1,JSON.stringify({viewport,rects}));
      assert.ok(rects[4].bottom<=viewport.height+1,'hangup stays within viewport');
      await el('service-close').click();
    }
    assert.equal(await page.evaluate(()=>ops.length),opsBeforeCall,'call transitions must never auto-trigger install');
    assert.deepEqual(exceptions,[]);
    console.log('OTA 首页更新卡、即时点击反馈、退出与重开引导、无假百分比、重开成功记忆、外观共存、无障碍减动效与通话免打扰布局全部通过。');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
