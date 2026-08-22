#!/usr/bin/env node
/**
 * mycc MCP Hub — handoff-server
 * 跨运行时交接包：让 A 引擎干到一半的活能被 B 引擎接住。
 *
 * 核心设计：字段按**数据来源**劈开，不混为一谈。
 *   - 仓库事实（branch / HEAD / dirty / diffstat）由本 server 直接跑 git 采集，不接受调用方自述；
 *   - 语义部分（目标 / 决策 / 未决 / 下一步 / 禁止事项）由调用方 LLM 填，明确标注为自述。
 * 交接包渲染时两类分区展示，接收方据此判断证据等级，并能靠对照发现自述与事实矛盾。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), '.mycc-mcp', 'handoffs');
fs.mkdirSync(ROOT, { recursive: true });
const audit = m => {
  try { fs.appendFileSync(path.join(os.homedir(), '.mycc-mcp', 'handoff-calls.log'), `${new Date().toISOString()} ${m}\n`); } catch {}
};

let CLIENT = 'unknown';           // 由 initialize 的 clientInfo 填充
const MAX_LIST = 20;

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 4e6,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();   // 屏蔽 stderr，否则非 git 目录会往终端喷 fatal:
  } catch { return null; }
};

/** 机器采集的仓库事实。不在 git 仓库时诚实降级，不编造。 */
function repoFacts(cwd) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { inRepo: false, cwd, note: 'not a git repository — no repo facts available' };
  const porcelain = git(['status', '--porcelain'], cwd) ?? '';
  const dirty = porcelain.split('\n').filter(Boolean).map(l => ({
    status: l.slice(0, 2).trim(), path: l.slice(3)
  }));
  return {
    inRepo: true,
    root,
    cwd,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    head: git(['rev-parse', '--short', 'HEAD'], cwd),
    headSubject: git(['log', '-1', '--pretty=%s'], cwd),
    dirtyCount: dirty.length,
    dirty: dirty.slice(0, 40),
    diffstat: (git(['diff', '--stat'], cwd) ?? '').split('\n').slice(-1)[0] || '(no unstaged changes)',
    stagedstat: (git(['diff', '--cached', '--stat'], cwd) ?? '').split('\n').slice(-1)[0] || '(nothing staged)',
    upstreamGap: (() => {
      const a = git(['rev-list', '--count', '@{u}..HEAD'], cwd);
      const b = git(['rev-list', '--count', 'HEAD..@{u}'], cwd);
      return (a === null || b === null) ? '(no upstream configured)' : `ahead ${a} / behind ${b}`;
    })()
  };
}

const arr = v => (Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? [String(v)] : []));

function capture(a) {
  const objective = String(a.objective || '').trim();
  if (!objective) throw new Error('objective is required — a handoff without a stated goal is not actionable');
  const cwd = a.cwd ? String(a.cwd) : process.cwd();
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:T.]/g, '').slice(0, 17)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;

  const packet = {
    id,
    createdAt: now.toISOString(),
    createdBy: CLIENT,
    selfReported: {
      objective,
      currentState: String(a.current_state || '').trim(),
      decisions: arr(a.decisions),
      openQuestions: arr(a.open_questions),
      nextSteps: arr(a.next_steps),
      risks: arr(a.risks),
      doNotDo: arr(a.do_not_do),
      memoryRefs: arr(a.memory_refs)
    },
    machineCollected: repoFacts(cwd)
  };
  const tmp = path.join(ROOT, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(packet, null, 2));
  fs.renameSync(tmp, path.join(ROOT, `${id}.json`));   // 原子落盘
  return { id, packet };
}

function listIds() {
  return fs.readdirSync(ROOT).filter(f => /^\d{8}-?\d*.*\.json$/.test(f) || f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, '')).sort().reverse();
}

function load(idArg) {
  const ids = listIds();
  if (!ids.length) throw new Error('no handoff packets exist yet — use handoff_capture first');
  let id = idArg ? String(idArg).trim().replace(/\.json$/, '') : ids[0];
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid id ${JSON.stringify(idArg)}`);
  const f = path.join(ROOT, `${id}.json`);
  if (!fs.existsSync(f)) throw new Error(`handoff not found: ${id} (available: ${ids.slice(0, 5).join(', ')})`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const bullets = (t, xs) => (xs.length ? `## ${t}\n${xs.map(x => `- ${x}`).join('\n')}\n\n` : '');

/** 渲染时严格分区：事实区与自述区分开，接收方据此判断证据等级 */
function render(p) {
  const s = p.selfReported, m = p.machineCollected;
  let out = `# HANDOFF ${p.id}\nCreated ${p.createdAt} by ${p.createdBy}\n\n`;
  out += `## Objective\n${s.objective}\n\n`;
  if (s.currentState) out += `## Current state\n${s.currentState}\n\n`;

  out += `## Repo facts — MACHINE-COLLECTED (not self-reported, trust these over the narrative)\n`;
  if (!m.inRepo) {
    out += `${m.note}\ncwd: ${m.cwd}\n\n`;
  } else {
    out += `root:      ${m.root}\nbranch:    ${m.branch} @ ${m.head} "${m.headSubject}"\n`;
    out += `upstream:  ${m.upstreamGap}\nunstaged:  ${m.diffstat}\nstaged:    ${m.stagedstat}\n`;
    out += `dirty:     ${m.dirtyCount} file(s)\n`;
    if (m.dirty.length) out += m.dirty.map(d => `  ${d.status.padEnd(2)} ${d.path}`).join('\n') + '\n';
    if (m.dirtyCount > m.dirty.length) out += `  … ${m.dirtyCount - m.dirty.length} more\n`;
    out += '\n';
  }

  out += `## Below is SELF-REPORTED by ${p.createdBy} — treat as claims, verify against the facts above\n\n`;
  out += bullets('Decisions', s.decisions);
  out += bullets('Open questions', s.openQuestions);
  out += bullets('Next steps', s.nextSteps);
  out += bullets('Risks', s.risks);
  out += bullets('DO NOT', s.doNotDo);
  out += bullets('Memory refs', s.memoryRefs);
  return out.trimEnd();
}

const TOOLS = [
  {
    name: 'handoff_capture',
    description: 'Save a handoff packet so another agent runtime (claude / codex / grok) can pick up this work. '
      + 'Repo facts (branch, HEAD, dirty files, diffstat) are collected automatically by the server — do NOT describe them yourself. '
      + 'You supply only the semantic parts. Call this before switching runtimes or ending a work session.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'what this work is trying to achieve (required)' },
        current_state: { type: 'string', description: 'where things stand right now' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'decisions already made and why' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'unresolved questions' },
        next_steps: { type: 'array', items: { type: 'string' }, description: 'concrete next actions' },
        risks: { type: 'array', items: { type: 'string' } },
        do_not_do: { type: 'array', items: { type: 'string' }, description: 'things the next agent must NOT do' },
        memory_refs: { type: 'array', items: { type: 'string' }, description: 'relevant memory file names' },
        cwd: { type: 'string', description: 'working dir to collect repo facts from (default: server cwd)' }
      },
      required: ['objective']
    }
  },
  {
    name: 'handoff_load',
    description: 'Load a handoff packet left by a previous agent (defaults to the most recent). '
      + 'Read this FIRST when told to continue someone else\'s work.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'packet id; omit for latest' } }, required: [] }
  },
  {
    name: 'handoff_list',
    description: 'List available handoff packets, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] }
  }
];

const send = o => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    CLIENT = params?.clientInfo?.name || 'unknown';
    audit(`initialize client=${CLIENT}`);
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'mycc-handoff', version: '0.1.0' }
    }});
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const a = params?.arguments || {};
    audit(`tools/call ${params?.name} by=${CLIENT}`);
    try {
      let text;
      if (params?.name === 'handoff_capture') {
        const { id: nid, packet } = capture(a);
        text = `Handoff saved as ${nid}.\n\n${render(packet)}`;
      } else if (params?.name === 'handoff_load') {
        text = render(load(a.id));
      } else if (params?.name === 'handoff_list') {
        const ids = listIds().slice(0, Math.min(Number(a.limit) || MAX_LIST, MAX_LIST));
        text = ids.length
          ? ids.map(x => { try { const p = load(x); return `${x}  by ${p.createdBy}  ${p.createdAt}\n    ${p.selfReported.objective.slice(0, 100)}`; } catch { return x; } }).join('\n')
          : 'no handoff packets yet';
      } else throw new Error(`unknown tool: ${params?.name}`);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      audit(`ERROR ${e.message}`);
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
