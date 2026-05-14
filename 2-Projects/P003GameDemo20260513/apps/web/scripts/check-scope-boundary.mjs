#!/usr/bin/env node
/**
 * check-scope-boundary.mjs —— V0.6 画内/画外铁律静态检查
 *
 * codex 评审建议：纯靠 review 不够，需要 AST 扫描。
 * 规则：FORBIDDEN_IN_CANVAS 列出的组件，禁止出现在
 * 标记了 data-scope="screen-canvas" 的 JSX 子树内。
 *
 * 实现策略：用栈式 div 计数器跟踪嵌套层级，子树范围 = 当前 div 关闭前。
 * 不依赖 babel-parser，正则 + 状态机够 demo 用。
 *
 * 使用：pnpm prebuild 自动跑，违反 = build fail (exit 1)。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

const FORBIDDEN_IN_CANVAS = new Set([
  'DebugBar',
  'VoiceButton',
  'PowerButton',
  'LEDIndicator',
  'MicrophoneVent',
]);

const errors = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (/\.(tsx|jsx)$/.test(entry)) {
      check(full);
    }
  }
}

function check(filePath) {
  const code = readFileSync(filePath, 'utf8');
  const startIdx = code.indexOf('data-scope="screen-canvas"');
  if (startIdx === -1) return;

  // 找到 data-scope 标记所在 div 的开始 `<` 位置
  const openLt = code.lastIndexOf('<', startIdx);
  if (openLt === -1) return;

  const subtree = extractElementSubtree(code, openLt);
  if (!subtree) return;

  for (const name of FORBIDDEN_IN_CANVAS) {
    const tagRegex = new RegExp(`<${name}[\\s/>]`, 'g');
    if (tagRegex.test(subtree)) {
      errors.push({ file: relative(SRC_ROOT, filePath), component: name });
    }
  }
}

/**
 * 从 startIdx (字符 < 位置) 开始，提取该 JSX 元素整个子树字符串。
 * 用 tag 栈跟踪嵌套，遇到对应闭合 tag 即收尾。
 * 只处理 div（因为 data-scope 标记肯定在 div 上）。
 */
function extractElementSubtree(code, startIdx) {
  // 检查起始是 <div
  if (!/^<div[\s>]/.test(code.slice(startIdx, startIdx + 5))) return null;

  let depth = 0;
  let i = startIdx;
  while (i < code.length) {
    const remaining = code.slice(i);
    // 自闭合 <div .../>
    const selfClose = remaining.match(/^<div\b[^>]*\/>/);
    if (selfClose && depth === 0) {
      return selfClose[0];
    }
    // 开标签 <div ...>
    const openMatch = remaining.match(/^<div\b[^>]*>/);
    if (openMatch) {
      depth++;
      i += openMatch[0].length;
      continue;
    }
    // 闭标签 </div>
    if (remaining.startsWith('</div>')) {
      depth--;
      i += '</div>'.length;
      if (depth === 0) {
        return code.slice(startIdx, i);
      }
      continue;
    }
    i++;
  }
  return null;
}

walk(SRC_ROOT);

if (errors.length > 0) {
  console.error('\n[check-scope-boundary] 违反画内/画外铁律：\n');
  for (const err of errors) {
    console.error(`  ✗ ${err.file}: 不能在 screen-canvas 子树内使用 <${err.component}>`);
  }
  console.error(
    '\n规则：data-scope="screen-canvas" 标记的容器内禁止出现模拟器/调试控件。',
  );
  console.error('  → 把这些组件移到设备外壳的下沿条或调试区。\n');
  process.exit(1);
}

console.log('[check-scope-boundary] ✓ 画内/画外铁律通过');
