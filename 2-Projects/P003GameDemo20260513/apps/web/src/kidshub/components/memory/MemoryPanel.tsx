// 记忆面板容器：顶部状态条（注入指示 + 列表⇄图谱切换 + 刷新 + 添加）+
// 主体（列表 / 图谱）+ 底部「记忆机制」折叠区（MemoryPipeline）。
// 仅在 tab 激活时被 mount，卸载即停 useMemoryData 轮询。
import { useMemo, useState } from 'react';
import { useMemoryData } from './memory-api';
import { MemoryList } from './MemoryList';
import { MemoryAddForm } from './MemoryAddForm';
import { MemoryGraph } from './MemoryGraph';
import { MemoryPipeline } from './MemoryPipeline';
import { INJECT_RECENT_MS } from './types';

type ViewMode = 'list' | 'graph';

export function MemoryPanel() {
  const { data, loading, error, refresh, newIds } = useMemoryData();
  const [view, setView] = useState<ViewMode>('list');
  const [showAdd, setShowAdd] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);

  const items = data?.items ?? [];
  const profile = data?.profile ?? null;
  const serverNow = data?.server_now ?? Date.now();

  // 「本轮已注入」= 近 INJECT_RECENT_MS 内注入过 prompt 的条数（以 server_now 为准，避免客户端时钟偏差）
  const injectedCount = useMemo(
    () =>
      items.filter((it) => it.last_injected_at > 0 && serverNow - it.last_injected_at < INJECT_RECENT_MS).length,
    [items, serverNow],
  );

  // 图谱只吃 active/resolved（archived 等不参与实体计算）
  const graphItems = useMemo(
    () => items.filter((it) => it.status === 'active' || it.status === 'resolved'),
    [items],
  );

  // 全空态：没有任何记忆条目且画像无兴趣
  const isEmpty = !loading && data !== null && items.length === 0 && (profile?.interests.length ?? 0) === 0;

  const handleSaved = () => {
    setShowAdd(false);
    void refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 text-xs text-neutral-200">
      {/* 状态条：左注入指示，右视图切换 + 刷新 + 添加 */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px]">
          {injectedCount > 0 ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-emerald-300">本轮已注入 {injectedCount} 条</span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
              <span className="text-neutral-500">本轮尚未注入</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* 列表 ⇄ 图谱 两小钮 */}
          <div className="flex overflow-hidden rounded-md border border-white/10">
            <button
              type="button"
              onClick={() => setView('list')}
              className={`px-2 py-0.5 text-[10px] ${
                view === 'list' ? 'bg-emerald-500/15 text-emerald-200' : 'text-neutral-400 hover:bg-white/5'
              }`}
            >
              ≡ 列表
            </button>
            <button
              type="button"
              onClick={() => setView('graph')}
              className={`px-2 py-0.5 text-[10px] ${
                view === 'graph' ? 'bg-emerald-500/15 text-emerald-200' : 'text-neutral-400 hover:bg-white/5'
              }`}
            >
              ✦ 图谱
            </button>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            title="立即刷新（平时每 10 秒自动轮询）"
            className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className={`rounded-md px-2 py-0.5 text-[10px] ${
              showAdd
                ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/40'
                : 'border border-white/10 text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            }`}
          >
            + 添加
          </button>
        </div>
      </div>

      {/* 添加表单（内联展开，非弹窗） */}
      {showAdd && <MemoryAddForm onSaved={handleSaved} />}

      {/* 主体：加载 / 错误 / 空态 / 列表 / 图谱 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && data === null ? (
          <div className="p-4 text-neutral-500">正在加载记忆…</div>
        ) : error && data === null ? (
          <div className="p-4 text-red-400">
            {error}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-2 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-white/5"
            >
              重试
            </button>
          </div>
        ) : isEmpty ? (
          <div className="p-4 leading-relaxed text-neutral-500">
            还没有记忆——和小可聊几句，每 3 轮她会自动记住重要的事。也可以点上方"添加"手动放一条进去。
          </div>
        ) : view === 'list' ? (
          <MemoryList
            items={items}
            profile={profile}
            serverNow={serverNow}
            archivedEmotionCount={data?.archived_emotion_count ?? 0}
            newIds={newIds}
            onRefresh={() => void refresh()}
          />
        ) : (
          <MemoryGraph items={graphItems} profile={profile} serverNow={serverNow} />
        )}
        {/* 轮询期偶发失败：保留旧数据，顶部细提示 */}
        {error && data !== null && (
          <div className="px-3 pb-2 text-[10px] text-amber-400/80">刷新失败({error})，展示的是上次数据</div>
        )}
      </div>

      {/* 底部：记忆机制折叠区（默认收起） */}
      <div className="border-t border-white/10">
        <button
          type="button"
          onClick={() => setShowPipeline((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-[11px] text-neutral-400 hover:bg-white/5"
        >
          <span>⚙️ 记忆机制</span>
          <span className="text-neutral-600">{showPipeline ? '▾ 收起' : '▸ 展开'}</span>
        </button>
        {showPipeline && (
          <div className="max-h-72 overflow-y-auto border-t border-white/5">
            <MemoryPipeline />
          </div>
        )}
      </div>
    </div>
  );
}
