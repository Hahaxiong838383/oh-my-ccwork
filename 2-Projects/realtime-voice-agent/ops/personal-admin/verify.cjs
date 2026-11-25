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
    await page.locator('#pass').fill(fs.readFileSync(0, 'utf8').trim());
    await page.locator('#signin button').click();
    await page.waitForFunction(() => document.querySelector('#voiceChoice').options.length >= 2);
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
  } finally { await browser.close(); }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
