#!/usr/bin/env node
/**
 * P4 mini E2E：验证 focus running → rewarding → reward openingBox → focus idle 完整链路
 *
 * 步骤：
 *  1. 跳到 focusRunning（focusMachine=running, mode=explore）
 *  2. DebugBar 点"一键满进度"（setFocusProgress(100)）
 *  3. 等 hook tick → dispatch FOCUS_REWARD_READY → focusMachine = 'rewarding' + rewardMachine = 'openingBox'
 *  4. 截图："rewarding" 状态：08-handoff.png 静止 + OpenBox overlay 浮上
 *  5. 等 ~10s（rare 宝箱 OPEN_ANIM=2.5s + REWARD_SHOWN=2.5s + askMode auto 直到 done）
 *     - 或直接通过 store __APP_STORE__ 强 trigger ECO_CHECK
 *  6. 验证 focusMachine 最终回 'idle'，焦点回 MainScreen
 *
 * 用法：node apps/web/scripts/p4-reward-handoff-test.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', '.scratch', 'p4-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const URL = process.env.E2E_URL ?? 'https://localhost:5173/';
const VIEWPORT = { width: 412, height: 915 };

function readStore(page) {
  return page.evaluate(() => {
    const w = window;
    const s = w.__APP_STORE__?.getState?.();
    return s
      ? {
          focusMachine: s.focusMachine,
          rewardMachine: s.rewardMachine,
          focusProgress: s.focusProgress,
          focusStage: s.focusStage,
          focusMode: s.focusMode,
          currentBoxLevel: s.currentBoxLevel,
          familyCoin: s.familyCoin,
          stardust: s.stardust,
        }
      : null;
  });
}

async function shot(page, name) {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path });
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
      const loc = msg.location();
      const sourceUrl = loc?.url ?? '';
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
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? '?'})`);
  });

  console.log(`\n=== P4 reward handoff E2E · ${URL} ===\n`);

  await page.goto(URL);
  await page.waitForLoadState('networkidle');

  // 1. 完成配网 + 跳到 focusRunning
  await page.click('button:has-text("✅ 完成配网")');
  await page.waitForTimeout(500);
  await page.selectOption('select[aria-label="跳关选择"]', 'focusRunning');
  await page.waitForTimeout(500);
  await shot(page, '01-focus-running');
  let s = await readStore(page);
  console.log('  step1 focusRunning:', s);

  // 2. 一键满进度（按钮显示在 DebugBar，仅 running 时）
  await page.click('button:has-text("⏩ 一键满进度")');
  await page.waitForTimeout(1500);  // 等 hook tick (1s) + dispatch FOCUS_REWARD_READY + reward OPEN_BOX
  s = await readStore(page);
  console.log('  step2 after 一键满进度:', s);
  await shot(page, '02-after-quick-full');

  // 3. 等 reward openingBox 完整动画（rare=2.5s）+ showingReward(2.5s) + ECO_CHECK auto
  await page.waitForTimeout(7000);
  s = await readStore(page);
  console.log('  step3 after 7s wait:', s);
  await shot(page, '03-after-reward-flow');

  // 4. reward 走到 askMode 后用户点（模拟自动）
  const askPickBtn = page.locator('button:has-text("继续出航"), button:has-text("返舱")').first();
  if (await askPickBtn.count() > 0) {
    await askPickBtn.click();
    console.log('  step4 ASK_PICK clicked');
    await page.waitForTimeout(1000);
    s = await readStore(page);
    console.log('  step4 after ASK_PICK:', s);
    await shot(page, '04-after-ask-pick');
  } else {
    console.log('  step4 no askMode button found, waiting for timeout...');
    await page.waitForTimeout(5000);
    s = await readStore(page);
    console.log('  step4 after timeout:', s);
    await shot(page, '04-after-timeout');
  }

  // 5. 最终验证：focusMachine 应该回 idle
  await page.waitForTimeout(1500);
  s = await readStore(page);
  console.log('  final:', s);
  await shot(page, '05-final-state');

  const pass =
    s.focusMachine === 'idle' &&
    s.focusProgress === 0 &&
    s.focusMode === null &&
    errors.length === 0 &&
    failed404s.length === 0;

  console.log(`\n=== ${pass ? '✅ PASS' : '❌ FAIL'} ===`);
  if (errors.length > 0) console.log('错误:', errors);
  if (failed404s.length > 0) console.log('404 URLs:', failed404s);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('p4 test crashed:', err);
  process.exit(2);
});
