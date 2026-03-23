import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = './captures/cndagri';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

// 收集网络请求（CSS/JS/字体/图片）
const assets = [];
page.on('response', async (resp) => {
  const url = resp.url();
  const ct = resp.headers()['content-type'] || '';
  if (ct.includes('css') || ct.includes('javascript') || ct.includes('font') || url.match(/\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|mp4|ico)(\?|$)/i)) {
    assets.push({ url, contentType: ct, status: resp.status() });
  }
});

console.log('Loading cndagri.com...');
await page.goto('https://www.cndagri.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// 截图 - 全页
await page.screenshot({ path: `${OUT}/full-page.png`, fullPage: true });
console.log('Full page screenshot saved');

// 截图 - viewport
await page.screenshot({ path: `${OUT}/viewport.png` });

// 获取页面 HTML
const html = await page.content();
fs.writeFileSync(`${OUT}/page.html`, html);

// 获取所有 CSS
const styles = await page.evaluate(() => {
  const sheets = [];
  for (const sheet of document.styleSheets) {
    try {
      const rules = [];
      for (const rule of sheet.cssRules) {
        rules.push(rule.cssText);
      }
      sheets.push({ href: sheet.href, rules });
    } catch (e) {
      sheets.push({ href: sheet.href, error: 'CORS blocked' });
    }
  }
  return sheets;
});
fs.writeFileSync(`${OUT}/styles.json`, JSON.stringify(styles, null, 2));

// 分析页面结构
const structure = await page.evaluate(() => {
  function analyzeElement(el, depth = 0) {
    if (depth > 6) return null;
    const info = {
      tag: el.tagName?.toLowerCase(),
      id: el.id || undefined,
      classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : undefined,
      text: el.children?.length === 0 ? el.textContent?.trim().substring(0, 100) : undefined,
      style: el.getAttribute('style') || undefined,
      href: el.getAttribute('href') || undefined,
      src: el.getAttribute('src') || undefined,
      children: [],
    };
    for (const child of el.children || []) {
      const c = analyzeElement(child, depth + 1);
      if (c) info.children.push(c);
    }
    if (info.children.length === 0) delete info.children;
    return info;
  }
  return analyzeElement(document.body);
});
fs.writeFileSync(`${OUT}/structure.json`, JSON.stringify(structure, null, 2));

// 分析动效 - 找所有带 animation/transition 的元素
const animations = await page.evaluate(() => {
  const results = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const cs = getComputedStyle(el);
    const anim = cs.animation || cs.animationName;
    const trans = cs.transition;
    const transform = cs.transform;
    if ((anim && anim !== 'none') || (trans && trans !== 'all 0s ease 0s' && trans !== 'none')) {
      results.push({
        selector: el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).join('.') : ''),
        animation: anim !== 'none' ? anim : undefined,
        transition: trans !== 'all 0s ease 0s' ? trans : undefined,
        transform: transform !== 'none' ? transform : undefined,
        boundingBox: el.getBoundingClientRect().toJSON(),
      });
    }
  }
  return results;
});
fs.writeFileSync(`${OUT}/animations.json`, JSON.stringify(animations, null, 2));

// 分析各个 section
const sections = await page.evaluate(() => {
  const secs = [];
  // 找主要 section/div 区块
  const candidates = document.querySelectorAll('section, [class*="section"], [class*="banner"], [class*="swiper"], [class*="module"], header, footer, nav');
  for (const sec of candidates) {
    const rect = sec.getBoundingClientRect();
    secs.push({
      tag: sec.tagName.toLowerCase(),
      id: sec.id,
      classes: sec.className && typeof sec.className === 'string' ? sec.className : '',
      rect: { top: rect.top, height: rect.height, width: rect.width },
      childCount: sec.children.length,
      textPreview: sec.textContent?.trim().substring(0, 200),
    });
  }
  return secs;
});
fs.writeFileSync(`${OUT}/sections.json`, JSON.stringify(sections, null, 2));

// 滚动截图各区段
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
const viewportHeight = 1080;
let scrollY = 0;
let idx = 0;
while (scrollY < totalHeight) {
  await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/scroll-${idx}.png` });
  scrollY += viewportHeight;
  idx++;
}
console.log(`Captured ${idx} scroll screenshots`);

// 分析 Swiper/轮播
const swiperInfo = await page.evaluate(() => {
  const swipers = document.querySelectorAll('.swiper, .swiper-container, [class*="swiper"]');
  return Array.from(swipers).map(s => ({
    classes: s.className,
    slides: s.querySelectorAll('.swiper-slide').length,
    hasAutoplay: s.querySelector('[data-swiper-autoplay]') !== null,
    rect: s.getBoundingClientRect().toJSON(),
  }));
});
fs.writeFileSync(`${OUT}/swiper.json`, JSON.stringify(swiperInfo, null, 2));

// 保存 assets 列表
fs.writeFileSync(`${OUT}/assets.json`, JSON.stringify(assets, null, 2));

// 获取所有内联脚本（可能包含动效逻辑）
const scripts = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('script')).map(s => ({
    src: s.src || null,
    type: s.type || null,
    content: s.src ? null : s.textContent?.substring(0, 2000),
  }));
});
fs.writeFileSync(`${OUT}/scripts.json`, JSON.stringify(scripts, null, 2));

await browser.close();
console.log('cndagri.com scraping complete!');
