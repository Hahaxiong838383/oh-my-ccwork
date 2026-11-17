#!/usr/bin/env node
/**
 * mycc MCP Hub — memory-server
 * 把 A canonical 经验库（cc 的跨项目长期记忆）以 MCP 工具形式暴露给三家运行时，
 * 让 codex / grok 也能检索原本只有 cc 读得到的记忆。
 * 只读：不提供任何写入工具。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const MEM_DIR = process.env.MYCC_MEMORY_DIR
  || path.join(os.homedir(), '.claude/projects/-home-hahaxiong83-mycc/memory');
const RG = process.env.MYCC_RG || 'rg';
const MAX_DESC = 240;
const MAX_SNIPPET = 200;
const DEFAULT_LIMIT = 8;
const HARD_LIMIT = 25;

// 旧库（B / EvoMap 的 memory-items.md）：2026-09-24 起一并检索。实测它有 A 没有的近期事实（codex/grok 写在这里），
// 只查 A 会漏；只查它又会漏 A 的教训（8-30 codex 实例）。条目级返回，带行号与条目里的日期，调用方自己按日期比新旧。
const LEGACY_ITEMS = process.env.MYCC_LEGACY_ITEMS
  || path.join(os.homedir(), '.mycc-global/0-System/memory-items.md');
const LEGACY_MAX = 8;

const LOGDIR = path.join(os.homedir(), '.mycc-mcp');
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch {}
const audit = m => {
  try { fs.appendFileSync(path.join(LOGDIR, 'memory-calls.log'), `${new Date().toISOString()} ${m}\n`); } catch {}
};

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** frontmatter 解析；817/860 有 name、799/860 有 description，缺失一律 fallback 到文件名 */
function meta(file) {
  const base = path.basename(file, '.md');
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 3000);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { name: base, description: '' };
    const name = (m[1].match(/^name:[ \t]*(.+)$/m) || [])[1]?.trim() || base;
    const desc = (m[1].match(/^description:[ \t]*(.+)$/m) || [])[1]?.trim() || '';
    return { name, description: desc };
  } catch { return { name: base, description: '' }; }
}

/** rg 退出码：0=有匹配 1=无匹配（正常，非错误） 2=真错误 —— 必须区分，否则"没搜到"会被当成故障 */
function rg(args) {
  try {
    return execFileSync(RG, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 8e6 });
  } catch (e) {
    if (e.status === 1) return '';
    throw new Error(`rg failed (status=${e.status}): ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}

const rgList = q => rg(['-l', '-i', '--no-messages', '-g', '*.md', '--', q, MEM_DIR]).split('\n').filter(Boolean);

/**
 * 渐进降级检索。多关键词查询若只做短语匹配会产生系统性假阴性——
 * 而"搜过了没有"会被下游当成结论，比没有这个工具更危险。
 * 因此：短语 → 全词都命中 → 任一词命中，并把实际生效的模式回给调用方。
 */
function searchFiles(query) {
  const literal = rgList(query);
  if (literal.length) return { files: literal, mode: 'phrase' };

  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length < 2) return { files: [], mode: 'phrase' };

  let acc = null;
  for (const t of terms) {
    const cur = new Set(rgList(t));
    acc = acc === null ? cur : new Set([...acc].filter(x => cur.has(x)));
    if (!acc.size) break;
  }
  if (acc && acc.size) return { files: [...acc], mode: `all-terms(${terms.length})` };

  const any = rgList(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  return { files: any, mode: any.length ? `any-term(${terms.length})` : 'none' };
}

const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 旧库条目级检索：同样「短语 → 全词 → 任一词」降级，只收条目行（- 开头）与小节标题（### 开头）。 */
function searchLegacy(query) {
  if (!fs.existsSync(LEGACY_ITEMS)) return { hits: [], mode: 'missing' };
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const probe = terms.length > 1 ? terms.map(escRe).join('|') : query;
  const lines = rg(['-n', '-i', '--no-heading', '--', probe, LEGACY_ITEMS]).split('\n').filter(Boolean)
    .map(l => { const k = l.indexOf(':'); return { no: Number(l.slice(0, k)), text: l.slice(k + 1).trim() }; })
    .filter(x => /^(- |### )/.test(x.text));
  const has = (s, t) => new RegExp(t, 'i').test(s);
  let hits = lines.filter(x => has(x.text, query.trim().split(/\s+/).length > 1 ? escRe(query.trim()) : query));
  if (hits.length) return { hits, mode: 'phrase' };
  if (terms.length < 2) return { hits: [], mode: 'phrase' };
  hits = lines.filter(x => terms.every(t => has(x.text, escRe(t))));
  if (hits.length) return { hits, mode: `all-terms(${terms.length})` };
  return { hits: lines, mode: lines.length ? `any-term(${terms.length})` : 'none' };
}

function legacySection(query) {
  let r;
  try { r = searchLegacy(query); }
  catch (e) { return `\n\n--- legacy memory-items: search failed (${clip(e.message, 160)}) ---`; }
  if (r.mode === 'missing') return `\n\n--- legacy memory-items: file not present on this machine (${LEGACY_ITEMS}) ---`;
  if (!r.hits.length) return `\n\n--- legacy memory-items (${LEGACY_ITEMS}): no entry matched ---`;
  const shown = r.hits.slice(0, LEGACY_MAX).map(x => {
    const date = (x.text.match(/20\d\d-\d\d-\d\d/) || [])[0];
    return `  [L${x.no}]${date ? ` (${date})` : ''} ${clip(x.text, MAX_SNIPPET + 60)}`;
  }).join('\n');
  return `\n\n--- legacy memory-items (${LEGACY_ITEMS}): ${r.hits.length} entr${r.hits.length > 1 ? 'ies' : 'y'} matched ` +
         `[match mode: ${r.mode}]; showing ${Math.min(LEGACY_MAX, r.hits.length)} ---\n` +
         `  Older store, diverged between machines and possibly stale, but it holds recent facts A lacks. ` +
         `If it conflicts with A, trust the newer dated statement and say so.\n${shown}`;
}

function search(query, limit) {
  const n = Math.min(Math.max(1, limit || DEFAULT_LIMIT), HARD_LIMIT);
  const { files, mode } = searchFiles(query);
  const total = fs.readdirSync(MEM_DIR).filter(f => f.endsWith('.md')).length;
  const legacy = legacySection(query);
  if (!files.length) {
    return `No A-canonical memory matched ${JSON.stringify(query)} — tried phrase, all-terms and any-term ` +
           `(index holds ${total} files).${legacy}`;
  }
  const picked = files.slice(0, n);
  const out = picked.map((f, i) => {
    const { name, description } = meta(f);
    let snip = '';
    try {
      const probe = mode === 'phrase' ? query : query.trim().split(/\s+/).filter(Boolean)
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      snip = rg(['-i', '-m', '2', '--no-heading', '-N', '--', probe, f])
        .split('\n').filter(Boolean).map(l => clip(l.trim(), MAX_SNIPPET)).join('\n      ');
    } catch { /* 单文件片段失败不应让整次检索失败 */ }
    return `[${i + 1}] ${path.basename(f)}\n` +
           `    name: ${name}\n` +
           (description ? `    desc: ${clip(description, MAX_DESC)}\n` : '') +
           (snip ? `    hit:  ${snip}\n` : '');
  }).join('\n');
  const more = files.length > picked.length
    ? `\n… ${files.length - picked.length} more matched but not listed (limit=${n}).`
    : '';
  return `${files.length} file(s) matched ${JSON.stringify(query)} [match mode: ${mode}]; showing ${picked.length}.\n\n${out}${more}\n` +
         `Use memory_read with a file name to get full text.${legacy}`;
}

/** 双重路径校验：字符白名单 + realpath 前缀，防路径遍历 */
function read(nameArg) {
  const base = String(nameArg || '').trim().replace(/\.md$/i, '');
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error(`invalid name ${JSON.stringify(nameArg)} — only [A-Za-z0-9._-] allowed`);
  }
  const target = path.join(MEM_DIR, base + '.md');
  const rootReal = fs.realpathSync(MEM_DIR);
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error(`memory not found: ${base}.md`); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error('path escapes memory dir');
  }
  const body = fs.readFileSync(real, 'utf8');
  return body.length > 60000 ? body.slice(0, 60000) + '\n\n…[truncated at 60000 chars]' : body;
}

const TOOLS = [
  {
    name: 'memory_search',
    description: "Search cc's long-term memory (A canonical: cross-project lessons, project facts, references) "
      + 'AND the legacy shared store 0-System/memory-items.md (entry-level, with line numbers and dates). '
      + 'Use this before debugging a third-party tool, repeating a past decision, or asking the user for facts '
      + 'that may already be recorded. Returns A file names + descriptions + matching lines, then legacy entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'regex or keywords (case-insensitive); Chinese works' },
        limit: { type: 'number', description: `max files to list (default ${DEFAULT_LIMIT}, max ${HARD_LIMIT})` }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_read',
    description: 'Read one memory file in full by its file name (as returned by memory_search).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'file name, e.g. feedback_probe_off_path' } },
      required: ['name']
    }
  }
];

const send = o => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    audit(`initialize client=${params?.clientInfo?.name || '?'}`);
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mycc-memory', version: '0.1.0' }
    }});
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const a = params?.arguments || {};
    audit(`tools/call ${params?.name} ${JSON.stringify(a).slice(0, 200)}`);
    try {
      let text;
      if (params?.name === 'memory_search') text = search(String(a.query ?? ''), Number(a.limit));
      else if (params?.name === 'memory_read') text = read(a.name);
      else throw new Error(`unknown tool: ${params?.name}`);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      audit(`ERROR ${e.message}`);
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
