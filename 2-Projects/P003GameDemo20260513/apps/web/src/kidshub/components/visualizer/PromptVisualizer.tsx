// PromptVisualizer.tsx — 拼接可视化主体：内部 sub-tab 切「场景卡 / 新手引导」两个视图
//   - 场景卡视图（SceneAssemblyView）：6 层组装堆叠 + 瀑布流 + framing + 最终成品
//   - 新手引导视图（TutorialVisualizer）：单步五件事 + 状态机推进
// 默认按当前态自动选 tab：lastTutorialStep 在 → tutorial；否则 → scene
import { useEffect, useState } from 'react';
import { useKidsHubStore } from '../../store/kidshub-store';
import { AssemblyPipeline } from './AssemblyPipeline';
import { FramingCard } from './FramingCard';
import { PromptLayerCard } from './PromptLayerCard';
import { FinalPromptView } from './FinalPromptView';
import { TutorialVisualizer } from './TutorialVisualizer';

type SubTab = 'scene' | 'tutorial';

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 1) return '刚刚触发';
  if (diff < 60) return `${diff} 秒前触发`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前触发`;
  return `${Math.floor(diff / 3600)} 小时前触发`;
}

export function PromptVisualizer() {
  const lastAssembly = useKidsHubStore((s) => s.lastAssembly);
  const lastTutorialStep = useKidsHubStore((s) => s.lastTutorialStep);

  // 默认按当前态选：tutorial 在 → 优先 tutorial；否则 scene
  const [tab, setTab] = useState<SubTab>(lastTutorialStep ? 'tutorial' : 'scene');
  const [userPinned, setUserPinned] = useState(false);

  // 自动切：用户没手动 pin 时，新触发会自动切到对应 tab
  // tutorial 启动 → 切 tutorial；场景卡触发 → 切 scene（更新 timestamp 是判定信号）
  useEffect(() => {
    if (userPinned) return;
    if (lastTutorialStep) setTab('tutorial');
  }, [lastTutorialStep?.timestamp, userPinned]);
  useEffect(() => {
    if (userPinned) return;
    if (lastAssembly && !lastTutorialStep) setTab('scene');
  }, [lastAssembly?.timestamp, lastTutorialStep, userPinned]);

  const handleTab = (next: SubTab) => {
    setUserPinned(true);
    setTab(next);
  };

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      {/* 内部 sub-tab */}
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
        <SubTabBtn active={tab === 'scene'} onClick={() => handleTab('scene')} dot={!!lastAssembly}>
          🎴 场景卡
        </SubTabBtn>
        <SubTabBtn active={tab === 'tutorial'} onClick={() => handleTab('tutorial')} dot={!!lastTutorialStep}>
          🧭 新手引导
        </SubTabBtn>
        {userPinned && (
          <button
            onClick={() => setUserPinned(false)}
            className="ml-auto text-[10px] text-neutral-500 hover:text-neutral-300"
            title="恢复后自动跟随当前触发切换"
          >
            ⟲ 自动跟随
          </button>
        )}
      </div>

      {/* 主体 */}
      <div className="min-h-0 flex-1">
        {tab === 'tutorial' ? <TutorialVisualizer /> : <SceneAssemblyView />}
      </div>
    </div>
  );
}

function SubTabBtn({
  active,
  onClick,
  dot,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/40'
          : 'flex items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
      }
    >
      {children}
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          dot ? (active ? 'bg-emerald-400' : 'bg-neutral-500') : 'bg-transparent'
        }`}
        title={dot ? '有数据' : '无数据'}
      />
    </button>
  );
}

// ────────────────────────── 场景卡视图（原 PromptVisualizer 主体） ──────────────────────────

function SceneAssemblyView() {
  const lastAssembly = useKidsHubStore((s) => s.lastAssembly);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lastAssembly) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lastAssembly]);

  if (!lastAssembly) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center text-neutral-400">
        <div className="text-4xl">🎨</div>
        <div className="text-sm">选一张场景卡，这里会实时展示 prompt 拼接过程：</div>
        <div className="text-xs text-neutral-500">瀑布流 / 6 层色块 / framing 角度 / 最终成品</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      <div className="flex-1 space-y-4 overflow-auto p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 pb-2">
          <div className="text-sm font-medium text-neutral-100">
            <span className="font-mono text-neutral-400">#{lastAssembly.cardNo}</span> · {lastAssembly.cardTitle}
          </div>
          <div className="font-mono text-[10px] text-neutral-500">{formatRelative(lastAssembly.timestamp, now)}</div>
        </div>

        <AssemblyPipeline assembly={lastAssembly} />
        <FramingCard angle={lastAssembly.angle} />

        <div>
          <div className="mb-2 text-xs uppercase tracking-[1px] text-neutral-400">
            📚 6 层组装堆叠（按拼接顺序）
          </div>
          <div className="space-y-2">
            {lastAssembly.layers.map((layer, i) => (
              <PromptLayerCard
                key={layer.key}
                layer={layer}
                index={i}
                variableSubstitutions={
                  layer.key === 'variables' ? lastAssembly.variableSubstitutions : undefined
                }
              />
            ))}
          </div>
        </div>

        <FinalPromptView
          finalPrompt={lastAssembly.finalPrompt}
          layers={lastAssembly.layers}
          cardTitle={lastAssembly.cardTitle}
        />
      </div>
    </div>
  );
}
