// Exercise the gallery's real renderers with a pointer kept down between samples.
const assert = require('node:assert/strict');

async function colorPixels(page, locator) {
  const data = await locator.screenshot();
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image,0,0,80,80);
    const pixels = ctx.getImageData(0,0,80,80).data;
    let red = 0, green = 0;
    for (let i=0; i<pixels.length; i+=4) {
      const [r,g,b] = pixels.subarray(i,i+3);
      if (r > g+20 && r > b+20) red++;
      if (g > r+20 && g > b+20) green++;
    }
    return {red,green};
  }, data.toString('base64'));
}

module.exports = async function verifyColorWheel(page) {
  await page.evaluate(() => {
    window.NightView.render({active:false, paired:true, phase:'idle'});
    window.picks = [];
    const pick = window.Voice.onAccentPick;
    window.Voice.onAccentPick = hex => { window.picks.push(hex); pick(hex); };
  });
  if (await page.locator('#color-popover').isHidden()) await page.locator('#btn-palette').click();
  const variants = [['classic','night'], ['open','controller'], ['open','controller:flat'],
    ['open','controller:glass'], ['open','rocket'], ['open','witch-hat:flat'],
    ['boop','classic-3d'], ['boop','skin-102'], ['boop','skin-102','2d'], ['boop','skin-1701'], ['robot','rectangle'], ['robot','hex-graphite']];
  const wheel = page.locator('#color-wheel');
  for (const [family,variant,view] of variants) {
    await page.locator('[data-family="'+family+'"]').click();
    await page.locator('.avatar-card[data-variant="'+variant+'"]').click();
    if (view==='2d' && await page.locator('#avatar-view').getAttribute('aria-pressed')==='true') await page.locator('#avatar-view').click();
    await page.locator('#color-custom').click();
    const rect = await wheel.boundingBox();
    const x = rect.x+rect.width/2, y=rect.y+rect.height/2, radius=rect.width*.46;
    const before = await page.evaluate(()=>({hex:NightView.accent(), picks:picks.length}));
    const surface = page.locator(family==='classic' ? '#orb-canvas' : '#avatar-engine');
    await page.mouse.move(x,y-radius);
    await page.mouse.down();
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const red=await colorPixels(page,surface);
    await page.mouse.move(x+radius*Math.sin(Math.PI*2/3),y+radius*.5,{steps:5});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const green=await colorPixels(page,surface);
    assert.ok(red.red > green.red+60 && green.green > red.green+60,JSON.stringify({family,variant,view,red,green}));
    assert.deepEqual(await page.evaluate(()=>({hex:NightView.accent(), picks:picks.length})),before);
    await page.mouse.up();
    assert.equal(await page.evaluate(()=>picks.length),before.picks+1);
    assert.equal(await page.locator('#color-hex').textContent(),await page.evaluate(()=>NightView.accent()));
    await page.locator('#color-custom').click();
  }
  await page.locator('#color-custom').click();
  const light=page.locator('#wheel-value');
  await light.focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#color-hex').textContent(),'#000000');
  await page.keyboard.press('End');
  const rect=await wheel.boundingBox();
  await page.mouse.move(rect.x+rect.width/2,rect.y+10);
  await page.mouse.down();
  const preview = await page.locator('#color-hex').textContent();
  await page.evaluate(()=>Voice.onSyncAccent('#EBDDFF'));
  assert.equal(await page.locator('#color-hex').textContent(),preview);
  await wheel.dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse'});
  await page.mouse.up();
  assert.equal(await page.locator('#color-hex').textContent(),'#EBDDFF');
  // Reset brightness, then touch the white centre and check the committed value survives reload.
  await light.focus();
  await page.keyboard.press('End');
  await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
  const saved = await page.evaluate(()=>NightView.accent());
  assert.match(saved,/^#F[0-9A-F]F[0-9A-F]F[0-9A-F]$/);
  await page.reload();
  assert.equal(await page.evaluate(()=>NightView.accent()),saved);
};
