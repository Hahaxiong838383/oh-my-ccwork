import { useState } from 'react';
import { useUserStore, type Gender } from '../../store/user-store';

/**
 * 首次启动引导 —— 4 步
 * 1. 世界观（你是飞船科学家）
 * 2. 小可介绍（你的搭档）
 * 3. 性别选择（影响藏品库 + 宝箱外观）
 * 4. 邀请专注
 */
const STEPS = [
  { title: '欢迎，指挥官', body: '方舟舷窗外，是一个等待你观测的封闭生态缸。\n它的成长，取决于你每一段专注的时光。' },
  { title: '这是小可', body: '它是方舟上的时空探险家，将陪你一起守护这个生态缸。\n它会叫你"指挥官"。' },
  { title: '选择你的舱位', body: '不同的舰长有不同的藏品库与宝箱外观。', isGender: true },
  { title: '开始今天的航程', body: '专注 15 分钟，方舟就会回报一份夜航奖励。\n准备好了吗？' },
];

export function OnboardingScene() {
  const [step, setStep] = useState(0);
  const setOnboarded = useUserStore((s) => s.setOnboarded);
  const setGender = useUserStore((s) => s.setGender);
  const gender = useUserStore((s) => s.gender);
  const last = step === STEPS.length - 1;
  const current = STEPS[step]!;
  const blocked = current.isGender && !gender;

  return (
    <div className="flex h-full w-full flex-col items-center justify-between bg-screen-bg px-12 py-8 text-center">
      <div className="text-[10px] tracking-[0.4em] text-porthole-glow/60">
        FUTURUS · K1 · INITIAL CONTACT · {String(step + 1).padStart(2, '0')}/{String(STEPS.length).padStart(2, '0')}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="h-20 w-20 rounded-full border-2 border-porthole-glow/40 bg-gradient-to-br from-eco-deep to-eco-mid shadow-[0_0_40px_rgba(79,209,255,0.3)]" />
        <h1 className="text-xl font-medium">{current.title}</h1>
        <p className="whitespace-pre-line text-xs leading-relaxed text-white/70">{current.body}</p>

        {current.isGender && (
          <div className="mt-2 flex gap-3">
            <GenderCard label="探险家舱" sub="Explorer Bay" value="male" selected={gender === 'male'} onClick={setGender} />
            <GenderCard label="星梦舱" sub="Starborn Bay" value="female" selected={gender === 'female'} onClick={setGender} />
          </div>
        )}
      </div>

      <button
        onClick={() => (last ? setOnboarded(true) : setStep(step + 1))}
        disabled={blocked}
        className={`w-44 rounded-full py-3 text-sm font-medium transition-transform active:scale-95 ${
          blocked
            ? 'bg-white/10 text-white/30'
            : 'bg-porthole-glow text-screen-bg shadow-[0_0_24px_rgba(79,209,255,0.4)]'
        }`}
      >
        {last ? '启航' : '继续'}
      </button>
    </div>
  );
}

function GenderCard({
  label,
  sub,
  value,
  selected,
  onClick,
}: {
  label: string;
  sub: string;
  value: Gender;
  selected: boolean;
  onClick: (v: Gender) => void;
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`flex flex-col items-center gap-1 rounded-xl border px-5 py-3 transition-all ${
        selected
          ? 'border-porthole-glow bg-porthole-glow/10 shadow-[0_0_16px_rgba(79,209,255,0.3)]'
          : 'border-white/10 bg-white/5'
      }`}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[10px] tracking-widest text-white/40">{sub}</span>
    </button>
  );
}
