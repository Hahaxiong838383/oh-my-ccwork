// Exercise the packaged page with real Chromium pointer, touchscreen and key events.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));
const origin = 'http://localhost:13094';

const observeBind = `
  const bindForTest = NightOrbInput.bind;
  NightOrbInput.bind = (canvas, orb) => {
    window.actions = [];
    for (const method of ['touch', 'lookAt', 'clearLook']) {
      const original = orb[method].bind(orb);
      orb[method] = (...args) => { actions.push([method, ...args]); return original(...args); };
    }
    bindForTest(canvas, orb);
  };
`;

// Count connected regions of the eyes' light ink in the default theme. Ignore the
// blue material and antialiased pixels so a halo or movement alone cannot pass.
function paintedEyes(canvas) {
  const {width, height} = canvas;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  let sumX = 0, sumY = 0, count = 0;
  for (let i=0; i<ink.length; i++) {
    const k=i*4, r=pixels[k];
    if (r<219 || r>249 || pixels[k+1]!==r+2 || pixels[k+2]!==r+3 || pixels[k+3]!==255) continue;
    ink[i]=1; sumX+=i%width; sumY+=Math.floor(i/width); count++;
  }
  const areas=[];
  for (let i=0; i<ink.length; i++) {
    if (!ink[i]) continue;
    const pending=[i]; ink[i]=0; let area=0;
    while (pending.length) {
      const j=pending.pop(); area++;
      for (const k of [j-1,j+1,j-width,j+width]) {
        if (ink[k]) { ink[k]=0; pending.push(k); }
      }
    }
    if (area>20) areas.push(area);
  }
  return {x:sumX/count/width, y:sumY/count/height, areas:areas.sort((a,b)=>b-a)};
}

async function exercise(browser, fallback) {
  const page = await browser.newPage({ viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fallback) await page.addInitScript(() => { Object.defineProperty(window, 'PointerEvent', {value: undefined}); });
  await page.route(origin + '/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (!/^[a-z][a-z0-9-]*\.(?:js|css|html)$/.test(name)) return route.abort();
    if (name === 'livekit.js') {
      // For a source-tree test use the same bundled SDK as build.sh. An extracted APK contains it.
      const body = await fs.readFile(path.join(assets, name)).catch(() =>
        fs.readFile(process.env.LIVEKIT_UMD || path.resolve(__dirname, '../../web/personal/node_modules/livekit-client/dist/livekit-client.umd.js')));
      return route.fulfill({contentType: 'text/javascript', body});
    }
    const body = await fs.readFile(path.join(assets, name), 'utf8');
    const type = path.extname(name);
    return route.fulfill({contentType: type === '.html' ? 'text/html' : type === '.css' ? 'text/css' : 'text/javascript', body: body + (name === 'orb-input.js' ? observeBind : '')});
  });
  await page.goto(origin);
  await page.waitForFunction(() => Array.isArray(window.actions));
  assert.equal(await page.locator('#app').getAttribute('data-paired'), 'false');
  const canvas = page.locator('#orb-canvas');
  const palette = page.locator('#btn-palette');
  const count = name => page.evaluate(m => actions.filter(a => a[0] === m).length, name);
  const reset = () => page.evaluate(() => { actions.length = 0; });
  const look = () => page.evaluate(() => actions.filter(a => a[0] === 'lookAt').at(-1)?.slice(1));
  const bounds = await canvas.boundingBox();
  const cx = Math.round(bounds.x + bounds.width/2), cy = Math.round(bounds.y + bounds.height/2);
  await page.touchscreen.tap(cx, cy);
  assert.equal(await count('touch'), 1, 'a finger tap on the body fires exactly once');
  // The canvas loses focus after the next pointerup. Its blur must not cancel the new gaze.
  await page.touchscreen.tap(16, 405);
  await page.waitForTimeout(190);
  assert.equal(await page.evaluate(() => actions.at(-1)[0]), 'lookAt', 'body-to-left-background tap persists');
  assert.ok((await look())[0] < -.45);
  if (!fallback) {
    // Fixed facial posture lets the assertion compare input direction without random blinks.
    await page.emulateMedia({reducedMotion: 'reduce'});
    const samples = {};
    for (const [direction,x,y] of [['W',16,405],['E',396,405],['N',206,14],['S',206,842],
      ['NW',22,30],['NE',390,32],['SW',20,828],['SE',392,827]]) {
      await page.touchscreen.tap(x,y);
      await page.waitForTimeout(110);
      const sample=await canvas.evaluate(paintedEyes);
      assert.ok(sample.areas[1] > 80, direction + ': both visible eyes retain painted area');
      samples[direction]=sample;
    }
    assert.ok(samples.W.x < .40 && samples.E.x > .61);
    assert.ok(samples.N.y < .33 && samples.S.y > .52);
    assert.ok(samples.NW.x < samples.NE.x-.09 && samples.SW.x < samples.SE.x-.09);
    assert.ok(samples.NW.y < samples.SW.y-.12 && samples.NE.y < samples.SE.y-.12);
    await page.emulateMedia({reducedMotion: 'no-preference'});
  }
  const cornerX = Math.ceil(bounds.x + 3), cornerY = Math.ceil(bounds.y + 3);
  await page.touchscreen.tap(cornerX, cornerY);
  assert.equal(await count('touch'), 1, 'canvas corner is outside the body');
  let direction = await look();
  assert.ok(direction[0] < -.22 && direction[1] < -.22);
  await page.touchscreen.tap(5, cy);
  assert.ok((await look())[0] < -.46);
  await palette.tap();
  assert.equal(await palette.getAttribute('aria-expanded'), 'true', 'button still opened its own panel');
  direction = await look();
  assert.ok(direction[0] > .08 && direction[1] < -.29, 'looks at top-right button');
  await page.waitForTimeout(1320);
  assert.equal(await page.evaluate(() => actions.at(-1)[0]), 'clearLook');
  await palette.focus(); await page.keyboard.press('Enter');
  assert.equal(await palette.getAttribute('aria-expanded'), 'false');
  assert.ok((await look())[0] > .08, 'keyboard activation looks at the focused control');

  await reset();
  await canvas.focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  assert.equal(await count('touch'), 2, 'keyboard activates orb once per key');

  const client = await page.context().newCDPSession(page);
  const send = (type, points) => client.send('Input.dispatchTouchEvent', {type, touchPoints: points});
  await reset();
  await send('touchStart', [{x: cx, y: cy}]);
  await send('touchMove', [{x: cx - 30, y: cy + 45}]);
  await send('touchEnd', []);
  await send('touchStart', [{x: cx, y: cy}]);
  await send('touchCancel', []);
  await send('touchStart', [{x: cx - 5, y: cy}]);
  await send('touchStart', [{x: cx - 5, y: cy, id: 0}, {x: cx + 5, y: cy, id: 1}]);
  await send('touchEnd', []);
  assert.equal(await count('touch') + await count('lookAt'), 0, 'drag, cancellation and pinch are not taps');
  await send('touchStart', [{x: cx, y: cy}]);
  await page.waitForTimeout(720); await send('touchEnd', []);
  assert.equal(await count('touch') + await count('lookAt'), 0, 'long press leaves native handling intact');

  await page.setViewportSize({width: 730, height: 415});
  await page.waitForTimeout(120);
  const after = await canvas.boundingBox();
  await page.touchscreen.tap(after.x + after.width/2, after.y + after.height/2);
  assert.equal(await count('touch'), 1, 'hit coordinates updated after rotation');
  if (!fallback) {
    await reset();
    await page.mouse.move(after.x+after.width/2, after.y+after.height/2);
    await page.mouse.down(); await page.mouse.move(5, 5); await page.mouse.up();
    assert.equal(await count('touch') + await count('lookAt'), 0);
    await page.mouse.click(after.x + after.width/2, after.y + after.height/2, {button:'right'});
    assert.equal(await count('touch') + await count('lookAt'), 0, 'context click leaves native handling intact');
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log(fallback ? 'Legacy touch + compatibility mouse passed' : 'Pointer Events passed');
}

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox']});
  try { await exercise(browser, false); await exercise(browser, true); } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
