import {
  listUnverifiedEpisodicsBefore,
  unflagEpisodicVerified,
  type EpisodicTraceRow,
} from './memory-db.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DEFAULT_SWEEP_LIMIT = 200;

function parsePositiveMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_EPISODIC_SWEEP_INTERVAL_MS = parsePositiveMs(
  process.env.EVODESK_EPISODIC_SWEEP_INTERVAL_MS,
  ONE_HOUR_MS,
);

export const DEFAULT_EPISODIC_VERIFICATION_SLA_MS = parsePositiveMs(
  process.env.EVODESK_EPISODIC_VERIFICATION_SLA_MS,
  ONE_DAY_MS,
);

export type EpisodicReverifyDecision = 'verified' | 'rejected';
export type EpisodicReverifyFn = (trace: EpisodicTraceRow) => EpisodicReverifyDecision;
export type EpisodicWarnHook = (
  message: string,
  context: Readonly<Record<string, string | number>>,
) => void;

export interface EpisodicSweepOptions {
  readonly now?: number;
  readonly slaMs?: number;
  readonly limit?: number;
  readonly reverify?: EpisodicReverifyFn;
  readonly onWarn?: EpisodicWarnHook;
}

export interface EpisodicSweepResult {
  readonly scanned: number;
  readonly verified: number;
  readonly stillUnverified: number;
}

export interface EpisodicSweeperHandle {
  readonly intervalMs: number;
  readonly slaMs: number;
  runNow: () => EpisodicSweepResult;
  stop: () => void;
}

function defaultReverify(trace: EpisodicTraceRow): EpisodicReverifyDecision {
  return trace.event.trim().length > 0 ? 'verified' : 'rejected';
}

function defaultWarn(message: string, context: Readonly<Record<string, string | number>>): void {
  console.warn(`[M16][episodic-sweeper] ${message}`, context);
}

export function sweepUnverifiedEpisodics(options: EpisodicSweepOptions = {}): EpisodicSweepResult {
  const now = options.now ?? Date.now();
  const slaMs = options.slaMs ?? DEFAULT_EPISODIC_VERIFICATION_SLA_MS;
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const reverify = options.reverify ?? defaultReverify;
  const onWarn = options.onWarn ?? defaultWarn;
  const cutoff = now - slaMs;
  const overdueTraces = listUnverifiedEpisodicsBefore(cutoff, limit);

  if (overdueTraces.length > 0) {
    onWarn('overdue_unverified_detected', {
      count: overdueTraces.length,
      cutoff,
      slaMs,
    });
  }

  let verified = 0;
  for (const trace of overdueTraces) {
    const decision = reverify(trace);
    if (decision === 'verified') {
      if (unflagEpisodicVerified(trace.id, 'sweeper')) {
        verified++;
      }
      continue;
    }

    onWarn('reverify_rejected', {
      traceId: trace.id,
      traceTs: trace.timestamp,
      ageMs: now - trace.timestamp,
    });
  }

  return {
    scanned: overdueTraces.length,
    verified,
    stillUnverified: overdueTraces.length - verified,
  };
}

export function startEpisodicSweeper(options: {
  readonly intervalMs?: number;
  readonly slaMs?: number;
  readonly limit?: number;
  readonly reverify?: EpisodicReverifyFn;
  readonly onWarn?: EpisodicWarnHook;
  readonly runOnStart?: boolean;
} = {}): EpisodicSweeperHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_EPISODIC_SWEEP_INTERVAL_MS;
  const slaMs = options.slaMs ?? DEFAULT_EPISODIC_VERIFICATION_SLA_MS;

  const runNow = (): EpisodicSweepResult => sweepUnverifiedEpisodics({
    slaMs,
    limit: options.limit,
    reverify: options.reverify,
    onWarn: options.onWarn,
  });

  if (options.runOnStart ?? true) {
    runNow();
  }

  const timer = setInterval(runNow, intervalMs);
  timer.unref();

  return {
    intervalMs,
    slaMs,
    runNow,
    stop: (): void => clearInterval(timer),
  };
}
