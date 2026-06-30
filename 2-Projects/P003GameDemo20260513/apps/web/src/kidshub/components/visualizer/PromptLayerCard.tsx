// PromptLayerCard.tsx — 单层色块，默认折叠；variables 层展开时渲染采样标记表
import { useState } from 'react';
import type { AssemblyLayer, VariableSubstitution } from '../../store/kidshub-store';

interface PromptLayerCardProps {
  layer: AssemblyLayer;
  index: number;
  variableSubstitutions?: VariableSubstitution[];
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function PromptLayerCard({ layer, index, variableSubstitutions }: PromptLayerCardProps) {
  const [collapsed, setCollapsed] = useState(true);
  const isVarsLayer = layer.key === 'variables';

  return (
    <div className={`rounded-lg border p-3 ${layer.accentClass}`}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono text-neutral-400">L{index + 1}</span>
            <span className="text-sm font-medium">{layer.label}</span>
            <span className="rounded-full border border-white/15 bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-200">
              {formatCount(layer.charCount)} 字符
            </span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-300/80">{layer.hint}</div>
          <div className="mt-0.5 font-mono text-[10px] text-neutral-500">{layer.source}</div>
        </div>
        <span className="flex-shrink-0 text-xs text-neutral-300">
          {collapsed ? '展开 ▼' : '收起 ▲'}
        </span>
      </button>

      {!collapsed && (
        <div className="mt-3">
          {isVarsLayer && variableSubstitutions ? (
            <div className="max-h-[60vh] overflow-auto rounded-md bg-neutral-900/50 p-2">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="text-neutral-400">
                    <th className="px-2 py-1 font-medium">key</th>
                    <th className="px-2 py-1 font-medium">value</th>
                    <th className="px-2 py-1 font-medium">采样标记</th>
                  </tr>
                </thead>
                <tbody>
                  {variableSubstitutions.map((v) => (
                    <tr key={v.key} className="border-t border-white/5 align-top">
                      <td className="px-2 py-1 font-mono text-neutral-300">{v.key}</td>
                      <td className="px-2 py-1 font-mono text-neutral-200 break-all">
                        {v.value || <span className="text-neutral-600">（空）</span>}
                      </td>
                      <td className="px-2 py-1">
                        {v.sampledThisTurn ? (
                          <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200">
                            ✨ 本轮采样
                          </span>
                        ) : (
                          <span className="text-neutral-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-neutral-900/50 p-2 font-mono text-[11px] text-neutral-200">
              {layer.rawText || '（本层无内容）'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
