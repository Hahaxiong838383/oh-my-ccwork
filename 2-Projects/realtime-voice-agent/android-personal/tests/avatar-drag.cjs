// Drive a single held finger and measure the visible eyes in the packaged page.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../build/assets'));

async function eyeCenter(canvas, family) {
  if (family === 'boop') {
    // The white ink blinks and changes shape. Measure the two projected SVG eye
    // layers relative to the projected shell so a moving jelly outline can't pass.
    return canvas.page().locator('boop-face').evaluate(face => {
      const view = face.shadowRoot.querySelector('.view-3d')?.shadowRoot;
      const shell = (view?.querySelector('.wall > path') || face._head).getBoundingClientRect();
      const eyes = view ? [...view.querySelectorAll('.eyes')].slice(0, 2) : [face._leftEye, face._rightEye];
      const bounds = eyes.map(eye => eye.getBoundingClientRect());
      const center = (box, axis) => axis === 'x' ? box.x + box.width / 2 : box.y + box.height / 2;
      const offset = axis => (center(bounds[0], axis) + center(bounds[1], axis)) / 2 - center(shell, axis);
      return {x:offset('x') / shell.width, y:offset('y') / shell.height, visible:bounds.every(b => b.width > 0 && b.height > 0)};
    });
  }
  const bounds = await canvas.boundingBox();
  const png = await canvas.page().screenshot({clip:bounds});
  return canvas.page().evaluate(async ({encoded, family}) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + encoded;
    await img.decode();
    const copy = document.createElement('canvas');
    copy.width = img.width;
    copy.height = img.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const {width, height, data} = ctx.getImageData(0, 0, img.width, img.height);
    let count = 0, sumX = 0, sumY = 0;
    for (let y = Math.ceil(height * .30); y < height * .71; y++) {
      for (let x = Math.ceil(width * .16); x < width * .84; x++) {
        const i = (y * width + x) * 4;
        const eye = family === 'open'
          ? data[i] === 21 && data[i+1] === 21 && data[i+2] === 21
          : data[i] > 245 && data[i+1] > 246 && data[i+2] > 246;
        if (eye) { count++; sumX += x; sumY += y; }
      }
    }
    return {x: sumX / count / width, y: sumY / count / height, visible:count > 35};
  }, {encoded: png.toString('base64'), family});
}

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:412,height:850}, isMobile:true, hasTouch:true});
    await page.route('https://night.test/**', route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      return route.fulfill({path:path.join(assets, name)});
    });
    await page.addInitScript(() => { window.NightHost = {paired:() => true}; });
    await page.goto('https://night.test/');
    const touch = await page.context().newCDPSession(page);
    const canvas = page.locator('#orb-canvas');
    const cases = [
      ['open', 'controller:flat', .12, .065], ['boop', 'classic-3d', .17, .14],
      ['boop', 'classic-2d', .16, .12], ['robot', 'rectangle', .13, .075],
    ];
    for (const [family, variant, horizontal, vertical] of cases) {
      await page.locator('#btn-palette').click();
      await page.locator('[data-family="' + family + '"]').click();
      await page.locator('.avatar-card[data-variant="' + variant + '"]').click();
      await page.locator('#appearance-done').click();
      await page.waitForTimeout(900);
      const box = await canvas.boundingBox();
      const send = (type, dx, dy) => touch.send('Input.dispatchTouchEvent', {type, touchPoints:
        type === 'touchEnd' ? [] : [{x:box.x + box.width*(.5+.38*dx), y:box.y + box.height*(.49+.34*dy)}]});
      // Start on the unoccupied stage so native petting and squeezing cannot
      // mask whether a continuous drag itself is driving the rendering.
      await send('touchStart', -1.5, 0);
      await page.waitForTimeout(160);
      let previousX = -1.5, previousY = 0;
      const seen = {};
      for (const [name, dx, dy] of [['left',-1,0], ['right',1,0], ['up',0,-1], ['down',0,1]]) {
        for (let step = 1; step <= 5; step++) {
          await send('touchMove', previousX + (dx-previousX)*step/5, previousY + (dy-previousY)*step/5);
          await page.waitForTimeout(24);
        }
        previousX = dx; previousY = dy;
        await page.waitForTimeout(550);
        seen[name] = await eyeCenter(canvas, family);
        assert.ok(seen[name].visible, variant + ' eyes visible at ' + name);
      }
      await page.waitForTimeout(850);
      const held = await eyeCenter(canvas, family);
      await send('touchEnd');
      console.log(variant, JSON.stringify({seen, held}));
      assert.ok(seen.right.x - seen.left.x > horizontal, variant + ' turns toward the finger horizontally');
      assert.ok(seen.down.y - seen.up.y > vertical, variant + ' turns toward the finger vertically');
      assert.ok(held.y - seen.up.y > vertical * .75, variant + ' stays oriented until the finger lifts');
      console.log('PASS', family, variant);
    }
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
