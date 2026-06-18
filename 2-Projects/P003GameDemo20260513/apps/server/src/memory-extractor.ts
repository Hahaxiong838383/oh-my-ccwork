import { type MemoryPatch, type FamilyMember } from './profile-store.js';

// P1.2 语音对话画像异步抽取：从近几轮对话抽取孩子的【长期画像更新】（改名/兴趣/性格/情绪），
// 产出 MemoryPatch 写回 profile-store（由 pipeline 出主链路异步调用，失败不影响语音）。
// 设计要点（team 评审）：只抽孩子明确表达的稳定信息（不臆测）；改名/兴趣做矛盾检测与合并；
// 字段长度限制防膨胀；抽取 LLM 任何异常都返回 null（降级=不更新，不阻断）。

type ChatTurn = { role: 'user' | 'assistant'; content: string };

const EXTRACT_SYSTEM =
  '你是儿童陪伴 AI「小可」的记忆抽取器。从孩子与小可的对话里，抽取孩子的【长期画像更新】，' +
  '只抽孩子自己明确表达的、稳定的信息，不要臆测，不要把一次性的对话内容当画像。\n' +
  '严格输出 JSON（没有任何更新就输出 {}）：\n' +
  '{\n' +
  '  "nickname": "孩子明确要求改的称呼/名字（如说「叫我XX」「我叫XX」「我的名字是XX」），否则省略",\n' +
  '  "interests": ["孩子明确表达喜欢/热爱的（如恐龙、奥特曼），否则省略"],\n' +
  '  "personality_notes": "明显的性格观察（谨慎，否则省略）",\n' +
  '  "recent_emotion": "近期情绪锚点（如「考试没考好难过」，否则省略）"\n' +
  '}\n' +
  '只返回 JSON 本身，不要解释、不要 markdown 代码块。';

// 非流式调 gemini 网关抽取（与对话同网关/key）。任何失败返回 null（不阻断、不更新）。
async function callExtractLlm(prompt: string): Promise<string | null> {
  const proxyUrl = process.env.GEMINI_PROXY_URL;
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_DEFAULT_MODEL ?? 'gemini-2.5-flash-lite';
  if (!proxyUrl || !apiKey) return null;
  try {
    const res = await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0, // 抽取要确定性
        max_tokens: 512,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * 从对话历史抽取画像更新。返回 MemoryPatch（无更新返回 null）。
 * @param history 近几轮对话（user=孩子 / assistant=小可）
 * @param current 当前画像（用于矛盾检测：改名/兴趣是否真变化）
 */
export async function extractMemoryUpdate(
  history: ChatTurn[],
  current: FamilyMember,
): Promise<MemoryPatch | null> {
  if (!history.length) return null;
  const convo = history.map((t) => `${t.role === 'user' ? '孩子' : '小可'}: ${t.content}`).join('\n');
  const known = `已知画像：昵称=${current.nickname || '未知'}，兴趣=${current.interests.map((i) => i.value).join('/') || '无'}`;
  const raw = await callExtractLlm(`${known}\n\n对话：\n${convo}`);
  if (!raw) return null;
  return parsePatch(raw, current);
}

// 解析 LLM 输出 JSON → MemoryPatch，并做矛盾检测/合并/字段长度限制。导出供单测。
export function parsePatch(raw: string, current: FamilyMember): MemoryPatch | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const patch: MemoryPatch = {};

  // 改名（矛盾检测）：新名非空且 ≠ 旧名才更新。这是「语音改名打通」的核心。
  if (typeof obj.nickname === 'string') {
    const n = clip(obj.nickname, 20);
    if (n && n !== current.nickname) patch.nickname = n;
  }

  // 兴趣：合并去重（新表达的兴趣加入，已有的不重复）。
  if (Array.isArray(obj.interests) && obj.interests.length) {
    const now = nowMs();
    const seen = new Set(current.interests.map((i) => i.value));
    const merged = [...current.interests];
    for (const v of obj.interests) {
      if (typeof v === 'string') {
        const val = clip(v, 20);
        if (val && !seen.has(val)) {
          seen.add(val);
          merged.push({ value: val, confidence: 0.7, last_updated: now, source: 'voice' });
        }
      }
    }
    if (merged.length !== current.interests.length) patch.interests = merged;
  }

  if (typeof obj.personality_notes === 'string') {
    const p = clip(obj.personality_notes, 200);
    if (p && p !== current.personality_notes) patch.personality_notes = p;
  }
  if (typeof obj.recent_emotion === 'string') {
    const e = clip(obj.recent_emotion, 200);
    if (e) patch.recent_emotion = e;
  }

  return Object.keys(patch).length ? patch : null;
}

function clip(raw: string, max: number): string {
  return raw
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(code < 0x20 || code === 0x7f);
    })
    .join('')
    .trim()
    .slice(0, max);
}

// 包一层便于单测（避免直接散用 Date.now）。
function nowMs(): number {
  return Date.now();
}
