// FinalPromptView.tsx — 底部最终成品；展开/折叠 + 复制按钮 + 临时 toast
import { useState } from 'react';
import type { AssemblyLayer } from '../../store/kidshub-store';

interface FinalPromptViewProps {
  finalPrompt: string;
  layers: AssemblyLayer[];
  cardTitle: string;
}

export function FinalPromptView({ finalPrompt, layers, cardTitle }: FinalPromptViewProps) {
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(finalPrompt);
      setToast('已复制');
    } catch {
      setToast('复制失败');
    }
    setTimeout(() => setToast(null), 1500);
  };

  const layersSummary = layers.map((l) => l.label).join(' + ');

  return (
    <div className="relative rounded-lg border border-emerald-400/30 bg-neutral-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-[1px] text-emerald-300/80">
            📤 sendSessionConfig 真实下发的 system prompt
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
            <span className="rounded-full border border-white/15 bg-neutral-800 px-2 py-0.5 text-neutral-200">
              {finalPrompt.length.toLocaleString('en-US')} 字符
            </span>
            <span className="truncate">卡：{cardTitle}</span>
            <span className="truncate text-neutral-500">{layersSummary}</span>
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            {expanded ? '折叠' : '展开'}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            复制
          </button>
        </div>
      </div>

      <pre
        className="mt-3 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-950/80 p-2 font-mono text-[11px] text-neutral-100"
        style={{ maxHeight: expanded ? '60vh' : '120px' }}
      >
        {finalPrompt || '（finalPrompt 为空）'}
      </pre>

      {toast && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-emerald-400/40 bg-emerald-500/20 px-3 py-1 text-xs text-emerald-100 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
