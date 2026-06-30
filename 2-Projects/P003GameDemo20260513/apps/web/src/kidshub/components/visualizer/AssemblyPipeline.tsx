// AssemblyPipeline.tsx — 顶部 7 步瀑布流，每次 lastAssembly.timestamp 变化时按 0.12s 步进渐入
import type { LastAssembly } from '../../store/kidshub-store';

interface AssemblyPipelineProps {
  assembly: LastAssembly;
}

interface Step {
  no: string;
  label: string;
  detail: string;
}

function buildSteps(a: LastAssembly): Step[] {
  const picksDetail =
    Object.entries(a.picks).length > 0
      ? Object.entries(a.picks)
          .map(([k, v]) => `${k}=${v.length > 12 ? v.slice(0, 12) + '…' : v}`)
          .join(' / ')
      : '（本卡无可采样事实）';

  const loreDetail =
    a.loreSections.length > 0
      ? `${a.loreSections.length} 节 (${a.loreSections.map((s) => s.title).join('/')})`
      : '0 节 (未命中 L2 lore)';

  return [
    { no: '①', label: '选卡', detail: `${a.cardNo}·${a.cardTitle}` },
    { no: '②', label: 'bargein 打断旧轮', detail: '立即停旧 TTS / ASR，turn tag 自增' },
    { no: '③', label: 'commander_suffix 覆盖', detail: '近因规则：本轮任务后缀追加到 prompt 末尾' },
    { no: '④', label: '事实采样', detail: `picks: ${picksDetail}` },
    { no: '⑤', label: 'L2 lore 路由', detail: loreDetail },
    { no: '⑥', label: '6 层拼接', detail: `${a.layers.length} 层 → ${a.finalPrompt.length} 字符` },
    { no: '⑦', label: 'sendSessionConfig 下发', detail: 'system prompt 覆盖到 RTC server' },
  ];
}

export function AssemblyPipeline({ assembly }: AssemblyPipelineProps) {
  const steps = buildSteps(assembly);

  return (
    <div
      key={assembly.timestamp}
      className="rounded-lg border border-white/10 bg-neutral-900/60 p-3"
    >
      <div className="mb-2 text-xs uppercase tracking-[1px] text-neutral-400">
        🌊 拼接瀑布流（7 步）
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-3">
        {steps.map((step, i) => (
          <div
            key={i}
            className="flex min-w-[140px] flex-1 items-start gap-2 opacity-0"
            style={{
              animation: 'kh-fade-in 0.4s ease-out forwards',
              animationDelay: `${i * 0.12}s`,
            }}
          >
            <span
              className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/80 text-[10px] font-bold text-white"
              style={{
                animation: 'kh-dot-pop 0.4s ease-out forwards',
                animationDelay: `${i * 0.12}s`,
              }}
            >
              {step.no}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-neutral-100">{step.label}</div>
              <div className="mt-0.5 break-all text-[10px] leading-tight text-neutral-400">
                {step.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes kh-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes kh-dot-pop {
          0%   { background-color: rgb(64 64 64); transform: scale(0.8); }
          60%  { background-color: rgb(34 197 94); transform: scale(1.15); }
          100% { background-color: rgb(16 185 129 / 0.8); transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
