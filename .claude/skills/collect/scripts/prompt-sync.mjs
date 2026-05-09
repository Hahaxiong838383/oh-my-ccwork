#!/usr/bin/env node
/**
 * prompt-sync.mjs — Futurus prompt compiler (v2, post-codex-review)
 *
 * --compile   : fetch 飞书 → extract Runtime Prompt → validate → write versions/
 * --activate  : latest compiled version → write current/ + update index.json
 * --rollback --version <ver> : rollback to specified version
 */

import { readFile, writeFile, mkdir, readdir, copyFile, rename } from 'fs/promises';
import { execFile } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { existsSync } from 'fs';

const PROMPTS_DIR = process.env.PROMPTS_DIR || '/root/.hermes/context/futurus/prompts';
const LARK_CLI = process.env.LARK_CLI_PATH || 'lark-cli';
const LOG_PATH = join(PROMPTS_DIR, 'sync.log');
const LOCK_PATH = join(PROMPTS_DIR, '.sync.lock');

const AGENTS = {
  analyze: {
    doc_token: 'RY7gdvATUoGZxVxAMFwchjjHnSy',
    max_tokens: 4000,
    required_vars: ['{CURATED_DATA}', '{STRATEGY_ANCHOR}'],
  },
  report: {
    doc_token: 'XTMTdbUFLo2NqbxRZicce3cInme',
    max_tokens: 2000,
    required_vars: ['{CURATED_DATA}'],
  },
};

const REQUIRED_SECTIONS = ['角色定义', '输出格式', '约束条件'];
const FORBIDDEN_PATTERNS = [
  /api[_\s-]?key/i,
  /192\.168\.\d+\.\d+/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /127\.0\.0\.\d+/,
  /localhost/i,
  /\.env(\.\w+)?\b/,
  /密钥|secret|password|token(?!s?\s*(预算|budget|estimate|估))/i,
];

// ── Helpers ──

function now() {
  return new Date().toISOString();
}

function ts() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function sha6(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 6);
}

async function log(msg) {
  const line = `${now()} ${msg}\n`;
  process.stderr.write(line);
  try {
    const existing = existsSync(LOG_PATH) ? await readFile(LOG_PATH, 'utf-8') : '';
    await writeFile(LOG_PATH, existing + line, 'utf-8');
  } catch { /* best effort */ }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// ── File Lock ──

async function acquireLock() {
  const lockData = JSON.stringify({ pid: process.pid, ts: Date.now() });
  try {
    await writeFile(LOCK_PATH, lockData, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      let staleMs = Infinity;
      let existingPid = 'unknown';
      try {
        const raw = await readFile(LOCK_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        staleMs = Date.now() - (parsed.ts || 0);
        existingPid = parsed.pid || 'unknown';
      } catch { staleMs = Infinity; } // can't parse → treat as stale
      if (staleMs > 300000) { // 5 min = definitely stale
        await log(`[lock] Stale lock detected (${Math.round(staleMs / 1000)}s old), forcing acquire`);
        await writeFile(LOCK_PATH, lockData);
        return true;
      }
      throw new Error(`Another sync process (PID ${existingPid}) is running (${Math.round(staleMs / 1000)}s ago)`);
    }
    throw err;
  }
}

async function releaseLock() {
  const { unlink } = await import('fs/promises');
  try { await unlink(LOCK_PATH); } catch { /* ok */ }
}

// ── Fetch ──

async function fetchDoc(docToken) {
  const raw = await runCmd(LARK_CLI, [
    'docs', '+fetch', '--as', 'user', '--doc', docToken, '--format', 'json',
  ]);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`Feishu fetch failed: ${JSON.stringify(parsed)}`);
  return parsed.data.markdown;
}

// ── Extract (code-block-aware from start) ──

function extractRuntimePrompt(markdown) {
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) inCodeBlock = !inCodeBlock;
    if (!inCodeBlock && /^## Runtime Prompt\s*$/.test(lines[i])) {
      startLine = i + 1;
      break;
    }
  }

  if (startLine === -1) return null;

  inCodeBlock = false;
  let endLine = lines.length;
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].startsWith('```')) inCodeBlock = !inCodeBlock;
    if (!inCodeBlock && /^## [^#]/.test(lines[i])) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join('\n').trim();
}

// ── Validate ──

function validate(content, agentName) {
  const cfg = AGENTS[agentName];
  const errors = [];

  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`###\\s*${section}`, 'm');
    if (!pattern.test(content)) {
      errors.push(`missing required section: ### ${section}`);
    }
  }

  const tokenEstimate = Math.ceil(content.length * 0.7);
  if (tokenEstimate > cfg.max_tokens) {
    errors.push(`token estimate ${tokenEstimate} exceeds limit ${cfg.max_tokens}`);
  }

  if (content.trim().length < 50) {
    errors.push('content too short (< 50 chars)');
  }

  for (const pat of FORBIDDEN_PATTERNS) {
    const match = content.match(pat);
    if (match) {
      errors.push(`forbidden pattern found: "${match[0]}"`);
    }
  }

  for (const v of cfg.required_vars) {
    if (!content.includes(v)) {
      errors.push(`missing template variable: ${v}`);
    }
  }

  return errors;
}

// ── Index ──

async function loadIndex() {
  const p = join(PROMPTS_DIR, 'index.json');
  try {
    return JSON.parse(await readFile(p, 'utf-8'));
  } catch {
    return { agents: {}, last_compile: null, last_activate: null };
  }
}

async function saveIndex(index) {
  const p = join(PROMPTS_DIR, 'index.json');
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await rename(tmp, p);
}

// ── Ensure all directories exist upfront ──

async function ensureDirs() {
  await mkdir(join(PROMPTS_DIR, 'source'), { recursive: true });
  await mkdir(join(PROMPTS_DIR, 'current'), { recursive: true });
  for (const name of Object.keys(AGENTS)) {
    await mkdir(join(PROMPTS_DIR, 'versions', name), { recursive: true });
  }
}

// ── Commands ──

async function compile() {
  await log('[compile] Starting');
  await acquireLock();
  try {
    await ensureDirs();
    const index = await loadIndex();
    const staged = [];

    for (const [name, cfg] of Object.entries(AGENTS)) {
      await log(`[compile] Fetching ${name} from feishu doc ${cfg.doc_token}`);
      const markdown = await fetchDoc(cfg.doc_token);

      await log(`[compile] Extracting Runtime Prompt for ${name}`);
      const content = extractRuntimePrompt(markdown);
      if (!content) {
        throw new Error(`[${name}] No "## Runtime Prompt" section found in document`);
      }

      await log(`[compile] Validating ${name}`);
      const errors = validate(content, name);
      if (errors.length > 0) {
        throw new Error(`[${name}] Validation failed:\n  - ${errors.join('\n  - ')}`);
      }

      const timestamp = ts();
      const hash = sha6(content);
      const versionId = `${timestamp}-${hash}`;
      const tokenEstimate = Math.ceil(content.length * 0.7);

      staged.push({ name, markdown, content, versionId, tokenEstimate });
    }

    const results = {};
    for (const { name, markdown, content, versionId, tokenEstimate } of staged) {
      const versionPath = join(PROMPTS_DIR, 'versions', name, `${versionId}.md`);
      await writeFile(versionPath, content, 'utf-8');

      const sourcePath = join(PROMPTS_DIR, 'source', `agent_${name}.source.md`);
      await writeFile(sourcePath, markdown, 'utf-8');

      if (!index.agents[name]) index.agents[name] = {};
      index.agents[name].latest_compiled = versionId;
      index.agents[name].compiled_at = now();

      results[name] = { version: versionId, tokens: tokenEstimate, path: versionPath };
      await log(`[compile] ${name} compiled: ${versionId} (~${tokenEstimate} tokens)`);
    }

    index.last_compile = now();
    await saveIndex(index);

    await log('[compile] Done');
    console.log(JSON.stringify({ status: 'compiled', agents: results }, null, 2));
  } finally {
    await releaseLock();
  }
}

async function activate() {
  await log('[activate] Starting');
  await acquireLock();
  try {
    await ensureDirs();
    const index = await loadIndex();

    const prepared = [];
    for (const [name] of Object.entries(AGENTS)) {
      const latest = index.agents?.[name]?.latest_compiled;
      if (!latest) {
        throw new Error(`[${name}] No compiled version found. Run --compile first.`);
      }
      const versionPath = join(PROMPTS_DIR, 'versions', name, `${latest}.md`);
      if (!existsSync(versionPath)) {
        throw new Error(`[${name}] Version file not found: ${versionPath}`);
      }
      const currentPath = join(PROMPTS_DIR, 'current', `agent_${name}.md`);
      const tmpPath = `${currentPath}.tmp-${process.pid}`;
      await copyFile(versionPath, tmpPath);
      prepared.push({ name, latest, tmpPath, currentPath });
    }

    for (const { name, latest, tmpPath, currentPath } of prepared) {
      await rename(tmpPath, currentPath);
      const prev = index.agents[name].active_version;
      index.agents[name].active_version = latest;
      index.agents[name].activated_at = now();
      index.agents[name].previous_version = prev || null;
      await log(`[activate] ${name}: ${prev || 'none'} → ${latest}`);
    }

    index.last_activate = now();
    await saveIndex(index);

    await log('[activate] Done');
    console.log(JSON.stringify({ status: 'activated', index }, null, 2));
  } finally {
    await releaseLock();
  }
}

async function rollback(targetVersion) {
  await log(`[rollback] Rolling back to version: ${targetVersion}`);
  await acquireLock();
  try {
    await ensureDirs();
    const index = await loadIndex();

    const prepared = [];
    for (const [name] of Object.entries(AGENTS)) {
      const versionDir = join(PROMPTS_DIR, 'versions', name);
      const candidates = await readdir(versionDir).catch(() => []);
      const match = candidates.find(f => f.startsWith(targetVersion));
      if (!match) {
        throw new Error(`[${name}] Version ${targetVersion} not found in ${versionDir}`);
      }
      const versionPath = join(versionDir, match);
      const currentPath = join(PROMPTS_DIR, 'current', `agent_${name}.md`);
      const tmpPath = `${currentPath}.tmp-${process.pid}`;
      await copyFile(versionPath, tmpPath);
      prepared.push({ name, match, tmpPath, currentPath });
    }

    for (const { name, match, tmpPath, currentPath } of prepared) {
      await rename(tmpPath, currentPath);
      const prev = index.agents[name].active_version;
      index.agents[name].active_version = match.replace('.md', '');
      index.agents[name].activated_at = now();
      index.agents[name].previous_version = prev || null;
      index.agents[name].rollback_from = prev;
      await log(`[rollback] ${name}: ${prev} → ${match.replace('.md', '')}`);
    }

    index.last_activate = now();
    await saveIndex(index);

    await log('[rollback] Done');
    console.log(JSON.stringify({ status: 'rolled_back', version: targetVersion }, null, 2));
  } finally {
    await releaseLock();
  }
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--compile')) {
    await compile();
  } else if (args.includes('--activate')) {
    await activate();
  } else if (args.includes('--rollback')) {
    const vIdx = args.indexOf('--version');
    if (vIdx === -1 || !args[vIdx + 1]) {
      throw new Error('--rollback requires --version <version_id>');
    }
    await rollback(args[vIdx + 1]);
  } else {
    console.error('Usage: prompt-sync.mjs --compile | --activate | --rollback --version <id>');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`[prompt-sync] Fatal: ${err.message}`);
  process.exit(1);
});
