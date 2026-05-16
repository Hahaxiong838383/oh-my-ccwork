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
      className="absolute inset-0 z-layer-mask overflow-hidden bg-[#040814] text-white"
      style={{ containerType: 'size' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
    >
      {/* 视频全屏：宽度顶满，长度方向超出自动裁切（object-cover + center） */}
      <motion.video
        key={ecoLevel}
        src={`/art/eco/${ecoLevel}.mp4`}
        className="absolute inset-0 h-full w-full object-cover object-center"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{
          opacity: phase === 0 ? 0 : 1,
          scale: phase >= 3 ? [1, 1.02, 1] : 1,
        }}
        transition={{ duration: phase >= 3 ? 0.8 : 0.45, ease: 'easeInOut' }}
      />

      {/* 顶部暗色 gradient 增强标题可读性（不影响中部视频内容） */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[22%]"
        style={{
          background:
            'linear-gradient(to bottom, rgba(4,8,20,0.78) 0%, rgba(4,8,20,0.45) 55%, rgba(4,8,20,0) 100%)',
        }}
      />

      <motion.p
        className="absolute left-1/2 top-[clamp(4cqh,6cqw,7cqh)] -translate-x-1/2 whitespace-nowrap text-center font-semibold text-white"
        style={{
          fontSize: 'clamp(1.6cqh,2.8cqw,3.4cqh)',
          textShadow: '0 0 0.6cqh rgba(0,0,0,0.85)',
        }}
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {phase >= 2 ? `灯光鱼缸 Lv${ecoLevel} 解锁！` : '生态缸有新解锁...'}
      </motion.p>

      {/* 顶部"叮咚"小点（解锁强调，phase>=2 时浮动呼吸） */}
      <motion.div
        className="absolute left-[clamp(2cqh,3cqw,4cqh)] top-[clamp(2cqh,3cqw,4cqh)] rounded-full bg-amber-200/90"
        style={{
          width: 'clamp(1.2cqh,1.8cqw,2.2cqh)',
          height: 'clamp(1.2cqh,1.8cqw,2.2cqh)',
          boxShadow: '0 0 1.2cqh rgba(255,200,80,0.7)',
        }}
        initial={{ opacity: 0, scale: 0.4 }}
        animate={
          phase >= 2 ? { opacity: [0.55, 1, 0.55], scale: [0.85, 1.3, 0.95] } : { opacity: 0, scale: 0.4 }
        }
        transition={{ duration: 0.9, repeat: phase >= 2 ? Infinity : 0, ease: 'easeInOut' }}
      />
    </motion.div>
  );
}
// CODEX-PROVIDED-D3
