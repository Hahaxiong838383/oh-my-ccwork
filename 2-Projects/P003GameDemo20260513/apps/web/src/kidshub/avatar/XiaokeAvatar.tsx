import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from '../../store/app-store';
import { useKidsHubStore } from '../store/kidshub-store';
import { useAvatarStore } from './avatar-store';
import { EXPRESSIONS, IDLE_POOL, POKE_POOL, expressionUrl, getExpression } from './expressions';

/**
 * XiaokeAvatar —— 画布里的小可本体（白色猫耳机器人，表情库驱动）
 *
 * 三层表情来源（仲裁在 avatar-store）：
 *  1. 状态机兜底：voiceStatus（聆听/思考/说话/待机）+ 连网态
 *  2. LLM 逐句标记：server 解析【表情：xxx】→ avatar.expression 事件（CanvasHost 接线）
 *  3. 互动：点小可本体随机开心反应；表情库面板手动指定
 *
 * 动画：表情切换弹跳（bumpKey 重挂）/ 待机慢呼吸 / 说话快 bob / 思考左右轻摇。
 */
export function XiaokeAvatar() {
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);

  const expressionId = useAvatarStore((s) => s.expressionId);
  const fileIndex = useAvatarStore((s) => s.fileIndex);
  const bumpKey = useAvatarStore((s) => s.bumpKey);
  const source = useAvatarStore((s) => s.source);
  const setExpression = useAvatarStore((s) => s.setExpression);
  const applyVoiceStatus = useAvatarStore((s) => s.applyVoiceStatus);

  const def = getExpression(expressionId);
  const file = def?.files[Math.min(fileIndex, (def?.files.length ?? 1) - 1)] ?? 'head-tilt.png';

  // 全量预加载：换表情不闪白（25 张约 4.6MB，本地工作台一次热完）
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

  // 连网成功庆祝 1.8s 后自动回待机
  useEffect(() => {
    if (expressionId !== 'net-success') return;
    const id = window.setTimeout(() => applyVoiceStatus('idle'), 1_800);
    return () => window.clearTimeout(id);
  }, [expressionId, applyVoiceStatus]);

  // 待机轮换：像有自己的小生活（歪头/招手/看书），仅 state 来源 + idle 时生效
  useEffect(() => {
    if (voiceStatus !== 'idle' || source !== 'state') return;
    const id = window.setInterval(() => {
      const pool = IDLE_POOL.filter((p) => p !== useAvatarStore.getState().expressionId);
      const next = pool[Math.floor(Math.random() * pool.length)];
      if (next) setExpression(next, 'state');
    }, 14_000);
    return () => window.clearInterval(id);
  }, [voiceStatus, source, setExpression]);

  // 点击互动：摸一摸 → 随机开心反应
  const handlePoke = () => {
    const pool = POKE_POOL.filter((p) => p !== expressionId);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? POKE_POOL[0];
    setExpression(next, 'click');
    const label = getExpression(next)?.label ?? next;
    pushDebug({ kind: 'avatar', title: `🎭 摸了摸小可 → ${label}` });
  };

  // 身体动画按状态分支（点 motion 值数组做循环）
  const bodyAnim = useMemo(() => {
    if (voiceStatus === 'speaking') {
      return { y: [0, -5, 0], rotate: 0, transition: { duration: 0.55, repeat: Infinity, ease: 'easeInOut' as const } };
    }
    if (voiceStatus === 'thinking') {
      return { y: [0, -2, 0], rotate: [-1.6, 1.6, -1.6], transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' as const } };
    }
    return { y: [0, -3, 0], rotate: 0, transition: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' as const } };
  }, [voiceStatus]);

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <motion.button
        type="button"
        aria-label={`小可（${def?.label ?? '待机'}）· 点一点逗逗它`}
        title={`小可 · ${def?.label ?? ''}（点一点逗逗它）`}
        onClick={handlePoke}
        className="pointer-events-auto absolute bottom-[11cqh] right-[2.5cqw] flex cursor-pointer select-none flex-col items-center bg-transparent outline-none"
        whileTap={{ scale: 0.94 }}
      >
        <motion.div animate={bodyAnim}>
          {/* bumpKey 重挂触发表情切换弹跳 */}
          <motion.img
            key={bumpKey}
            src={expressionUrl(file)}
            alt={def?.label ?? '小可'}
            draggable={false}
            className="h-[38cqh] w-auto drop-shadow-[0_8px_18px_rgba(0,30,80,0.45)]"
            initial={{ scale: 0.82, y: 10, opacity: 0.4 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 20 }}
          />
        </motion.div>
        {/* 脚下投影 */}
        <div className="-mt-[1.6cqh] h-[2.4cqh] w-[16cqw] max-w-[150px] rounded-[50%] bg-black/35 blur-[6px]" />
      </motion.button>
    </div>
  );
}
