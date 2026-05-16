#!/usr/bin/env node
/**
 * P9 mini E2E：4 等级生态缸视频切换截图
 *
 * 步骤：
 *  1. 跳到 askMode（确保 idle）
 *  2. setEcoLevel(1) + jumpToScene('ecoUnlock') → 等视频开播 + 截图
 *  3. 同样测 Lv2/3/4
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', '.scratch', 'p9-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const URL = process.env.E2E_URL ?? 'https://localhost:5173/';
const VIEWPORT = { width: 412, height: 915 };

async function shot(page, name) {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
  console.log(`  📸 ${name}.png`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const sourceUrl = msg.location()?.url ?? '';
      const isStaticNoise =
        msg.text().includes('Failed to load resource') &&
        /favicon\.ico|apple-touch-icon|icon-\d+x\d+\.png|robots\.txt/i.test(sourceUrl);
      if (!isStaticNoise) errors.push(`${msg.text()} [src=${sourceUrl}]`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const failed404s = [];
  page.on('response', (resp) => {
    if (resp.status() === 404) failed404s.push(resp.url());
  });

  console.log(`\n=== P9 生态缸 4 等级视频切换验证 ===\n`);

  await page.goto(URL);
  await page.waitForLoadState('networkidle');
  await page.click('button:has-text("✅ 完成配网")');
  await page.waitForTimeout(800);

  for (const lv of [1, 2, 3, 4]) {
    await page.evaluate((n) => {
      window.__APP_STORE__.getState().setEcoLevel(n);
    }, lv);
    await page.selectOption('select[aria-label="跳关选择"]', 'ecoUnlock');
    await page.waitForTimeout(2500);  // 等 video 加载 + 播放 + phase>=2 标题"Lv N 解锁"显示
    await shot(page, `eco-lv${lv}`);
    const state = await page.evaluate(() => {
      const s = window.__APP_STORE__.getState();
      return { ecoLevel: s.ecoLevel, rewardMachine: s.rewardMachine };
    });
    console.log(`  Lv${lv}: store=${JSON.stringify(state)}`);
  }

  const pass = errors.length === 0 && failed404s.length === 0;
  console.log(`\n=== ${pass ? '✅ PASS' : '❌ FAIL'} ===`);
  if (errors.length > 0) console.log('错误:', errors);
  if (failed404s.length > 0) console.log('404:', failed404s);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('p9 test crashed:', err);
  process.exit(2);
});
