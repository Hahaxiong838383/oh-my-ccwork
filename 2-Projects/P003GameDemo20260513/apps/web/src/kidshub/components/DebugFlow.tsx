import { useEffect, useRef, useState } from 'react';
import { useKidsHubStore } from '../store/kidshub-store';
import type { DebugEntry } from '../store/kidshub-store';
import { useTutorialStore } from '../tutorial/tutorial-store';
import { getUnitStep, getUnit } from '../tutorial/tutorial-units';
import { getSharedVoiceClient } from '../../services/voice-client';
import { useAppStore } from '../../store/app-store';

const kindColor: Record<DebugEntry['kind'], string> = {
  action: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  asr: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  llm: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  tts: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  prompt: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  config: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
  perf: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30',
  avatar: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  error: 'bg-red-500/20 text-red-300 border-red-500/30',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function DebugFlow() {
  const debugLog = useKidsHubStore((s) => s.debugLog);
  const clearDebug = useKidsHubStore((s) => s.clearDebug);
  const tutorialActive = useTutorialStore((s) => s.isActive);
  const tutorialUnitId = useTutorialStore((s) => s.unitId);
  const tutorialStepIndex = useTutorialStore((s) => s.stepIndex);
  const tutorialPhase = useTutorialStore((s) => s.phase);
  const tutorialRemind = useTutorialStore((s) => s.remindCount);
  const completedUnits = useTutorialStore((s) => s.completedUnits);
  const anyCompleted = Object.values(completedUnits).some(Boolean);

  // 重置引导：清本地完成标记 + 停掉在途语音/字幕（PM 反复体验入口）
  const resetTutorial = () => {
    getSharedVoiceClient().bargeIn();
    useAppStore.getState().setSubtitle('');
    useTutorialStore.getState().resetForDebug();
  };

  const listRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // auto scroll to bottom when new entry
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [debugLog.length]);

  const toggle = (idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-xs text-neutral-300">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="font-medium text-neutral-400">调试流 · 时间线</div>
          {tutorialActive && (
            <span className="rounded-full border border-yellow-500/30 bg-yellow-500/15 px-2 py-0.5 text-[10px] text-yellow-300">
              {getUnit(tutorialUnitId)?.emoji ?? '🧭'} Step{' '}
              {getUnitStep(tutorialUnitId, tutorialStepIndex)?.specStep ?? '?'} · {tutorialPhase}
              {tutorialRemind > 0 ? ` · 已提醒${tutorialRemind}次` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={resetTutorial}
            title="清除 tutorial_settings 本地完成标记并停止当前引导，可重新体验"
            className={`rounded border px-2 py-0.5 text-[10px] hover:bg-white/5 ${
              anyCompleted || tutorialActive
                ? 'border-yellow-500/30 text-yellow-300'
                : 'border-white/10 text-neutral-500'
            }`}
          >
            重置引导
          </button>
          <button
            onClick={clearDebug}
            className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-white/5"
          >
            清空
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-auto p-2 font-mono text-[11px]">
        {debugLog.length === 0 && (
          <div className="px-2 py-6 text-center text-neutral-500">暂无日志。选择场景卡并开始对话后这里会出现记录。</div>
        )}
        {debugLog.map((e, idx) => {
          const isOpen = !!expanded[idx];
          return (
            <div key={idx} className="mb-1 rounded border border-white/10 bg-neutral-900/60">
              <div
                className="flex cursor-pointer items-start gap-2 px-2 py-1 hover:bg-white/5"
                onClick={() => toggle(idx)}
              >
                <span className="mt-0.5 shrink-0 text-[10px] text-neutral-500">{formatTime(e.ts)}</span>
                <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${kindColor[e.kind]}`}>
                  {e.kind}
                </span>
                <span className="min-w-0 flex-1 break-words text-neutral-200">{e.title}</span>
                {e.detail && (
                  <span className="shrink-0 text-[10px] text-neutral-500">{isOpen ? '收起' : '展开'}</span>
                )}
              </div>
              {e.detail && isOpen && (
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words border-t border-white/10 bg-black/40 p-2 text-[10px] text-neutral-400">
                  {e.detail}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
