// 记忆列表视图：五类分组（约定 → 画像卡 → 情绪 → 重要的人 → 偏好 → 最近的事）+
// 条目展开细节（来源引用/日期/来源/注入状态）+ 删除/标记兑现（破坏操作一律内联二次确认）。
import { Fragment, useMemo, useState } from 'react';
import { useKidsHubStore } from '../../store/kidshub-store';
import { deleteInterest, deleteMemory, resolveMemory } from './memory-api';
import { INJECT_RECENT_MS, TYPE_META, TYPE_ORDER } from './types';
import type { MemoryItemView, MemoryTypeKey, ProfileView } from './types';

interface MemoryListProps {
  items: MemoryItemView[];
  profile: ProfileView | null;
  serverNow: number;
  archivedEmotionCount: number;
  /** 3s 高亮的新记忆 id（useMemoryData diff 产出） */
  newIds: Set<string>;
  /** 任何写操作成功后调用（回源刷新） */
  onRefresh: () => void;
}

/** 时间戳 → MM-DD（本地时区） */
function formatMMDD(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** 两个时间戳是否同一天（本地时区） */
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** birthday（YYYY-MM）→ 周岁；格式坏/未来值 → null 不显示 */
function calcAge(birthday: string, now: number): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(birthday);
  if (!m) return null;
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const d = new Date(now);
  let age = d.getFullYear() - by;
  if (d.getMonth() + 1 < bm) age -= 1;
  return age >= 0 ? age : null;
}

/** promise 兑现状态徽章（resolved → due_at 当天/过期/未来 → next_session → 无） */
function promiseBadge(it: MemoryItemView, serverNow: number): { text: string; cls: string } | null {
  if (it.status === 'resolved') {
    return { text: '✓ 已兑现', cls: 'bg-emerald-500/10 text-emerald-400/70' };
  }
  if (it.status !== 'active') return null;
  if (it.due_at !== null) {
    if (isSameDay(it.due_at, serverNow)) return { text: '今天该兑现', cls: 'bg-red-500/15 text-red-300' };
    if (it.due_at < serverNow) return { text: '已过期', cls: 'bg-amber-500/15 text-amber-300' };
    return { text: `${formatMMDD(it.due_at)} 兑现`, cls: 'bg-white/5 text-neutral-400' };
  }
  if (it.due_granularity === 'next_session') {
    return { text: '下次见面', cls: 'bg-white/5 text-neutral-400' };
  }
  return null;
}

export function MemoryList({ items, profile, serverNow, archivedEmotionCount, newIds, onRefresh }: MemoryListProps) {
  // 按类型分组；promise 组 resolved 排 active 之后，组内一律 created_at 降序
  const groups = useMemo(() => {
    const map = new Map<MemoryTypeKey, MemoryItemView[]>();
    for (const key of TYPE_ORDER) map.set(key, []);
    for (const it of items) map.get(it.type)?.push(it);
    for (const [key, list] of map) {
      list.sort((a, b) => {
        if (key === 'promise') {
          const ra = a.status === 'resolved' ? 1 : 0;
          const rb = b.status === 'resolved' ? 1 : 0;
          if (ra !== rb) return ra - rb;
        }
        return b.created_at - a.created_at;
      });
    }
    return map;
  }, [items]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {TYPE_ORDER.map((key) => (
        <Fragment key={key}>
          <MemoryGroup
            type={key}
            list={groups.get(key) ?? []}
            serverNow={serverNow}
            archivedEmotionCount={key === 'emotion' ? archivedEmotionCount : 0}
            newIds={newIds}
            onRefresh={onRefresh}
          />
          {/* 画像卡插在约定组之后 */}
          {key === 'promise' && profile && (
            <ProfileCard profile={profile} serverNow={serverNow} onRefresh={onRefresh} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ---------- 类型分组 ----------

function MemoryGroup({
  type,
  list,
  serverNow,
  archivedEmotionCount,
  newIds,
  onRefresh,
}: {
  type: MemoryTypeKey;
  list: MemoryItemView[];
  serverNow: number;
  archivedEmotionCount: number;
  newIds: Set<string>;
  onRefresh: () => void;
}) {
  const meta = TYPE_META[type];
  // 空组隐藏（情绪组例外：有归档计数时仍渲染，展示「淡忘归档」机制）
  if (list.length === 0 && archivedEmotionCount === 0) return null;

  // 计数：promise 无上限显示「N 待兑现」，其余显示「N/cap」
  const countText =
    type === 'promise'
      ? `${list.filter((it) => it.status === 'active').length} 待兑现`
      : `${list.length}/${meta.cap ?? '∞'}`;

  return (
    <div>
      {/* 组头：emoji + label + 计数 + 类型学小标签（情景/语义 · 生命周期） */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] leading-none">{meta.emoji}</span>
          <span className="font-medium text-neutral-300">{meta.label}</span>
          <span className="text-[10px] text-neutral-500">{countText}</span>
        </div>
        <span className="shrink-0 text-[10px] text-neutral-600">
          {meta.taxonomy.replace('记忆', '')}·{meta.lifecycle}
        </span>
      </div>

      <div className="mt-1.5 flex flex-col gap-1.5">
        {list.map((it) => (
          <MemoryItemCard key={it.id} item={it} serverNow={serverNow} isNew={newIds.has(it.id)} onRefresh={onRefresh} />
        ))}
      </div>

      {/* 情绪组尾：30 天淡忘归档说明 */}
      {type === 'emotion' && archivedEmotionCount > 0 && (
        <div className="mt-1.5 text-[10px] text-neutral-600">30 天前的 {archivedEmotionCount} 条已淡忘归档</div>
      )}
    </div>
  );
}

// ---------- 单条记忆卡 ----------

function MemoryItemCard({
  item,
  serverNow,
  isNew,
  onRefresh,
}: {
  item: MemoryItemView;
  serverNow: number;
  isNew: boolean;
  onRefresh: () => void;
}) {
  const token = useKidsHubStore((s) => s.token);
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const meta = TYPE_META[item.type];
  const badge = item.type === 'promise' ? promiseBadge(item, serverNow) : null;
  // 「小可现在记着」= 近期注入过 prompt（用 server_now 算，避免客户端时钟偏差）
  const injectedRecently = item.last_injected_at > 0 && serverNow - item.last_injected_at < INJECT_RECENT_MS;

  const runOp = async (op: (token: string) => Promise<unknown>) => {
    if (!token || busy) return;
    setBusy(true);
    setOpError(null);
    try {
      await op(token);
      onRefresh();
    } catch {
      setOpError('操作失败，请重试');
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div
      className={`rounded-lg border bg-white/[0.03] transition-colors duration-500 ${
        isNew ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-white/10'
      }`}
    >
      {/* 摘要行：色点 + 内容 + 徽章，点击展开细节 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-1.5 px-2.5 py-2 text-left"
      >
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotCls}`} />
        <span className="min-w-0 flex-1 break-words leading-snug text-neutral-200">{item.content}</span>
        {badge && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none ${badge.cls}`}>{badge.text}</span>
        )}
      </button>

      {/* 展开细节：来源引用 + 元信息 + 操作 */}
      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-white/5 px-2.5 py-2">
          {item.source_quote !== '' && (
            <div className="border-l-2 border-white/15 pl-2 text-[11px] leading-snug text-neutral-400">
              来自{item.source_role === 'assistant' ? '小可' : '孩子'}:"{item.source_quote}"
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-500">
            <span>{formatMMDD(item.created_at)}</span>
            <span>{item.source === 'manual' ? '手动添加' : '对话抽取'}</span>
            {injectedRecently && <span className="text-emerald-400">● 小可现在记着</span>}
          </div>

          {/* 操作区：promise active 多一个「标记已兑现」；删除必须内联二次确认 */}
          <div className="flex items-center gap-2 pt-0.5">
            {item.type === 'promise' && item.status === 'active' && !confirmingDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void runOp((t) => resolveMemory(t, item.id))}
                className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                ✓ 标记已兑现
              </button>
            )}
            {confirmingDelete ? (
              <span className="flex items-center gap-1.5 text-[10px] text-red-300">
                确认删除?
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runOp((t) => deleteMemory(t, item.id))}
                  className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                >
                  是
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded border border-white/10 px-2 py-0.5 text-neutral-400 hover:bg-white/5 disabled:opacity-50"
                >
                  否
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
                className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-white/5 hover:text-red-300 disabled:opacity-50"
              >
                删除
              </button>
            )}
          </div>
          {opError && <div className="text-[10px] text-red-400">{opError}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- 孩子画像卡（语义记忆：昵称/年龄/性别 + 兴趣 chips） ----------

function ProfileCard({
  profile,
  serverNow,
  onRefresh,
}: {
  profile: ProfileView;
  serverNow: number;
  onRefresh: () => void;
}) {
  const token = useKidsHubStore((s) => s.token);
  // 待二次确认删除的兴趣值（一次只确认一个）
  const [confirmValue, setConfirmValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const age = calcAge(profile.birthday, serverNow);

  const removeInterest = async (value: string) => {
    if (!token || busy) return;
    setBusy(true);
    setOpError(null);
    try {
      await deleteInterest(token, value);
      onRefresh();
    } catch {
      setOpError('删除失败，请重试');
    } finally {
      setBusy(false);
      setConfirmValue(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] leading-none">🧒</span>
          <span className="font-medium text-neutral-300">孩子画像</span>
        </div>
        <span className="shrink-0 text-[10px] text-neutral-600">语义·稳定保留</span>
      </div>

      {/* 昵称 · 年龄 · 性别（birthday 为空/坏格式时省略年龄） */}
      <div className="mt-1.5 text-neutral-200">
        {profile.nickname}
        {age !== null && <span className="text-neutral-400"> · {age} 岁</span>}
        {profile.gender !== '' && <span className="text-neutral-400"> · {profile.gender}</span>}
      </div>

      {/* 兴趣 chips：× → 内联确认 → 删除 */}
      {profile.interests.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {profile.interests.map((interest) =>
            confirmValue === interest.value ? (
              <span
                key={interest.value}
                className="flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300"
              >
                删除"{interest.value}"?
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeInterest(interest.value)}
                  className="font-medium hover:text-red-200 disabled:opacity-50"
                >
                  是
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmValue(null)}
                  className="text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                >
                  否
                </button>
              </span>
            ) : (
              <span
                key={interest.value}
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-neutral-300"
              >
                {interest.value}
                <button
                  type="button"
                  onClick={() => setConfirmValue(interest.value)}
                  title="删除这个兴趣"
                  className="text-neutral-500 hover:text-red-300"
                >
                  ×
                </button>
              </span>
            ),
          )}
        </div>
      )}
      {opError && <div className="mt-1 text-[10px] text-red-400">{opError}</div>}
    </div>
  );
}
