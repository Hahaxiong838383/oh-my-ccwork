import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

const DIST = './dist';
const PORT = 8765;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
};

const server = createServer((req, res) => {
  let filePath = join(DIST, req.url === '/' ? '/index.html' : req.url);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

server.listen(PORT, async () => {
  console.log(`Server at http://localhost:${PORT}`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  // Collect console messages for debugging
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text());
  });

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Force all animations to end state for static screenshots
  await page.evaluate(() => {
    // Kill loader
    const loader = document.getElementById('pageLoader');
    if (loader) loader.style.display = 'none';
    document.body.classList.add('loaded');

    // Force ALL elements to visible by injecting a style override
    const style = document.createElement('style');
    style.textContent = `
      .text-reveal-line, .text-reveal-block, .split-text,
      .product-card, .news-card, .timeline-item, .roadmap-bar,
      .split-char, .r4-big, .r4-small, .r4-desc, .btn-more,
      .section-title, .parallax-card, [data-animate] {
        opacity: 1 !important;
        transform: none !important;
        clip-path: none !important;
        visibility: visible !important;
      }
      .roadmap-bar {
        transform: scaleX(1) !important;
      }
    `;
    document.head.appendChild(style);
  });

  await page.waitForTimeout(500);

  // Scroll to top for hero
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './preview-hero.png' });
  console.log('Hero captured');

  // Section screenshots using section IDs
  const sections = [
    { id: 'about', name: 'about' },
    { id: 'products', name: 'showcase' },
    { selector: '.r3', name: 'products-swiper' },
    { id: 'innovation', name: 'tech-roadmap' },
    { id: 'timeline', name: 'timeline' },
    { selector: '.partner-section', name: 'partners' },
    { id: 'news', name: 'news' },
    { selector: '.r6', name: 'cta' },
    { id: 'contact', name: 'footer' },
  ];

  for (const sec of sections) {
    const scrolled = await page.evaluate((s) => {
      const el = s.id ? document.getElementById(s.id) : document.querySelector(s.selector);
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'start' });
        return true;
      }
      return false;
    }, sec);

    if (scrolled) {
      await page.waitForTimeout(600);
      // Force reveal again after scroll
      await page.evaluate(() => {
        document.querySelectorAll('.text-reveal-line, .text-reveal-block, .split-text, .product-card, .news-card, .timeline-item, .roadmap-bar').forEach(el => {
          el.style.opacity = '1';
          el.style.transform = 'none';
          el.style.clipPath = 'none';
        });
      });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `./preview-${sec.name}.png` });
      console.log(`${sec.name} captured`);
    } else {
      console.log(`${sec.name} NOT FOUND`);
    }
  }

  // Full page
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './preview-full.png', fullPage: true });
  console.log('Full page captured');

  await browser.close();
  server.close();
  console.log('Preview complete!');
});
