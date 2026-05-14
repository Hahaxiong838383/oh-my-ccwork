import { useCallback, useEffect, useRef } from 'react';

/**
 * useAudioFx —— 轻量音效合成 hook（无需音频文件）
 *
 * 用 Web Audio API 合成占位音效：
 *   - thinking: "嗯..." 短促正弦波 + 淡入淡出（掩盖 AI 延迟）
 *   - bootWelcome: 启动音 + LED 呼吸节奏
 *   - boxOpen: 4 级宝箱音效（pitch 随等级升高）
 *
 * iOS Safari 要求音频需要 user gesture 才能播放。本 hook 自动在第一次
 * pointerdown 时解锁 AudioContext。所有 play* 调用前都会确保已解锁。
 *
 * D2 下午接入真 TTS 后，本 hook 提供的占位由真 TTS 流替代，接口不变。
 */
export function useAudioFx() {
  const ctxRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);

  const ensureContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (ctxRef.current) return ctxRef.current;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctxRef.current = new AC();
    return ctxRef.current;
  }, []);

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // 播一个 0ms 的零音量 buffer 解锁
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    unlockedRef.current = true;
  }, [ensureContext]);

  // 首次任意 pointerdown 解锁
  useEffect(() => {
    const onPointer = () => unlock();
    window.addEventListener('pointerdown', onPointer, { once: true });
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [unlock]);

  const playTone = useCallback(
    (opts: { freq: number; durationMs: number; type?: OscillatorType; volume?: number }) => {
      const ctx = ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const dur = opts.durationMs / 1_000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = opts.type ?? 'sine';
      osc.frequency.value = opts.freq;
      const peak = opts.volume ?? 0.15;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    },
    [ensureContext],
  );

  const playThinking = useCallback(() => {
    // "嗯..." 占位：220Hz 三角波 280ms
    playTone({ freq: 220, durationMs: 280, type: 'triangle', volume: 0.12 });
  }, [playTone]);

  const playBootWelcome = useCallback(() => {
    // K1 启动音：上升二音
    playTone({ freq: 440, durationMs: 120, type: 'sine', volume: 0.18 });
    setTimeout(() => playTone({ freq: 660, durationMs: 220, type: 'sine', volume: 0.18 }), 140);
  }, [playTone]);

  const playBoxOpen = useCallback(
    (level: 'common' | 'rare' | 'epic' | 'legendary') => {
      const pitchMap: Record<typeof level, number> = {
        common: 330,
        rare: 392,
        epic: 523,
        legendary: 784,
      };
      playTone({ freq: pitchMap[level], durationMs: 350, type: 'triangle', volume: 0.2 });
      // legendary 加一个高八度叠加
      if (level === 'legendary') {
        setTimeout(() => playTone({ freq: 1568, durationMs: 250, type: 'sine', volume: 0.12 }), 80);
      }
    },
    [playTone],
  );

  return { unlock, playThinking, playBootWelcome, playBoxOpen };
}
