import { motion } from 'framer-motion';
import { BOX_LEVELS } from '../config/boxes';
import { useAppStore } from '../store/app-store';

interface ParticleSpec {
  id: string;
  tx: number;
  ty: number;
  size: string;
  duration: number;
  delay: number;
}

interface FireworkSpec {
  id: string;
  x: string;
  y: string;
  delay: number;
  color: string;
}

function getReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function OpenBox() {
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const currentBoxLevel = useAppStore((s) => s.currentBoxLevel);

  const visible = rewardMachine === 'openingBox' || rewardMachine === 'showingReward';
  if (!visible || !currentBoxLevel) return null;

  const config = BOX_LEVELS[currentBoxLevel];
  const reducedMotion = getReducedMotion();
  const isOpening = rewardMachine === 'openingBox';
  const isShowing = rewardMachine === 'showingReward';

  const particleCount = reducedMotion ? 0 : config.particleCount;

  const particles: ParticleSpec[] = particleCount === 0
    ? []
    : Array.from({ length: particleCount }, (_, i) => {
      const angle = (Math.PI * 2 * i) / particleCount + Math.random() * 0.36;
      const distance = 60 + Math.random() * 190;
      return {
        id: `particle-${i}`,
        tx: Math.cos(angle) * distance,
        ty: Math.sin(angle) * distance,
        size: `clamp(0.35cqh, ${0.65 + Math.random() * 0.55}cqw, 1.1cqh)`,
        duration: 0.9 + Math.random() * 0.8,
        delay: Math.random() * 0.18,
      };
    });

  const fireworks: FireworkSpec[] = reducedMotion || !config.shouldFireworks
    ? []
    : Array.from({ length: 7 }, (_, i) => {
      const palette = ['#fbbf24', '#f59e0b', '#fde68a', '#f97316'];
      return {
        id: `firework-${i}`,
        x: `${14 + i * 12}%`,
        y: `${22 + (i % 2) * 18}%`,
        delay: i * 0.12,
        color: palette[i % palette.length],
      };
    });

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-layer-mask overflow-hidden text-white"
      style={{ containerType: 'size' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <motion.div
        className="absolute inset-0"
        animate={config.shouldShake && isOpening && !reducedMotion ? { x: [0, -config.shakePx, config.shakePx, 0] } : { x: 0 }}
        transition={
          config.shouldShake && isOpening && !reducedMotion
            ? { duration: Math.max(0.5, config.shakeMs / 1000), repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.2 }
        }
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,0.18),rgba(5,12,24,0.9)_60%)]" />

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[clamp(1.2cqh,1.8cqw,2.8cqh)] px-[clamp(3cqh,5cqw,6cqh)]">
          <motion.p
            className="text-center font-semibold tracking-[0.04em]"
            style={{ fontSize: 'clamp(1.3cqh, 2.4cqw, 2.8cqh)', color: config.color }}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            ✨ {config.name}
          </motion.p>

          <div className="relative grid place-items-center" style={{ width: 'clamp(20cqh, 30cqw, 34cqh)', height: 'clamp(20cqh, 30cqw, 34cqh)' }}>
            <motion.div
              className="absolute rounded-full"
              style={{
                width: 'clamp(12cqh, 20cqw, 23cqh)',
                height: 'clamp(12cqh, 20cqw, 23cqh)',
                backgroundColor: config.ringColor,
                // gemini 建议：legendary 强化"爆金"质感
                filter: currentBoxLevel === 'legendary' ? 'brightness(1.5)' : undefined,
              }}
              animate={
                reducedMotion
                  ? { opacity: isOpening ? 0.45 : 0.18 }
                  : {
                      // legendary 圆环扩散倍率 1.95 → 3.5（gemini 评审）
                      scale: isOpening
                        ? [0.55, currentBoxLevel === 'legendary' ? 3.5 : 1.95]
                        : [0.9, 1.3],
                      opacity: isOpening ? [0.85, 0.05] : [0.4, 0.15],
                    }
              }
              transition={
                reducedMotion
                  ? { duration: 0.25 }
                  : { duration: Math.max(0.8, config.shakeMs / 1000), repeat: isOpening ? Infinity : 0, ease: 'easeOut' }
              }
            />

            <motion.span
              className="select-none drop-shadow-[0_0_1.6cqh_rgba(255,255,255,0.35)]"
              style={{ fontSize: 'clamp(8.5cqh, 12cqw, 13.5cqh)', filter: `drop-shadow(0 0 0.8cqh ${config.color})` }}
              initial={{ scale: 0.9, rotate: 0, opacity: 0 }}
              animate={
                isOpening
                  ? reducedMotion
                    ? { scale: 1, opacity: 1 }
                    : { scale: [1, 1.08, 1], rotate: [0, -3, 3, 0], opacity: 1 }
                  : reducedMotion
                    ? { scale: 0.94, opacity: 0 }
                    : { scale: [1.05, 1.3, 0], rotate: [0, -10, 14], opacity: [1, 1, 0] }
              }
              transition={
                isOpening
                  ? { duration: Math.max(0.6, config.shakeMs / 1200), repeat: reducedMotion ? 0 : Infinity, ease: 'easeInOut' }
                  : { duration: reducedMotion ? 0.35 : 0.7, ease: 'easeInOut' }
              }
            >
              📦
            </motion.span>

            {isShowing && particles.map((particle) => (
              <motion.span
                key={particle.id}
                className="absolute rounded-full"
                style={{ width: particle.size, height: particle.size, backgroundColor: config.color }}
                initial={{ x: 0, y: 0, opacity: 0.95, scale: 1 }}
                animate={{ x: particle.tx, y: particle.ty, opacity: 0, scale: 0.4 }}
                transition={{ duration: particle.duration, delay: particle.delay, ease: 'easeOut' }}
              />
            ))}
          </div>

          {isShowing ? (
            <motion.div
              className="rounded-[2.2cqh] border border-yellow-200/60 bg-black/32 px-[clamp(1.8cqh,3cqw,3.4cqh)] py-[clamp(1.1cqh,1.8cqw,2.2cqh)] text-center text-yellow-100 shadow-[0_0_2.2cqh_rgba(255,215,0,0.4)]"
              style={{ fontSize: 'clamp(1.5cqh, 2.5cqw, 2.9cqh)' }}
              initial={{ opacity: 0, scale: 0.7, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0.3 : 0.45, ease: 'easeOut' }}
            >
              <p className="font-semibold tracking-[0.04em]">+{config.rewards.stardust} ⭐</p>
              <p className="mt-[clamp(0.25cqh,0.5cqw,0.7cqh)] font-semibold tracking-[0.04em]">+{config.rewards.familyCoin} 🪙</p>
            </motion.div>
          ) : null}

          <motion.p
            className="text-center text-white/85"
            style={{ fontSize: 'clamp(1.2cqh, 2.1cqw, 2.6cqh)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: isShowing ? 1 : 0 }}
            transition={{ duration: 0.28 }}
          >
            {config.xiaokeLine}
          </motion.p>
        </div>

        {isShowing && fireworks.length > 0 ? (
          <div className="absolute inset-0">
            {fireworks.map((firework) => (
              <motion.div
                key={firework.id}
                className="absolute"
                style={{ left: firework.x, top: firework.y }}
                initial={{ opacity: 0, scale: 0.3 }}
                animate={{ opacity: [0, 1, 0], scale: [0.2, 1.35, 0.5] }}
                transition={{ duration: 1.1, delay: firework.delay, repeat: Infinity, repeatDelay: 0.3 }}
              >
                <span
                  className="absolute rounded-full"
                  style={{
                    width: 'clamp(0.9cqh,1.4cqw,1.9cqh)',
                    height: 'clamp(0.9cqh,1.4cqw,1.9cqh)',
                    backgroundColor: firework.color,
                    boxShadow: `0 0 1.5cqh ${firework.color}`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              </motion.div>
            ))}
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  );
}
// CODEX-PROVIDED-D3
