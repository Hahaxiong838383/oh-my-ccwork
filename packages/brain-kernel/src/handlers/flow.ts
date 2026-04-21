import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FlowMetrics } from '@evodesk/shared';
import {
  getLatestDegradationMetrics,
  recentTasks,
} from '../memory/memory-db.js';
import { logFlowStateTransition, recentFlowStates } from '../flow/flow-state.js';
import { challengeRatio, skillLevel } from '../flow/skill-level.js';
import { isDegrading } from '../flow/degradation-detector.js';
import { taskComplexity } from '../flow/task-complexity.js';
import { getCurrentFlowState, jsonResponse } from './_shared.js';

function handleFlowMetrics(_req: IncomingMessage, res: ServerResponse): void {
  const { state, boost } = getCurrentFlowState();

  const tasks = recentTasks(20);
  const degradationMetrics = getLatestDegradationMetrics();
  const skill = skillLevel(tasks);
  const latestTask = tasks[0];
  const complexity = latestTask ? taskComplexity(latestTask) : 0;
  const ratio = challengeRatio(complexity, skill);

  const degradationInput = degradationMetrics
    ? {
      thinkingRatio: degradationMetrics.thinkingRatio ?? 0.5,
      templateSimilarity: degradationMetrics.templateSimilarity,
      toolSkipRate: degradationMetrics.toolSkipRate,
      verificationSkipped: degradationMetrics.verificationSkipped,
      firstDraftAccepted: degradationMetrics.firstDraftAccepted,
      taskComplexity: complexity,
    }
    : {
      thinkingRatio: 0.5,
      templateSimilarity: 0.3,
      toolSkipRate: 0.1,
      verificationSkipped: false,
      firstDraftAccepted: false,
      taskComplexity: complexity,
    };

  // 记录心流状态转换
  logFlowStateTransition(state, ratio);

  const metrics: FlowMetrics = {
    challengeRatio: ratio,
    skillLevel: skill,
    taskComplexity: complexity,
    isDegrading: isDegrading(degradationInput),
    flowState: state,
    boost: boost.active ? boost : undefined,
    timestamp: Date.now(),
  };
  jsonResponse(res, 200, metrics);
}

function handleFlowHistory(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const rawDays = parseInt(urlObj.searchParams.get('days') ?? '7', 10);
  if (!Number.isFinite(rawDays)) {
    jsonResponse(res, 400, { error: 'Invalid days parameter' });
    return;
  }
  const days = Math.min(Math.max(rawDays, 1), 30);

  const states = recentFlowStates(days * 288); // 假设每 5min 一条，每天 288 条
  if (states.length === 0) {
    jsonResponse(res, 200, { days, distribution: {}, dailyBreakdown: [], message: '暂无足够数据' });
    return;
  }

  // 全局分布
  const counts: Record<string, number> = { FLOW: 0, BOREDOM: 0, ANXIETY: 0, APATHY: 0 };
  for (const s of states) {
    counts[s.state] = (counts[s.state] ?? 0) + 1;
  }
  const total = states.length;
  const distribution = Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, Number((v / total).toFixed(3))]),
  );

  // 按天聚合
  const dayMap = new Map<string, Record<string, number>>();
  for (const s of states) {
    const dayKey = new Date(s.timestamp).toISOString().slice(0, 10);
    const dayBucket = dayMap.get(dayKey) ?? { FLOW: 0, BOREDOM: 0, ANXIETY: 0, APATHY: 0 };
    dayBucket[s.state] = (dayBucket[s.state] ?? 0) + 1;
    dayMap.set(dayKey, dayBucket);
  }

  const dailyBreakdown = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const dayTotal = Object.values(bucket).reduce((a, b) => a + b, 0);
      return {
        date,
        total: dayTotal,
        distribution: Object.fromEntries(
          Object.entries(bucket).map(([k, v]) => [k, Number((v / dayTotal).toFixed(3))]),
        ),
      };
    });

  // 周环比：最近 7 天 vs 之前 7 天的平均 skillLevel（从 task_log 近似）
  const recentTasksData = recentTasks(40);
  const now = Date.now();
  const weekMs = 7 * 24 * 3600 * 1000;
  const thisWeekTasks = recentTasksData.filter(t => t.completedAt > now - weekMs);
  const lastWeekTasks = recentTasksData.filter(t => t.completedAt > now - 2 * weekMs && t.completedAt <= now - weekMs);

  const thisWeekSkill = thisWeekTasks.length > 0 ? skillLevel(thisWeekTasks) : null;
  const lastWeekSkill = lastWeekTasks.length > 0 ? skillLevel(lastWeekTasks) : null;
  const deltaGain = thisWeekSkill !== null && lastWeekSkill !== null
    ? Number((thisWeekSkill - lastWeekSkill).toFixed(3))
    : null;

  jsonResponse(res, 200, {
    days,
    total: states.length,
    distribution,
    dailyBreakdown,
    deltaGain: { thisWeek: thisWeekSkill, lastWeek: lastWeekSkill, delta: deltaGain },
  });
}

export async function handleFlow(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/v1/flow/metrics' && method === 'GET') {
    handleFlowMetrics(req, res);
    return true;
  }
  if (url.startsWith('/v1/flow/history') && method === 'GET') {
    handleFlowHistory(req, res);
    return true;
  }
  return false;
}
