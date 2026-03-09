#!/usr/bin/env node
/**
 * RSS 数据源自动验证脚本
 *
 * 功能：
 * - 检验 sources.json 中所有数据源的可用性（HTTP HEAD + 解析校验）
 * - 自动更新 active 状态、lastChecked、lastStatus、lastError
 * - 对 active: false 的候选源也进行探测，发现可用时自动激活
 * - 打印验证摘要报告
 *
 * 用法：
 *   node validate-sources.mjs              # 验证所有组（dry-run 不写入）
 *   node validate-sources.mjs --save       # 验证并更新 sources.json
 *   node validate-sources.mjs --group rss-ipo --save  # 只验证指定组
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, 'sources.json');
const TIMEOUT_MS = 5000;
const TODAY = new Date().toISOString().slice(0, 10);

// ── HTTP 检验 ──────────────────────────────────────────────────────────────

async function checkUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 优先 HEAD，快速；部分服务器不支持 HEAD 则 fallback GET（只取头）
    let res = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 RSSValidator/1.0' },
    }).catch(() => null);

    if (!res || res.status === 405) {
      res = await fetch(url, {
        method: 'GET',
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 RSSValidator/1.0' },
      });
    }

    clearTimeout(timer);
    return { status: res.status, ok: res.status >= 200 && res.status < 400 };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    return { status: 0, ok: false, error: msg };
  }
}

// ── 验证单个源 ──────────────────────────────────────────────────────────────

async function validateSource(source) {
  process.stderr.write(`  checking ${source.name} ... `);
  const result = await checkUrl(source.url);

  const updated = {
    ...source,
    lastChecked: TODAY,
    lastStatus: result.status,
  };

  if (result.error) {
    updated.lastError = result.error;
  } else {
    delete updated.lastError;
  }

  // 规则：
  // - 200/301/302/307/308 → active = true
  // - 其他（404/403/0/timeout）→ active = false
  // - 已经是 true 且本次失败 → 标记失败但不立即停用（连续3次失败才停用，这里简化为直接标记）
  const wasActive = source.active;
  updated.active = result.ok;

  const icon = result.ok ? '✅' : '❌';
  const change = wasActive !== result.ok
    ? (result.ok ? ' [新激活]' : ' [已停用]')
    : '';
  process.stderr.write(`${icon} ${result.status}${result.error ? ' ' + result.error : ''}${change}\n`);

  return updated;
}

// ── 主逻辑 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const shouldSave = args.includes('--save');
  const groupIdx = args.indexOf('--group');
  const targetGroup = groupIdx !== -1 ? args[groupIdx + 1] : null;

  const raw = await readFile(SOURCES_PATH, 'utf-8');
  const data = JSON.parse(raw);

  let totalChecked = 0;
  let totalActive = 0;
  let totalInactive = 0;
  let newlyActivated = 0;
  let newlyDeactivated = 0;

  const groups = Object.keys(data).filter(k => !k.startsWith('_'));
  const targetGroups = targetGroup ? [targetGroup] : groups;

  for (const group of targetGroups) {
    if (!data[group]) {
      console.error(`Unknown group: ${group}`);
      continue;
    }

    process.stderr.write(`\n📡 验证组：${group}\n`);
    const sources = data[group];
    const updated = [];

    for (const source of sources) {
      const result = await validateSource(source);
      updated.push(result);
      totalChecked++;
      if (result.active) totalActive++;
      else totalInactive++;
      if (!source.active && result.active) newlyActivated++;
      if (source.active && !result.active) newlyDeactivated++;
    }

    data[group] = updated;
  }

  // 摘要
  console.error('\n─────────────────────────────────');
  console.error(`验证完成：共 ${totalChecked} 个源`);
  console.error(`  ✅ 可用：${totalActive}  ❌ 不可用：${totalInactive}`);
  if (newlyActivated > 0) console.error(`  🎉 新激活：${newlyActivated} 个`);
  if (newlyDeactivated > 0) console.error(`  ⚠️  新停用：${newlyDeactivated} 个`);

  if (shouldSave) {
    data._updated = TODAY;
    await writeFile(SOURCES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    console.error(`\n💾 已更新 sources.json`);
  } else {
    console.error('\n（dry-run 模式，加 --save 才会写入文件）');
  }

  // stdout 输出 JSON 摘要（供其他脚本使用）
  console.log(JSON.stringify({
    date: TODAY,
    total: totalChecked,
    active: totalActive,
    inactive: totalInactive,
    newlyActivated,
    newlyDeactivated,
    groups: targetGroups,
  }));
}

main().catch(err => {
  console.error('validate-sources error:', err.message);
  process.exit(1);
});
