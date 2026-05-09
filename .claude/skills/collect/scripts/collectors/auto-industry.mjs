#!/usr/bin/env node
/**
 * 汽车行业资讯 RSS Collector
 * 数据源：盖世汽车、汽车之家、36kr汽车、第一电动 等
 * 领域：HUD/智能座舱/自动驾驶/新能源汽车
 *
 * 用法：
 *   node auto-industry.mjs                                              # 采集（默认 48h）
 *   node auto-industry.mjs --extract /path/to/auto-industry.json 3,8    # 按序号提取
 *   node auto-industry.mjs --index /path/to/auto-industry.json           # 打印索引列表
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'auto-industry';
const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');

// 硬编码兜底
// 注：中国微信公众号 RSS 代理已大面积失效，保留可用源
const FEEDS_FALLBACK = [
  { name: '36kr汽车', url: 'https://36kr.com/feed', enabled: true },
  { name: 'CnEVPost', url: 'https://cnevpost.com/feed/', enabled: true },
  { name: 'Electrek', url: 'https://electrek.co/feed/', enabled: true },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
];

// 汽车/HUD/智能座舱相关关键词
const AUTO_KEYWORDS = [
  // HUD 核心
  'HUD', '抬头显示', 'AR-HUD', 'W-HUD', 'C-HUD', 'AR导航',
  '挡风玻璃', '风挡投影', '增强现实', 'DLP', 'LCoS', 'TFT',
  // 智能座舱
  '座舱', '智能座舱', '车机', '中控', '仪表', '液晶仪表',
  '车载显示', '多屏', '联屏', '曲面屏', 'OLED',
  // 自动驾驶/ADAS
  '自动驾驶', 'ADAS', 'L2', 'L3', 'L4', '辅助驾驶',
  '激光雷达', 'LiDAR', '毫米波', '摄像头', '传感器融合',
  // 智能网联
  '车联网', 'V2X', 'OTA', 'T-Box', '车路协同',
  // 新能源
  '新能源', '电动', 'EV', '混动', 'PHEV', '纯电',
  '充电', '换电', '固态电池', '动力电池',
  // 供应链/Tier 1
  '博世', '大陆', '电装', '华为', '比亚迪', '特斯拉',
  '蔚来', '小鹏', '理想', '极氪', '零跑', '哪吒',
  // 英文
  'autonomous', 'cockpit', 'dashboard', 'infotainment',
  'Tesla', 'BYD', 'NIO', 'XPeng', 'Li Auto',
];

function isAutoRelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return AUTO_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
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
  lines.push(`### [auto-industry:${idx}] ${item.title}`);
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
      console.error('Usage: node auto-industry.mjs --extract <json> <idx,idx,...|all>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node auto-industry.mjs --index <json>');
      process.exit(1);
    }
    const raw = await readFile(jsonPath, 'utf-8');
    printIndex(JSON.parse(raw));
    return;
  }

  // ── 采集模式 ──
  const feeds = await loadActiveSources('auto-industry', FEEDS_FALLBACK);
  const { items, errors } = await fetchFeeds(feeds, { hoursBack: 48 });

  // CnEVPost 是汽车专业源直接保留，其他通用源需要关键词过滤
  const AUTO_SPECIALIZED = ['CnEVPost'];
  const filtered = items.filter(item => {
    const feedName = item.meta?.feedName || '';
    if (AUTO_SPECIALIZED.some(s => feedName.includes(s))) return true;
    return isAutoRelated(item.title, item.summary);
  });

  const metadata = {
    totalFetched: items.length,
    autoFiltered: filtered.length,
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
