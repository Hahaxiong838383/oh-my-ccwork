// Test a deployed client using the device credential on stdin and a synthetic WAV.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const { VOICE_TEST_URL, VOICE_TEST_PIN, VOICE_TEST_WAV, VOICE_TEST_EXPECT, CHROMIUM_PATH } = process.env;
  assert(VOICE_TEST_URL && VOICE_TEST_WAV && VOICE_TEST_EXPECT,
    'Set VOICE_TEST_URL, VOICE_TEST_WAV and VOICE_TEST_EXPECT');
  const args = ['--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=' + VOICE_TEST_WAV];
  if (VOICE_TEST_PIN) args.push('--ignore-certificate-errors-spki-list=' + VOICE_TEST_PIN);
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args });
  try {
    const context = await browser.newContext({permissions:['microphone'],viewport:{width:390,height:844}});
    const page = await context.newPage();
    await page.goto(VOICE_TEST_URL);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'glass');
    await page.locator('#device').fill(fs.readFileSync(0,'utf8').trim());
    const ticket = page.waitForResponse(r => new URL(r.url()).pathname === '/api/voice/ticket');
    await page.locator('#connect').click();
    assert.equal((await ticket).status(),200);
    await page.locator('#controls:visible').waitFor();
    await page.waitForFunction(() => {
      const lines = [...document.querySelectorAll('#lines li')];
      return ['小可','我'].every(who => lines.some(line => line.querySelector('strong')?.textContent === who))
          && document.querySelector('#tracks audio')?.currentTime > 0;
    }, null, {timeout:90000});
    const userLines = await page.locator('#lines li').evaluateAll(lines =>
      lines.filter(line => line.querySelector('strong')?.textContent === '我').map(line => line.querySelector('span').textContent));
    assert(userLines.some(line => line.includes(VOICE_TEST_EXPECT)), '输入字幕与合成录音不一致');
    await page.locator('#mic').click();
    await page.getByRole('button',{name:'恢复麦克风'}).click();
    await page.getByRole('button',{name:'静音',exact:true}).waitFor();
    await page.locator('#end').click();
    await page.locator('#start:visible').waitFor();
    console.log('通过设备签票、指定问句字幕、助手字幕、音轨播放、静音切换和结束测试');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message);process.exitCode=1; });
