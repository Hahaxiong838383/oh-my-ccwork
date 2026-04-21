import type { DegradationMetrics } from '@evodesk/shared';

const MIN_SIGNALS_FOR_DEGRADATION = 2;

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function isDegrading(m: DegradationMetrics): boolean {
  const tr = fin(m.thinkingRatio);
  const ts = fin(m.templateSimilarity);
  const tsr = fin(m.toolSkipRate);
  const tc = fin(m.taskComplexity);
  const signals = [
    tr < 0.3,
    ts > 0.85,
    tsr > 0.6,
    m.verificationSkipped === true,
    m.firstDraftAccepted === true && tc > 0.5,
  ];
  return signals.filter(Boolean).length >= MIN_SIGNALS_FOR_DEGRADATION;
}

export function degradationScore(m: DegradationMetrics): number {
  const tr = fin(m.thinkingRatio);
  const ts = fin(m.templateSimilarity);
  const tsr = fin(m.toolSkipRate);
  const tc = fin(m.taskComplexity);
  let score = 0;
  if (tr < 0.3) score += (0.3 - tr) / 0.3;
  if (ts > 0.85) score += (ts - 0.85) / 0.15;
  if (tsr > 0.6) score += (tsr - 0.6) / 0.4;
  if (m.verificationSkipped === true) score += 0.5;
  if (m.firstDraftAccepted === true && tc > 0.5) score += tc * 0.5;
  return Math.min(score / 3, 1);
}
