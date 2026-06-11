import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/app-store';

/**
 * KidsHub 专属字幕条 —— 打字机模式的朴素单层渲染
 *
 * 为什么不复用原 demo StatusBar：它的 AnimatePresence popLayout + sentenceKey 重挂
 * 是为"整句一次性 set"设计的；打字机每 180ms set 一次，高频更新下 exit 节点泄漏，
 * 实测出现"句首字重复 + 前句首字残留"（「就在你…」显示「就就在」）。
 * 打字机本身就是动画，渲染层只需要稳定的单层文本。
 *
 * 消失逻辑：主责在打字机 finishPlayback 的 onClear；这里只留 15s 静默兜底
 * （覆盖 ASR 用户字幕 / 错误文案这类不走打字机的直接 setSubtitle）。
 */
export function KidsHubSubtitle() {
  const subtitle = useAppStore((s) => s.subtitle);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);

  // 静默兜底：同一条字幕 15s 没变化（没被打字机清/换）自动清
  useEffect(() => {
    if (!subtitle.trim()) return;
    const id = window.setTimeout(() => setSubtitle(''), 15_000);
    return () => window.clearTimeout(id);
  }, [subtitle, setSubtitle]);

  const [statusVisible, setStatusVisible] = useState(false);
  useEffect(() => {
    setStatusVisible(voiceStatus !== 'idle');
  }, [voiceStatus]);

  const hasText = subtitle.trim().length > 0;
  if (!hasText && !statusVisible) return null;

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-[0.6cqh]"
      style={{ bottom: '1cqh', width: '98cqw', maxWidth: '98cqw' }}
    >
      {/* voiceStatus 指示器（聆听/思考/说话） */}
      {voiceStatus !== 'idle' && (
        <div className="rounded-[3px] bg-black/25 px-[2cqw] py-[0.3cqh] backdrop-blur-md">
          {voiceStatus === 'listening' && (
            <div className="flex items-center gap-1.5 text-[clamp(9px,2.2cqw,12px)] text-blue-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-300" />
              <span>小可正在听...</span>
            </div>
          )}
          {voiceStatus === 'thinking' && (
            <div className="text-[clamp(9px,2.2cqw,12px)] text-yellow-200">小可在想…</div>
          )}
          {voiceStatus === 'speaking' && (
            <div className="text-[clamp(9px,2.2cqw,12px)] text-emerald-200">小可正在说</div>
          )}
        </div>
      )}

      {/* 字幕：单层稳定渲染，打字机控节奏 */}
      {hasText && (
        <div
          className="rounded-[3px] bg-black/50 px-[3.5cqw] py-[0.4cqh] text-center backdrop-blur-md"
          style={{
            maxWidth: '100%',
            fontSize: 'clamp(10px, 2.6cqw, 14px)',
            lineHeight: 1.4,
            letterSpacing: '0.06em',
            color: '#fff',
            fontWeight: 300,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}
