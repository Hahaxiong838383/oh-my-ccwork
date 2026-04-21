/**
 * 降智检测校准器
 *
 * 使用标注数据集验证 isDegrading() 的准确率，
 * 并尝试不同阈值组合寻找最优参数。
 */

import { isDegrading } from '../flow/degradation-detector.js';
import { DEGRADATION_TEST_CASES, type DegradationTestCase } from './eval-tasks.js';

export interface ConfusionMatrix {
  readonly tp: number; // True Positive: 实际降智，预测降智
  readonly tn: number; // True Negative: 实际正常，预测正常
  readonly fp: number; // False Positive: 实际正常，预测降智
  readonly fn: number; // False Negative: 实际降智，预测正常
}

export interface CalibrationReport {
  readonly matrix: ConfusionMatrix;
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly totalCases: number;
  readonly details: readonly CaseDetail[];
  readonly timestamp: number;
}

interface CaseDetail {
  readonly caseId: string;
  readonly label: 'degraded' | 'normal';
  readonly predicted: boolean;
  readonly correct: boolean;
  readonly description: string;
}

/**
 * 运行校准：用标注数据集测试当前 isDegrading() 阈值
 */
export function runCalibration(): CalibrationReport {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  const details: CaseDetail[] = [];

  for (const testCase of DEGRADATION_TEST_CASES) {
    const predicted = isDegrading(testCase.metrics);
    const expected = testCase.label === 'degraded';
    const correct = predicted === expected;

    if (expected && predicted) tp++;
    else if (!expected && !predicted) tn++;
    else if (!expected && predicted) fp++;
    else fn++;

    details.push({
      caseId: testCase.caseId,
      label: testCase.label,
      predicted,
      correct,
      description: testCase.description,
    });
  }

  const total = tp + tn + fp + fn;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    matrix: { tp, tn, fp, fn },
    accuracy,
    precision,
    recall,
    f1,
    totalCases: total,
    details,
    timestamp: Date.now(),
  };
}

/**
 * 格式化校准报告为可读文本
 */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    '# 降智检测校准报告',
    '',
    '## 混淆矩阵',
    '|  | 预测降智 | 预测正常 |',
    '|--|---------|---------|',
    `| 实际降智 | TP=${report.matrix.tp} | FN=${report.matrix.fn} |`,
    `| 实际正常 | FP=${report.matrix.fp} | TN=${report.matrix.tn} |`,
    '',
    '## 指标',
    `- 准确率: ${(report.accuracy * 100).toFixed(1)}%${report.accuracy >= 0.75 ? ' ✅' : ' ❌ (目标 >75%)'}`,
    `- 精确率: ${(report.precision * 100).toFixed(1)}%`,
    `- 召回率: ${(report.recall * 100).toFixed(1)}%`,
    `- F1: ${(report.f1 * 100).toFixed(1)}%`,
    `- 总样本: ${report.totalCases}`,
    '',
    '## 详细结果',
    '| Case | 标签 | 预测 | 结果 | 描述 |',
    '|------|------|------|------|------|',
  ];

  for (const d of report.details) {
    const pred = d.predicted ? '降智' : '正常';
    const result = d.correct ? '✅' : '❌';
    lines.push(`| ${d.caseId} | ${d.label} | ${pred} | ${result} | ${d.description} |`);
  }

  return lines.join('\n');
}
