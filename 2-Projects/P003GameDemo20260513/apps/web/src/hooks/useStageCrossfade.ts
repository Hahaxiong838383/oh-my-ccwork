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
  const [currentOpacity, setCurrentOpacity] = useState(1);

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
