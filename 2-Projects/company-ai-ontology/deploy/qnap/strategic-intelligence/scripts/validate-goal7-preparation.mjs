#!/usr/bin/env node

import { validateGoal7PreparationBundle } from './goal7-phase-evidence-lib.mjs'

const root = process.env.GOAL7_DEPLOYMENT_EVIDENCE_ROOT || process.argv[2]
const sourceCommit = process.env.GOAL7_APPROVED_SOURCE_COMMIT || process.argv[3]
const hLiteSourceCommit = process.env.GOAL7_APPROVED_H_LITE_SOURCE_COMMIT || process.argv[4]
if (!root || !sourceCommit || !hLiteSourceCommit) throw new Error('preparation root and approved commits are required')

const result = await validateGoal7PreparationBundle(root, { sourceCommit, hLiteSourceCommit })
const evidence = result.evidence
process.stdout.write([
  'preparation_status=verified',
  `run_id=${evidence.runId}`,
  `source_commit=${evidence.sourceCommit}`,
  `h_lite_source_commit=${evidence.hLiteSourceCommit}`,
  `runtime_root=${evidence.runtimeRoot}`,
  `runtime_evidence_root=${evidence.runtimeEvidenceRoot}`,
  `backup_root=${evidence.backupRoot}`,
  `backup_env_sha256=${evidence.backup.envSha256}`,
  `backup_compose_sha256=${evidence.backup.composeSha256}`,
  `previous_agent_core_image_id=${evidence.images.agentCore.previousImageId}`,
  `previous_knowledge_connector_image_id=${evidence.images.knowledgeConnector.previousImageId}`,
  `previous_h_lite_image_id=${evidence.images.hLite.previousImageId}`,
  `candidate_agent_core_image_id=${evidence.images.agentCore.candidateImageId}`,
  `candidate_knowledge_connector_image_id=${evidence.images.knowledgeConnector.candidateImageId}`,
  `candidate_h_lite_image_id=${evidence.images.hLite.candidateImageId}`,
  `preparation_evidence_sha256=${result.evidenceSha256}`,
  '',
].join('\n'))
