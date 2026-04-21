import type { TaskRecord } from '@evodesk/shared';

function clamp(value: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(v, min), max);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return sum / values.length;
}

export function skillLevel(recentTasks: readonly TaskRecord[]): number {
  if (recentTasks.length === 0) return 0.5;

  const successRate = recentTasks.filter(t => t.success).length / recentTasks.length;
  const avgRetries = mean(recentTasks.map(t => clamp(t.retryCount, 0, 100)));
  const correctionRate = recentTasks.filter(t => t.userCorrected).length / recentTasks.length;

  return clamp(
    successRate * 0.5 + (1 - avgRetries / 5) * 0.3 + (1 - correctionRate) * 0.2,
    0.01,
    0.99,
  );
}

export function challengeRatio(taskComplexity: number, skill: number): number {
  if (skill === 0) return 1;
  return clamp(taskComplexity / skill, 0, 2);
}
