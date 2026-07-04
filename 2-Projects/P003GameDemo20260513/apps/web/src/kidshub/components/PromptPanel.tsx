// 右栏容器：顶部 tab 切换「编辑 / 拼接可视化 / 小可的记忆」+ 下方按 tab mount 对应子面板。
// 编辑 tab 内容原样搬到 PromptEditor，零回归；拼接可视化 tab 是新的白盒视图（PromptVisualizer）；
// 记忆 tab 仅激活时 mount MemoryPanel（离开卸载即停 10s 轮询）。
import { useState } from 'react';
import { PromptEditor } from './PromptEditor';
import { PromptVisualizer } from './visualizer/PromptVisualizer';
import { MemoryPanel } from './memory/MemoryPanel';

interface PromptPanelProps {
  onSend: () => void;
  onExport: () => void;
  hasUnsent: boolean;
}

type RightTab = 'editor' | 'visualizer' | 'memory';

export function PromptPanel({ onSend, onExport, hasUnsent }: PromptPanelProps) {
  const [tab, setTab] = useState<RightTab>('editor');

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      {/* 顶栏：标题 + tab 切换（三 tab 窄栏放不下时换行） */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 border-b border-white/10 px-3 py-2">
        <div className="text-xs uppercase tracking-[1px] text-neutral-400">Prompt 工作区</div>
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'editor'} onClick={() => setTab('editor')}>
            📝 编辑
          </TabButton>
          <TabButton active={tab === 'visualizer'} onClick={() => setTab('visualizer')}>
            🔬 拼接可视化
          </TabButton>
          <TabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
            🧠 小可的记忆
          </TabButton>
        </div>
      </div>

      {/* 主体（按 tab 切；记忆面板仅激活时 mount，卸载即停轮询） */}
      <div className="flex-1 min-h-0">
        {tab === 'editor' ? (
          <PromptEditor onSend={onSend} onExport={onExport} hasUnsent={hasUnsent} />
        ) : tab === 'visualizer' ? (
          <PromptVisualizer />
        ) : (
          <MemoryPanel />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'rounded-md bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/40'
          : 'rounded-md bg-transparent px-2.5 py-1 text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
      }
    >
      {children}
    </button>
  );
}
