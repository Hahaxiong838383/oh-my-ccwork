import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/app-store';

interface StatusBarProps {}

/**
 * StatusBar —— 全局字幕条 + voiceStatus 指示器
 *
 * 视觉规范（2026-05-17 川哥统一标准）：
 *   - 位置垂直对齐 Welcome 自渲染字幕：bottom: 6cqh
 *   - 形状复刻 Welcome 胶囊：rounded-full bg-black/40 backdrop-blur-md
 *   - 宽度根据文字长度自适应，maxWidth: min(94cqw, 760px)（允许更宽到边缘）
 *   - 单行不换行（whiteSpace: nowrap），超出 maxWidth 时 marquee 横向滚动
 *   - voiceStatus 指示器移到字幕胶囊上方（小一号、悬浮）
 */
export function StatusBar(_props: StatusBarProps) {
  const subtitle = useAppStore((s) => s.subtitle);
  const voiceStatus = useAppStore((s) => s.voiceStatus);

  const visible = subtitle.trim().length > 0 || voiceStatus !== 'idle';

  // marquee 长文字横向滚动检测：JS 算溢出像素 + CSS variable
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollState, setScrollState] = useState<{ dur: number; offset: number }>({ dur: 0, offset: 0 });

  useEffect(() => {
    if (!containerRef.current || !textRef.current) {
      setScrollState({ dur: 0, offset: 0 });
      return;
    }
    // 等下一帧拿到真实宽度
    const id = window.requestAnimationFrame(() => {
      const cw = containerRef.current?.clientWidth ?? 0;
      const tw = textRef.current?.scrollWidth ?? 0;
      const overflow = tw - cw;
      if (overflow > 4) {
        // 滚动速度 ~80px/s，根据溢出长度算总时长
        const dur = Math.max(5, Math.min(25, overflow / 80 + 4));
        setScrollState({ dur, offset: overflow });
      } else {
        setScrollState({ dur: 0, offset: 0 });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [subtitle]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          // 与 Welcome.tsx baked 字幕同一垂直位置 6cqh，自适应宽度
          initial={{ opacity: 0, y: 12, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: 12, x: '-50%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="pointer-events-none absolute left-1/2 z-layer-feedback flex flex-col items-center gap-[1cqh]"
          style={{ bottom: '6cqh', maxWidth: 'min(94cqw, 760px)' }}
        >
          {/* voiceStatus 指示器悬浮在字幕胶囊上方 */}
          {voiceStatus !== 'idle' && (
            <div className="rounded-full bg-black/30 px-[2.5cqw] py-[0.5cqh] backdrop-blur-md">
              {voiceStatus === 'listening' && (
                <div className="flex items-center gap-1.5 text-[clamp(10px,2.6cqw,14px)] text-blue-200">
                  <span className="h-2 w-2 rounded-full bg-blue-300 animate-pulse" />
                  <span>小可正在听...</span>
                </div>
              )}
              {voiceStatus === 'thinking' && (
                <div className="flex items-center gap-1.5 text-[clamp(10px,2.6cqw,14px)] text-yellow-200">
                  <span>小可在想</span>
                  <span className="flex items-end gap-1">
                    {[0, 1, 2].map((item) => (
                      <span
                        key={`thinking-dot-${item}`}
                        className="h-1.5 w-1.5 rounded-full bg-yellow-200"
                        style={{ animation: `status-thinking 0.9s ease-in-out ${item * 0.16}s infinite` }}
                      />
                    ))}
                  </span>
                </div>
              )}
              {voiceStatus === 'speaking' && (
                <div className="flex items-center gap-1.5 text-[clamp(10px,2.6cqw,14px)] text-emerald-200">
                  <span>小可正在说</span>
                  <span className="flex h-3 items-end gap-0.5">
                    {[0, 1, 2].map((item) => (
                      <span
                        key={`speaking-wave-${item}`}
                        className="w-1 rounded-full bg-emerald-300"
                        style={{ animation: `status-speaking-wave 0.8s ease-in-out ${item * 0.1}s infinite` }}
                      />
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 字幕胶囊（复刻 Welcome 风格） */}
          {subtitle.trim().length > 0 && (
            <div
              ref={containerRef}
              className="overflow-hidden rounded-full bg-black/40 px-[5cqw] py-[1.6cqh] backdrop-blur-md"
              style={{ maxWidth: '100%' }}
            >
              <span
                ref={textRef}
                className="inline-block font-light text-white"
                style={{
                  fontSize: 'clamp(12px, 3.4cqw, 18px)',
                  letterSpacing: '0.08em',
                  whiteSpace: 'nowrap',
                  ['--marquee-offset' as string]: `-${scrollState.offset}px`,
                  animation:
                    scrollState.dur > 0
                      ? `subtitle-marquee ${scrollState.dur}s linear infinite`
                      : 'none',
                }}
              >
                {subtitle}
              </span>
            </div>
          )}

          <style>{`
            @keyframes status-thinking {
              0%, 100% { transform: translateY(0); opacity: 0.35; }
              50% { transform: translateY(-3px); opacity: 1; }
            }
            @keyframes status-speaking-wave {
              0%, 100% { height: 4px; opacity: 0.6; }
              50% { height: 10px; opacity: 1; }
            }
            @keyframes subtitle-marquee {
              0%, 12% { transform: translateX(0); }
              88%, 100% { transform: translateX(var(--marquee-offset, 0px)); }
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
