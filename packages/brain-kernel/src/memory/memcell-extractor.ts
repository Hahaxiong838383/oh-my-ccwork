import { createHash } from 'node:crypto';
import type {
  MemCell,
  EpisodicTrace,
  AtomicFact,
  ForesightSignal,
  AgentCase,
} from '@evodesk/shared';

// ============================================================
// Domain 白名单 + 归一化
// ============================================================

const VALID_DOMAINS = [
  'coding', 'system', 'preference', 'product', 'ops',
  'security', 'decision', 'knowledge', 'personal', 'general',
] as const;

const DOMAIN_ALIASES: Record<string, string> = {
  '技术': 'coding', '代码': 'coding', 'code': 'coding', 'programming': 'coding',
  '运维': 'ops', 'devops': 'ops', '部署': 'ops', 'deploy': 'ops', 'infrastructure': 'ops',
  '安全': 'security', '产品': 'product', '偏好': 'preference', 'pref': 'preference',
  '决策': 'decision', '知识': 'knowledge', '个人': 'personal', 'user': 'personal',
  '系统': 'system', 'config': 'system', '配置': 'system',
};

function normalizeDomain(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (DOMAIN_ALIASES[lower]) return DOMAIN_ALIASES[lower];
  if ((VALID_DOMAINS as readonly string[]).includes(lower)) return lower;
  return 'general';
}

interface ExtractInput {
  readonly sessionId: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

interface ExtractResult {
  readonly memCell: MemCell;
  readonly model: string;
  readonly latencyMs: number;
}

interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
}

const SYSTEM_PROMPT = `你是 EvoDesk 的记忆提取引擎。从对话中提取四类信息，输出严格的 JSON。

## 四类信息

1. **episodicTraces** — 情景记忆：发生了什么事件
   - event: 事件描述（一句话）
   - context: 上下文背景
   - timestamp: 0（由调用方填充）

2. **atomicFacts** — 原子事实：可独立验证的知识
   - statement: 事实陈述
   - domain: 所属领域，必须从以下白名单中选择：
     coding | system | preference | product | ops | security | decision | knowledge | personal | general
   - confidence: 0.0-1.0 置信度
   - source: 信息来源（"user"、"observation"、"inference"）

3. **foresightSignals** — 预见信号：值得关注的趋势
   - signal: 信号描述
   - relevance: 0.0-1.0 相关度
   - detectedAt: 0（由调用方填充）

4. **agentCases** — 行为案例：做了什么、结果如何
   - action: 采取的动作
   - outcome: "success" | "failure" | "partial"
   - lesson: 经验教训

## 输出格式

\`\`\`json
{
  "episodicTraces": [...],
  "atomicFacts": [...],
  "foresightSignals": [...],
  "agentCases": []
}
\`\`\`

规则：
- 每类 0-5 条，宁缺毋滥
- 无可提取信息时返回空数组
- 只输出 JSON，不要其他内容`;

function buildUserPrompt(messages: ExtractInput['messages']): string {
  const recent = messages.slice(-6);
  return recent.map(m => `${m.role}: ${m.content}`).join('\n');
}

function extractJson(raw: string): unknown {
  let text = raw.trim();

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();

  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) throw new Error('no JSON found');
  text = text.slice(start);

  let depth = 0;
  let inStr = false;
  let escaped = false;
  let endPos = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { endPos = i; break; }
    }
  }

  if (endPos > 0) text = text.slice(0, endPos + 1);

  return JSON.parse(text);
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(v, 0), 1)
    : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeArray(obj: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const arr = obj[key];
  return Array.isArray(arr) ? arr.filter(isRecord) : [];
}

function parseMemCell(raw: unknown, sessionId: string, now: number): Omit<MemCell, 'id' | 'contentHash'> {
  if (!isRecord(raw)) throw new Error('LLM output is not an object');
  const obj = raw;

  const episodicTraces: EpisodicTrace[] = safeArray(obj, 'episodicTraces')
    .filter(t => t.event)
    .map((t): EpisodicTrace => ({
      event: String(t.event),
      context: String(t.context ?? ''),
      timestamp: now,
    }));

  const atomicFacts: AtomicFact[] = safeArray(obj, 'atomicFacts')
    .filter(f => f.statement)
    .map((f): AtomicFact => ({
      statement: String(f.statement),
      domain: normalizeDomain(String(f.domain ?? 'general')),
      confidence: clamp01(f.confidence, 0.5),
      source: String(f.source ?? 'observation'),
    }));

  const foresightSignals: ForesightSignal[] = safeArray(obj, 'foresightSignals')
    .filter(s => s.signal)
    .map((s): ForesightSignal => ({
      signal: String(s.signal),
      relevance: clamp01(s.relevance, 0.5),
      detectedAt: now,
    }));

  const agentCases: AgentCase[] = safeArray(obj, 'agentCases')
    .filter(c => c.action)
    .map((c): AgentCase => ({
      action: String(c.action),
      outcome: (['success', 'failure', 'partial'].includes(String(c.outcome)) ? String(c.outcome) : 'partial') as AgentCase['outcome'],
      lesson: String(c.lesson ?? ''),
    }));

  return { sessionId, episodicTraces, atomicFacts, foresightSignals, agentCases, createdAt: now };
}

function contentHash(cell: Omit<MemCell, 'id' | 'contentHash'>): string {
  const payload = JSON.stringify({
    episodicTraces: cell.episodicTraces,
    atomicFacts: cell.atomicFacts,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function getLlmConfig(): LlmConfig | null {
  const baseUrl = process.env.EVODESK_LLM_BASE_URL;
  const apiKey = process.env.EVODESK_LLM_API_KEY;
  const model = process.env.EVODESK_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  const maxTokens = parseInt(process.env.EVODESK_LLM_MAX_TOKENS ?? '4096', 10);
  return { baseUrl, apiKey, model, maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4096 };
}

export async function extractMemCell(input: ExtractInput, config: LlmConfig): Promise<ExtractResult> {
  const startMs = Date.now();
  const userPrompt = buildUserPrompt(input.messages);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: config.maxTokens ?? 2048,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[memcell-extractor] LLM API ${res.status}: ${text.slice(0, 500)}`);
    throw new Error(`LLM extraction failed (status ${res.status})`);
  }

  const json = await res.json() as { choices: { message: { content: string } }[] };
  const content = json.choices[0]?.message?.content ?? '';

  const parsed = extractJson(content);
  const now = Date.now();
  const partial = parseMemCell(parsed, input.sessionId, now);
  const hash = contentHash(partial);

  const memCell: MemCell = {
    id: crypto.randomUUID(),
    ...partial,
    contentHash: hash,
  };

  return { memCell, model: config.model, latencyMs: Date.now() - startMs };
}
