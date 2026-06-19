import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from '../store/app-store';
import { useAvatarStore } from '../kidshub/avatar/avatar-store';
import {
  EXPRESSIONS,
  IDLE_POOL,
  POKE_POOL,
  expressionUrl,
  getExpression,
} from '../kidshub/avatar/expressions';

/**
 * 移动端小可舞台 —— 复用表情库资源 + avatar-store 状态驱动（与工作台 XiaokeAvatar 同一套仲裁），
 * 但布局为「站在主界面空间中央偏下」：柔和地面光晕 + 投影 + 呼吸/说话 bob。
 * 苹果清新：浅色调、柔和、克制；投影改用冷灰（适配浅背景，非工作台的深蓝）。
 */
export function MobileAvatar() {
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const expressionId = useAvatarStore((s) => s.expressionId);
  const fileIndex = useAvatarStore((s) => s.fileIndex);
  const bumpKey = useAvatarStore((s) => s.bumpKey);
  const source = useAvatarStore((s) => s.source);
  const llmHold = useAvatarStore((s) => s.llmHold);
  const setExpression = useAvatarStore((s) => s.setExpression);
  const applyVoiceStatus = useAvatarStore((s) => s.applyVoiceStatus);

  const def = getExpression(expressionId);
  const file = def?.files[Math.min(fileIndex, (def?.files.length ?? 1) - 1)] ?? 'head-tilt.webp';

  // 全量预加载，换表情不闪白
  useEffect(() => {
    EXPRESSIONS.flatMap((e) => e.files).forEach((f) => {
      const img = new Image();
      img.src = expressionUrl(f);
    });
  }, []);

  // 状态机 → 表情兜底
  const prevStatusRef = useRef(voiceStatus);
  useEffect(() => {
    if (prevStatusRef.current === voiceStatus) return;
    prevStatusRef.current = voiceStatus;
    applyVoiceStatus(voiceStatus);
  }, [voiceStatus, applyVoiceStatus]);

  // 连网庆祝后回待机
  useEffect(() => {
    if (expressionId !== 'net-success') return;
    const id = window.setTimeout(() => applyVoiceStatus('idle'), 1_800);
    return () => window.clearTimeout(id);
  }, [expressionId, applyVoiceStatus]);

  // 待机轮换（仅真空闲 >20s）
  useEffect(() => {
    if (voiceStatus !== 'idle' || source !== 'state') return;
    const id = window.setInterval(() => {
      const s = useAvatarStore.getState();
      if (Date.now() - s.lastBumpAt < 20_000) return;
      const pool = IDLE_POOL.filter((p) => p !== s.expressionId);
      const next = pool[Math.floor(Math.random() * pool.length)];
      if (next) setExpression(next, 'state');
    }, 8_000);
    return () => window.clearInterval(id);
  }, [voiceStatus, source, setExpression]);

  const handlePoke = () => {
    const pool = POKE_POOL.filter((p) => p !== expressionId);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? POKE_POOL[0];
    setExpression(next, 'click');
  };

  // 身体动画按状态分支（仅 transform，硬件加速）
  const bodyAnim = useMemo(() => {
    if (voiceStatus === 'speaking' || llmHold) {
      return {
        y: [0, -6, 0],
        rotate: 0,
        transition: { duration: 0.55, repeat: Infinity, ease: 'easeInOut' as const },
      };
    }
    if (voiceStatus === 'thinking') {
      return {
        y: [0, -3, 0],
        rotate: [-1.6, 1.6, -1.6],
        transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' as const },
      };
    }
    return {
      y: [0, -4, 0],
      rotate: 0,
      transition: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' as const },
    };
  }, [voiceStatus, llmHold]);

  return (
    <div className="relative flex h-full w-full items-end justify-center">
      {/* 站立空间光晕：柔和径向高光，营造小可"站在亮处"的空间感（inline 径向渐变，tailwind v3 无 radial util） */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[12%] h-[70%] w-[82%] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(circle at 50% 42%, rgba(186,230,253,0.55) 0%, rgba(224,242,254,0.28) 42%, rgba(255,255,255,0) 72%)',
        }}
      />
      <motion.button
        type="button"
        aria-label={`小可（${def?.label ?? '待机'}）· 点一点逗逗它`}
        onClick={handlePoke}
        className="relative flex select-none flex-col items-center bg-transparent pb-5 outline-none"
        whileTap={{ scale: 0.95 }}
      >
        <motion.div animate={bodyAnim} style={{ willChange: 'transform' }}>
          <motion.img
            key={bumpKey}
            src={expressionUrl(file)}
            alt={def?.label ?? '小可'}
            draggable={false}
            className="h-[340px] w-auto"
            style={{ filter: 'drop-shadow(0 14px 22px rgba(51,65,85,0.22))' }}
            initial={{ scale: 0.84, y: 10, opacity: 0.4 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 22 }}
          />
        </motion.div>
        {/* 地面投影（浅背景适配：冷灰、柔和扩散） */}
        <div className="-mt-2 h-4 w-40 max-w-[180px] rounded-[50%] bg-slate-400/30 blur-[10px]" />
      </motion.button>
    </div>
  );
}
