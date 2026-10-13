/**
 * 记忆抽取时机（R5，2026-09-03）：默认 `MEMORY_EXTRACT_MODE=turn`（设备房每轮抽，Web 每 3 轮，行为不变）；
 * `trigger` 模式下（可用 `MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST` 只灰度部分设备）：
 *   ① 孩子这句话含记忆触发词（改称呼/不喜欢/又喜欢/约定/时间词/情绪词/经历词）→ 立刻抽（改名等仍下一轮生效）；
 *   ② 否则攒着，攒满 BATCH_TURNS 轮抽一次（窗口=攒着的这几轮）；
 *   ③ 攒着的轮次 IDLE_MS 内没有新发言（会话空隙/挂断）→ 定时器从 conversation.db 拉出未抽取的那段补抽。
 * 背景：近 14 天 1754 轮/112 场会话，每轮一次 LLM；会话 p50=5 轮、p90=36 轮，规模化后成本差一个量级；
 * VoiceMem/TrueMemory 都把抽取放在轮后/会话末冷路；Tycho 的数字说明「一不一致就重建」是负收益。
 * 灰度判据看 extraction_log 的 note（reason=trigger|batch|idle）与条目产出。
 */
import { conversationStore } from './conversation-store.js';
import { extractAndPersist } from './memory-extractor.js';

export const BATCH_TURNS = 5;
export const IDLE_MS = 3 * 60_000;
const MAX_WINDOW_MESSAGES = 12;
const SWEEP_MS = 60_000;

/** 值得立刻抽的话：改称呼 / 好恶变化 / 约定 / 有时效的事 / 明确情绪 / 经历 / 关系 */
export const TRIGGER_RE =
  /叫我|名字|改名|称呼|不喜欢|讨厌|又喜欢|喜欢上|最喜欢|最爱|答应|约定|说好|记得|明天|后天|下周|周[一二三四五六日天]|考试|比赛|生日|要去|去了|来了|害怕|紧张|难过|生气|开心|伤心|想哭|哭了|妈妈|爸爸|老师|同学|朋友|妹妹|弟弟|哥哥|姐姐/;

export type ExtractMode = 'turn' | 'trigger';
export type Decision = { run: boolean; reason: 'turn' | 'trigger' | 'batch' | 'skip'; windowMessages: number };

type Pending = { count: number; lastTs: number; lastExtractedTs: number };
const _pending = new Map<string, Pending>();

export function extractMode(): ExtractMode {
  return process.env.MEMORY_EXTRACT_MODE?.trim() === 'trigger' ? 'trigger' : 'turn';
}

/** 该账号是否走 trigger 模式（mode=trigger 且（名单为空 或 SN 在名单）；账号形态 device-<SN>）。 */
export function triggerModeFor(accountId: string, role: string): boolean {
  if (extractMode() !== 'trigger' || role !== 'device') return false;
  const raw = process.env.MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST?.trim() ?? '';
  if (!raw) return true;
  const sn = accountId.startsWith('device-') ? accountId.slice('device-'.length) : accountId;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(sn);
}

/** 纯函数：给定模式与攒着的轮数，决定这一轮抽不抽、窗口多大（供单测）。 */
export function decideForTurn(
  opts: { trigger: boolean; role: string; userText: string; userTurnsInHistory: number; pendingCount: number },
): Decision {
  if (!opts.trigger) {
    const every = opts.role === 'device' ? 1 : 3;
    return { run: opts.userTurnsInHistory % every === 0, reason: 'turn', windowMessages: 6 };
  }
  const pending = opts.pendingCount + 1; // 含本轮
  if (TRIGGER_RE.test(opts.userText)) return { run: true, reason: 'trigger', windowMessages: Math.min(MAX_WINDOW_MESSAGES, Math.max(6, pending * 2)) };
  if (pending >= BATCH_TURNS) return { run: true, reason: 'batch', windowMessages: Math.min(MAX_WINDOW_MESSAGES, pending * 2) };
  return { run: false, reason: 'skip', windowMessages: 0 };
}

/** 每轮调用：返回决策并维护攒轮状态。 */
export function onTurn(accountId: string, role: string, userText: string, userTurnsInHistory: number, now = Date.now()): Decision {
  const trigger = triggerModeFor(accountId, role);
  const p = _pending.get(accountId) ?? { count: 0, lastTs: 0, lastExtractedTs: 0 };
  const d = decideForTurn({ trigger, role, userText, userTurnsInHistory, pendingCount: trigger ? p.count : 0 });
  if (trigger) {
    if (d.run) _pending.set(accountId, { count: 0, lastTs: now, lastExtractedTs: now });
    else _pending.set(accountId, { count: p.count + 1, lastTs: now, lastExtractedTs: p.lastExtractedTs });
    if (_pending.size > 1000) _pending.clear();
  }
  return d;
}

/** 单测/诊断：攒轮状态。 */
export function pendingOf(accountId: string): Pending | undefined {
  return _pending.get(accountId);
}
export function resetPending(): void {
  _pending.clear();
}

/**
 * 空隙补抽：攒着的轮次 IDLE_MS 内没新发言 → 从 conversation.db 拉「上次抽取之后」的消息（≤12 条）补抽一次。
 * 返回补抽的账号数。导出供单测与定时器共用。
 */
export async function flushIdle(now = Date.now()): Promise<number> {
  let flushed = 0;
  for (const [acct, p] of _pending) {
    if (p.count <= 0 || now - p.lastTs < IDLE_MS) continue;
    const rows = conversationStore
      .list({ accountId: acct, limit: MAX_WINDOW_MESSAGES })
      .filter((r) => r.ts > p.lastExtractedTs)
      .reverse();
    _pending.set(acct, { count: 0, lastTs: p.lastTs, lastExtractedTs: now });
    if (!rows.length) continue;
    try {
      await extractAndPersist(acct, rows.map((r) => ({ role: r.role, content: r.text, id: r.id })), 'rtc', { reason: 'idle' });
      flushed += 1;
    } catch (err) {
      console.log('[memory] idle 补抽失败(不影响语音):', String((err as Error)?.message ?? err));
    }
  }
  return flushed;
}

// 启动自报模式（运行态真值：/proc 看不到 --env-file 注入的键，只能靠进程自己说）
console.log(`[memory] extract scheduler mode=${extractMode()} allowlist=${JSON.stringify(process.env.MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST?.trim() ?? '')}`);

// 定时扫描（unref：不阻止进程退出，单测不挂）
const _timer = setInterval(() => {
  if (extractMode() !== 'trigger') return;
  void flushIdle();
}, SWEEP_MS);
_timer.unref();
