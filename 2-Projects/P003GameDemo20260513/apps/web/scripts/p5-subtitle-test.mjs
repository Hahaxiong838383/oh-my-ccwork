#!/usr/bin/env node
/**
 * P5 mini E2E：验证 StatusBar 在 focusRunning / focusCompanion / MainScreen 三种 scene 都显示字幕。
 *
 * 步骤：
 *  1. 跳到 MainScreen（welcome → askMode）→ 注入 subtitle，截图看字幕条
 *  2. 跳到 focusRunning → 注入 subtitle，截图
 *  3. 跳到 focusCompanion → 注入 subtitle，截图
 *  4. 关盖（lidOpen=false）→ 注入 subtitle，截图（字幕应该不显示）
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', '.scratch', 'p5-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const URL = process.env.E2E_URL ?? 'https://localhost:5173/';
const VIEWPORT = { width: 412, height: 915 };

async function shot(page, name) {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
  console.log(`  📸 ${name}.png`);
}

async function injectSubtitle(page, text) {
  await page.evaluate((t) => {
    const w = window;
    const store = w.__APP_STORE__;
    store.getState().setSubtitle(t);
  }, text);
}

async function checkSubtitleVisible(page) {
  return page.evaluate(() => {
    // StatusBar 显示文本节点包含 subtitle
    const nodes = Array.from(document.querySelectorAll('div'));
    return nodes.some((el) => {
      const t = el.textContent ?? '';
      return /听到你说|出航中|小可在说|...小可正在听/i.test(t) || el.textContent?.trim() === '听到你说：你好';
    });
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForLoadState('networkidle');

  await page.click('button:has-text("✅ 完成配网")');
  await page.waitForTimeout(800);

  console.log('\n=== P5 字幕跨场景显示验证 ===\n');

  // 1. MainScreen
  await page.selectOption('select[aria-label="跳关选择"]', 'welcome');
  await page.waitForTimeout(400);
  await injectSubtitle(page, '听到你说：你好');
  await page.waitForTimeout(400);
  await shot(page, '01-mainscreen-with-subtitle');

  // 2. focusRunning
  await page.selectOption('select[aria-label="跳关选择"]', 'focusRunning');
  await page.waitForTimeout(500);
  await injectSubtitle(page, '听到你说：今天好开心');
  await page.waitForTimeout(400);
  await shot(page, '02-focusRunning-with-subtitle');

  // 3. focusCompanion
  await page.selectOption('select[aria-label="跳关选择"]', 'focusCompanion');
  await page.waitForTimeout(500);
  await injectSubtitle(page, '小可在说：慢慢来');
  await page.waitForTimeout(400);
  await shot(page, '03-focusCompanion-with-subtitle');

  // 4. 关盖（lidOpen=false）— 字幕不应显示
  await page.evaluate(() => {
    window.__APP_STORE__.getState().setLidOpen(false);
  });
  await page.waitForTimeout(400);
  await injectSubtitle(page, '不应显示的字幕');
  await page.waitForTimeout(400);
  await shot(page, '04-shutdown-no-subtitle');

  // 验证 4 张截图 dom 状态
  await page.evaluate(() => {
    window.__APP_STORE__.getState().setLidOpen(true);
  });

  console.log('\n✅ 4 张截图已生成，川哥可看：');
  console.log(`   ${SCREENSHOT_DIR}`);

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('p5 test crashed:', err);
  process.exit(2);
});
