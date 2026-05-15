import { useEffect } from 'react';
import type { FocusMode } from '../store/app-store';

const EXPLORE_ARTS: readonly string[] = [
  '/art/focus-running/01-launching.png',
  '/art/focus-running/02-transition.png',
  '/art/focus-running/03-locked.png',
  '/art/focus-running/04-active.png',
  '/art/focus-running/05-active-rotating.png',
  '/art/focus-running/06-openable.png',
  '/art/focus-running/07-full.png',
  '/art/focus-running/08-handoff.png',
];

const COMPANION_ARTS: readonly string[] = [
  '/art/focus-companion/01-locked.png',
  '/art/focus-companion/02-active.png',
  '/art/focus-companion/03-openable.png',
  '/art/focus-companion/04-full.png',
];

export function useFocusArtPreload(focusMode: FocusMode): void {
  useEffect(() => {
    if (focusMode === null) return;
    const sources = focusMode === 'explore' ? EXPLORE_ARTS : COMPANION_ARTS;
    for (const src of sources) {
      const img = new Image();
      img.src = src;
    }
  }, [focusMode]);
}
