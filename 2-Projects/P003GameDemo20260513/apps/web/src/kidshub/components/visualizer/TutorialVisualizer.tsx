// TutorialVisualizer.tsx — 新手引导白盒视图（与场景卡视图并列，由 PromptVisualizer 按 sub-tab 切显示）
// 不走 6 层拼接，走「单步五件事 + 状态机推进」模型：
//   1. 旁白话术 voiceCopy（含 {child_nickname} 注入对比）
//   2. 等待目标 waitFor + describeTarget + ASR 推进关键词
//   3. LLM 兜底 system prompt（buildTutorialSystemPrompt）
//   4. 30s 提醒话术 + 第 3 次过渡 + 间隔/上限
//   5. 步骤元信息（表情/演出幕/音效/captureMode/…）
// 数据契约：useKidsHubStore.lastTutorialStep（TutorialStepAssembly）
import { useEffect, useState } from 'react';
import { useKidsHubStore } from '../../store/kidshub-store';
import type { TutorialStepAssembly } from '../../store/kidshub-store';
import {
  SKIP_HINTS,
  SKIP_RESPONSE,
  REMIND_INTERVAL_MS,
  REMIND_MAX,
  REMIND_FINAL_SUFFIX,
} from '../../tutorial/tutorial-types';

const PHASE_META: Record<TutorialStepAssembly['phase'], { label: string; cls: string }> = {
  speaking: { label: 'speaking · 播报中', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200' },
  waiting: { label: 'waiting · 等待用户动作', cls: 'border-amber-400/40 bg-amber-500/15 text-amber-200' },
  celebrating: { label: 'celebrating · 庆祝播报', cls: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' },
  handoff: { label: 'handoff · 衔接确认', cls: 'border-purple-400/40 bg-purple-500/15 text-purple-200' },
};

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 1) return '刚刚更新';
  if (diff < 60) return `${diff} 秒前更新`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前更新`;
  return `${Math.floor(diff / 3600)} 小时前更新`;
}

export function TutorialVisualizer() {
  const snap = useKidsHubStore((s) => s.lastTutorialStep);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snap) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [snap]);

  if (!snap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center text-neutral-400">
        <div className="text-4xl">🧭</div>
        <div className="text-sm">从左栏点一个「新手引导」单元启动</div>
        <div className="text-xs text-neutral-500">
          这里会实时展示当前步骤：旁白 / 等待动作 / LLM 兜底 / 提醒话术 / 元信息
        </div>
      </div>
    );
  }

  const phaseMeta = PHASE_META[snap.phase];

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      <div className="flex-1 space-y-4 overflow-auto p-3">
        {/* 顶栏：单元 + 步骤 + phase chip + 时间 */}
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 pb-2">
          <div className="text-sm font-medium text-neutral-100">
            <span className="mr-1">{snap.unitEmoji}</span>
            {snap.unitTitle}
            <span className="ml-2 font-mono text-[11px] text-neutral-400">
              Step {snap.stepIndex + 1}/{snap.stepTotal}
              <span className="ml-1 text-neutral-500">(配表 {snap.step.specStep})</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${phaseMeta.cls}`}>
              {phaseMeta.label}
            </span>
            <span className="font-mono text-[10px] text-neutral-500">
              {formatRelative(snap.timestamp, now)}
            </span>
          </div>
        </div>

        {/* 1. 步进瀑布流（5 步：进入步 → 锁表情 → 下发兜底 prompt → 播旁白/演出 → 等待用户动作） */}
        <StepPipeline snap={snap} />

        {/* 2. 当前步骤五大色块 */}
        <div>
          <div className="mb-2 text-xs uppercase tracking-[1px] text-neutral-400">
            📦 当前步骤五大白盒
          </div>
          <div className="space-y-2">
            <VoiceCopyCard snap={snap} />
            <WaitTargetCard snap={snap} />
            <SystemPromptCard snap={snap} />
            <RemindCard snap={snap} />
            <MetaCard snap={snap} />
          </div>
        </div>

        {/* 3. 全局规则卡（每个引导单元都一样的兜底规则） */}
        <GlobalRulesCard />
      </div>
    </div>
  );
}

// ────────────────────────────── 子组件 ──────────────────────────────

function StepPipeline({ snap }: { snap: TutorialStepAssembly }) {
  const { step, phase } = snap;
  const hasVoice = !!step.voiceCopy;
  const hasWait = !!step.waitFor;

  const steps = [
    { no: '①', label: '进入步骤', detail: `${step.id} · 第 ${snap.stepIndex + 1} 步` },
    { no: '②', label: '锁表情', detail: `${step.expression}（tutorial lock）` },
    {
      no: '③',
      label: '下发 LLM 兜底 prompt',
      detail: `sendSessionConfig · 兜底拉回（${step.systemPrompt.length} 字符）`,
    },
    {
      no: '④',
      label: hasVoice ? '播旁白' : '定时演出',
      detail: hasVoice
        ? `sayDirect · ${step.voiceCopy!.length} 字符`
        : `等定时器 ${(step.durationMs ?? 5000) / 1000}s 推进`,
    },
    {
      no: '⑤',
      label: hasWait ? '等用户动作' : '自动推进',
      detail: hasWait
        ? `waitFor=${step.waitFor}（ASR 命中 / 控件点击 / 30s×3 兜底）`
        : 'phase=speaking → playback_end → 自动 next',
    },
  ];

  return (
    <div key={snap.timestamp} className="rounded-lg border border-white/10 bg-neutral-900/60 p-3">
      <div className="mb-2 text-xs uppercase tracking-[1px] text-neutral-400">
        🌊 引导步进瀑布流（5 步 · 当前 phase: {phase}）
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-3">
        {steps.map((s, i) => (
          <div
            key={i}
            className="flex min-w-[140px] flex-1 items-start gap-2 opacity-0"
            style={{ animation: 'kh-fade-in 0.4s ease-out forwards', animationDelay: `${i * 0.12}s` }}
          >
            <span
              className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/80 text-[10px] font-bold text-white"
              style={{ animation: 'kh-dot-pop 0.4s ease-out forwards', animationDelay: `${i * 0.12}s` }}
            >
              {s.no}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-neutral-100">{s.label}</div>
              <div className="mt-0.5 break-all text-[10px] leading-tight text-neutral-400">{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
      {/* keyframes 定义（与场景卡 AssemblyPipeline 同名复用；重复定义浏览器自然 dedupe，无副作用） */}
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

function VoiceCopyCard({ snap }: { snap: TutorialStepAssembly }) {
  const [open, setOpen] = useState(true);
  const { step, nickname } = snap;
  if (!step.voiceCopy && !step.durationMs) {
    return null;
  }
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-emerald-400/50 bg-emerald-500/10 text-emerald-100"
      title="① 旁白话术 voiceCopy"
      meta={
        step.voiceCopy
          ? `sayDirect · ${step.voiceCopy.length} 字符 · {child_nickname} → ${nickname}`
          : `无语音步 · 定时 ${(step.durationMs ?? 0) / 1000}s 推进`
      }
      hint="固定脚本（不走 LLM 自由生成），sayDirect 后立即同步喂打字机字幕。"
      source={`tutorial/tutorial-${snap.unitId}.ts · step.voiceCopy`}
    >
      {step.voiceCopy ? (
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">注入后（实际播放）</div>
            <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/60 p-2 font-mono text-[11px] text-emerald-100">
              {step.voiceCopy}
            </pre>
          </div>
          {step.voiceCopyRaw && step.voiceCopyRaw !== step.voiceCopy && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">原文（含占位符）</div>
              <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/40 p-2 font-mono text-[11px] text-neutral-300">
                {step.voiceCopyRaw}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-neutral-400">
          无 voiceCopy；durationMs={step.durationMs}ms 到时自动 onSpeechEnd 推进。
        </div>
      )}
    </CollapsibleCard>
  );
}

function WaitTargetCard({ snap }: { snap: TutorialStepAssembly }) {
  const [open, setOpen] = useState(true);
  const { step } = snap;
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-amber-400/50 bg-amber-500/10 text-amber-100"
      title="② 等待目标 waitFor"
      meta={
        step.waitFor
          ? `target=${step.waitFor} · 推进关键词 ${step.advanceHints.length} 个`
          : '无等待（纯播报/演出步，自动推进）'
      }
      hint="ASR 命中推进词 / 控件点击 / 30s×3 超时兜底——三者任一触发推进。"
      source="tutorial/tutorial-types.ts · hintsForTarget(waitFor)"
    >
      {step.waitFor ? (
        <div className="space-y-2 text-[11px]">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-amber-300/30 bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] text-amber-200">
              waitFor: {step.waitFor}
            </span>
            {step.targetDescription && (
              <span className="text-neutral-300">{step.targetDescription}</span>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">ASR 推进关键词</div>
            <div className="flex flex-wrap gap-1">
              {step.advanceHints.length === 0 ? (
                <span className="text-neutral-500">（无关键词，只能点击控件推进）</span>
              ) : (
                step.advanceHints.map((h) => (
                  <span
                    key={h}
                    className="rounded border border-white/15 bg-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-200"
                  >
                    {h}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-neutral-400">本步无 waitFor，旁白/演出结束自动推进下一步。</div>
      )}
    </CollapsibleCard>
  );
}

function SystemPromptCard({ snap }: { snap: TutorialStepAssembly }) {
  const [open, setOpen] = useState(false);
  const { step } = snap;
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-sky-400/50 bg-sky-500/10 text-sky-100"
      title="③ LLM 兜底 system prompt"
      meta={`buildTutorialSystemPrompt(step) · ${step.systemPrompt.length} 字符`}
      hint="孩子岔题时走正常 LLM，由这段兜底 prompt 让 LLM 简短回答后拉回当前步骤动作。"
      source="tutorial/tutorial-types.ts · buildTutorialSystemPrompt"
    >
      <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/60 p-2 font-mono text-[11px] text-sky-50">
        {step.systemPrompt}
      </pre>
    </CollapsibleCard>
  );
}

function RemindCard({ snap }: { snap: TutorialStepAssembly }) {
  const [open, setOpen] = useState(false);
  const { step, remindCount } = snap;
  if (!step.remindCopy) {
    return (
      <div className="rounded-lg border border-white/10 bg-neutral-900/40 p-3 text-[11px] text-neutral-500">
        ④ 提醒话术：本步无 remindCopy（非等待步无超时提醒）
      </div>
    );
  }
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-violet-400/50 bg-violet-500/10 text-violet-100"
      title="④ 30s 超时提醒话术"
      meta={`已提醒 ${remindCount}/${REMIND_MAX} · 间隔 ${REMIND_INTERVAL_MS / 1000}s`}
      hint={`waiting 期每 ${REMIND_INTERVAL_MS / 1000}s 触发一次；第 ${REMIND_MAX} 次播过渡语后强制跳下一步。`}
      source="tutorial/tutorial-types.ts · REMIND_*"
    >
      <div className="space-y-2 text-[11px]">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">
            前 {REMIND_MAX - 1} 次提醒
          </div>
          <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/60 p-2 font-mono text-violet-100">
            {step.remindCopy}
          </pre>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">
            第 {REMIND_MAX} 次（过渡语 → forceNext）
          </div>
          <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/40 p-2 font-mono text-neutral-300">
            {REMIND_FINAL_SUFFIX}
          </pre>
        </div>
      </div>
    </CollapsibleCard>
  );
}

function MetaCard({ snap }: { snap: TutorialStepAssembly }) {
  const [open, setOpen] = useState(false);
  const { step, captureMode } = snap;
  const rows: Array<[string, string]> = [
    ['expression', step.expression],
    ['target', step.target ?? '—'],
    ['waitFor', step.waitFor ?? '—'],
    ['durationMs', step.durationMs == null ? '—' : `${step.durationMs}`],
    ['hideAvatar', String(step.hideAvatar)],
    ['scene', step.scene ?? '—'],
    ['sound', step.sound ?? '—'],
    ['isUnitEnd', String(step.isUnitEnd)],
    ['captureMode', captureMode],
    ['source', 'tutorial'],
  ];
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-white/15 bg-neutral-900"
      title="⑤ 步骤元信息"
      meta="表情 / 演出幕 / 音效 / sessionMeta"
      hint="非话术维度但会影响舞台呈现：sound 进步时播；captureMode=feedback 时孩子吐槽会落库。"
      source="tutorial/tutorial-types.ts · TutorialStep + TutorialManager · sendSessionMeta"
    >
      <div className="max-h-[40vh] overflow-auto rounded-md bg-neutral-900/50 p-2">
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="text-neutral-400">
              <th className="px-2 py-1 font-medium">field</th>
              <th className="px-2 py-1 font-medium">value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-white/5 align-top">
                <td className="px-2 py-1 font-mono text-neutral-300">{k}</td>
                <td className="px-2 py-1 font-mono text-neutral-200 break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleCard>
  );
}

function GlobalRulesCard() {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accent="border-rose-400/30 bg-rose-500/5 text-rose-100"
      title="🛟 全局兜底规则（每个引导单元都一样）"
      meta={`跳过词 ${SKIP_HINTS.length} 个 · 30s × ${REMIND_MAX} 兜底跳步`}
      hint="任意步说出跳过词 → 播跳过回应后退出；waiting 期 30s ×3 自动跳到下一步。"
      source="tutorial/tutorial-types.ts · SKIP_HINTS / REMIND_*"
    >
      <div className="space-y-3 text-[11px]">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">跳过词（SKIP_HINTS）</div>
          <div className="flex flex-wrap gap-1">
            {SKIP_HINTS.map((h) => (
              <span
                key={h}
                className="rounded border border-rose-300/30 bg-neutral-800 px-2 py-0.5 font-mono text-[10px] text-rose-100"
              >
                {h}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">跳过响应（SKIP_RESPONSE）</div>
          <pre className="whitespace-pre-wrap rounded-md bg-neutral-900/60 p-2 font-mono text-rose-50">
            {SKIP_RESPONSE}
          </pre>
        </div>
      </div>
    </CollapsibleCard>
  );
}

// ────────────────────────── 通用折叠卡 ──────────────────────────

function CollapsibleCard({
  open,
  onToggle,
  accent,
  title,
  meta,
  hint,
  source,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  accent: string;
  title: string;
  meta: string;
  hint: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 ${accent}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <span className="rounded-full border border-white/15 bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-200">
              {meta}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-300/80">{hint}</div>
          <div className="mt-0.5 font-mono text-[10px] text-neutral-500">{source}</div>
        </div>
        <span className="flex-shrink-0 text-xs text-neutral-300">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
