#!/usr/bin/env node
/**
 * e2e-flow-test.mjs —— P003 V0.6 端到端流程自动验收
 *
 * cc 主线交付验收脚本（不让川哥当人肉测试机）：
 *   1. 自动打开 dev server 页面
 *   2. 模拟点 [✅完成配网] → 等待 Welcome → NightReport → AskMode 自动推进
 *   3. 截图每个阶段
 *   4. 检查 React Hook 错误 / 渲染异常 / 状态机 transition 日志
 *   5. 跳关下拉条覆盖测试 10 个剧情节点
 *   6. 输出验收报告
 *
 * 用法：node apps/web/scripts/e2e-flow-test.mjs [--url=http://localhost:5173]
 * 依赖：playwright（在 /tmp/node_modules）
 */

import pkg from '/tmp/node_modules/playwright/index.js';
const { chromium } = pkg;
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', '.scratch', 'e2e-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const URL = process.env.E2E_URL ?? 'https://localhost:5173/';
const VIEWPORT = { width: 412, height: 915 };

const errors = [];
const transitions = [];
const sfxEvents = [];

function recordConsole(msg) {
  const text = msg.text();
  if (msg.type() === 'error') {
    // 过滤无害噪音：react-devtools 提示 + PWA dev 静态资源 404（白名单收窄，避免吞掉真 API 404）
    const sourceUrl = msg.location()?.url ?? '';
    const isStaticNoise =
      text.includes('Failed to load resource') &&
      /favicon\.ico|apple-touch-icon|icon-\d+x\d+\.png|robots\.txt/i.test(sourceUrl);
    const isNoise = text.includes('react-devtools') || isStaticNoise;
    if (!isNoise) errors.push(`${text} [src=${sourceUrl}]`);
  }
  if (text.includes('[boot]') || text.includes('[focus]') || text.includes('[reward]')) {
    transitions.push(text.replace(/^.*?\[/, '['));
  }
  if (text.includes('[sfx]') || text.includes('[jumpToScene]') || text.includes('[timer]')) {
    sfxEvents.push(text);
  }
}

async function step(page, name, action, delayMs) {
  if (action) await action();
  if (delayMs) await page.waitForTimeout(delayMs);
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path });
  console.log(`  📸 ${name}.png`);
  return path;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', recordConsole);
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const failed404s = [];
  page.on('response', (resp) => {
    if (resp.status() === 404) failed404s.push(resp.url());
  });

  console.log(`\n=== P003 E2E 验收 · ${URL} ===\n`);

  await page.goto(URL);
  await page.waitForLoadState('networkidle');

  // A. 配网流程
  console.log('A. 配网流程');
  await step(page, 'a01-init-setupguide', null, 500);
  await step(page, 'a02-after-setup', async () => {
    await page.click('button:has-text("✅ 完成配网")');
  }, 800);
  await step(page, 'a03-welcome-2s', null, 1500);
  await step(page, 'a04-nightreport-5s', null, 2500);
  await step(page, 'a05-askmode-12s', null, 6500);

  // B. 跳关下拉条全 11 项
  console.log('\nB. 跳关下拉条全 11 项');
  const scenes = [
    'welcome', 'nightReport', 'askMode', 'focusRunning',
    'focusCompanion', 'boxCommon', 'boxRare', 'boxEpic', 'boxLegendary',
    'ecoUnlock', 'farewell',
  ];
  for (const scene of scenes) {
    await step(page, `b-${scene}`, async () => {
      await page.selectOption('select[aria-label="跳关选择"]', scene);
    }, 800);
  }

  // C. 键盘快捷键 1-9/0/f
  console.log('\nC. 键盘快捷键 1-9/0/f');
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'f']) {
    await step(page, `c-key-${key}`, async () => {
      await page.keyboard.press(key);
    }, 500);
  }

  // C2. 状态机收敛：askMode → 选"探索" → focusMachine 进 launching → 4s 后 running → 点"返舱" → confirmExit → 点"确定" → familyCoin +10
  console.log('\nC2. 状态机收敛验证（boot askMode → focusMachine → familyCoin）');
  await page.selectOption('select[aria-label="跳关选择"]', 'askMode');
  await page.waitForTimeout(400);
  const focusBefore = await page.evaluate(() => {
    const w = window;
    return w.__APP_STORE__?.getState?.().focusMachine ?? 'unknown';
  });

  await page.click('button:has-text("探索")');
  await page.waitForTimeout(300);
  const focusAfterPick = await page.evaluate(() => {
    return window.__APP_STORE__?.getState?.().focusMachine ?? 'unknown';
  });
  await step(page, 'c2-after-pick-explore', null, 0);

  // 等 LAUNCH_ANIM_END timer fire（focus-machine.ts LAUNCH_ANIM_MS = 2500ms）
  await page.waitForTimeout(2800);
  const focusAfterLaunch = await page.evaluate(() => {
    return window.__APP_STORE__?.getState?.().focusMachine ?? 'unknown';
  });
  await step(page, 'c2-after-launch-anim', null, 0);

  // 点返舱
  const returnBtn = page.locator('button:has-text("返舱")');
  let confirmStateShown = false;
  let familyCoinAdded = false;
  if (await returnBtn.count() > 0) {
    const familyCoinBefore = await page.evaluate(() => {
      return window.__APP_STORE__?.getState?.().familyCoin ?? 0;
    });
    await returnBtn.click();
    await page.waitForTimeout(300);
    const focusAfterRequest = await page.evaluate(() => {
      return window.__APP_STORE__?.getState?.().focusMachine ?? 'unknown';
    });
    confirmStateShown = focusAfterRequest === 'confirmExit';
    await step(page, 'c2-confirm-exit', null, 0);

    if (confirmStateShown) {
      await page.click('button:has-text("确定")');
      await page.waitForTimeout(300);
      const familyCoinAfter = await page.evaluate(() => {
        return window.__APP_STORE__?.getState?.().familyCoin ?? 0;
      });
      familyCoinAdded = familyCoinAfter - familyCoinBefore === 10;
      await step(page, 'c2-after-confirm', null, 0);
    }
  }

  console.log(`  focusMachine before pick: ${focusBefore}`);
  console.log(`  focusMachine after pick:  ${focusAfterPick} (期望: launching)`);
  console.log(`  focusMachine after 2.8s:  ${focusAfterLaunch} (期望: running)`);
  console.log(`  confirmExit shown:        ${confirmStateShown}`);
  console.log(`  familyCoin +10 added:     ${familyCoinAdded}`);

  const c2Pass =
    focusAfterPick === 'launching' &&
    focusAfterLaunch === 'running' &&
    confirmStateShown &&
    familyCoinAdded;
  if (!c2Pass) errors.push(`C2 状态机收敛断言失败：pick=${focusAfterPick} launch=${focusAfterLaunch} confirm=${confirmStateShown} coin=${familyCoinAdded}`);

  // C3. SettingsButton 占位反馈：点击应弹 Tip（跳到 focusRunning 避免 Welcome 全屏 overlay 拦截）
  console.log('\nC3. SettingsButton 占位反馈');
  await page.selectOption('select[aria-label="跳关选择"]', 'focusRunning');
  await page.waitForTimeout(400);
  const settingsBtn = page.locator('button[aria-label="设置"]');
  let settingsTipShown = false;
  if (await settingsBtn.count() > 0) {
    await settingsBtn.click();
    await page.waitForTimeout(300);
    settingsTipShown = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('div')).some((el) =>
        el.textContent?.includes('设置面板开发中'),
      );
    });
    await step(page, 'c3-settings-tip', null, 0);
  }
  console.log(`  settings 占位 Tip 显示: ${settingsTipShown}`);
  if (!settingsTipShown) errors.push('C3 SettingsButton 点击未弹 Tip（死按钮回归）');

  // C4. D3 场景多时点截图：OpenBox/EcoUnlock/Farewell 看完整动画
  console.log('\nC4. D3 三场景动画多时点截图');
  for (const level of ['common', 'rare', 'epic', 'legendary']) {
    const sceneId = `box${level[0].toUpperCase()}${level.slice(1)}`;
    await page.selectOption('select[aria-label="跳关选择"]', sceneId);
    await page.waitForTimeout(300);
    await step(page, `c4-${level}-t0`, null, 0);          // 进入开箱
    await page.waitForTimeout(1500);
    await step(page, `c4-${level}-t1`, null, 0);          // 1.8s（震屏中段）
    // openAnim: common 2s / rare 2.5s / epic 3s / legendary 4s
    await page.waitForTimeout(1500);
    await step(page, `c4-${level}-t2`, null, 0);          // 3.3s（reward HUD）
    await page.waitForTimeout(2500);
    await step(page, `c4-${level}-t3`, null, 0);          // 5.8s（ecoUnlock 或 askMode）
  }

  await page.selectOption('select[aria-label="跳关选择"]', 'ecoUnlock');
  for (const [t, dur] of [['t0', 500], ['t1', 1500], ['t2', 1500], ['t3', 500]]) {
    await page.waitForTimeout(dur);
    await step(page, `c4-eco-${t}`, null, 0);
  }

  await page.selectOption('select[aria-label="跳关选择"]', 'farewell');
  await step(page, 'c4-farewell-waving', null, 800);   // waving 中段
  await page.waitForTimeout(1000);                      // → shutdown
  await step(page, 'c4-farewell-shutdown-t0', null, 0); // shutdown 进入瞬间
  await page.waitForTimeout(800);
  await step(page, 'c4-farewell-shutdown-t1', null, 0); // slogan 显著时点（duration 1.8s 内）
  const farewellFinal = await page.evaluate(() => {
    return window.__APP_STORE__?.getState?.().farewellState;
  });
  console.log(`  farewell 最终 state: ${farewellFinal}`);
  if (farewellFinal !== 'shutdown') errors.push(`farewell 未进入 shutdown: ${farewellFinal}`);

  // D. 按住说话按钮（mock 阶段）
  console.log('\nD. VoiceButton 交互（mock）');
  await page.keyboard.press('1');
  await page.waitForTimeout(1000);
  const voiceBtn = page.locator('button[aria-label="按住说话"]');
  await step(page, 'd01-press-voice', async () => {
    await voiceBtn.dispatchEvent('pointerdown');
  }, 600);
  await step(page, 'd02-release-voice', async () => {
    await voiceBtn.dispatchEvent('pointerup');
  }, 2000);

  await browser.close();

  // === 验收报告 ===
  console.log('\n=== 验收报告 ===\n');
  console.log(`截图：${SCREENSHOT_DIR}`);
  console.log(`\n状态机 transitions (${transitions.length}):`);
  transitions.forEach((t) => console.log('  ' + t));

  console.log(`\nSFX/timer events (${sfxEvents.length}):`);
  sfxEvents.slice(0, 10).forEach((e) => console.log('  ' + e));

  console.log(`\n📦 404 资源 (${failed404s.length}):`);
  failed404s.forEach((u) => console.log('  ' + u));

  console.log(`\n❌ 错误 (${errors.length}):`);
  errors.forEach((e) => console.log('  ' + e.slice(0, 200)));

  // 验收门
  const passed = errors.length === 0 && transitions.length > 0;
  console.log(`\n=== ${passed ? '✅ PASS' : '❌ FAIL'} ===`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e-flow-test crashed:', err);
  process.exit(2);
});
