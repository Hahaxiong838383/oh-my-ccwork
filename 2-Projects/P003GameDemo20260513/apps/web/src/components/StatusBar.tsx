import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/app-store';

interface StatusBarProps {}

/**
 * StatusBar —— 全局字幕条 + voiceStatus 指示器
 *
 * 视觉规范（2026-05-17 D5 P6 川哥统一标准）：
 *   - 位置：bottom: 1cqh（贴屏幕底部）
 *   - 形状：rounded-[3px] 4 圆角统一 + bg-black/50 + backdrop-blur-md 磨砂玻璃
 *   - 垂直尺寸缩小一半：py-[0.8cqh]
 *   - 字号缩小：fontSize clamp(10px, 2.6cqw, 14px)
 *   - 宽度根据文字长度自适应，maxWidth: min(94cqw, 760px)
 *   - 长文 marquee 纵向向上滚动（whitespace: normal，超过 2 行容器高度时 translateY 卷动）
 *   - 字幕说完自动消失：N s 后 setSubtitle('')，N = max(2.5, length×0.13 + 1.5)
 */
export function StatusBar(_props: StatusBarProps) {
  const subtitle = useAppStore((s) => s.subtitle);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);

  const visible = subtitle.trim().length > 0 || voiceStatus !== 'idle';

  // marquee 长文字纵向向上滚动检测：JS 算溢出像素（scrollHeight - clientHeight） + CSS variable
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollState, setScrollState] = useState<{ dur: number; offset: number }>({ dur: 0, offset: 0 });

  useEffect(() => {
    if (!containerRef.current || !textRef.current) {
      setScrollState({ dur: 0, offset: 0 });
      return;
    }
    const id = window.requestAnimationFrame(() => {
      const c = containerRef.current;
      if (!c) {
        setScrollState({ dur: 0, offset: 0 });
        return;
      }
      // border-box 下用 container 自身 scrollHeight - clientHeight，
      // 自动扣除 padding，避免 span vs div 维度错位（gemini D5 P6 R3 修正）
      const overflow = c.scrollHeight - c.clientHeight;
      if (overflow > 4) {
        const dur = Math.max(4, Math.min(20, overflow / 16 + 3));
        setScrollState({ dur, offset: overflow });
      } else {
        setScrollState({ dur: 0, offset: 0 });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [subtitle]);

  // 字幕说完自动消失：N 秒后清空（time = 字数×130ms + 1500ms，clamp [2.5s, 8s]）
  // 包含长文 marquee 完整滚一遍所需时间
  useEffect(() => {
    const text = subtitle.trim();
    if (text.length === 0) return;
    const baseMs = Math.max(2500, Math.min(8000, text.length * 130 + 1500));
    // 长文滚动情况延长到滚一遍 + 缓冲
    const totalMs = scrollState.dur > 0 ? Math.max(baseMs, scrollState.dur * 1000 + 1000) : baseMs;
    const id = window.setTimeout(() => {
      setSubtitle('');
    }, totalMs);
    return () => window.clearTimeout(id);
  }, [subtitle, scrollState.dur, setSubtitle]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 8, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: 8, x: '-50%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="pointer-events-none absolute left-1/2 z-layer-feedback flex flex-col items-center gap-[0.6cqh]"
          style={{ bottom: '1cqh', maxWidth: 'min(94cqw, 760px)' }}
        >
          {/* voiceStatus 指示器悬浮在字幕上方 */}
          {voiceStatus !== 'idle' && (
            <div
              className="bg-black/25 px-[2cqw] py-[0.3cqh] backdrop-blur-md"
              style={{ borderRadius: '3px' }}
            >
              {voiceStatus === 'listening' && (
                <div className="flex items-center gap-1.5 text-[clamp(9px,2.2cqw,12px)] text-blue-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-300 animate-pulse" />
                  <span>小可正在听...</span>
                </div>
              )}
              {voiceStatus === 'thinking' && (
                <div className="flex items-center gap-1.5 text-[clamp(9px,2.2cqw,12px)] text-yellow-200">
                  <span>小可在想</span>
                  <span className="flex items-end gap-1">
                    {[0, 1, 2].map((item) => (
                      <span
                        key={`thinking-dot-${item}`}
                        className="h-1 w-1 rounded-full bg-yellow-200"
                        style={{ animation: `status-thinking 0.9s ease-in-out ${item * 0.16}s infinite` }}
                      />
                    ))}
                  </span>
                </div>
              )}
              {voiceStatus === 'speaking' && (
                <div className="flex items-center gap-1.5 text-[clamp(9px,2.2cqw,12px)] text-emerald-200">
                  <span>小可正在说</span>
                  <span className="flex h-2.5 items-end gap-0.5">
                    {[0, 1, 2].map((item) => (
                      <span
                        key={`speaking-wave-${item}`}
                        className="w-0.5 rounded-full bg-emerald-300"
                        style={{ animation: `status-speaking-wave 0.8s ease-in-out ${item * 0.1}s infinite` }}
                      />
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 字幕色块：4 圆角统一 3px + 磨砂玻璃半透 + 垂直尺寸减半 + 字号缩小
              D5 P6：whitespace normal 允许换行，容器固定为约 2 行高，长字幕向上滚动 */}
          {subtitle.trim().length > 0 && (
            <div
              ref={containerRef}
              className="overflow-hidden bg-black/50 px-[3.5cqw] py-[0.8cqh] backdrop-blur-md"
              style={{
                borderRadius: '3px',
                maxWidth: '100%',
                // border-box：maxHeight 必须包含上下 padding（py-[0.8cqh]）
                // 否则 2 行字会被裁断（gemini D5 P6 R3 修正）
                maxHeight: 'calc((clamp(10px, 2.6cqw, 14px) * 1.5) * 2 + 0.8cqh * 2)',
                lineHeight: 1.5,
                boxSizing: 'border-box',
              }}
            >
              <span
                ref={textRef}
                className="block font-light text-white"
                style={{
                  fontSize: 'clamp(10px, 2.6cqw, 14px)',
                  letterSpacing: '0.06em',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  ['--marquee-offset-y' as string]: `-${scrollState.offset}px`,
                  animation:
                    scrollState.dur > 0
                      ? `subtitle-marquee-y ${scrollState.dur}s linear infinite`
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
              50% { transform: translateY(-2px); opacity: 1; }
            }
            @keyframes status-speaking-wave {
              0%, 100% { height: 3px; opacity: 0.6; }
              50% { height: 8px; opacity: 1; }
            }
            @keyframes subtitle-marquee-y {
              0%, 15% { transform: translateY(0); }
              85%, 100% { transform: translateY(var(--marquee-offset-y, 0px)); }
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
