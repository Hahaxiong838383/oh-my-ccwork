import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/app-store';

/**
 * KidsHub 专属字幕条 —— 电影字幕式整句渲染（C2 2026-06-19）
 *
 * 字幕来源：CanvasHost 的 cue rAF（读 server tts.cue 的整句文本 + AudioContext 播放时刻）
 * 直接 setSubtitle(整句)。无打字机、无逐字、无渐隐、无高亮——像影院字幕一行一行整句出现，
 * 与音频严格同步。ASR 用户字幕 / 错误文案也走同一 subtitle 字符串。
 *
 * 长 cue（Doubao 偶把多句合一段）最多显示 2 行（底部对齐保留尾部）。
 * 消失：主责在 CanvasHost onPlaybackEnd 的延迟清空；这里只留 15s 静默兜底。
 */
export function KidsHubSubtitle() {
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setUserSubtitle = useAppStore((s) => s.setUserSubtitle);

  // 静默兜底：同一条字幕 15s 没变化（信号缺失没被清/换）自动清
  useEffect(() => {
    if (!subtitle.trim()) return;
    const id = window.setTimeout(() => setSubtitle(''), 15_000);
    return () => window.clearTimeout(id);
  }, [subtitle, setSubtitle]);

  // 用户字幕(实时对话 RTC 模式,useVolcRtc 写入的火山 ASR 转写)同样 15s 静默兜底清
  useEffect(() => {
    if (!userSubtitle.trim()) return;
    const id = window.setTimeout(() => setUserSubtitle(''), 15_000);
    return () => window.clearTimeout(id);
  }, [userSubtitle, setUserSubtitle]);

  const [statusVisible, setStatusVisible] = useState(false);
  useEffect(() => {
    setStatusVisible(voiceStatus !== 'idle');
  }, [voiceStatus]);

  const hasText = subtitle.trim().length > 0;
  const hasUserText = userSubtitle.trim().length > 0;
  if (!hasText && !hasUserText && !statusVisible) return null;

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-[0.6cqh]"
      style={{ bottom: '1cqh', width: '98cqw', maxWidth: '98cqw' }}
    >
      {/* 用户说话字幕（实时对话 RTC：火山 ASR 转写。小灰条在小可字幕上方，样式对齐 /live 页） */}
      {hasUserText && (
        <div
          className="rounded-[3px] bg-black/30 px-[3cqw] py-[0.3cqh] text-center backdrop-blur-md"
          style={{
            maxWidth: '92%',
            fontSize: 'clamp(9px, 2.2cqw, 12px)',
            lineHeight: 1.4,
            letterSpacing: '0.05em',
            fontWeight: 300,
            color: 'rgba(226,232,240,0.92)',
            maxHeight: '2.8em',
            overflow: 'hidden',
          }}
        >
          你：{userSubtitle}
        </div>
      )}

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

      {/* 字幕：电影字幕式整句单层渲染。长 cue 最多 2 行（底部对齐保留尾部，当前句永远可见）。 */}
      {hasText && (
        <div
          className="rounded-[3px] bg-black/50 px-[3.5cqw] py-[0.4cqh] text-center backdrop-blur-md"
          style={{
            maxWidth: '100%',
            fontSize: 'clamp(10px, 2.6cqw, 14px)',
            lineHeight: 1.4,
            letterSpacing: '0.06em',
            fontWeight: 300,
            color: '#fff',
            maxHeight: '2.8em',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
          }}
        >
          <div>{subtitle}</div>
        </div>
      )}
    </div>
  );
}
