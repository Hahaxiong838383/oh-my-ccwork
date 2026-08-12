#!/usr/bin/env node

import { validateGoal7MigrationBundle } from './goal7-phase-evidence-lib.mjs'

const root = process.env.GOAL7_DEPLOYMENT_EVIDENCE_ROOT || process.argv[2]
const sourceCommit = process.env.GOAL7_APPROVED_SOURCE_COMMIT || process.argv[3]
const hLiteSourceCommit = process.env.GOAL7_APPROVED_H_LITE_SOURCE_COMMIT || process.argv[4]
if (!root || !sourceCommit || !hLiteSourceCommit) throw new Error('migration root and approved commits are required')

const result = await validateGoal7MigrationBundle(root, { sourceCommit, hLiteSourceCommit })
const preparation = result.preparation.evidence
process.stdout.write([
  'migration_status=verified',
  `run_id=${preparation.runId}`,
  `source_commit=${preparation.sourceCommit}`,
  `h_lite_source_commit=${preparation.hLiteSourceCommit}`,
  `agent_core_version=${preparation.agentCoreVersion}`,
  `knowledge_connector_version=${preparation.knowledgeConnectorVersion}`,
  `h_lite_version=${preparation.hLiteVersion}`,
  `runtime_root=${preparation.runtimeRoot}`,
  `runtime_evidence_root=${preparation.runtimeEvidenceRoot}`,
  `backup_root=${preparation.backupRoot}`,
  `backup_env_sha256=${preparation.backup.envSha256}`,
  `backup_compose_sha256=${preparation.backup.composeSha256}`,
  `previous_agent_core_image_id=${preparation.images.agentCore.previousImageId}`,
  `previous_knowledge_connector_image_id=${preparation.images.knowledgeConnector.previousImageId}`,
  `previous_h_lite_image_id=${preparation.images.hLite.previousImageId}`,
  `candidate_agent_core_image_id=${preparation.images.agentCore.candidateImageId}`,
  `candidate_knowledge_connector_image_id=${preparation.images.knowledgeConnector.candidateImageId}`,
  `candidate_h_lite_image_id=${preparation.images.hLite.candidateImageId}`,
  `preparation_evidence_sha256=${result.preparation.evidenceSha256}`,
  `migration_evidence_sha256=${result.evidenceSha256}`,
  '',
].join('\n'))
