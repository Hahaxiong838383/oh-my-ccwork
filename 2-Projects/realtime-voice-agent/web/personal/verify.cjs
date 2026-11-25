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
    await page.waitForFunction(([input, answer]) => {
      const lines = [...document.querySelectorAll('#lines li')];
      return ['小可','我'].every(who => lines.some(line => line.querySelector('strong')?.textContent === who))
          && lines.some(line => line.querySelector('strong')?.textContent === '我' && line.textContent.includes(input))
          && (!answer || lines.some(line => line.querySelector('strong')?.textContent === '小可' && new RegExp(answer).test(line.textContent)))
          && document.querySelector('#tracks audio')?.currentTime > 0;
    }, [VOICE_TEST_EXPECT, process.env.VOICE_TEST_ANSWER || ''], {timeout:90000});
    const userLines = await page.locator('#lines li').evaluateAll(lines =>
      lines.filter(line => line.querySelector('strong')?.textContent === '我').map(line => line.querySelector('span').textContent));
    assert(userLines.some(line => line.includes(VOICE_TEST_EXPECT)), '输入字幕与合成录音不一致');
    const answer = await page.locator('#lines li').evaluateAll(lines => lines
      .filter(line => line.querySelector('strong')?.textContent === '小可')
      .map(line => line.innerText).join(' '));
    if (process.env.VOICE_TEST_ANSWER) assert.match(answer, new RegExp(process.env.VOICE_TEST_ANSWER));
    if (process.env.VOICE_TEST_SOURCE_HOST) {
      const confirmed = await page.waitForFunction(host => {
        const link = [...document.querySelectorAll('#lines .sources a')].find(a => {
          const url = new URL(a.href);
          const row = a.closest('li')?.closest('.sources')?.parentElement;
          return row?.querySelector('strong')?.textContent === '小可' && row.querySelector('span')?.textContent.trim().length > 4
            && url.protocol === 'https:' && (url.hostname === host || url.hostname.endsWith('.' + host));
        });
        if (!link) return false;
        const row = link.closest('.sources').parentElement;
        return {url:link.href, caption:[...row.children].filter(n=>n.tagName==='SPAN').map(n=>n.textContent).join('')};
      }, process.env.VOICE_TEST_SOURCE_HOST, {timeout:45000});
      console.log('语音工具来源', await confirmed.jsonValue());
    }
    const media = await page.waitForFunction(async () => {
      for (const participant of active.room.remoteParticipants.values()) {
        if (!participant.isAgent) continue;
        for (const publication of participant.audioTrackPublications.values()) {
          const report = await publication.track?.getRTCStatsReport();
          if (!report) continue;
          for (const stat of report.values()) {
            if (stat.type === 'inbound-rtp' && stat.kind === 'audio' &&
                stat.totalAudioEnergy > 0 && stat.packetsReceived > 5)
              return {packets: stat.packetsReceived, energy: stat.totalAudioEnergy};
          }
        }
      }
      return false;
    }, null, {timeout:20000});
    console.log('输入字幕', userLines.join(' '), '回复字幕', answer.slice(0,160),
      '浏览器收到的音轨', await media.jsonValue());
    await page.getByRole('button', {name:'静音',exact:true}).click();
    await page.getByRole('button',{name:'恢复麦克风'}).click();
    await page.getByRole('button',{name:'静音',exact:true}).waitFor();
    await page.locator('#end').click();
    await page.locator('#start:visible').waitFor();
    console.log('通过设备签票、指定问句字幕、助手字幕、音轨播放、静音切换和结束测试');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message);process.exitCode=1; });
