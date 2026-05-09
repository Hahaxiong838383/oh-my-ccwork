#!/usr/bin/env node
/**
 * Futurus 战略情报每日编排器
 * 7 阶段流水线：context_pack → collect → curate → analyze → report → deliver → eval(shadow)
 *
 * 用法：
 *   node futurus-daily-run.mjs                     # 完整运行
 *   node futurus-daily-run.mjs --resume <run_id>   # 从断点恢复
 *   node futurus-daily-run.mjs --dry-run            # 只跑 collect+dedup，不调 LLM
 */

import { readFile, writeFile, mkdir, rename, readdir, open } from 'fs/promises';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const COLLECT_DIR = join(__dir, '..');
const HERMES_HOME = process.env.HERMES_HOME || '/root/.hermes';
const CONTEXT_DIR = process.env.FUTURUS_CONTEXT_DIR || join(HERMES_HOME, 'context/futurus');
const RUNS_DIR = process.env.FUTURUS_RUNS_DIR || join(HERMES_HOME, 'runs');
const TEMPLATE_PATH = join(RUNS_DIR, 'template', 'run_manifest_template.json');
const LARK_CLI = process.env.LARK_CLI_PATH || 'lark-cli';
const FUTURUS_COLLECTORS = ['policy-gov', 'auto-industry', 'hud-competitors', 'auto-oem', 'ar-xr', 'macro-economy'];
const PROMPTS_DIR = join(CONTEXT_DIR, 'prompts');

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL;
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL;
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';

function generateRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${rand}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function now() {
  return new Date().toISOString();
}

async function loadManifest(runDir) {
  const path = join(runDir, 'run_manifest.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

async function saveManifest(runDir, manifest) {
  const p = join(runDir, 'run_manifest.json');
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  await rename(tmp, p);
}

function updateStage(manifest, stageName, updates) {
  const stage = manifest.stages.find(s => s.name === stageName);
  if (stage) Object.assign(stage, updates);
  return manifest;
}

function getStageStatus(manifest, stageName) {
  const stage = manifest.stages.find(s => s.name === stageName);
  return stage?.status || 'unknown';
}

async function initRun(runId) {
  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  const templateRaw = await readFile(TEMPLATE_PATH, 'utf-8');
  const manifest = JSON.parse(templateRaw.replace('{RUN_ID}', runId));
  manifest.started_at = now();
  manifest.overall_status = 'running';

  await saveManifest(runDir, manifest);
  console.error(`[run] Initialized run ${runId} at ${runDir}`);
  return { runDir, manifest };
}

// ── LLM 调用 ──

async function callLLM(provider, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 4096;
  const timeout = opts.timeout || 120000;

  let url, apiKey, model;
  if (provider === 'gemini') {
    if (!GEMINI_PROXY_URL || !GEMINI_PROXY_KEY) {
      throw new Error('GEMINI_PROXY_URL and GEMINI_PROXY_KEY must be set');
    }
    url = `${GEMINI_PROXY_URL}/chat/completions`;
    apiKey = GEMINI_PROXY_KEY;
    model = 'gemini-2.5-flash';
  } else if (provider === 'minimax') {
    if (!MINIMAX_API_KEY || !MINIMAX_BASE_URL) {
      throw new Error('MINIMAX_API_KEY and MINIMAX_BASE_URL must be set');
    }
    url = `${MINIMAX_BASE_URL}/chat/completions`;
    apiKey = MINIMAX_API_KEY;
    model = MINIMAX_MODEL;
  } else {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const MAX_RETRIES = 3;
  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const body = {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.3,
        };

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          const isRetryable = resp.status >= 500 || resp.status === 429;
          if (isRetryable && attempt < MAX_RETRIES - 1) {
            console.error(`[llm] ${provider} HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES}...`);
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw new Error(`LLM ${provider} HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
        }

        const data = await resp.json();
        let content = data.choices?.[0]?.message?.content || '';
        content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
        const usage = data.usage || {};

        return {
          content,
          tokens_in: usage.prompt_tokens || 0,
          tokens_out: usage.completion_tokens || 0,
          model: data.model || model,
        };
      } catch (err) {
        const isAbort = err.name === 'AbortError';
        const isRetryable = isAbort || err.message?.includes('ECONNRESET') || err.message?.includes('ETIMEDOUT');
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          console.error(`[llm] ${provider} ${err.message}, retry ${attempt + 1}/${MAX_RETRIES}...`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── 成本熔断 ──

async function loadModelRouting() {
  const routingPath = join(CONTEXT_DIR, 'model_routing.json');
  try {
    return JSON.parse(await readFile(routingPath, 'utf-8'));
  } catch {
    return { limits: { daily_usd: 2, single_run_max_tokens: 200000 } };
  }
}

async function getTodayTokenUsage() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let totalTokens = 0;

  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(today)) continue;
      const manifestPath = join(RUNS_DIR, entry.name, 'run_manifest.json');
      try {
        const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
        const s = m.cost_summary?.by_stage || {};
        totalTokens += (s.analyze?.tokens_in || 0) + (s.analyze?.tokens_out || 0)
                     + (s.report?.tokens_in || 0) + (s.report?.tokens_out || 0)
                     + (s.eval?.tokens_in || 0) + (s.eval?.tokens_out || 0);
      } catch { /* skip broken manifests */ }
    }
  } catch { /* runs dir may not exist yet */ }

  return totalTokens;
}

async function checkCostCircuitBreaker() {
  const routing = await loadModelRouting();
  const limits = routing.limits || {};
  const todayTokens = await getTodayTokenUsage();
  const maxTokens = limits.single_run_max_tokens || 200000;

  if (todayTokens > maxTokens) {
    return { allowed: false, reason: `daily token usage ${todayTokens} exceeds limit ${maxTokens}`, degrade: false };
  }

  const degradeThreshold = maxTokens * ((limits.degrade_threshold_pct || 80) / 100);
  if (todayTokens > degradeThreshold) {
    return { allowed: true, reason: `token usage ${todayTokens} above ${limits.degrade_threshold_pct}% threshold, degrading to dry-run`, degrade: true };
  }

  return { allowed: true, reason: 'within limits', degrade: false };
}

// ── 前日摘要 ──

async function resolvePreviousRun() {
  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    const runDirs = entries
      .filter(e => e.isDirectory() && /^\d{8}-/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const dirName of runDirs) {
      const manifestPath = join(RUNS_DIR, dirName, 'run_manifest.json');
      try {
        const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
        if (m.overall_status !== 'completed') continue;

        const curatedPath = join(RUNS_DIR, dirName, 'curated.json');
        const curated = JSON.parse(await readFile(curatedPath, 'utf-8'));
        const titles = [];
        for (const source of (curated.sources || [])) {
          for (const item of (source.items || [])) {
            if (titles.length >= 5) break;
            titles.push(`- [${source.source}] ${item.title}`);
          }
          if (titles.length >= 5) break;
        }

        return titles.length > 0
          ? titles.join('\n')
          : 'no_previous_run';
      } catch { continue; }
    }
  } catch { /* ignore */ }

  return 'no_previous_run';
}

// ── Stage 1: Context Pack ──
async function stageContextPack(runDir, manifest) {
  if (getStageStatus(manifest, 'context_pack') === 'completed') {
    console.error('[context_pack] Already completed, skipping');
    return manifest;
  }

  updateStage(manifest, 'context_pack', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const templatePath = join(CONTEXT_DIR, 'daily_context_pack.md');
    const template = await readFile(templatePath, 'utf-8');

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const prevTakeaways = await resolvePreviousRun();

    const filled = template
      .replace('{YYYY-MM-DD}', fmt(today))
      .replace('{START_DATE}', fmt(yesterday))
      .replace('{END_DATE}', fmt(today))
      .replace('{PREV_DATE}', fmt(yesterday))
      .replace('{FOCUS_AREAS}', 'HUD竞品, OEM动态, 政策监管, 汽车行业')
      .replace('{SOURCE_SCOPE}', FUTURUS_COLLECTORS.join(', '))
      .replace('{COLLECT_FILTER_MODEL}', 'MiniMax-M2.7')
      .replace('{ANALYSIS_CORE_MODEL}', 'gemini-2.5-flash')
      .replace('{REPORT_WRITE_MODEL}', 'MiniMax-M2.7')
      .replace('{ROUTING_NOTES}', '低成本路由：MiniMax 做筛选和报告，Gemini 做分析')
      .replace('{PREV_KEY_TAKEAWAYS}', prevTakeaways)
      .replace('{PREV_PENDING_ITEMS}', '无');

    const outPath = join(runDir, 'daily_context_pack.md');
    await writeFile(outPath, filled, 'utf-8');

    updateStage(manifest, 'context_pack', {
      status: 'completed', ended_at: now(), output_file: outPath,
    });
    await saveManifest(runDir, manifest);
    console.error('[context_pack] Completed');
  } catch (err) {
    updateStage(manifest, 'context_pack', {
      status: 'failed', ended_at: now(), error: err.message,
      retry_count: (manifest.stages.find(s => s.name === 'context_pack')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Stage 2: Collect ──
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(cmd, args, { timeout: 120000, ...opts });
    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
    proc.on('error', reject);
  });
}

async function stageCollect(runDir, manifest) {
  if (getStageStatus(manifest, 'collect') === 'completed') {
    console.error('[collect] Already completed, skipping');
    return manifest;
  }

  updateStage(manifest, 'collect', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const collectScript = join(COLLECT_DIR, 'collect.mjs');
    const saveDir = join(runDir, 'raw');

    const { stdout } = await runCommand('node', [
      collectScript,
      '--sources', FUTURUS_COLLECTORS.join(','),
      '--save', saveDir,
    ]);

    const collectResult = JSON.parse(stdout);
    const outPath = join(runDir, 'collect_merged.json');
    await writeFile(outPath, JSON.stringify(collectResult, null, 2), 'utf-8');

    const totalItems = collectResult.sources?.reduce((sum, s) => sum + (s.items?.length || 0), 0) || 0;

    updateStage(manifest, 'collect', {
      status: 'completed', ended_at: now(), output_file: outPath,
    });
    manifest.cost_summary.by_stage.collect = { items_raw: totalItems };
    await saveManifest(runDir, manifest);
    console.error(`[collect] Completed: ${totalItems} raw items`);
  } catch (err) {
    updateStage(manifest, 'collect', {
      status: 'failed', ended_at: now(), error: err.message,
      retry_count: (manifest.stages.find(s => s.name === 'collect')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Stage 3: Curate (dedup + rank) ──
function dedup(sources) {
  const seen = new Map();
  const deduped = [];

  for (const source of sources) {
    const items = source.items || [];
    const kept = [];
    for (const item of items) {
      const key = item.url || `${item.title}::${item.pubDate}`;
      if (!seen.has(key)) {
        seen.set(key, source.source);
        kept.push(item);
      }
    }
    deduped.push({ ...source, items: kept });
  }

  return { deduped, duplicatesRemoved: sources.reduce((s, src) => s + (src.items?.length || 0), 0) - deduped.reduce((s, src) => s + (src.items?.length || 0), 0) };
}

async function stageCurate(runDir, manifest) {
  if (getStageStatus(manifest, 'curate') === 'completed') {
    console.error('[curate] Already completed, skipping');
    return manifest;
  }

  updateStage(manifest, 'curate', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const collectPath = join(runDir, 'collect_merged.json');
    const raw = JSON.parse(await readFile(collectPath, 'utf-8'));

    const { deduped, duplicatesRemoved } = dedup(raw.sources || []);
    const totalAfterDedup = deduped.reduce((s, src) => s + (src.items?.length || 0), 0);

    const curateResult = {
      curated_at: now(),
      duplicates_removed: duplicatesRemoved,
      total_items: totalAfterDedup,
      sources: deduped,
    };

    const outPath = join(runDir, 'curated.json');
    await writeFile(outPath, JSON.stringify(curateResult, null, 2), 'utf-8');

    updateStage(manifest, 'curate', {
      status: 'completed', ended_at: now(), output_file: outPath,
    });
    manifest.cost_summary.by_stage.curate = {
      items_after_dedup: totalAfterDedup, duplicates_removed: duplicatesRemoved,
    };
    await saveManifest(runDir, manifest);
    console.error(`[curate] Completed: ${totalAfterDedup} items after dedup (${duplicatesRemoved} removed)`);
  } catch (err) {
    updateStage(manifest, 'curate', {
      status: 'failed', ended_at: now(), error: err.message,
      retry_count: (manifest.stages.find(s => s.name === 'curate')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Prompt Template Loading ──

async function loadPromptTemplate(agentName) {
  const templatePath = join(PROMPTS_DIR, 'current', `agent_${agentName}.md`);
  try {
    const content = await readFile(templatePath, 'utf-8');
    console.error(`[prompt] Loaded external template: ${templatePath}`);
    return { content, source: 'external' };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[prompt] Template not found (ENOENT), using fallback for ${agentName}`);
      return { content: null, source: 'fallback' };
    }
    throw new Error(`[prompt] Failed to read template ${templatePath}: ${err.message}`);
  }
}

function resolvePromptVersion() {
  const result = {};
  for (const name of ['analyze', 'report']) {
    const p = join(PROMPTS_DIR, 'current', `agent_${name}.md`);
    try {
      const content = readFileSync(p, 'utf-8');
      result[name] = createHash('sha256').update(content).digest('hex').slice(0, 12);
    } catch { result[name] = 'fallback'; }
  }
  return result;
}

// ── Stage 4: Analyze (Gemini Proxy LLM) ──
async function stageAnalyze(runDir, manifest, dryRun) {
  if (getStageStatus(manifest, 'analyze') === 'completed') {
    console.error('[analyze] Already completed, skipping');
    return manifest;
  }

  if (dryRun) {
    console.error('[analyze] Dry run — skipping LLM analysis');
    updateStage(manifest, 'analyze', { status: 'skipped', ended_at: now() });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  // P1d: 成本熔断
  const costCheck = await checkCostCircuitBreaker();
  if (!costCheck.allowed) {
    console.error(`[analyze] Cost circuit breaker: ${costCheck.reason}`);
    updateStage(manifest, 'analyze', { status: 'skipped', ended_at: now(), note: costCheck.reason });
    await saveManifest(runDir, manifest);
    return manifest;
  }
  if (costCheck.degrade) {
    console.error(`[analyze] Cost degradation: ${costCheck.reason}`);
    updateStage(manifest, 'analyze', { status: 'skipped', ended_at: now(), note: costCheck.reason });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  updateStage(manifest, 'analyze', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const curatedPath = join(runDir, 'curated.json');
    const curated = JSON.parse(await readFile(curatedPath, 'utf-8'));
    const anchorPath = join(CONTEXT_DIR, 'strategy_anchor.md');
    const anchor = await readFile(anchorPath, 'utf-8');

    const summaries = [];
    for (const source of curated.sources) {
      for (const item of source.items) {
        summaries.push(`[${source.source}] ${item.title} — ${(item.summary || '').slice(0, 200)}`);
      }
    }
    const curatedText = summaries.join('\n');

    const { content: tpl, source: promptSource } = await loadPromptTemplate('analyze');
    let prompt;
    if (tpl) {
      prompt = tpl
        .replace('{CURATED_DATA}', curatedText)
        .replace('{STRATEGY_ANCHOR}', anchor);
    } else {
      prompt = [
        '你是 Futurus 战略情报分析师。基于以下采集结果，输出结构化分析。',
        '',
        '## 战略锚点',
        anchor,
        '',
        '## 今日采集摘要',
        curatedText,
        '',
        '## 输出要求',
        '1. 按7大领域分类（政策监管/宏观经济/汽车行业/OEM动态/HUD竞品/AR-XR/光学科学）',
        '2. 每条结论附 source_url + confidence（high/medium/low）',
        '3. 标注「需跟踪」的事项',
        '4. 最后附一段 <=100 字的 CEO 摘要',
      ].join('\n');
    }
    console.error(`[analyze] Prompt source: ${promptSource}`);

    // 检查 prompt token 估算（1 char ≈ 0.7 token for 中文）
    const estimatedTokens = Math.ceil(prompt.length * 0.7);
    const routing = await loadModelRouting();
    const maxTokens = routing.limits?.single_run_max_tokens || 200000;
    if (estimatedTokens > maxTokens) {
      throw new Error(`Prompt too large: ~${estimatedTokens} tokens > limit ${maxTokens}`);
    }

    console.error(`[analyze] Calling Gemini Proxy (est. ${estimatedTokens} tokens)...`);
    const result = await callLLM('gemini', prompt, { maxTokens: 4096, timeout: 180000 });

    const outPath = join(runDir, 'analysis.md');
    await writeFile(outPath, result.content, 'utf-8');

    if (process.env.DEBUG) {
      const promptPath = join(runDir, 'analysis_prompt.md');
      await writeFile(promptPath, prompt, 'utf-8');
    }

    updateStage(manifest, 'analyze', {
      status: 'completed', ended_at: now(), output_file: outPath,
    });
    manifest.cost_summary.by_stage.analyze = {
      prompt_chars: prompt.length,
      prompt_source: promptSource,
      items_analyzed: summaries.length,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      model: result.model,
    };
    await saveManifest(runDir, manifest);
    console.error(`[analyze] Completed: ${result.tokens_in}+${result.tokens_out} tokens`);
  } catch (err) {
    updateStage(manifest, 'analyze', {
      status: 'failed', ended_at: now(), error: err.message,
      retry_count: (manifest.stages.find(s => s.name === 'analyze')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Stage 5: Report (MiniMax LLM) ──
async function stageReport(runDir, manifest, dryRun) {
  if (getStageStatus(manifest, 'report') === 'completed') {
    console.error('[report] Already completed, skipping');
    return manifest;
  }

  if (dryRun || getStageStatus(manifest, 'analyze') === 'skipped') {
    console.error('[report] Skipping (dry-run or analyze was skipped)');
    updateStage(manifest, 'report', { status: 'skipped', ended_at: now() });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  updateStage(manifest, 'report', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const analysisPath = join(runDir, 'analysis.md');
    const analysis = await readFile(analysisPath, 'utf-8');

    const { content: tpl, source: promptSource } = await loadPromptTemplate('report');
    let prompt;
    if (tpl) {
      prompt = tpl.replace('{CURATED_DATA}', analysis);
    } else {
      prompt = [
        '你是 CEO 简报撰写专家。基于以下战略情报分析，撰写一份 <=500 字的 CEO 日报。',
        '',
        '## 分析内容',
        analysis,
        '',
        '## 输出格式',
        '标题：Futurus 战略情报日报 YYYY-MM-DD',
        '',
        '要求：',
        '1. 开头用 1-2 句总结今日最重要发现',
        '2. 按优先级列出 3-5 条关键信息，每条 <=80 字',
        '3. 每条标注领域标签和置信度',
        '4. 结尾列出「需跟踪」事项（如有）',
        '5. 语言简洁专业，适合 CEO 快速阅读',
        '6. 总字数 <=500',
      ].join('\n');
    }
    console.error(`[report] Prompt source: ${promptSource}`);

    console.error('[report] Calling MiniMax...');
    const result = await callLLM('minimax', prompt, { maxTokens: 2048, timeout: 120000 });

    const outPath = join(runDir, 'report.md');
    await writeFile(outPath, result.content, 'utf-8');

    let totalTokensIn = result.tokens_in;
    let totalTokensOut = result.tokens_out;
    const reportFiles = { ceo: outPath };

    const deptTpl = await loadPromptTemplate('report-dept');
    if (deptTpl.content) {
      const deptPrompt = deptTpl.content.replace('{CURATED_DATA}', analysis);
      console.error('[report] Generating dept report...');
      const deptResult = await callLLM('minimax', deptPrompt, { maxTokens: 2048, timeout: 120000 });
      const deptPath = join(runDir, 'report-dept.md');
      await writeFile(deptPath, deptResult.content, 'utf-8');
      reportFiles.dept = deptPath;
      totalTokensIn += deptResult.tokens_in;
      totalTokensOut += deptResult.tokens_out;
      console.error(`[report] Dept report: ${deptResult.tokens_in}+${deptResult.tokens_out} tokens`);
    }

    const allTpl = await loadPromptTemplate('report-all');
    if (allTpl.content) {
      const allPrompt = allTpl.content.replace('{CURATED_DATA}', analysis);
      console.error('[report] Generating all-staff report...');
      const allResult = await callLLM('minimax', allPrompt, { maxTokens: 1024, timeout: 120000 });
      const allPath = join(runDir, 'report-all.md');
      await writeFile(allPath, allResult.content, 'utf-8');
      reportFiles.all = allPath;
      totalTokensIn += allResult.tokens_in;
      totalTokensOut += allResult.tokens_out;
      console.error(`[report] All-staff report: ${allResult.tokens_in}+${allResult.tokens_out} tokens`);
    }

    updateStage(manifest, 'report', {
      status: 'completed', ended_at: now(), output_file: outPath, report_files: reportFiles,
    });
    manifest.cost_summary.by_stage.report = {
      prompt_source: promptSource,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      model: result.model,
    };
    await saveManifest(runDir, manifest);
    console.error(`[report] All versions completed: ${totalTokensIn}+${totalTokensOut} tokens total`);
  } catch (err) {
    updateStage(manifest, 'report', {
      status: 'failed', ended_at: now(), error: err.message.slice(0, 2000),
      retry_count: (manifest.stages.find(s => s.name === 'report')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Stage 6: Deliver (飞书通知) ──
async function stageDeliver(runDir, manifest, dryRun, deliverMode = 'normal') {
  const deliverStage = manifest.stages.find(s => s.name === 'deliver');
  if (deliverStage?.status === 'completed') {
    console.error('[deliver] Already completed, skipping');
    return manifest;
  }

  // HIGH-2 fix: resume 时如果 deliver 处于 running+send_started，拒绝自动重发
  if (deliverStage?.status === 'running' && deliverStage?.send_started_at) {
    console.error('[deliver] In uncertain state (sent but not confirmed). Skipping to avoid duplicate push.');
    updateStage(manifest, 'deliver', {
      status: 'completed', ended_at: now(), note: 'auto-skipped: possible duplicate',
    });
    await saveManifest(runDir, manifest);
    return manifest;
  }
  if (deliverStage?.message_id) {
    console.error('[deliver] Already sent (message_id exists), skipping');
    updateStage(manifest, 'deliver', { status: 'completed', ended_at: now(), note: 'idempotent-skip' });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  if (dryRun || getStageStatus(manifest, 'report') === 'skipped') {
    console.error('[deliver] Skipping (dry-run or report was skipped)');
    updateStage(manifest, 'deliver', { status: 'skipped', ended_at: now() });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  updateStage(manifest, 'deliver', { status: 'running', started_at: now(), send_started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const reportPath = join(runDir, 'report.md');
    const report = await readFile(reportPath, 'utf-8');
    let messageId = null;

    const larkCliAvailable = await runCommand('which', [LARK_CLI]).then(() => true).catch(() => false);
    if (larkCliAvailable) {
      const today = new Date().toISOString().slice(0, 10);
      const draftPrefix = deliverMode === 'draft' ? '[⚠️ 草稿 - 来源覆盖率不足] ' : '';
      const reportStage = manifest.stages.find(s => s.name === 'report');
      const reportFiles = reportStage?.report_files || {};
      let fullReport = report;
      if (reportFiles.dept) {
        try { fullReport += '\n\n---\n\n' + (await readFile(reportFiles.dept, 'utf-8')).slice(0, 1500); } catch {}
      }
      if (reportFiles.all) {
        try { fullReport += '\n\n---\n\n' + (await readFile(reportFiles.all, 'utf-8')).slice(0, 800); } catch {}
      }
      const msg = `${draftPrefix}Futurus 战略情报日报 ${today}\n\n${fullReport.slice(0, 3800)}`;

      const { stdout: sendOutput } = await runCommand(LARK_CLI, [
        'im', '+messages-send',
        '--as', 'bot',
        '--user-id', 'ou_2d27697a6d9c92307cf01e7eb35102b0',
        '--text', msg,
      ]);
      try {
        const parsed = JSON.parse(sendOutput);
        messageId = parsed?.data?.message_id || null;
      } catch { /* best effort */ }
      console.error(`[deliver] Sent to feishu${messageId ? ` (msg=${messageId})` : ''}`);
    } else {
      console.error('[deliver] lark-cli not found, skipping feishu delivery');
    }

    updateStage(manifest, 'deliver', {
      status: 'completed', ended_at: now(), output_file: reportPath, message_id: messageId, deliver_mode: deliverMode,
    });
    await saveManifest(runDir, manifest);
    console.error('[deliver] Completed');

    try {
      const larkDocAvailable = await runCommand('which', [LARK_CLI]).then(() => true).catch(() => false);
      if (larkDocAvailable && reportPath) {
        const docTitle = `情报日报-${new Date().toISOString().slice(0, 10)}`;
        const docContent = await readFile(reportPath, 'utf-8');
        const { stdout: docOut } = await runCommand(LARK_CLI, [
          'docs', '+create', '--title', docTitle,
          '--markdown', docContent.slice(0, 8000), '--as', 'user',
        ]);
        console.error(`[deliver] Wiki archived: ${docTitle}`);
        updateStage(manifest, 'deliver', { wiki_archived: true });
        await saveManifest(runDir, manifest);
      }
    } catch (wikiErr) {
      console.error('[deliver] Wiki archive soft-fail: ' + wikiErr.message);
    }
  } catch (err) {
    updateStage(manifest, 'deliver', {
      status: 'failed', ended_at: now(), error: err.message.slice(0, 2000),
      retry_count: (manifest.stages.find(s => s.name === 'deliver')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

function calcSourceUrlCoverage(reportContent, curatedSources) {
  const urls = [];
  for (const source of (curatedSources || [])) {
    for (const item of (source.items || [])) {
      if (item.url) urls.push(item.url);
    }
  }
  if (urls.length === 0) return 1.0;
  const mentioned = urls.filter(url => reportContent.includes(url));
  return mentioned.length / urls.length;
}

// ── Feedback & Proposal ──
const FEEDBACK_PATH = join(CONTEXT_DIR, 'feedback.jsonl');

async function appendFeedback(runId, evalScore, issues) {
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    run_id: runId,
    eval_score: evalScore || {},
    issues: (issues || []).map(i => ({ type: i.type, severity: i.severity })),
    timestamp: now(),
  };
  const line = JSON.stringify(entry) + '\n';
  const fh = await open(FEEDBACK_PATH, 'a');
  try { await fh.write(line); } finally { await fh.close(); }
  console.error(`[feedback] Appended to ${FEEDBACK_PATH}`);
}

async function checkProposalTrigger() {
  const routing = await loadModelRouting();
  const trigger = routing.eval?.proposal_trigger || { min_consecutive_low_score: 2, min_same_feedback_count: 2 };
  let lines;
  try {
    const raw = await readFile(FEEDBACK_PATH, 'utf-8');
    lines = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return { triggered: false, reason: 'no feedback data' }; }
  if (lines.length < 2) return { triggered: false, reason: 'insufficient data' };
  const recent = lines.slice(-5);
  const consecutiveLow = recent.reverse().findIndex(l => (l.eval_score?.overall || 5) >= 3.5);
  if (consecutiveLow >= trigger.min_consecutive_low_score) {
    return { triggered: true, reason: `${consecutiveLow} consecutive low scores` };
  }
  const issueCounts = {};
  for (const l of recent) {
    for (const i of (l.issues || [])) {
      issueCounts[i.type] = (issueCounts[i.type] || 0) + 1;
    }
  }
  const repeatedIssue = Object.entries(issueCounts).find(([, c]) => c >= trigger.min_same_feedback_count);
  if (repeatedIssue) {
    return { triggered: true, reason: `issue "${repeatedIssue[0]}" appeared ${repeatedIssue[1]} times` };
  }
  return { triggered: false, reason: 'thresholds not met' };
}

async function writeProposal(reason, evalScore, issues) {
  const proposalsDir = join(PROMPTS_DIR, 'proposals');
  await mkdir(proposalsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(proposalsDir, `${date}.diff.md`);
  const content = [
    `# Prompt Improvement Proposal — ${date}`,
    '',
    `## Trigger: ${reason}`,
    '',
    '## Current Eval Scores',
    JSON.stringify(evalScore, null, 2),
    '',
    '## Recurring Issues',
    ...(issues || []).map(i => `- [${i.severity}] ${i.type}: ${i.detail || ''}`),
    '',
    '## Suggested Changes',
    '<!-- TODO: auto-generate or manually fill -->',
    '',
  ].join('\n');
  await writeFile(path, content, 'utf-8');
  console.error(`[proposal] Written to ${path}`);
  return path;
}

// ── Stage 5.5: Quality Gate (report → deliver 之间的质量门禁) ──
async function stageQualityGate(runDir, manifest, dryRun) {
  if (!manifest.stages.find(s => s.name === 'quality_gate')) {
    manifest.stages.splice(
      manifest.stages.findIndex(s => s.name === 'deliver'), 0,
      { name: 'quality_gate', status: 'pending', started_at: null, ended_at: null, error: null, retry_count: 0 }
    );
  }
  if (getStageStatus(manifest, 'quality_gate') === 'completed') {
    console.error('[quality_gate] Already completed, skipping');
    return manifest;
  }
  if (dryRun || getStageStatus(manifest, 'report') !== 'completed') {
    console.error('[quality_gate] Skipping (dry-run or report not completed)');
    updateStage(manifest, 'quality_gate', { status: 'skipped', ended_at: now() });
    await saveManifest(runDir, manifest);
    return manifest;
  }

  updateStage(manifest, 'quality_gate', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);

  try {
    const reportPath = join(runDir, 'report.md');
    const report = await readFile(reportPath, 'utf-8');
    const curatedPath = join(runDir, 'curated.json');
    const curated = JSON.parse(await readFile(curatedPath, 'utf-8'));

    const sourceUrlCoverage = calcSourceUrlCoverage(report, curated.sources || []);
    const coverageThreshold = 0.70;
    const passed = sourceUrlCoverage >= coverageThreshold;
    const deliverMode = passed ? 'normal' : 'draft';

    console.error(`[quality_gate] source_url_coverage=${sourceUrlCoverage.toFixed(2)}, threshold=${coverageThreshold}, deliver_mode=${deliverMode}`);

    updateStage(manifest, 'quality_gate', {
      status: 'completed',
      ended_at: now(),
      source_url_coverage: sourceUrlCoverage,
      coverage_threshold: coverageThreshold,
      passed,
      deliver_mode: deliverMode,
    });
    await saveManifest(runDir, manifest);
  } catch (err) {
    console.error('[quality_gate] Failed, defaulting to draft mode: ' + err.message);
    updateStage(manifest, 'quality_gate', {
      status: 'failed', ended_at: now(), error: err.message.slice(0, 2000),
      deliver_mode: 'draft',
    });
    await saveManifest(runDir, manifest);
  }
  return manifest;
}

function getDeliverMode(manifest) {
  const qg = manifest.stages.find(s => s.name === 'quality_gate');
  return qg?.deliver_mode || 'normal';
}

async function stageEval(runDir, manifest, dryRun) {
  if (getStageStatus(manifest, 'eval') === 'completed') {
    console.error('[eval] Already completed, skipping');
    return manifest;
  }
  if (dryRun || getStageStatus(manifest, 'report') === 'skipped') {
    console.error('[eval] Skipping (dry-run or report was skipped)');
    updateStage(manifest, 'eval', { status: 'skipped', ended_at: now() });
    await saveManifest(runDir, manifest);
    return manifest;
  }
  const routing = await loadModelRouting();
  const evalMode = routing.eval?.mode || 'shadow';
  updateStage(manifest, 'eval', { status: 'running', started_at: now() });
  await saveManifest(runDir, manifest);
  const costCheck = await checkCostCircuitBreaker();
  if (!costCheck.allowed || costCheck.degrade) {
    console.error(`[eval] Cost limit: ${costCheck.reason}, skipping eval`);
    updateStage(manifest, 'eval', { status: 'skipped', ended_at: now(), note: costCheck.reason });
    await saveManifest(runDir, manifest);
    return manifest;
  }
  let llmResult = null;
  try {
    const reportPath = join(runDir, 'report.md');
    const report = await readFile(reportPath, 'utf-8');
    const curatedPath = join(runDir, 'curated.json');
    const curated = JSON.parse(await readFile(curatedPath, 'utf-8'));
    const sourceNames = [...new Set((curated.sources || []).map(s => s.source))];
    const totalItems = curated.total_items || 0;
    const sourceUrlCoverage = calcSourceUrlCoverage(report, curated.sources || []);
    const evalPrompt = [
      '你是一个战略情报报告质量评估专家。请对以下报告进行结构化评分。',
      '',
      '## 报告内容',
      report,
      '',
      '## 采集源覆盖情况',
      ' 来源: ' + sourceNames.join(', '),
      ' 总条目数: ' + totalItems,
      '',
      '## 评分要求',
      '请严格按以下 JSON 格式输出（不要输出其他内容）：',
      '```json',
      '{',
      '  "eval_score": {',
      '    "coverage": <1-5, 领域覆盖完整度>,',
      '    "actionability": <1-5, 结论可操作性>,',
      '    "confidence_distribution": {"high": <数量>, "medium": <数量>, "low": <数量>},',
      '    "word_count_ok": <true/false, 是否 <=500 字>,',
      '    "source_url_coverage": <0-1, 引用来源比例>,',
      '    "overall": <1-5, 综合评分>',
      '  },',
      '  "issues": [',
      '    {"type": "<issue_type>", "detail": "<具体描述>", "severity": "high|medium|low"}',
      '  ]',
      '}',
      '```',
      '',
      '评分标准：',
      '- coverage: 7大领域(政策监管/宏观经济/汽车行业/OEM动态/HUD竞品/AR-XR/光学科学)覆盖数',
      '- actionability: 结论是否具体可执行，而非泛泛而谈',
      '- word_count_ok: 报告正文 <=500 字',
      '- source_url_coverage: 提及来源链接的条目占比',
      '- overall: 综合以上各维度的加权评分',
    ].join('\n');
    console.error('[eval] Calling Gemini Flash for evaluation...');
    llmResult = await callLLM('gemini', evalPrompt, { maxTokens: 1024, timeout: 60000 });
    let evalResult;
    try {
      const jsonMatch = llmResult.content.match(/```json\s*([\s\S]*?)```/) ||
                        llmResult.content.match(/\{[\s\S]*"eval_score"[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : llmResult.content;
      evalResult = JSON.parse(jsonStr.trim());
    } catch (parseErr) {
      console.error('[eval] Failed to parse eval JSON: ' + parseErr.message);
      evalResult = {
        eval_score: { coverage: 0, actionability: 0, overall: 0 },
        issues: [{ type: 'parse_error', detail: 'LLM output was not valid JSON', severity: 'low' }],
        raw_response: llmResult.content.slice(0, 500),
      };
    }
    evalResult.eval_score = evalResult.eval_score || {};
    if (typeof evalResult.eval_score.source_url_coverage !== 'number') {
      evalResult.eval_score.source_url_coverage = sourceUrlCoverage;
    }
    updateStage(manifest, 'eval', {
      status: 'completed',
      ended_at: now(),
      eval_mode: evalMode,
      eval_score: evalResult.eval_score || {},
      issues: evalResult.issues || [],
      proposal_generated: false,
    });
    manifest.cost_summary.by_stage.eval = {
      tokens_in: llmResult.tokens_in,
      tokens_out: llmResult.tokens_out,
      model: llmResult.model,
    };
    await saveManifest(runDir, manifest);
    console.error('[eval] ' + evalMode + ' mode completed: overall=' + (evalResult.eval_score?.overall || 'N/A') + ', ' + llmResult.tokens_in + '+' + llmResult.tokens_out + ' tokens');

    try {
      await appendFeedback(manifest.run_id, evalResult.eval_score, evalResult.issues);
      const proposal = await checkProposalTrigger();
      if (proposal.triggered) {
        const proposalPath = await writeProposal(proposal.reason, evalResult.eval_score, evalResult.issues);
        updateStage(manifest, 'eval', { proposal_generated: true, proposal_path: proposalPath });
        await saveManifest(runDir, manifest);
        console.error('[eval] Proposal generated: ' + proposal.reason);
      } else {
        console.error('[eval] No proposal needed: ' + proposal.reason);
      }
    } catch (fbErr) {
      console.error('[eval] Feedback/proposal soft-fail: ' + fbErr.message);
    }
  } catch (err) {
    if (llmResult) {
      manifest.cost_summary.by_stage.eval = {
        tokens_in: llmResult.tokens_in,
        tokens_out: llmResult.tokens_out,
        model: llmResult.model,
      };
    }
    updateStage(manifest, 'eval', {
      status: 'failed', ended_at: now(), error: err.message.slice(0, 2000),
      eval_mode: evalMode,
      retry_count: (manifest.stages.find(s => s.name === 'eval')?.retry_count || 0) + 1,
    });
    await saveManifest(runDir, manifest);
    throw err;
  }
  return manifest;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const resumeIdx = args.indexOf('--resume');
  let dryRun = args.includes('--dry-run');

  let runId, runDir, manifest;

  if (resumeIdx !== -1 && args[resumeIdx + 1]) {
    runId = args[resumeIdx + 1];
    runDir = join(RUNS_DIR, runId);
    manifest = await loadManifest(runDir);
    console.error(`[run] Resuming run ${runId}`);
  } else {
    runId = generateRunId();
    ({ runDir, manifest } = await initRun(runId));
  }

  // P1d: 成本降级检查 — 如果超阈值，自动降级为 dry-run
  if (!dryRun) {
    const costCheck = await checkCostCircuitBreaker();
    if (!costCheck.allowed) {
      console.error(`[run] Cost circuit breaker triggered: ${costCheck.reason}. Aborting.`);
      manifest.overall_status = 'aborted';
      manifest.ended_at = now();
      manifest.cost_summary.abort_reason = costCheck.reason;
      await saveManifest(runDir, manifest);
      process.exit(1);
    }
    if (costCheck.degrade) {
      console.error(`[run] Cost degradation: ${costCheck.reason}. Switching to dry-run.`);
      dryRun = true;
    }
  }

  const pipeline = [
    () => stageContextPack(runDir, manifest),
    () => stageCollect(runDir, manifest),
    () => stageCurate(runDir, manifest),
    () => stageAnalyze(runDir, manifest, dryRun),
    () => stageReport(runDir, manifest, dryRun),
    () => stageQualityGate(runDir, manifest, dryRun),
    () => stageDeliver(runDir, manifest, dryRun, getDeliverMode(manifest)),
  ];

  for (const stage of pipeline) {
    try {
      manifest = await stage();
    } catch (err) {
      console.error(`[run] Stage failed: ${err.message}`);
      manifest.overall_status = 'failed';
      manifest.ended_at = now();
      await saveManifest(runDir, manifest);
      console.error(`[run] Manifest saved. Resume with: node futurus-daily-run.mjs --resume ${runId}`);
      process.exit(1);
    }
  }

  // stageEval: soft-fail — deliver success + eval failure = overall still completed
  try {
    manifest = await stageEval(runDir, manifest, dryRun);
  } catch (err) {
    console.error('[eval] Soft-fail: ' + err.message);
    // eval failure does NOT affect overall_status
  }

  manifest.overall_status = 'completed';
  manifest.ended_at = now();
  const byStage = manifest.cost_summary.by_stage;
  manifest.cost_summary.token_total =
    (byStage.analyze?.tokens_in || 0) + (byStage.analyze?.tokens_out || 0) +
    (byStage.report?.tokens_in || 0) + (byStage.report?.tokens_out || 0) +
    (byStage.eval?.tokens_in || 0) + (byStage.eval?.tokens_out || 0);
  manifest.prompt_version = resolvePromptVersion();
  await saveManifest(runDir, manifest);

  console.error(`[run] Run ${runId} completed successfully`);
  console.log(JSON.stringify({ run_id: runId, status: 'completed', run_dir: runDir }));
}

main().catch(err => {
  console.error(`[run] Fatal: ${err.message}`);
  process.exit(1);
});
