import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';

const OUT = './captures/futurus';
const IMG_OUT = './captures/futurus/images';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IMG_OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

// 收集所有图片 URL
const imageUrls = new Set();
page.on('response', async (resp) => {
  const url = resp.url();
  const ct = resp.headers()['content-type'] || '';
  if (ct.includes('image') || url.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i)) {
    imageUrls.add(url);
  }
});

console.log('Loading futurus.co...');
await page.goto('https://www.futurus.co/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// 截图
await page.screenshot({ path: `${OUT}/full-page.png`, fullPage: true });
await page.screenshot({ path: `${OUT}/viewport.png` });
console.log('Screenshots saved');

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
      text: el.children?.length === 0 ? el.textContent?.trim().substring(0, 200) : undefined,
      style: el.getAttribute('style') || undefined,
      href: el.getAttribute('href') || undefined,
      src: el.getAttribute('src') || undefined,
      'data-src': el.getAttribute('data-src') || undefined,
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

// 分析动效
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
      });
    }
  }
  return results;
});
fs.writeFileSync(`${OUT}/animations.json`, JSON.stringify(animations, null, 2));

// 分析各个 section
const sections = await page.evaluate(() => {
  const secs = [];
  const candidates = document.querySelectorAll('section, [class*="section"], [class*="banner"], [class*="swiper"], [class*="module"], [class*="block"], header, footer, nav');
  for (const sec of candidates) {
    const rect = sec.getBoundingClientRect();
    secs.push({
      tag: sec.tagName.toLowerCase(),
      id: sec.id,
      classes: sec.className && typeof sec.className === 'string' ? sec.className : '',
      rect: { top: rect.top, height: rect.height, width: rect.width },
      childCount: sec.children.length,
      textPreview: sec.textContent?.trim().substring(0, 300),
    });
  }
  return secs;
});
fs.writeFileSync(`${OUT}/sections.json`, JSON.stringify(sections, null, 2));

// 提取所有文案内容
const content = await page.evaluate(() => {
  const data = {
    title: document.title,
    meta: {},
    nav: [],
    sections: [],
    footer: null,
  };

  // Meta
  document.querySelectorAll('meta').forEach(m => {
    const name = m.getAttribute('name') || m.getAttribute('property');
    if (name) data.meta[name] = m.getAttribute('content');
  });

  // Nav links
  document.querySelectorAll('nav a, header a').forEach(a => {
    data.nav.push({ text: a.textContent?.trim(), href: a.getAttribute('href') });
  });

  // All text blocks
  document.querySelectorAll('h1, h2, h3, h4, h5, p, span, a, li, button').forEach(el => {
    const text = el.textContent?.trim();
    if (text && text.length > 2 && text.length < 500) {
      data.sections.push({
        tag: el.tagName.toLowerCase(),
        text,
        classes: el.className && typeof el.className === 'string' ? el.className : '',
        parent: el.parentElement?.className || '',
      });
    }
  });

  // Footer
  const footer = document.querySelector('footer');
  if (footer) data.footer = footer.innerHTML;

  return data;
});
fs.writeFileSync(`${OUT}/content.json`, JSON.stringify(content, null, 2));

// 提取所有图片 src
const images = await page.evaluate(() => {
  const imgs = [];
  document.querySelectorAll('img, video, source').forEach(el => {
    const src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('srcset');
    const poster = el.getAttribute('poster');
    if (src) imgs.push({ tag: el.tagName.toLowerCase(), src, alt: el.getAttribute('alt'), poster });
  });
  // background-image
  document.querySelectorAll('*').forEach(el => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url')) {
      imgs.push({ tag: el.tagName.toLowerCase(), backgroundImage: bg, classes: el.className });
    }
  });
  return imgs;
});
fs.writeFileSync(`${OUT}/images.json`, JSON.stringify(images, null, 2));

// 保存所有收集到的 image URLs
fs.writeFileSync(`${OUT}/image-urls.json`, JSON.stringify([...imageUrls], null, 2));

// 滚动截图
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
const viewportHeight = 1080;
let scrollY = 0;
let idx = 0;
while (scrollY < totalHeight) {
  await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/scroll-${idx}.png` });
  scrollY += viewportHeight;
  idx++;
}
console.log(`Captured ${idx} scroll screenshots`);

// 内联脚本
const scripts = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('script')).map(s => ({
    src: s.src || null,
    type: s.type || null,
    content: s.src ? null : s.textContent?.substring(0, 3000),
  }));
});
fs.writeFileSync(`${OUT}/scripts.json`, JSON.stringify(scripts, null, 2));

await browser.close();
console.log('futurus.co scraping complete!');
