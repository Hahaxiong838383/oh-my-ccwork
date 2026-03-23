import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const PORT = 8766;
const DIST_DIR = path.resolve('dist');
const OUT_DIR = path.resolve('our-screenshots');

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

// 1. Start HTTP server
const server = http.createServer((req, res) => {
  let filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, async () => {
  console.log(`HTTP server running on http://localhost:${PORT}`);

  let browser;
  try {
    // 2. Launch browser
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });

    // 3. Navigate and wait
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    console.log('Page loaded, waiting 3 seconds...');
    await page.waitForTimeout(3000);

    // 4. Inject styles to force all animated elements visible
    await page.evaluate(() => {
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
        .roadmap-bar { transform: scaleX(1) !important; }
        .page-loader { display: none !important; }
      `;
      document.head.appendChild(style);
      document.body.classList.add('loaded');
    });
    console.log('Injected visibility styles');

    // Wait a bit for styles to take effect
    await page.waitForTimeout(500);

    // 5. Scroll and screenshot
    const totalHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = 900;
    const scrolls = Math.ceil(totalHeight / viewportHeight);

    console.log(`Total page height: ${totalHeight}px, viewport: ${viewportHeight}px, screenshots: ${scrolls}`);

    for (let i = 0; i < scrolls; i++) {
      const scrollY = i * viewportHeight;
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      await page.waitForTimeout(300);

      // Re-inject styles after scroll (some animations may trigger on scroll)
      await page.evaluate(() => {
        const existingForce = document.getElementById('force-visible');
        if (!existingForce) {
          const style = document.createElement('style');
          style.id = 'force-visible';
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
            .roadmap-bar { transform: scaleX(1) !important; }
            .page-loader { display: none !important; }
          `;
          document.head.appendChild(style);
        }
      });

      const filePath = path.join(OUT_DIR, `our-scroll-${i}.png`);
      await page.screenshot({ path: filePath });
      console.log(`Saved: our-scroll-${i}.png (scrollY: ${scrollY}px)`);
    }

    console.log(`\nDone! ${scrolls} screenshots saved to ${OUT_DIR}`);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    // 6. Cleanup
    if (browser) await browser.close();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  }
});
