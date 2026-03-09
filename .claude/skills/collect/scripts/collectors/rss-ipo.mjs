#!/usr/bin/env node
/**
 * IPO 市场资讯 RSS Collector
 * 数据源：TechCrunch 创业/金融相关 RSS，过滤 IPO 关键词
 *
 * 用法：
 *   node rss-ipo.mjs                                           # 采集（默认 48h）
 *   node rss-ipo.mjs --extract /path/to/rss-ipo.json 3,8     # 按序号提取
 *   node rss-ipo.mjs --index /path/to/rss-ipo.json             # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'rss-ipo';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 硬编码兜底（sources.json 不存在时使用）
const FEEDS_FALLBACK = [
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
  { name: 'TechCrunch Startups', url: 'https://techcrunch.com/category/startups/feed/', enabled: true },
  { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/', enabled: true },
  { name: 'VentureBeat', url: 'https://venturebeat.com/feed/', enabled: true },
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

// 关键词过滤（用于筛选 IPO/融资/科技/AI/汽车/AR/MR 等相关内容）
const IPO_KEYWORDS = [
  // IPO/上市
  'IPO', 'ipo', '上市', '招股', '新股', '申购', '配售', '募资', '估值',
  '主板', '创业板', '科创板', '北交所', '港股', '美股', 'SPAC',
  'went public', 'public listing', 'debut', 'stock market',
  // 融资/投资
  'funding', 'raise', 'raised', 'venture', 'venture capital', 'VC',
  'investment', 'investor', 'round', 'series', 'valuation', 'unicorn',
  'acquisition', 'acqui', 'merge', 'M&A', 'deal',
  // 金融科技
  'fintech', 'financial', 'payments', 'crypto', 'blockchain',
  // AI/科技
  'artificial intelligence', 'AI', 'machine learning', 'deep learning', 'neural network',
  'LLM', 'GPT', 'Claude', 'OpenAI', 'Anthropic', 'Google DeepMind', 'Meta AI',
  'robotics', 'robot', 'autonomous', 'self-driving', '自动驾驶',
  // 汽车/出行
  'automotive', 'car', 'vehicle', 'EV', 'electric vehicle', 'Tesla', 'BYD',
  'mobility', 'ride-hailing', 'uber', 'lyft', 'didi',
  // AR/VR/MR
  'AR', 'VR', 'MR', 'augmented reality', 'virtual reality', 'mixed reality',
  'metaverse', 'headset', 'Apple Vision', 'Meta Quest', 'Hololens',
  // 硬件/芯片
  'chip', 'semiconductor', 'processor', 'GPU', 'NPU', 'ASIC', 'intel', 'nvidia', 'amd', 'qualcomm',
  // 消费电子
  'smartphone', 'mobile', 'tablet', 'wearable', 'smartwatch', 'drone'
];

function isIPORelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return IPO_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// 格式化摘要（截取前200字）
function truncateSummary(summary, maxLen = 200) {
  if (!summary) return '';
  // 去除HTML标签
  const plain = summary.replace(/<[^>]+>/g, '').trim();
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen) + '...';
}

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [rss-ipo:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**来源**：${m.feedName || '-'} | **日期**：${item.pubDate || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  if (item.summary) {
    lines.push(truncateSummary(item.summary, 300));
    lines.push('');
  }
  return lines.join('\n');
}

// ── --index 格式化 ──
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
      console.error('Usage: node rss-ipo.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node rss-ipo.mjs --index <json>');
      process.exit(1);
    }
    const { readFile } = await import('fs/promises');
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // 采集模式：优先从 sources.json 读取 active 源，找不到则用硬编码兜底
  const feeds = await loadActiveSources('rss-ipo', FEEDS_FALLBACK.filter(f => f.enabled !== false));
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 48 });

  // 过滤 IPO 相关内容
  const ipoItems = items.filter(item => isIPORelated(item.title, item.summary));

  const metadata = {
    totalFetched: items.length,
    ipoFiltered: ipoItems.length,
    feeds: feeds.map(f => f.name),
  };
  if (errors.length > 0) {
    metadata.errors = errors;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, ipoItems, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
