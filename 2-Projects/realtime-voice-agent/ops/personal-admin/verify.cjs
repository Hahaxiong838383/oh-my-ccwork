// Read-only browser check. The administrator password is read from standard input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function verify() {
  const origin = new URL(process.env.ADMIN_TEST_URL).origin;
  assert(origin.startsWith('https://'), '需要 HTTPS 管理入口');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { window.previewBlob = blob; return create(blob); };
    });
    await page.goto(origin);
    assert.equal((await context.request.get(origin + '/api/voices')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/providers')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/brain/overview')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/operations')).status(), 401);
    await page.locator('#pass').fill(fs.readFileSync(0, 'utf8').trim());
    await page.locator('#signin button').click();
    await page.waitForFunction(() => document.querySelector('#voiceChoice').options.length >= 2);
    const read = async route => {
      const r = await context.request.get(origin + '/api/' + route);
      assert.equal(r.status(),200,'无法读取 '+route);
      return r.json();
    };
    const overview = await read('brain/overview');
    assert.ok(Number.isSafeInteger(overview.memoryCount) && Number.isSafeInteger(overview.growthCount));
    const operations = await read('operations');
    assert.ok(operations.sampledAt && operations.ota?.state && operations.brain?.state && operations.backup?.state);
    const open = async (tab, path) => {
      const response = page.waitForResponse(r => new URL(r.url()).pathname===path && r.request().method()==='GET');
      await page.locator('#mobileView').selectOption(tab);
      const r=await response;
      assert.equal(r.status(),200,'工作区读取失败 '+tab);
      return r.json();
    };
    for(const [tab,path,root] of [['memories','/api/brain/memories','memoryRows'],['growth','/api/brain/growth','growthRows'],['tools','/api/brain/tools/history','historyRows'],['activity','/api/brain/activity','activityRows']]){
      const data=await open(tab,path);
      assert.ok(Number.isSafeInteger(data.total)&&Array.isArray(data.items));
      await page.waitForFunction(([id,count])=>{
        const el=document.getElementById(id);
        return count ? el.querySelectorAll('.record').length===count : /暂无|尚未/.test(el.textContent);
      },[root,data.items.length]);
      if(tab==='memories'){
        for(const key of ['verified','pending','conflict','inactive']){
          const metric=data.counts[key==='conflict'?'conflicts':key];
          assert.ok(Number.isSafeInteger(metric)&&metric>=0);
          assert.equal(await page.locator('#memCounters [data-state="'+key+'"] strong').textContent(),String(metric));
        }
        if(data.items.length){
          const row=data.items[0],route='/api/brain/memories/'+encodeURIComponent(row.id);
          const response=page.waitForResponse(r=>new URL(r.url()).pathname===route);
          await page.locator('#memoryRows [data-memory]').first().click();
          const detail=await (await response).json();
          assert.equal(detail.item.id,row.id);assert.ok(Array.isArray(detail.uses));
          await page.waitForFunction(value=>document.querySelector('#memDetail').textContent.includes(value),detail.item.value);
          assert.equal(await page.locator('#memDetail').isVisible(),true);
          assert.equal(await page.locator('#memoryRows').isVisible(),false);
          await page.locator('#memoryBack').click();assert.equal(await page.locator('#memoryRows').isVisible(),true);
        }
        const ex=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/brain/extractions');
        await page.locator('#extractTab').click();
        const records=await(await ex).json();
        assert.equal(records.total,records.summary.runs);assert.equal(typeof records.service.configured,'boolean');
        await page.waitForFunction(n=>document.querySelector('#extractStats strong')?.textContent===String(n),records.total);
        assert.equal(await page.locator('#extractRows .record').count(),records.items.length);
      }
      if(tab==='growth'){
        const snapshots=await read('brain/growth/snapshots');
        if(snapshots.items.length){
          await page.locator('#snapshotCompare tbody tr').first().waitFor();
          assert.equal(await page.locator('#snapshotCompare tbody tr').count(),snapshots.dimensions.length+4);
        }else await page.getByText('尚无每日快照。',{exact:true}).waitFor();
      }
      if(tab==='tools'){
        const samples=await read('turn-timing');assert.ok(Array.isArray(samples.items));
        await page.waitForFunction(()=>document.querySelector('#turnTiming tbody tr')||document.querySelector('#turnTiming').textContent.includes('尚无可回看'));
      }
    }
    const wordState=await open('hotwords','/api/word-publications');
    assert.ok(Number.isSafeInteger(wordState.current.revision));
    await page.waitForFunction(n=>document.getElementById('privateWordsPanel').textContent.includes('版本 '+n),wordState.current.revision);
    const cues=await open('filler','/api/brain/voice-cues');
    assert.ok(Number.isSafeInteger(cues.revision));
    await page.waitForFunction(rev=>document.getElementById('cueState').textContent.includes('修订 '+rev),cues.revision);
    assert.equal(await page.locator('#chatWait').inputValue(),String(cues.chatWaitMs));
    await open('operations','/api/operations');
    await page.waitForFunction(()=>document.getElementById('opsTime').textContent.startsWith('采样时间'));
    const devices=(await read('devices')).devices;
    assert.ok(Array.isArray(devices));
    if(devices.length){
      await page.locator('#mobileView').selectOption('devices');
      const stats=page.waitForResponse(r=>/^\/api\/devices\/[^/]+\/diagnostics$/.test(new URL(r.url()).pathname));
      await page.locator('#deviceHistory summary').click();
      const response=await stats;assert.equal(response.status(),200);
      const {uploads}=await response.json();
      for(const k of ['batches','submitted','inserted','repeats'])assert.ok(Number.isSafeInteger(uploads[k])&&uploads[k]>=0,k);
      assert.equal(uploads.submitted,uploads.inserted+uploads.repeats);
      await page.waitForFunction(n=>document.querySelector('#diagUploads .fact-line:nth-child(3) span:last-child')?.textContent===String(n),uploads.inserted);
    }
    await page.locator('#mobileView').selectOption('diagnostics');
    assert.ok(await page.getByRole('button',{name:'新试问',exact:true}).isVisible());
    await page.locator('#mobileView').selectOption('voice');
    const readVoices = async () => {
      const r = await context.request.get(origin + '/api/voices');
      assert.equal(r.status(), 200);
      return r.json();
    };
    const before = await readVoices();
    for (const voice of before.voices) {
      await page.selectOption('#voiceChoice', voice.id);
      const preview = page.waitForResponse(r => new URL(r.url()).pathname === '/api/voices/preview');
      await page.click('#preview');
      const response = await preview;
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => document.querySelector('#sample').readyState >= 2 && document.querySelector('#sample').currentTime > 0);
      const energy = await page.evaluate(async () => {
        const audio = new AudioContext();
        try {
          const bytes = await window.previewBlob.arrayBuffer();
          const clip = await audio.decodeAudioData(bytes);
          const pcm = clip.getChannelData(0);
          return { seconds: clip.duration, rms: Math.sqrt(pcm.reduce((sum, n) => sum + n * n, 0) / pcm.length) };
        } finally { await audio.close(); }
      });
      assert(energy.seconds > 0.3 && energy.rms > 0.001, voice.name + ' 样音为空');
      console.log(voice.name, voice.id, energy);
    }
    assert.equal((await readVoices()).active, before.active, '试听改变了生效音色');
    for (const width of [390, 1360]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), '页面横向溢出');
    }
    await page.click('#logout');
    await page.locator('#signin:visible').waitFor();
    assert.equal((await context.request.get(origin + '/api/voices')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/providers')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/brain/overview')).status(), 401);
    console.log('PASS 主人登录、私人各区真实载荷、权限、音色试听与退出。');
  } finally { await browser.close(); }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
