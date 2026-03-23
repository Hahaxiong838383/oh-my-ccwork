/**
 * Download placeholder background images for FUTURUS website
 * Uses Unsplash CDN direct URLs (images.unsplash.com) which don't have anti-bot protection
 */
import https from 'https';
import fs from 'fs';
import path from 'path';

const OUT = '/Users/rayman.chen/mycc/2-Projects/futurus-rebuild/dist/img';
fs.mkdirSync(OUT, { recursive: true });

/**
 * Download file from URL, following redirects (up to 10 hops)
 */
function download(url, destPath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  -> Redirect to: ${res.headers.location.substring(0, 100)}...`);
        return download(res.headers.location, destPath, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close();
        const kb = (fs.statSync(destPath).size / 1024).toFixed(0);
        console.log(`  -> Saved: ${path.basename(destPath)} (${kb} KB)`);
        resolve();
      });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Unsplash image IDs mapped to filenames
// CDN URL format: https://images.unsplash.com/photo-{id}?w=1920&q=80&fm=jpg&fit=crop
const images = [
  {
    filename: 'banner-1.jpg',
    // Night city driving with car light trails - by Maxim Tolchinskiy
    id: 'Gqx9V1Vsr3M',
    desc: 'Night city driving / car trails',
  },
  {
    filename: 'banner-2.jpg',
    // Modern car interior with digital dashboard - by Александр Бендус
    id: 'DeYTBLR8nAQ',
    desc: 'Modern car digital dashboard',
  },
  {
    filename: 'banner-3.jpg',
    // Futuristic city skyline with digital network overlay
    id: 'ivXtIm4ZegE',
    desc: 'Futuristic city with digital overlay',
  },
  {
    filename: 'r2-bg.jpg',
    // Aerial view of a city at night - by Tahamie Farooqui
    id: 'yrRJ_FM1hHU',
    desc: 'Aerial city night view',
  },
  {
    filename: 'cta-bg.jpg',
    // Highway during golden hour - by David Boca
    id: 'tYh1DbJhB68',
    desc: 'Highway golden hour sunset',
  },
];

async function main() {
  console.log('=== FUTURUS Background Image Downloader ===');
  console.log(`Output: ${OUT}\n`);

  for (const img of images) {
    const destPath = path.join(OUT, img.filename);
    // Unsplash CDN URL format using photo ID
    const url = `https://images.unsplash.com/photo-${img.id}?w=1920&h=1080&q=80&fm=jpg&fit=crop&crop=entropy`;

    console.log(`[${img.filename}] ${img.desc}`);
    console.log(`  URL: ${url}`);

    try {
      await download(url, destPath);
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);

      // Fallback: try the /photos/{id}/download endpoint style
      const fallbackUrl = `https://unsplash.com/photos/${img.id}/download?w=1920`;
      console.log(`  Trying fallback: ${fallbackUrl}`);
      try {
        await download(fallbackUrl, destPath);
      } catch (err2) {
        console.log(`  Fallback also FAILED: ${err2.message}`);
      }
    }
  }

  // Summary
  console.log('\n=== Results ===');
  for (const img of images) {
    const fp = path.join(OUT, img.filename);
    if (fs.existsSync(fp)) {
      const kb = (fs.statSync(fp).size / 1024).toFixed(0);
      console.log(`  [OK] ${img.filename}: ${kb} KB`);
    } else {
      console.log(`  [MISSING] ${img.filename}`);
    }
  }
}

main().catch(console.error);
