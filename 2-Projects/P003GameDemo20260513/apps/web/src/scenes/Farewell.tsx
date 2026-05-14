import { motion } from 'framer-motion';
import { Xiaoke } from '../components/Xiaoke';
import { useAppStore } from '../store/app-store';

function getReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Farewell() {
  const farewellState = useAppStore((s) => s.farewellState);
  const reducedMotion = getReducedMotion();

  if (farewellState !== 'waving' && farewellState !== 'shutdown') return null;

  const isWaving = farewellState === 'waving';

  return (
    <motion.div
      className="absolute inset-0 z-layer-mask overflow-hidden text-white"
      style={{ containerType: 'size' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-[#1E1B4B] to-[#0B2A52]" />

      {isWaving ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[clamp(1.4cqh,2.2cqw,3cqh)] px-[clamp(3cqh,4.5cqw,6cqh)] text-center">
          <div className="relative flex items-center justify-center" style={{ width: 'clamp(16cqh, 23cqw, 26cqh)', height: 'clamp(16cqh, 23cqw, 26cqh)' }}>
            <Xiaoke />
            <motion.span
              className="absolute select-none"
              style={{
                left: '68%',
                top: '30%',
                fontSize: 'clamp(2.6cqh,4.4cqw,5.2cqh)',
                transformOrigin: '20% 80%',
              }}
              animate={
                reducedMotion
                  ? { opacity: 1 }
                  : { rotate: [-20, 20, -20, 20, -20], y: [0, -2, 0, -2, 0], opacity: [0.85, 1, 0.85, 1, 0.85] }
              }
              transition={{ duration: 1.5, ease: 'easeInOut', repeat: reducedMotion ? 0 : 1 }}
            >
              👋
            </motion.span>
          </div>

          <motion.p
            className="font-semibold tracking-[0.04em] text-white/95"
            style={{ fontSize: 'clamp(1.8cqh,3.1cqw,3.6cqh)' }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            指挥官，明天见～
          </motion.p>
        </div>
      ) : null}

      {!isWaving ? (
        <div className="absolute inset-0">
          <motion.div
            className="absolute inset-0 bg-black"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
          />

          <motion.p
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-center font-semibold tracking-[0.08em] text-white"
            style={{ fontSize: 'clamp(1.4cqh,2.5cqw,3cqh)' }}
            initial={{ opacity: 0 }}
            animate={reducedMotion ? { opacity: [0, 1, 0] } : { opacity: [0, 1, 1, 0] }}
            transition={{ duration: 2.5, times: reducedMotion ? [0, 0.5, 1] : [0, 0.1, 0.9, 1], ease: 'easeInOut' }}
          >
            FUTURUS · K1 让陪伴有温度
          </motion.p>
        </div>
      ) : null}
    </motion.div>
  );
}
// CODEX-PROVIDED-D3
