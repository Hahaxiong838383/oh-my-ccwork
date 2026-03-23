import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/Users/rayman.chen/mycc/2-Projects/futurus-rebuild/ref-screenshots';
const URL = 'https://www.cndagri.com/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('=== 正在访问页面 ===');
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('页面加载完成，等待3秒...');
  await page.waitForTimeout(3000);

  // ========== 1. 逐屏截图 ==========
  console.log('\n=== 逐屏截图 ===');
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  console.log(`页面总高度: ${totalHeight}px, 视口高度: ${viewportHeight}px`);

  let scrollY = 0;
  let idx = 0;
  const maxScreenshots = 15; // safety limit

  while (scrollY < totalHeight && idx < maxScreenshots) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(800); // wait for animations
    const filepath = path.join(SCREENSHOT_DIR, `ref-scroll-${idx}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`截图: ref-scroll-${idx}.png (scrollY=${scrollY})`);
    scrollY += viewportHeight;
    idx++;
  }
  // 确保最后一屏也截到
  if (scrollY > totalHeight) {
    await page.evaluate((y) => window.scrollTo(0, y), totalHeight - viewportHeight);
    await page.waitForTimeout(500);
    const filepath = path.join(SCREENSHOT_DIR, `ref-scroll-${idx}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`截图: ref-scroll-${idx}.png (bottom)`);
  }

  // 也截一张全页面截图
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ref-fullpage.png'), fullPage: true });
  console.log('全页面截图: ref-fullpage.png');

  // ========== 2. 提取 CSS 动画 ==========
  console.log('\n=== CSS 动画 (@keyframes) ===');
  const keyframes = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule) {
            let content = '';
            for (const kf of rule.cssRules) {
              content += `  ${kf.keyText} { ${kf.cssText} }\n`;
            }
            results.push({ name: rule.name, content: rule.cssText });
          }
        }
      } catch (e) { /* cross-origin */ }
    }
    return results;
  });
  for (const kf of keyframes) {
    console.log(`\n@keyframes ${kf.name}:`);
    console.log(kf.content.substring(0, 500));
  }

  // ========== 3. Transition 属性 ==========
  console.log('\n=== Transition 属性 ===');
  const transitions = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.style && rule.style.transition) {
            results.push({ selector: rule.selectorText, transition: rule.style.transition });
          }
          // 也查嵌套规则
          if (rule.cssRules) {
            for (const sub of rule.cssRules) {
              if (sub.style && sub.style.transition) {
                results.push({ selector: sub.selectorText, transition: sub.style.transition });
              }
            }
          }
        }
      } catch (e) { }
    }
    return results;
  });
  for (const t of transitions) {
    console.log(`${t.selector}: transition: ${t.transition}`);
  }

  // ========== 4. Transform 元素 ==========
  console.log('\n=== Transform 元素 ===');
  const transforms = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.transform && cs.transform !== 'none') {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? `.${String(el.className).split(' ').join('.')}` : '';
        const id = el.id ? `#${el.id}` : '';
        results.push({ element: `${tag}${id}${cls}`, transform: cs.transform });
      }
    }
    return results.slice(0, 100); // limit
  });
  for (const t of transforms) {
    console.log(`${t.element}: transform: ${t.transform}`);
  }

  // ========== 5. Swiper/轮播配置 ==========
  console.log('\n=== Swiper/轮播配置 ===');
  const swiperInfo = await page.evaluate(() => {
    const results = [];
    // 检查 Swiper 实例
    if (typeof Swiper !== 'undefined') {
      results.push('Swiper library found');
    }
    // 找 .swiper 容器
    const swipers = document.querySelectorAll('.swiper, .swiper-container, [class*="swiper"], [class*="carousel"], [class*="slider"]');
    for (const s of swipers) {
      results.push({
        element: s.tagName + (s.className ? '.' + String(s.className).split(' ').join('.') : ''),
        slides: s.querySelectorAll('.swiper-slide, [class*="slide"]').length,
        html: s.outerHTML.substring(0, 500),
      });
    }
    // 检查全局 Swiper 实例
    const swiperInstances = document.querySelectorAll('.swiper');
    for (const si of swiperInstances) {
      if (si.swiper) {
        results.push({
          config: {
            autoplay: si.swiper.params?.autoplay,
            loop: si.swiper.params?.loop,
            speed: si.swiper.params?.speed,
            slidesPerView: si.swiper.params?.slidesPerView,
            spaceBetween: si.swiper.params?.spaceBetween,
            effect: si.swiper.params?.effect,
            direction: si.swiper.params?.direction,
          }
        });
      }
    }
    return results;
  });
  console.log(JSON.stringify(swiperInfo, null, 2));

  // ========== 6. 背景图片 URL ==========
  console.log('\n=== 背景图片 URL ===');
  const bgImages = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? String(el.className).split(' ').slice(0, 3).join('.') : '';
        results.push({ element: `${tag}.${cls}`, backgroundImage: cs.backgroundImage });
      }
    }
    return results;
  });
  for (const bg of bgImages) {
    console.log(`${bg.element}: ${bg.backgroundImage.substring(0, 200)}`);
  }

  // ========== 7. Hover 效果 ==========
  console.log('\n=== Hover 效果 CSS 规则 ===');
  const hoverRules = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes(':hover')) {
            results.push({ selector: rule.selectorText, css: rule.cssText.substring(0, 300) });
          }
          if (rule.cssRules) {
            for (const sub of rule.cssRules) {
              if (sub.selectorText && sub.selectorText.includes(':hover')) {
                results.push({ selector: sub.selectorText, css: sub.cssText.substring(0, 300) });
              }
            }
          }
        }
      } catch (e) { }
    }
    return results;
  });
  for (const h of hoverRules) {
    console.log(`${h.selector}:`);
    console.log(`  ${h.css}`);
  }

  // ========== 8. Section 尺寸 ==========
  console.log('\n=== 页面各 Section 的尺寸 ===');
  const sections = await page.evaluate(() => {
    const results = [];
    const sels = document.querySelectorAll('section, [class*="section"], header, footer, nav, [class*="banner"], [class*="hero"], main, [class*="wrapper"], [class*="block"]');
    for (const el of sels) {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const cls = el.className ? String(el.className).split(' ').slice(0, 3).join('.') : '';
      results.push({
        element: `${tag}.${cls}`,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        padding: cs.padding,
        margin: cs.margin,
        top: Math.round(rect.top + window.scrollY),
      });
    }
    return results;
  });
  for (const s of sections) {
    console.log(`${s.element}: ${s.width}x${s.height} | padding: ${s.padding} | margin: ${s.margin} | top: ${s.top}px`);
  }

  // ========== 9. 导航栏 HTML ==========
  console.log('\n=== 导航栏 HTML 结构 ===');
  const navHTML = await page.evaluate(() => {
    const nav = document.querySelector('nav, header, [class*="nav"], [class*="header"]');
    return nav ? nav.outerHTML : 'Not found';
  });
  console.log(navHTML.substring(0, 3000));

  // ========== 10. Banner 区结构 ==========
  console.log('\n=== Banner 区结构 ===');
  const bannerInfo = await page.evaluate(() => {
    const banner = document.querySelector('[class*="banner"], [class*="hero"], [class*="slider"], .swiper:first-of-type, section:first-of-type');
    if (!banner) return 'Not found';
    return {
      html: banner.outerHTML.substring(0, 3000),
      rect: banner.getBoundingClientRect(),
    };
  });
  console.log(typeof bannerInfo === 'string' ? bannerInfo : bannerInfo.html);

  // ========== 11. 渐变色值 ==========
  console.log('\n=== 渐变色值 ===');
  const gradients = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          const text = rule.cssText || '';
          const matches = text.match(/(?:linear|radial|conic)-gradient\([^)]+\)/g);
          if (matches) {
            for (const m of matches) {
              results.push({ selector: rule.selectorText, gradient: m });
            }
          }
          if (rule.cssRules) {
            for (const sub of rule.cssRules) {
              const subText = sub.cssText || '';
              const subMatches = subText.match(/(?:linear|radial|conic)-gradient\([^)]+\)/g);
              if (subMatches) {
                for (const m of subMatches) {
                  results.push({ selector: sub.selectorText, gradient: m });
                }
              }
            }
          }
        }
      } catch (e) { }
    }
    // 也从计算样式中获取
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? String(el.className).split(' ').slice(0, 2).join('.') : '';
        results.push({ selector: `computed:${tag}.${cls}`, gradient: cs.backgroundImage.substring(0, 300) });
      }
    }
    return results;
  });
  for (const g of gradients) {
    console.log(`${g.selector}: ${g.gradient}`);
  }

  // ========== 12. 波浪分隔线 SVG/CSS ==========
  console.log('\n=== 波浪分隔线 SVG/CSS ===');
  const waves = await page.evaluate(() => {
    const results = [];
    // SVG waves
    const svgs = document.querySelectorAll('svg');
    for (const svg of svgs) {
      const paths = svg.querySelectorAll('path');
      for (const p of paths) {
        const d = p.getAttribute('d') || '';
        if (d.toLowerCase().includes('c') || d.toLowerCase().includes('q') || d.toLowerCase().includes('s')) {
          results.push({ type: 'svg', html: svg.outerHTML.substring(0, 500) });
          break;
        }
      }
    }
    // CSS clip-path waves
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.clipPath && cs.clipPath !== 'none') {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? String(el.className).split(' ').slice(0, 2).join('.') : '';
        results.push({ type: 'clip-path', element: `${tag}.${cls}`, clipPath: cs.clipPath });
      }
    }
    // 查找伪元素中的波浪
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          const text = rule.cssText || '';
          if (text.includes('wave') || text.includes('clip-path') || text.includes('polygon')) {
            results.push({ type: 'css-rule', selector: rule.selectorText, css: text.substring(0, 500) });
          }
        }
      } catch (e) { }
    }
    return results;
  });
  console.log(JSON.stringify(waves, null, 2));

  // ========== 13. 数据区块 clip-path ==========
  console.log('\n=== 数据区块 clip-path / 三角形 ===');
  const clipPaths = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.clipPath && cs.clipPath !== 'none') {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? String(el.className).split(' ').slice(0, 3).join('.') : '';
        const rect = el.getBoundingClientRect();
        results.push({
          element: `${tag}.${cls}`,
          clipPath: cs.clipPath,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
      // 也检查 CSS border-based triangles
      if ((cs.borderTopWidth !== '0px' || cs.borderBottomWidth !== '0px') &&
          (cs.borderLeftColor === 'transparent' || cs.borderRightColor === 'transparent')) {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? String(el.className).split(' ').slice(0, 3).join('.') : '';
        results.push({
          element: `${tag}.${cls}`,
          type: 'border-triangle',
          borderTop: cs.borderTop,
          borderBottom: cs.borderBottom,
          borderLeft: cs.borderLeft,
          borderRight: cs.borderRight,
        });
      }
    }
    return results;
  });
  console.log(JSON.stringify(clipPaths, null, 2));

  // ========== 14. 合作伙伴跑马灯 ==========
  console.log('\n=== 合作伙伴跑马灯 ===');
  const marquee = await page.evaluate(() => {
    const results = [];
    // 找跑马灯元素
    const els = document.querySelectorAll('[class*="partner"], [class*="marquee"], [class*="scroll"], [class*="brand"], [class*="client"], [class*="logo-list"], [class*="cooperat"]');
    for (const el of els) {
      const cs = getComputedStyle(el);
      results.push({
        element: el.tagName + '.' + String(el.className).split(' ').slice(0, 3).join('.'),
        animation: cs.animation,
        animationDuration: cs.animationDuration,
        overflow: cs.overflow,
        html: el.outerHTML.substring(0, 2000),
      });
    }
    // 检查 marquee 标签
    const marquees = document.querySelectorAll('marquee');
    for (const m of marquees) {
      results.push({
        element: 'marquee',
        scrollAmount: m.scrollAmount,
        direction: m.direction,
        html: m.outerHTML.substring(0, 1000),
      });
    }
    return results;
  });
  console.log(JSON.stringify(marquee, null, 2));

  // ========== 15. 时间线/路线图 ==========
  console.log('\n=== 时间线/路线图 ===');
  const timeline = await page.evaluate(() => {
    const results = [];
    const els = document.querySelectorAll('[class*="timeline"], [class*="roadmap"], [class*="history"], [class*="milestone"], [class*="process"], [class*="step"]');
    for (const el of els) {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      results.push({
        element: el.tagName + '.' + String(el.className).split(' ').slice(0, 3).join('.'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        html: el.outerHTML.substring(0, 2000),
      });
    }
    return results;
  });
  console.log(JSON.stringify(timeline, null, 2));

  // ========== 16. Footer 结构 ==========
  console.log('\n=== Footer 详细结构 ===');
  const footerHTML = await page.evaluate(() => {
    const footer = document.querySelector('footer, [class*="footer"]');
    if (!footer) return 'Not found';
    const cs = getComputedStyle(footer);
    return {
      html: footer.outerHTML.substring(0, 5000),
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      padding: cs.padding,
      height: footer.getBoundingClientRect().height,
    };
  });
  console.log(typeof footerHTML === 'string' ? footerHTML : JSON.stringify(footerHTML, null, 2));

  // ========== 17. 提取所有外部样式表内容 ==========
  console.log('\n=== 外部样式表 URLs ===');
  const styleUrls = await page.evaluate(() => {
    const urls = [];
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      urls.push(link.href);
    }
    return urls;
  });
  for (const u of styleUrls) {
    console.log(u);
  }

  // ========== 18. 所有 <script> 标签 ==========
  console.log('\n=== Script 标签 ===');
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  });
  for (const s of scripts) {
    console.log(s);
  }

  // ========== 19. 字体信息 ==========
  console.log('\n=== 字体信息 ===');
  const fonts = await page.evaluate(() => {
    const results = new Set();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.fontFamily) results.add(cs.fontFamily);
    }
    return [...results];
  });
  for (const f of fonts) {
    console.log(f);
  }

  // ========== 20. 颜色方案 ==========
  console.log('\n=== 主要颜色方案 ===');
  const colors = await page.evaluate(() => {
    const colorMap = {};
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const c = cs.color;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        colorMap[bg] = (colorMap[bg] || 0) + 1;
      }
      if (c) {
        colorMap[c] = (colorMap[c] || 0) + 1;
      }
    }
    return Object.entries(colorMap).sort((a, b) => b[1] - a[1]).slice(0, 30);
  });
  for (const [color, count] of colors) {
    console.log(`${color}: 使用 ${count} 次`);
  }

  // ========== 21. 完整页面 DOM 结构概览 ==========
  console.log('\n=== 页面 DOM 结构概览 ===');
  const domStructure = await page.evaluate(() => {
    function getStructure(el, depth = 0) {
      if (depth > 3) return '';
      const tag = el.tagName?.toLowerCase();
      if (!tag) return '';
      const cls = el.className ? ` class="${String(el.className).split(' ').slice(0, 4).join(' ')}"` : '';
      const id = el.id ? ` id="${el.id}"` : '';
      let result = '  '.repeat(depth) + `<${tag}${id}${cls}>\n`;
      for (const child of el.children) {
        result += getStructure(child, depth + 1);
      }
      return result;
    }
    return getStructure(document.body);
  });
  console.log(domStructure.substring(0, 5000));

  // ========== 22. 内联样式中的完整 CSS ==========
  console.log('\n=== 内联 <style> 标签内容 ===');
  const inlineStyles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n---\n');
  });
  console.log(inlineStyles.substring(0, 10000));

  await browser.close();
  console.log('\n=== 抓取完成 ===');
}

main().catch(console.error);
