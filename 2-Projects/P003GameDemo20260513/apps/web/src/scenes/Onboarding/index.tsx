import { useState } from 'react';
import { useAppStore } from '../../store/app-store';

const STEPS = [
  {
    title: '欢迎，飞船科学家',
    body: '你将通过舷窗观测一个封闭生态缸。\n它的成长，取决于你每日的专注。',
  },
  {
    title: 'K1 是你的搭档',
    body: '它会陪你学习、为你播报，开箱时和你一起欢呼。',
  },
  {
    title: '开始今天的观测',
    body: '专注 15 分钟，生态缸会回馈一份奖励。\n准备好了吗？',
  },
];

export function OnboardingScene() {
  const [step, setStep] = useState(0);
  const setOnboarded = useAppStore((s) => s.setOnboarded);
  const last = step === STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <div className="flex h-full w-full flex-col items-center justify-between bg-porthole-bg px-8 py-12 text-center">
      <div className="text-xs tracking-[0.3em] text-porthole-glow/60">
        K1 · INITIAL CONTACT · {String(step + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="h-32 w-32 rounded-full border-2 border-porthole-glow/40 bg-gradient-to-br from-ecosystem-deep to-ecosystem-mid shadow-[0_0_60px_rgba(79,209,255,0.3)]" />
        <h1 className="text-2xl font-medium">{current.title}</h1>
        <p className="whitespace-pre-line text-sm leading-relaxed text-white/70">{current.body}</p>
      </div>

      <button
        onClick={() => (last ? setOnboarded(true) : setStep(step + 1))}
        className="w-full max-w-xs rounded-full bg-porthole-glow py-4 text-base font-medium text-porthole-bg active:scale-95 transition-transform"
      >
        {last ? '开始观测' : '继续'}
      </button>
    </div>
  );
}
