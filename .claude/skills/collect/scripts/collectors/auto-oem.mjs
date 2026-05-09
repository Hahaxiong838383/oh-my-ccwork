#!/usr/bin/env node
/**
 * 主机厂资讯 RSS Collector
 * 数据源：特斯拉中国、蔚来、小鹏、理想、极氪、Electrek
 *
 * 用法：
 *   node auto-oem.mjs                                          # 采集（默认 48h）
 *   node auto-oem.mjs --extract /path/to/auto-oem.json 3,8    # 按序号提取
 *   node auto-oem.mjs --index /path/to/auto-oem.json          # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'auto-oem';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 注：中国微信公众号 RSS 代理已大面积失效，使用英文汽车媒体为主
const FEEDS_FALLBACK = [
  { name: 'CnEVPost', url: 'https://cnevpost.com/feed/', enabled: true },
  { name: 'Electrek', url: 'https://electrek.co/feed/', enabled: true },
  { name: '36kr', url: 'https://36kr.com/feed', enabled: true },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
];

// 车企品牌词 + 智能化关键词（移除"显示/屏幕/display"等泛词）
const OEM_KEYWORDS = [
  // 中国新势力品牌
  '蔚来', 'NIO', '小鹏', 'XPeng', 'XPENG', '理想', 'Li Auto',
  '极氪', 'ZEEKR', '零跑', 'Leapmotor', '哪吒', '智己',
  '问界', 'AITO', '鸿蒙智行',
  // 中国传统车企
  '比亚迪', 'BYD', '吉利', 'Geely', '长城', '长安', '奇瑞', 'Chery',
  // 国际品牌
  'Tesla', '特斯拉', 'Mercedes', '奔驰', 'BMW', '宝马',
  'Audi', '奥迪', 'Volkswagen', 'Toyota', 'Volvo', 'Porsche',
  // 智能化（具体短语，非泛词）
  'HUD', '抬头显示', 'AR-HUD', '智能座舱', 'OTA',
  '自动驾驶', 'autonomous driving', 'FSD', 'Autopilot',
  '城市NOA', '高阶智驾', 'ADAS',
];

function isOemRelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return OEM_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
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
  lines.push(`### [auto-oem:${idx}] ${item.title}`);
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
      console.error('Usage: node auto-oem.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node auto-oem.mjs --index <json>');
      process.exit(1);
    }
    const { readFile } = await import('fs/promises');
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // 采集模式：优先从 sources.json 读取 active 源，找不到则用硬编码兜底
  const feeds = await loadActiveSources('auto-oem', FEEDS_FALLBACK);
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 48 });

  // CnEVPost 是 EV 专业源直接保留，其他用关键词过滤
  const OEM_SPECIALIZED = ['CnEVPost'];
  const filtered = items.filter(item => {
    const feedName = item.meta?.feedName || '';
    if (OEM_SPECIALIZED.some(s => feedName.includes(s))) return true;
    return isOemRelated(item.title, item.summary);
  });

  const metadata = {
    feeds: feeds.map(f => f.name),
    oemFiltered: filtered.length,
  };
  if (errors.length > 0) {
    metadata.errors = errors;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, filtered, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
