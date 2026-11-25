// Run against the C page using an isolated Chromium trust store containing the edge CA.
// Provide a temporary device credential on stdin.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const { VOICE_TEST_URL, CHROMIUM_PATH } = process.env;
  const url = new URL(VOICE_TEST_URL);
  const credential = fs.readFileSync(0, 'utf8').trim();
  assert(/^pv1_[0-9a-f]{64}$/.test(credential), 'A temporary device credential is required');
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.addInitScript(() => {
      window.micRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.micRequests++;
        throw new DOMException('microphone unavailable', 'NotAllowedError');
      };
    });
    await page.goto(url.toString());
    const request = path => new URL(path, url).toString();
    async function status(path, options) {
      return page.evaluate(async ([path, options]) => (await fetch(path, { method: 'POST', ...options })).status, [path, options]);
    }
    assert.equal(await status('/api/voice/ticket'), 401);
    assert.equal(await status('/api/voice/ticket', { headers: { Authorization: 'Bearer pv1_' + 'f'.repeat(64) } }), 401);
    await page.locator('#device').fill(credential);
    const ticket = page.waitForResponse(response => response.url() === request('/api/voice/ticket'));
    await page.getByRole('button', { name: '仅用文字' }).click();
    const response = await ticket;
    assert.equal(response.status(), 200);
    assert.equal(await status('/api/voice/ticket', {
      headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
      body: '{"room":"foreign-room"}',
    }), 400);
    const signed = await response.json();
    const grants = JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url')).video;
    assert.equal(grants.room, signed.room);
    assert(grants.roomJoin && grants.canPublishData);
    assert(!grants.roomList && !grants.roomAdmin && !grants.roomCreate && !grants.agent);
    assert.equal(await status('/twirp/livekit.RoomService/ListRooms', {
      headers: { Authorization: 'Bearer ' + signed.token, 'Content-Type': 'application/json' }, body: '{}',
    }), Number(process.env.VOICE_TEST_LIST_ROOMS_STATUS || 401));

    await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 18000 });
    assert.equal(await page.evaluate(() => window.micRequests), 0);
    assert.equal(await page.locator('#store').isChecked(), false);
    await page.evaluate(() => {
      window.wire = [];
      active.room.on(LivekitClient.RoomEvent.DataReceived, (data, sender, kind, topic) => {
        if (topic === 'personal.v1.output') window.wire.push({ ...JSON.parse(new TextDecoder().decode(data)), sender: sender?.identity, kind });
      });
    });

    const message = page.locator('#message');
    async function ask(text) {
      await message.fill(text);
      await message.press('Enter');
    }
    await ask('请上网查 Python 3.14.0 正式发布的日期，给我 Python 官方发布公告原文。');
    const link = page.locator('#lines .sources a').first();
    await link.waitFor({ timeout: 40000 });
    const href = new URL(await link.getAttribute('href'));
    assert.equal(href.protocol, 'https:');
    assert(['python.org', 'www.python.org'].includes(href.hostname));
    assert.match(href.pathname, /downloads\/release\/python-3140/);
    assert.match(await page.locator('#lines').innerText(), /2025\s*年\s*10\s*月\s*7\s*日|2025-10-07/);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const search = await page.evaluate(() => window.wire.find(frame => frame.metadata?.tool === 'search'));
    assert.equal(search.kind, 0);
    assert(search.sender === 'personal-text-relay' || search.sender.startsWith('agent-'));
    assert.equal(search.metadata.sources[0].url, href.toString());
    const opened = page.waitForEvent('popup');
    await link.click();
    const popup = await opened;
    try {
      await popup.waitForURL(url => url.hostname.replace(/^www\./, '') === 'python.org'
        && url.pathname.replace(/\/$/, '') === href.pathname.replace(/\/$/, ''), {
        waitUntil: 'commit', timeout: 12000,
      });
    } catch (error) {
      throw Error('来源新标签页未打开到 Python 公告，停在 ' + popup.url(), { cause: error });
    }
    await popup.close();
    console.log('真实查询、文字回执、可靠来源包及页面链接通过。');

    await page.evaluate(async frame => {
      const { room, peer } = active;
      await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({
        recipient: peer.identity, type: 'text', id: frame.id, text: '现在几点？', store: false,
      })), { topic: 'personal.v1.input', reliable: true, destinationIdentities: [peer.identity] });
    }, search);
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(id => window.wire.filter(e => e.id === id).length, search.id), 1);

    await ask('请搜索 Python 3.13.1 的正式发布日期并给出处。');
    await page.getByRole('button', { name: '停止回复' }).click();
    await page.waitForFunction(() => window.wire.some(frame => frame.type === 'cancelled'), null, { timeout: 9000 });
    const cancelled = await page.evaluate(() => window.wire.find(frame => frame.type === 'cancelled'));
    await page.waitForTimeout(600);
    await ask('北京时间现在几点？');
    await page.waitForFunction(() => window.wire.some(frame => frame.metadata?.tool === 'clock'), null, { timeout: 15000 });
    assert.equal(await page.evaluate(id => window.wire.filter(e => e.id === id).length, cancelled.id), 1);
    assert.equal(await page.evaluate(() => window.micRequests), 0);
    assert.deepEqual(failures, []);
    await page.getByRole('button', { name: '结束通话' }).click();
    await page.locator('#start:visible').waitFor();
    console.log('设备签票边界、无麦克风、重复包、取消及同房下一轮通过。room=' + signed.room);
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
