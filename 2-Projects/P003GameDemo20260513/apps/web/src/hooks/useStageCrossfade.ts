import { useEffect, useMemo, useState } from 'react';
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
  // D5 P10：初始 opacity 0 → mount 后 raf 切 1，让首帧也有淡入
  // 修复 launching→running 切场景时 03 图视觉断帧的"没图"错觉
  const [currentOpacity, setCurrentOpacity] = useState(0);

  useEffect(() => {
    setAlternateOn(false);
  }, [focusStage]);

  // D5 P10：mount 后立即把 opacity 拉到 1（首帧 fade-in 300ms）
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setCurrentOpacity(1));
    return () => window.cancelAnimationFrame(raf);
  }, []);

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
    if (targetSrc === currentSrc) return;

    let raf = 0;
    const cleanupTimer = window.setTimeout(() => {
      setPreviousSrc(null);
      setIsFading(false);
      setCurrentOpacity(1);
    }, fadeDurationMs);

    setPreviousSrc(currentSrc);
    setCurrentSrc(targetSrc);
    setCurrentOpacity(0);
    setIsFading(true);

    raf = window.requestAnimationFrame(() => {
      setCurrentOpacity(1);
    });

    return () => {
      window.clearTimeout(cleanupTimer);
      window.cancelAnimationFrame(raf);
    };
  }, [currentSrc, fadeDurationMs, targetSrc]);

  return {
    currentSrc,
    previousSrc,
    isFading,
    currentOpacity,
  };
}
