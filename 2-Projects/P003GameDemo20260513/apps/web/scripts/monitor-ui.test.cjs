/* Run against the real admin HTML with local vendor assets and synthetic API data.
 * PLAYWRIGHT_MODULE_PATH may point to an already installed Playwright package.
 * No credentials, production requests or application writes are used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const admin = path.resolve(__dirname, '../public/admin');
const html = fs.readFileSync(path.join(admin, 'index.html'), 'utf8')
  .replace("app.mount('#app');", "window.monitorFixtureVm = app.mount('#app');");
const artifacts = process.env.MONITOR_UI_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-ui-'));
fs.mkdirSync(artifacts, { recursive: true });
const now = Date.now();
const snapshot = {
  hostname: 'fixture-hk2', collect_ms: 210, errors: [],
  host: { uptime_s: 3600, load1: 0.7, load5: 0.6, load15: 0.5, nproc: 8, mem_avail_mb: 6000, mem_total_mb: 8000, disk_root_used_pct: 27, disk_root_avail_gb: 56 },
  services: [], sidecars: [], device_cmd: [], connections: {},
  mem_avail_mb: 6000, mem_total_mb: 8000, load1: 0.7, nproc: 8,
  rust_mem_bytes: 800000000, rust_mem_high_bytes: 3000000000, rust_active: 'active', max_jobs: 20,
};
let payload = { ok: true, id: 'worker:fixture', label: 'fixture-hk2', role: 'worker', data: snapshot, error: null, fetched_at_ms: now, latency_ms: 230 };
let workerRequestFails = false;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const results = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const assets = {
      '/npm/vue@3.4.21/dist/vue.global.prod.js': ['vue-3.4.21.global.prod.js', 'text/javascript'],
      '/npm/element-plus@2.9.1/dist/index.full.min.js': ['element-plus-2.9.1.full.min.js', 'text/javascript'],
      '/npm/element-plus@2.9.1/dist/index.css': ['element-plus-2.9.1.css', 'text/css'],
      '/npm/echarts@5.5.0/dist/echarts.min.js': ['echarts-5.5.0.min.js', 'text/javascript'],
    };
    if (assets[url.pathname]) {
      const [file, contentType] = assets[url.pathname];
      return route.fulfill({ status: 200, contentType, body: fs.readFileSync(path.join(admin, 'vendor', file)) });
    }
    if (url.hostname === 'monitor.test' && url.pathname === '/admin/') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (url.pathname === '/api/admin/hosts-status') {
      return route.fulfill({ json: { ok: true, hosts: [payload], ts: now, ttl_ms: 30000, cached: false } });
    }
    if (url.pathname === '/api/admin/worker-stats') {
      if (workerRequestFails) return route.fulfill({ status: 503, json: { ok: false, error: 'fixture request failed' } });
      return route.fulfill({ json: { ok: true, machines: [payload], machine: payload.data, capacity: payload.ok ? { max_jobs: 20, remaining: 17, active_total: 3 } : null, ts: now } });
    }
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { ok: true, role: 'admin', items: [], devices: [], env_allow: [], stats: { today_ok: 0, today_rejected: 0 } } });
    }
    return route.abort();
  });
  await page.goto('http://monitor.test/admin/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('kidshub_admin_token', 'fixture-only');
    const vm = window.monitorFixtureVm;
    vm.isLoggedIn = true;
    vm.currentUser.role = 'admin';
    vm.currentPage = 'worker';
    vm.asideCollapsed = true;
  });

  async function render(tab) {
    await page.evaluate(tab => {
      const vm = window.monitorFixtureVm;
      vm.khNav = tab;
      if (tab === 'servers') vm.loadHostsStatus(true);
      else vm.loadWorkerStats();
    }, tab);
    await page.waitForFunction(tab => !window.monitorFixtureVm[tab === 'servers' ? 'hostsStatus' : 'workerStats'].loading, tab);
    await page.evaluate(() => Vue.nextTick());
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.kh-card .el-tag')).every(el => getComputedStyle(el).opacity === '1'));
    return page.locator('.kh-card').filter({ hasText: 'fixture-hk2' }).first();
  }
  async function check(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: e.message }); }
  }

  await check('successful collection does not claim business health', async () => {
    const card = await render('servers');
    assert.match(await card.innerText(), /采集成功/);
    assert.match(await card.innerText(), /脚本 210 ms/);
  });
  payload = { ...payload, data: { ...snapshot, journal_cache: { state: 'fresh', collected_at_ms: now - 30000, max_age_s: 180, error: null } } };
  await check('fresh journal cache exposes its own update time on both monitoring pages', async () => {
    for (const tab of ['servers', 'devices']) {
      const card = await render(tab);
      assert.match(await card.innerText(), /日志统计更新于 .*秒前 · 每分钟更新/);
      assert.doesNotMatch(await card.innerText(), /日志统计已过期/);
    }
  });
  payload = { ...payload, data: { ...snapshot, errors: ['journal cache stale'], journal_cache: { state: 'stale', collected_at_ms: now - 600000, max_age_s: 180, error: null } } };
  await check('expired journal cache cannot look like fresh statistics on either page', async () => {
    for (const tab of ['servers', 'devices']) {
      const card = await render(tab);
      assert.match(await card.innerText(), /日志统计已过期/);
      assert.match(await card.innerText(), /上次更新 .*分钟前/);
      assert.match(await card.innerText(), /部分采集失败/);
      assert.doesNotMatch(await card.innerText(), /日志统计更新于/);
      assert.equal(await card.getByText(/日志统计已过期/).evaluate(el => getComputedStyle(el).color), 'rgb(232, 131, 58)');
    }
    await page.screenshot({ path: path.join(artifacts, 'stale-journal.png'), fullPage: true });
  });
  payload = { ...payload, data: { ...snapshot, errors: ['worker_link: journal timeout'], connections: { worker_links: [{ unit: 'voice-worker-rust', state: 'unknown' }] }, sidecars: [{ unit: 'voice-worker-rust', state: 'unknown', sock: '/tmp/fixture.sock', listening: true, unavailable_1h: null }] } };
  await check('partial collection is visible and unknown state stays unknown', async () => {
    const card = await render('servers');
    const text = await card.innerText();
    assert.match(text, /部分采集失败/);
    assert.match(text, /worker_link: journal timeout/);
    assert.match(text, /未确认/);
    assert.doesNotMatch(text, /正常/);
    await page.screenshot({ path: path.join(artifacts, 'partial.png'), fullPage: true });
  });
  await check('resource cards show partial collection instead of silently hiding warnings', async () => {
    const card = await render('devices');
    assert.match(await card.innerText(), /部分采集失败/);
    assert.match(await card.innerText(), /worker_link: journal timeout/);
  });
  payload = { ...payload, ok: false, data: null, error: 'SSH采集错误：' + '@'.repeat(500) };
  await check('failed collection is not presented as server unreachable', async () => {
    const card = await render('servers');
    assert.match(await card.innerText(), /采集失败/);
    assert.doesNotMatch(await card.innerText(), /不可达/);
    assert.equal(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  });
  await check('long SSH errors wrap inside resource cards', async () => {
    const card = await render('devices');
    assert.match(await card.innerText(), /采集失败/);
    assert.equal(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    assert.equal(await card.evaluate(el => el.clientHeight < 300), true, 'long diagnostics must not stretch every resource card');
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
  });
  payload = { ...payload, ok: true, data: snapshot, error: null };
  await check('request failure marks last resource results and hides stale capacity', async () => {
    await render('devices');
    const capacity = page.locator('.kh-card').filter({ hasText: '剩余可接入设备' }).first();
    assert.match(await capacity.innerText(), /在线 3 房/);
    workerRequestFails = true;
    await render('devices');
    const alerts = (await page.locator('.el-alert').allTextContents()).join('\n');
    assert.match(alerts, /上次采集结果/);
    assert.match(alerts, /fixture request failed/);
    assert.doesNotMatch(await capacity.innerText(), /在线 3 房/);
  });
  await check('full Vue template compiles without browser errors', async () => assert.deepEqual(errors, []));
  await browser.close();
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, artifacts }, null, 2));
  if (results.some(r => !r.ok)) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
