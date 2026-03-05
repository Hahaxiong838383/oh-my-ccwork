#!/usr/bin/env node
/**
 * AI 前沿资讯 RSS Collector
 * 数据源：Ben's Bites、MIT科技评论中文 等 AI 相关 RSS
 *
 * 用法：
 *   node rss-ai.mjs                                           # 采集（默认 48h）
 *   node rss-ai.mjs --extract /path/to/rss-ai.json 3,8        # 按序号提取
 *   node rss-ai.mjs --index /path/to/rss-ai.json              # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'rss-ai';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 硬编码兜底
const FEEDS_FALLBACK = [
  { name: "Ben's Bites", url: 'https://www.bensbites.com/feed', enabled: true },
  { name: 'MIT科技评论中文', url: 'https://plink.anyfeeder.com/mittrchina/hot', enabled: true },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', enabled: true },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index/', enabled: true },
  { name: '新智元', url: 'https://plink.anyfeeder.com/weixin/AI_era', enabled: true },
];

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
  lines.push(`### [rss-ai:${idx}] ${item.title}`);
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
      console.error('Usage: node rss-ai.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node rss-ai.mjs --index <json>');
      process.exit(1);
    }
    const { readFile } = await import('fs/promises');
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // 采集模式：优先从 sources.json 读取 active 源，找不到则用硬编码兜底
  const feeds = await loadActiveSources('rss-ai', FEEDS_FALLBACK);
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 48 });

  const metadata = {
    feeds: feeds.map(f => f.name),
  };
  if (errors.length > 0) {
    metadata.errors = errors;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, items, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
