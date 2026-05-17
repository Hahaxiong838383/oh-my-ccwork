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

  // D5 P22：跨句重挂 key 触发 fade-up 动画（打字机推进过程中 prefix 共享 key 不重挂）
  // 检测规则：新文本不是旧文本的 prefix → 跨句了 → key++
  const containerRef = useRef<HTMLDivElement>(null);
  const prevTextRef = useRef('');
  const [sentenceKey, setSentenceKey] = useState(0);
  const scrollState = { dur: 0, offset: 0 } as const;

  useEffect(() => {
    const text = subtitle;
    if (text.length === 0) {
      prevTextRef.current = '';
      return;
    }
    const prev = prevTextRef.current;
    if (prev.length > 0 && !text.startsWith(prev)) {
      // 不是 prev 的 prefix → 是新句，触发 key++
      setSentenceKey((k) => k + 1);
    }
    prevTextRef.current = text;
  }, [subtitle]);

  // 字幕说完自动消失：N 秒后清空
  // D5 P22：公式 text.length × 240ms + 1500ms buffer，匹配打字机/TTS 5 字/秒
  // 旧公式 130ms/字 太短，字幕在 TTS 说完前就消失了
  // clamp [3500ms, 12000ms]
  useEffect(() => {
    const text = subtitle.trim();
    if (text.length === 0) return;
    const baseMs = Math.max(3_500, Math.min(12_000, text.length * 240 + 1500));
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
          style={{ bottom: '1cqh', width: '98cqw', maxWidth: '98cqw' }}
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

          {/* 字幕色块：D5 P22 改用单句显示 + 跨句 fade-up，单句容器只显示一行，
              逐字打字 + 跨句滑动效果由 AnimatePresence key={sentenceKey} 驱动 */}
          {subtitle.trim().length > 0 && (
            <div
              ref={containerRef}
              className="relative overflow-hidden bg-black/50 px-[3.5cqw] py-[0.4cqh] backdrop-blur-md"
              style={{
                borderRadius: '3px',
                width: '100%',
                maxWidth: '100%',
                height: 'calc(clamp(10px, 2.6cqw, 14px) * 1.4 + 8px)',
                lineHeight: 1.4,
                boxSizing: 'border-box',
                textAlign: 'center',
              }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={sentenceKey}
                  initial={{ y: '60%', opacity: 0 }}
                  animate={{ y: '0%', opacity: 1 }}
                  exit={{ y: '-60%', opacity: 0 }}
                  transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 flex items-center justify-center font-light text-white"
                  style={{
                    fontSize: 'clamp(10px, 2.6cqw, 14px)',
                    letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    padding: '0 1cqw',
                  }}
                >
                  {subtitle}
                </motion.span>
              </AnimatePresence>
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
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
