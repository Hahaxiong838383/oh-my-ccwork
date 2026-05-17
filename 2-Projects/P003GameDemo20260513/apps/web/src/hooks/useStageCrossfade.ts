import { useEffect, useMemo, useRef, useState } from 'react';
import { type FocusStage } from '../store/app-store';

interface UseStageCrossfadeOptions {
  fadeDurationMs?: number;
  alternateSrc?: string;
  alternateIntervalMs?: number;
  alternateEnabled?: boolean;
}

interface StageCrossfadeState {
  currentSrc: string;
  previousSrc: string | null;
  isFading: boolean;
  currentOpacity: number;
}

const DEFAULT_FADE_DURATION_MS = 300;
const DEFAULT_ALTERNATE_INTERVAL_MS = 1_500;

export function useStageCrossfade(
  focusStage: FocusStage,
  imageMap: Record<FocusStage, string>,
  options: UseStageCrossfadeOptions = {},
): StageCrossfadeState {
  const {
    fadeDurationMs = DEFAULT_FADE_DURATION_MS,
    alternateSrc,
    alternateIntervalMs = DEFAULT_ALTERNATE_INTERVAL_MS,
    alternateEnabled = false,
  } = options;

  const [alternateOn, setAlternateOn] = useState(false);

  const shouldAlternate = Boolean(alternateEnabled && focusStage === 'active' && alternateSrc);
  const baseSrc = imageMap[focusStage];

  const targetSrc = useMemo(() => {
    if (!shouldAlternate || !alternateSrc) return baseSrc;
    return alternateOn ? alternateSrc : baseSrc;
  }, [alternateOn, alternateSrc, baseSrc, shouldAlternate]);

  const [currentSrc, setCurrentSrc] = useState(targetSrc);
  const [previousSrc, setPreviousSrc] = useState<string | null>(null);
  const [isFading, setIsFading] = useState(false);
  // D5 P11：恢复初始 opacity 1，立即可见，避免 mount 首帧黑屏
  const [currentOpacity, setCurrentOpacity] = useState(1);

  // D5 P11：用 ref 跟踪 lastSrc，让 effect deps 只依赖 targetSrc
  // 否则每次 setCurrentSrc(targetSrc) 触发 deps 变化 → cleanup 取消 raf/timer
  // → opacity 永远停在 0 → 背景全黑（截图见 D5 P10 反馈）
  const lastSrcRef = useRef(targetSrc);

  useEffect(() => {
    setAlternateOn(false);
  }, [focusStage]);

  useEffect(() => {
    if (!shouldAlternate) return;

    let cancelled = false;
    let timer: number | undefined;

    const scheduleNext = () => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setAlternateOn((value) => !value);
        scheduleNext();
      }, alternateIntervalMs);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [alternateIntervalMs, shouldAlternate]);

  useEffect(() => {
    if (targetSrc === lastSrcRef.current) return;
    const prevSrc = lastSrcRef.current;
    lastSrcRef.current = targetSrc;

    setPreviousSrc(prevSrc);
    setCurrentSrc(targetSrc);
    setCurrentOpacity(0);
    setIsFading(true);

    // D5 P11：raf + timer 不挂 cleanup，避免下次 effect 触发时被 cancel
    // 即使切换很快，最终 opacity 一定 = 1
    window.requestAnimationFrame(() => {
      setCurrentOpacity(1);
    });
    window.setTimeout(() => {
      setPreviousSrc(null);
      setIsFading(false);
      setCurrentOpacity(1);
    }, fadeDurationMs);
  }, [targetSrc, fadeDurationMs]);

  return {
    currentSrc,
    previousSrc,
    isFading,
    currentOpacity,
  };
}
