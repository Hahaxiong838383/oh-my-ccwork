/**
 * 情景记忆历史对话回填脚本
 * ============================
 * 场景：情景记忆(Phase 1)功能上线晚于历史对话时，历史对话没被抽成 memory_item。
 *       本脚本用现有抽取链路(extractAll)对指定账号的历史 conversation 补跑一遍，
 *       把情景记忆(promise/event/emotion/relation/preference)补写进 memory_item。
 *
 * 特性：
 *   - 只回填【情景记忆】(episodic.items)，不动画像(profile)，不改约定兑现/兴趣撤销状态。
 *   - 回填条目统一打 source='backfill'，可一键回滚：
 *       DELETE FROM memory_item WHERE account_id=? AND source='backfill';
 *   - 绕过 extractAndPersist 的「没建档不抽」限制(直接调 extractAll)，未建档账号也能回填。
 *   - UNIQUE(account,type,content) 去重 + ON CONFLICT DO NOTHING，多跑幂等不重复。
 *   - 默认 DRY RUN(只抽取展示不写库)；写库须显式 DRY_RUN=0。
 *
 * 用法(在 apps/server 目录下)：
 *   # 试跑(不写库)
 *   node --experimental-sqlite --env-file=.env.local --import tsx scripts/backfill-episodic-memory.ts <account_id>
 *   # 真写库(务必先备份 data/profile.db)
 *   DRY_RUN=0 node --experimental-sqlite --env-file=.env.local --import tsx scripts/backfill-episodic-memory.ts <account_id>
 *
 * 注意：历史 promise 的 due 时间词("明天/周五")会按【当前时间】解析，due 语义会偏——
 *       如需精确可后续对 backfill 的 promise 单独清 due。
 */
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractAll } from '../src/memory-extractor.js';
import { memoryItemStore } from '../src/memory-item-store.js';
import { profileStore } from '../src/profile-store.js';

const ACCT = process.argv[2];
if (!ACCT) {
  console.error('用法: backfill-episodic-memory.ts <account_id>  (写库加 DRY_RUN=0)');
  process.exit(1);
}
const DRY = process.env.DRY_RUN !== '0';
const WIN = 6; // 每 6 条(3 轮)一窗，与生产抽取窗口(EXTRACT_EVERY_TURNS*2)一致

const convDbPath = resolve(process.cwd(), 'data/conversation.db');
const conv = new DatabaseSync(convDbPath, { readOnly: true });
const msgs = conv
  .prepare("SELECT role, text FROM conversation WHERE account_id=? AND text<>'' ORDER BY ts")
  .all(ACCT) as Array<{ role: 'user' | 'assistant'; text: string }>;
console.log(`[backfill] acct=${ACCT} 共 ${msgs.length} 条对话 | 模式=${DRY ? 'DRY RUN(不写库)' : '写库'}`);

let current: any = profileStore.getProfile(ACCT);
if (!current) {
  current = { account_id: ACCT, nickname: '', birthday: '', gender: '', interests: [], preferred_address: '', personality_notes: '', recent_emotion: '', game_progress: [], created_at: 0, updated_at: 0 };
}

let calls = 0;
let added = 0;
const collected: Array<{ type: string; content: string }> = [];
let winIdx = 0;
for (let i = 0; i + 2 <= msgs.length; i += WIN) {
  const win = msgs.slice(i, i + WIN).map((m) => ({ role: m.role, content: m.text }));
  if (!win.some((w) => w.role === 'user')) continue;
  winIdx++;
  try {
    const { episodic } = await extractAll(win, current, { sessionId: `backfill-${ACCT}`, activePromises: [] });
    calls++;
    if (episodic && episodic.items.length) {
      if (DRY) {
        collected.push(...episodic.items.map((it) => ({ type: it.type, content: it.content })));
      } else {
        added += memoryItemStore.addItems(ACCT, episodic.items.map((it) => ({ ...it, source: 'backfill' })));
      }
    }
  } catch (e) {
    console.error(`  窗${winIdx}失败: ${(e as Error).message}`);
  }
  if (winIdx % 25 === 0) console.error(`  进度: ${winIdx} 窗`);
}

console.log(`\n=== ${DRY ? 'DRY RUN' : '回填'}完成: ${calls} 次抽取 ===`);
if (DRY) {
  const byType: Record<string, number> = {};
  for (const it of collected) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(`预计可抽 ${collected.length} 条(未去重): ${JSON.stringify(byType)}`);
  for (const it of collected) console.log(`  [${it.type}] ${it.content}`);
} else {
  const { items, archived_emotion_count } = memoryItemStore.listByAccount(ACCT);
  const byType: Record<string, number> = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(`净写入(去重后): ${added} | memory_item 现存 ${items.length} 条(归档emotion ${archived_emotion_count})`);
  console.log(`类型分布: ${JSON.stringify(byType)}`);
}
