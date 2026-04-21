import type { TaskRecord } from '@evodesk/shared';

interface ComplexityFactors {
  readonly toolCount: number;
  readonly stepCount: number;
  readonly contextDepth: number;
  readonly novelty: number;
  readonly stakeLevel: number;
}

const WEIGHTS = [0.15, 0.25, 0.2, 0.3, 0.1] as const;

function fin(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function computeFactors(task: TaskRecord): ComplexityFactors {
  return {
    toolCount: Math.min(Math.max(fin(task.toolCallsRequired, 0) / 10, 0), 1),
    stepCount: Math.min(Math.max(fin(task.estimatedSteps, 0) / 20, 0), 1),
    contextDepth: Math.min(Math.max(fin(task.memoryRetrievalCount, 0) / 5, 0), 1),
    novelty: Math.min(Math.max(1 - fin(task.similarTaskSuccessRate, 0), 0), 1),
    stakeLevel: task.isReversible ? 0.3 : 0.8,
  };
}

export function taskComplexity(task: TaskRecord): number {
  const factors = computeFactors(task);
  const values = [factors.toolCount, factors.stepCount, factors.contextDepth, factors.novelty, factors.stakeLevel];
  const result = values.reduce((acc, v, i) => acc * Math.pow(Math.max(v, 0.001), WEIGHTS[i]), 1);
  return Number.isFinite(result) ? result : 0;
}
