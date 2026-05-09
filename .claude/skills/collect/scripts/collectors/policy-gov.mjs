#!/usr/bin/env node
/**
 * 政策法规 RSS Collector
 * 数据源：工信部、商务部、发改委 等政府部门 RSS
 * 领域：HUD/汽车电子/智能网联相关政策
 *
 * 用法：
 *   node policy-gov.mjs                                          # 采集（默认 72h）
 *   node policy-gov.mjs --extract /path/to/policy-gov.json 3,8   # 按序号提取
 *   node policy-gov.mjs --index /path/to/policy-gov.json          # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'policy-gov';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 硬编码兜底：通过通用新闻源 + 关键词过滤获取政策信息
// 注：中国政府直接 RSS 已全面关闭，改用媒体报道间接获取
const FEEDS_FALLBACK = [
  { name: '36kr', url: 'https://36kr.com/feed', enabled: true },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
  { name: 'CnEVPost', url: 'https://cnevpost.com/feed/', enabled: true },
  { name: 'Electrek', url: 'https://electrek.co/feed/', enabled: true },
  { name: 'UN经济发展', url: 'https://news.un.org/feed/subscribe/zh/news/topic/economic-development/feed/rss.xml', enabled: true },
];

// 汽车/HUD/智能网联相关关键词过滤
const POLICY_KEYWORDS = [
  // 汽车行业（长短语优先）
  '汽车', '车联网', '智能网联', '自动驾驶', '新能源汽车', '电动汽车',
  'HUD', '抬头显示', 'AR导航', '智能座舱', '车载电子',
  // 电子/芯片
  '芯片', '半导体', '集成电路', '激光雷达',
  // 政策类型（需要汽车上下文的泛词已移除）
  '征求意见', '产业政策', '发展规划',
  // 行业监管
  '工信部', '数据安全', '网络安全',
  // 英文（避免短词子串误报）
  'automotive', 'autonomous driving', 'electric vehicle', 'ADAS',
];

function isPolicyRelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return POLICY_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
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
  lines.push(`### [policy-gov:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**来源**：${m.feedName || '-'} | **日期**：${item.pubDate || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  if (m.category) lines.push(`**分类**：${m.category}`);
  lines.push('');
  if (item.summary) {
    lines.push(item.summary);
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
      console.error('Usage: node policy-gov.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node policy-gov.mjs --index <json>');
      process.exit(1);
    }
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // ── 采集模式 ──
  // 政策类信息更新慢，窗口设为 72h
  const feeds = await loadActiveSources('policy-gov', FEEDS_FALLBACK);
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 72 });

  // 关键词过滤
  const filtered = items.filter(item => isPolicyRelated(item.title, item.summary));

  const metadata = {
    totalFetched: items.length,
    policyFiltered: filtered.length,
    feeds: feeds.map(f => f.name),
  };
  if (errors.length > 0) {
    metadata.errors = errors;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, filtered, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
