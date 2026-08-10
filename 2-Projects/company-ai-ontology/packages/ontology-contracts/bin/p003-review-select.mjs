#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAN_FILE = path.join(PACKAGE_ROOT, 'catalogs/p003-impact-review-selection-plan-v1.json')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function rowObjects(page) {
  return page.data.data.map((row, index) => ({
    recordId: page.data.record_id_list[index],
    ...Object.fromEntries(page.data.fields.map((field, fieldIndex) => [field, row[fieldIndex]])),
  }))
}

function first(value) {
  return Array.isArray(value) ? value[0] : value
}

function semanticQuality(logic) {
  return /目标直接影响企业长期战略目标|“O1目的”|“灵魂优先原则”/.test(String(logic || ''))
    ? 'generated_generic_requires_rewrite'
    : 'generated_generic_requires_rewrite'
}

function facetParts(label) {
  const match = String(label).match(/^(.*)-(O1目标|O1目的|O2原则|O2原因)$/)
  if (!match) throw new Error(`invalid goal facet label ${label}`)
  return { moduleKey: match[1], facetType: match[2] }
}

function goalMatches(moduleKey, goalLabel) {
  const normalized = String(goalLabel || '').replace(/[：:]$/, '')
  return normalized.startsWith(moduleKey)
}

const exportDir = path.resolve(argument('--export-dir') || '')
const outputFile = path.resolve(argument('--output') || path.join(PACKAGE_ROOT, 'catalogs/p003-impact-review-candidate-v1.json'))
const markdownFile = argument('--markdown-output') ? path.resolve(argument('--markdown-output')) : null
if (!argument('--export-dir')) throw new Error('--export-dir is required')
const plan = JSON.parse(await fs.readFile(PLAN_FILE, 'utf8'))
const pageFiles = (await fs.readdir(exportDir)).filter((name) => /^transmission-\d{3}\.json$/.test(name)).sort()
const transmissionRecords = []
for (const file of pageFiles) transmissionRecords.push(...rowObjects(JSON.parse(await fs.readFile(path.join(exportDir, file), 'utf8'))))
const goalsPage = JSON.parse(await fs.readFile(path.join(exportDir, 'goals.json'), 'utf8'))
const goalRecords = rowObjects(goalsPage).filter((entry) => entry['文本'])
const sourceSnapshot = transmissionRecords
  .map((entry) => ({
    recordId: entry.recordId,
    matrixNumber: entry['编号'],
    primaryDimension: first(entry['一级维度']),
    secondaryDimension: first(entry['二级维度']),
    target: entry['对应内容'],
    transmissionType: entry['传导类型'],
    logic: entry['传导逻辑描述'],
    positive: entry['正向可能性'],
    negative: entry['负向可能性'],
  }))
  .sort((left, right) => left.matrixNumber - right.matrixNumber)
if (sourceSnapshot.length !== 4644) throw new Error(`expected 4644 transmission records, received ${sourceSnapshot.length}`)

const candidates = []
for (const category of plan.categories) {
  for (const [secondaryDimension, targetGoalFacetLabel] of category.pairs) {
    const source = sourceSnapshot.find((entry) => entry.secondaryDimension === secondaryDimension && entry.target === targetGoalFacetLabel)
    if (!source) throw new Error(`selection source missing: ${secondaryDimension} -> ${targetGoalFacetLabel}`)
    const { moduleKey, facetType } = facetParts(targetGoalFacetLabel)
    const goal = goalRecords.find((entry) => goalMatches(moduleKey, entry['文本']))
    if (!goal) throw new Error(`goal source missing: ${moduleKey}`)
    const facetField = {
      O1目标: 'O1-目标(+完成标准)',
      O1目的: 'O1-目的（目标的解释）',
      O2原则: 'O2-原则',
      O2原因: 'O2-原因（原则的解释说明）',
    }[facetType]
    const decisionLeverage = facetType === 'O1目标' ? 25 : facetType === 'O1目的' ? 23 : 20
    const riskPriority = category.categoryKey === 'privacy_safety_compliance' ? 10 : 5
    const score = 30 + decisionLeverage + 18 + 12 + riskPriority
    candidates.push({
      candidateKey: `p003-impact-${String(candidates.length + 1).padStart(3, '0')}`,
      productLineKey: 'p003-reading-writing-desk-ai',
      categoryKey: category.categoryKey,
      categoryName: category.displayName,
      selectionScore: score,
      selectionScoreBreakdown: {
        p003Relevance: 30,
        decisionLeverage,
        measurementFeasibility: 18,
        crossFunctionalCoverage: 12,
        riskPriority,
      },
      selectionReasons: category.selectionReasons,
      source: {
        recordId: source.recordId,
        matrixNumber: source.matrixNumber,
        rowHash: hash(source),
        primaryDimension: source.primaryDimension,
        secondaryDimension: source.secondaryDimension,
        scope: first(transmissionRecords.find((entry) => entry.recordId === source.recordId)?.['范围']) || null,
        targetGoalFacetLabel,
        transmissionType: source.transmissionType,
        generatedLogic: source.logic,
        generatedPositivePossibility: source.positive,
        generatedNegativePossibility: source.negative,
      },
      goalFacet: {
        goalRecordId: goal.recordId,
        moduleKey,
        facetType,
        sourcePreview: String(goal[facetField] || '').slice(0, 500),
      },
      sourceSemanticQuality: semanticQuality(source.logic),
      proposedAssessment: {
        direction: 'context_dependent',
        strength: 'pending_dri_review',
        expectedLag: 'pending_dri_review',
        applicabilityConditions: ['pending_dri_definition'],
        activationConditions: [
          'named_individual_dri_approved',
          'generated_logic_semantically_rewritten',
          'support_and_challenge_evidence_attached',
          'metric_baseline_and_threshold_approved',
          'applicable_compliance_review_passed'
        ],
        pauseConditions: ['source_revoked', 'evidence_stale_or_conflicted', 'validation_metric_unavailable'],
        invalidationConditions: ['dri_rejected', 'material_counterevidence_confirmed', 'p003_scope_changed']
      },
      validationMetrics: category.validationMetrics,
      evidence: { support: [], challenge: [] },
      proposedReview: {
        driRoles: category.driRoles,
        namedIndividualDri: null,
        reviewedAt: null,
      },
      state: {
        generationStatus: 'generated_draft',
        verificationStatus: 'unverified',
        activationStatus: 'inactive',
        reviewStatus: 'pending_dri_review',
      },
      reviewChecklist: {
        semanticRewriteAccepted: false,
        applicabilityConditionsAccepted: false,
        directionStrengthLagAccepted: false,
        supportEvidenceAccepted: false,
        challengeEvidenceAccepted: false,
        validationMetricAccepted: false,
        namedDriAccepted: false,
        activationDecisionAccepted: false,
      },
    })
  }
}

const catalog = {
  catalogVersion: '1.0.0-candidate.1',
  status: 'review_candidate_only',
  productLineKey: 'p003-reading-writing-desk-ai',
  selectionDate: plan.selectionDate,
  selectionMethod: plan.selectionMethod,
  source: {
    baseToken: 'Wz3EbCQwBa7elVsjU5xcOI4RnRh',
    tableId: 'tblTSoJMk6BNqQFq',
    viewId: 'vewI3BEgug',
    recordCount: sourceSnapshot.length,
    snapshotHash: hash(sourceSnapshot),
    goalRecordCount: goalRecords.length,
    goalSnapshotHash: hash(goalRecords.map((entry) => ({ recordId: entry.recordId, module: entry['文本'] }))),
  },
  activationAllowed: false,
  candidates,
}
await fs.writeFile(outputFile, `${JSON.stringify(catalog, null, 2)}\n`)

if (markdownFile) {
  const lines = [
    '# P1-SI-G P003 读写台及 AI 产品 DRI 审核包',
    '',
    `候选数：${candidates.length}；源矩阵：${sourceSnapshot.length} 条；状态：全部 generated_draft / unverified / inactive。`,
    '',
    '> 源传导文案高度模板化。每条候选都必须由真实 DRI 重写语义、补充正反证据、确认方向/强度/滞后和验证指标，才有资格进入后续激活提案。',
    '',
  ]
  for (const category of plan.categories) {
    lines.push(`## ${category.displayName}`, '', '| Matrix | 外部维度 | GoalFacet | Score | 建议 DRI |', '|---:|---|---|---:|---|')
    for (const candidate of candidates.filter((entry) => entry.categoryKey === category.categoryKey)) {
      lines.push(`| ${candidate.source.matrixNumber} | ${candidate.source.primaryDimension} / ${candidate.source.secondaryDimension} | ${candidate.source.targetGoalFacetLabel} | ${candidate.selectionScore} | ${candidate.proposedReview.driRoles.join('、')} |`)
    }
    lines.push('')
  }
  lines.push('## 统一审核门禁', '', '1. 指定实名 DRI，而不是只有角色。', '2. 重写模板化传导逻辑，明确适用条件。', '3. 至少补充一条支持证据和一条反证。', '4. 明确方向、强度、预期滞后和验证指标基线。', '5. 合规、安全或供应风险涉及否决项时必须先关闭风险。', '6. 未通过审核时继续保持 inactive，不得创建正式 P2 或员工任务。', '')
  await fs.writeFile(markdownFile, `${lines.join('\n')}\n`)
}

process.stdout.write(`${JSON.stringify({ ok: true, candidateCount: candidates.length, sourceSnapshotHash: catalog.source.snapshotHash, outputFile, markdownFile }, null, 2)}\n`)
