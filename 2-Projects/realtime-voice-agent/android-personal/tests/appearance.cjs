// Run on the assets extracted from the signed APK, with Android's document policy.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname,'../build/assets'));
const base = 'https://night.local/night-app/';
const policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:412,height:850}, deviceScaleFactor:1});
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(base)) { requests.push(url); return route.abort(); }
      const file = path.resolve(assets, decodeURIComponent(url.slice(base.length)));
      if (!file.startsWith(assets + path.sep)) return route.abort();
      return route.fulfill({path:file, headers:{'Content-Security-Policy':policy,
        'Content-Type':({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json'})[path.extname(file)] || 'application/octet-stream'}});
    });
    await page.addInitScript(() => {
      // Observe frames delivered to each actual renderer while leaving its drawing code in place.
      window.seenFrames = {};
      Object.defineProperty(window, 'NightAvatars', {configurable:true, set(registry) {
        const register = registry.register;
        registry.register = family => {
          const mount = family.mount;
          family.mount = (host, id) => {
            const actor = mount(host, id), update = actor.update.bind(actor);
            actor.update = frame => {window.seenFrames[family.id] = frame; return update(frame);};
            return actor;
          };
          register(family);
        };
        Object.defineProperty(window, 'NightAvatars', {value:registry, configurable:true});
      }});
    });
    await page.goto(base + 'index.html');
    const app = page.locator('#app'), grid = page.locator('#avatar-grid');
    assert.equal(await app.getAttribute('data-avatar'),'classic');
    await page.locator('#btn-service').click();
    assert.ok(await page.locator('#service-panel').isVisible());
    await page.locator('#btn-palette').click();
    assert.ok(await page.locator('#service-panel').isHidden());
    assert.ok(await page.locator('#color-popover').isVisible());
    assert.equal(await page.locator('#avatar-families button').count(),4);
    const counts = {};
    for (const family of ['classic','open','boop','robot']) {
      await page.locator('[data-family='+family+']').click();
      const cards = grid.locator('.avatar-card');
      await cards.first().waitFor();
      const count = await cards.count();
      const labels=await cards.allTextContents();
      assert.equal(new Set(labels).size,count,family+' duplicate display name');
      for (const label of labels) assert.ok(/[\u3400-\u9fff]/.test(label) && !/[a-z]/i.test(label),label);
      assert.ok(count >= ({classic:1,open:17,boop:10,robot:4})[family]);
      for (let i=0;i<count;i++) {
        await cards.nth(i).evaluate(b=>b.click());
        assert.equal(await cards.nth(i).getAttribute('aria-pressed'),'true',family+' variant '+i);
        assert.equal(await app.getAttribute('data-avatar'),family);
        await page.evaluate(()=>new Promise(requestAnimationFrame));
      }
      const thumbs = await grid.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(async img=>{
        img.loading='eager'; await img.decode(); return img.naturalWidth;
      })));
      if (family !== 'classic') assert.equal(thumbs.filter(n=>n>0).length,count);
      const options = page.locator('#avatar-expression option');
      for (const label of await options.allTextContents()) assert.ok(/[\u3400-\u9fff]/.test(label) && !/[a-z]/i.test(label),label);
      const expressions = await options.evaluateAll(items=>items.slice(1).map(i=>i.value));
      assert.ok(expressions.length >= ({classic:39,open:6,boop:12,robot:9})[family]);
      for (const id of expressions) {
        await page.selectOption('#avatar-expression',id);
        await page.evaluate(()=>new Promise(requestAnimationFrame));
      }
      await require('./voice-expressions.cjs')(page, family, expressions);
      if (family !== 'classic') {
        const stageSize = await page.locator('#avatar-engine').evaluate(host => [
          host.offsetWidth, host.firstElementChild.offsetWidth, host.offsetHeight, host.firstElementChild.offsetHeight]);
        assert.deepEqual([stageSize[1],stageSize[3]], [stageSize[0],stageSize[2]]);
        await page.evaluate(()=>{
          NightView.render({paired:true,active:true,phase:'listening'});
          NightView.micLevel(.6);
        });
        await page.waitForFunction(id=>seenFrames[id]?.localLevel>.5 && seenFrames[id]?.remoteLevel===0,family);
        await page.evaluate(()=>{
          NightView.render({paired:true,active:true,phase:'speaking'});
          NightView.level(.85);
          NightView.speech({seq:3,kind:'question'});
        });
        await page.waitForFunction(id=>seenFrames[id]?.phase==='speaking' && seenFrames[id]?.remoteLevel>.8,family);
        await page.evaluate(()=>NightView.render({paired:false,active:false,phase:'idle'}));
        await page.waitForFunction(id=>seenFrames[id]?.phase==='idle' && seenFrames[id]?.level===0,family);
      }
      if (family === 'boop') {
        await page.locator('#avatar-view').click();
        assert.equal(await page.locator('#avatar-engine boop-face').first().getAttribute('view'),'2d');
        await page.locator('#avatar-view').click();
        assert.equal(await page.locator('#avatar-engine boop-face').first().getAttribute('view'),'3d');
        await page.waitForFunction(()=>{
          const face=document.querySelector('#avatar-engine boop-face');
          const layer=face.shadowRoot.querySelector('.view-3d');
          if (!layer) return false;
          const a=face.getBoundingClientRect(), b=layer.getBoundingClientRect();
          return b.width>0 && Math.abs(a.x-b.x)<2 && Math.abs(a.y-b.y)<2;
        });
        await page.locator('#avatar-group').selectOption({index:2});
        assert.ok(await cards.count()>0 && await cards.count()<count);
        await page.locator('#avatar-group').selectOption('');
      }
      counts[family] = [count, expressions.length];
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,family+'.png')});
    }
    const last = await page.locator('#avatar-engine').getAttribute('data-variant');
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('app').dataset.avatar==='robot');
    assert.equal(await app.getAttribute('data-avatar'),'robot');
    assert.equal(await page.locator('#avatar-engine').getAttribute('data-variant'),last);
    await page.evaluate(()=>NightView.render({paired:true,active:true,phase:'speaking',reply:'同一个通话里的字幕'}));
    await page.locator('#btn-palette').click();
    for(const dims of [{width:412,height:850},{width:320,height:590},{width:820,height:390}]){
      await page.setViewportSize(dims);
      for (const id of ['btn-call','btn-mute','reply-text']) {
        await page.waitForFunction(id=>{
          const e=document.getElementById(id),r=e.getBoundingClientRect();
          return r.width>0 && r.height>0 && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        },id,{timeout:3000});
      }
      const bounds = await page.locator('#color-popover').boundingBox();
      const anchor = await page.locator('#btn-palette').boundingBox();
      const below = bounds.y - anchor.y - anchor.height;
      assert.ok(below >= 0 && below <= 16, 'appearance opens directly below its trigger');
      assert.ok(anchor.x + anchor.width / 2 >= bounds.x && anchor.x + anchor.width / 2 <= bounds.x + bounds.width);
      const first = await grid.locator('button').first().boundingBox();
      const fourth = await grid.locator('button').nth(3).boundingBox();
      assert.ok(fourth.y > first.y + first.height, 'three-column thumbnail grid during calls');
      if (dims.height >= 800) {
        const gallery = await grid.boundingBox();
        assert.ok(gallery.height >= (fourth.y - first.y) * 3, 'three full rows on a phone');
      }
      const controls = page.locator('#panel-active');
      assert.equal(await controls.locator('button:visible').count(),2);
      assert.equal((await controls.innerText()).trim(),'');
      assert.equal(await controls.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
      for (const button of await controls.getByRole('button').all()) {
        const b = await button.boundingBox();
        assert.ok(b.width>=48 && b.height>=48,'finger-sized control');
      }
      const hush = await page.locator('#btn-mute').boundingBox();
      const call = await page.locator('#btn-call').boundingBox();
      assert.ok(call.x - (hush.x + hush.width) >= 28, 'keep mute and hangup apart');
      await page.locator('#avatar-grid button').last().scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#appearance-expression').isHidden());
    }
    await grid.locator('button').first().focus();
    await page.keyboard.press('ArrowDown');
    assert.ok(await grid.locator('button').nth(3).evaluate(b => b === document.activeElement));
    await page.keyboard.press('End');
    assert.ok(await grid.locator('button').last().evaluate(b => b === document.activeElement));
    await page.keyboard.press('Tab');
    assert.ok(await grid.evaluate(g => !g.contains(document.activeElement)));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('[data-family=boop]').click();
    await grid.locator('button').first().click();
    await page.evaluate(()=>{NightView.level(.7); NightView.speech({seq:1,kind:'question'});});
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#reply-text').textContent(),'同一个通话里的字幕');
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#color-popover').isHidden());
    assert.equal(await app.getAttribute('data-active'),'true');
    await page.setViewportSize({width:412,height:850});
    await require('./color-wheel.cjs')(page);
    assert.deepEqual(errors,[]); assert.deepEqual(requests,[]);
    console.log(JSON.stringify({variantsAndExpressions:counts, offline:true, preservedSelection:true}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
