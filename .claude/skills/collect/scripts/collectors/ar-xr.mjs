#!/usr/bin/env node
/**
 * HUD 竞品资讯 RSS Collector
 * 数据源：锐思华创、华阳集团、怡利电子、泽景电子 等
 *
 * 用法：
 *   node hud-competitors.mjs                                                # 采集（默认 72h）
 *   node hud-competitors.mjs --extract /path/to/hud-competitors.json 3,8   # 按序号提取
 *   node hud-competitors.mjs --index /path/to/hud-competitors.json          # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'ar-xr';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 注：中国微信公众号 RSS 代理（anyfeeder）已大面积失效
// 改用通用汽车科技媒体 + HUD 关键词精准过滤
const FEEDS_FALLBACK = [
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', enabled: true },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', enabled: true },
  { name: 'Road to VR', url: 'https://www.roadtovr.com/feed/', enabled: true },
  { name: 'UploadVR', url: 'https://uploadvr.com/feed/', enabled: true },
];

// HUD/AR/车载显示 精准关键词（删除 AR 等超短词避免误报）
const HUD_KEYWORDS = [
  'AR光学', '空间计算', 'LiDAR', '全息显示', 'Micro-LED',
  '光波导', '脑机接口', 'Apple Vision Pro', 'Meta Quest',
  'spatial computing', 'waveguide', 'holographic', 'mixed reality', 'XR headset',
];

function isHudRelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return HUD_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

async function loadActiveSources(group, fallback) {
  try {
    const raw = await readFile(SOURCES_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const sources = data[group];
    if (!Array.isArray(sources) || sources.length === 0) return fallback;
    const active = sources.filter(s => s.active).map(s => ({ name: s.name, url: s.url, enabled: true }));
    return active.length > 0 ? active : fallback;
  } catch {
    return fallback;
  }
}

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [hud-competitors:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**来源**：${m.feedName || '-'} | **日期**：${item.pubDate || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  if (item.summary) {
    lines.push(item.summary);
    lines.push('');
  }
  return lines.join('\n');
}

// ── --index 格式化（可选模式，快速浏览所有条目） ──
function printIndex(data) {
  const items = data.items || [];
  console.log(`## ${SOURCE_NAME} 索引（共 ${items.length} 条）\n`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const feedName = item.meta?.feedName || '-';
    const date = item.pubDate ? item.pubDate.slice(0, 10) : '-';
    console.log(`[${i}] [${feedName}] ${item.title} (${date})`);
  }
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) {
      console.error('Usage: node hud-competitors.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node hud-competitors.mjs --index <json>');
      process.exit(1);
    }
    const { readFile } = await import('fs/promises');
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // 采集模式：优先从 sources.json 读取 active 源，找不到则用硬编码兜底
  const feeds = await loadActiveSources('hud-competitors', FEEDS_FALLBACK);
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 72 });

  // 全部源都用关键词过滤（当前无专业源）
  const filtered = items.filter(item => isHudRelated(item.title, item.summary));

  const metadata = {
    feeds: feeds.map(f => f.name),
    hudFiltered: filtered.length,
  };
  if (errors.length > 0) {
    metadata.errors = errors;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, filtered, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
