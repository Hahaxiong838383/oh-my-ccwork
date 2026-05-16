import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from '../store/app-store';

function getReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function EcoUnlock() {
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const ecoLevel = useAppStore((s) => s.ecoLevel);
  const reducedMotion = getReducedMotion();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (rewardMachine !== 'ecoUnlock') return;

    const timers: number[] = [];
    setPhase(0);
    timers.push(window.setTimeout(() => setPhase(1), 500));
    timers.push(window.setTimeout(() => setPhase(2), 2000));
    timers.push(window.setTimeout(() => setPhase(3), 3000));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [rewardMachine]);

  if (rewardMachine !== 'ecoUnlock') return null;

  if (reducedMotion) {
    return (
      <motion.div
        className="absolute inset-0 z-layer-mask flex items-center justify-center bg-gradient-to-b from-[#082F49] to-[#064E3B] px-[clamp(3cqh,5cqw,6cqh)] text-center text-white"
        style={{ containerType: 'size' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.32 }}
      >
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.28 }}>
          <p className="text-white/85" style={{ fontSize: 'clamp(1.4cqh,2.4cqw,2.8cqh)' }}>生态缸有新解锁...</p>
          <p className="mt-[clamp(0.8cqh,1.2cqw,1.8cqh)] font-semibold text-emerald-100" style={{ fontSize: 'clamp(1.8cqh,3.2cqw,3.8cqh)' }}>
            灯光鱼缸 Lv{ecoLevel} 解锁！
          </p>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="absolute inset-0 z-layer-mask overflow-hidden text-white"
      style={{ containerType: 'size' }}
      initial={{ opacity: 0 }}
      // gemini 建议：phase 3 不再透明降级，保持 opacity 1 让观众看清 Lv2 精致细节
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-[#082F49] to-[#064E3B]" />

      <motion.p
        className="absolute left-1/2 top-[clamp(4cqh,6cqw,7cqh)] -translate-x-1/2 whitespace-nowrap text-center text-white/85"
        style={{ fontSize: 'clamp(1.3cqh,2.2cqw,2.7cqh)' }}
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {phase >= 2 ? `灯光鱼缸 Lv${ecoLevel} 解锁！` : '生态缸有新解锁...'}
      </motion.p>

      <motion.div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: 'clamp(18cqh, 27cqw, 31cqh)', height: 'clamp(18cqh, 27cqw, 31cqh)' }}
        initial={{ scale: 0.82, opacity: 0 }}
        animate={{
          scale: phase >= 3 ? [1, 1.08, 1] : 1,
          opacity: phase === 0 ? 0 : 1,
        }}
        transition={{ duration: phase >= 3 ? 0.8 : 0.4, ease: 'easeInOut' }}
      >
        <div className="absolute inset-0 rounded-full border border-cyan-100/30 bg-cyan-100/10 shadow-[inset_0_0_3cqh_rgba(255,255,255,0.22),0_0_2.6cqh_rgba(56,189,248,0.35)] backdrop-blur-[2px]" />
        <div className="absolute inset-[5%] overflow-hidden rounded-full border border-cyan-200/20 bg-gradient-to-b from-cyan-100/12 via-cyan-200/4 to-emerald-200/14">
          <video
            key={ecoLevel}
            src={`/art/eco/${ecoLevel}.mp4`}
            className="h-full w-full object-cover"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
          />
        </div>

        <motion.div
          className="absolute left-1/2 top-[4%] -translate-x-1/2 rounded-full bg-amber-200/80"
          style={{ width: 'clamp(1.2cqh,1.8cqw,2.2cqh)', height: 'clamp(1.2cqh,1.8cqw,2.2cqh)' }}
          initial={{ opacity: 0, scale: 0.4 }}
          animate={phase >= 2 ? { opacity: [0.45, 1, 0.45], scale: [0.8, 1.35, 0.9] } : { opacity: 0, scale: 0.4 }}
          transition={{ duration: 0.9, repeat: phase >= 2 ? Infinity : 0, ease: 'easeInOut' }}
        />
      </motion.div>
    </motion.div>
  );
}
// CODEX-PROVIDED-D3
