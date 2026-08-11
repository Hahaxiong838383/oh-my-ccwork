#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const inputFile = process.argv[2]
const outputFile = process.argv[3]
if (!inputFile || !outputFile) throw new Error('usage: compile-shadow-domain-sql.mjs <domain-batch.json> <output.sql>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const validation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-shadow-domain-batch.mjs'), path.resolve(inputFile)], { encoding: 'utf8' })
if (validation.status !== 0) throw new Error(validation.stderr.trim() || 'domain batch validation failed')

const bytes = await fs.readFile(path.resolve(inputFile))
const batch = JSON.parse(bytes.toString('utf8'))
const payloadBase64 = bytes.toString('base64')
const batchHash = createHash('sha256').update(bytes).digest('hex')
const safeRunId = String(batch.runId).replace(/'/g, "''")

const sql = String.raw`\set ON_ERROR_STOP on
BEGIN;
SET LOCAL row_security = on;
SELECT set_config('app.tenant_id', :'tenant_id', true);

DO $persist_shadow_domain$
DECLARE
  domain_batch jsonb := convert_from(decode('${payloadBase64}', 'base64'), 'UTF8')::jsonb;
  tenant uuid := platform.current_tenant_id();
  source_entry jsonb;
  source_decision jsonb;
  raw_snapshot jsonb;
  observation jsonb;
  signal jsonb;
  evidence_record jsonb;
  hypothesis jsonb;
  assessment jsonb;
  report_run jsonb;
  report_draft jsonb;
  input_record jsonb;
  ingestion_run_id uuid;
  source_entry_id uuid;
  source_decision_id uuid;
  snapshot_id uuid;
  observation_id uuid;
  signal_id uuid;
  evidence_id uuid;
  hypothesis_id uuid;
  assessment_id uuid;
  report_input_set_id uuid;
  report_run_id uuid;
  report_id uuid;
  resolved_input_id uuid;
  snapshot_ids uuid[];
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app.tenant_id is required' USING ERRCODE = '42501';
  END IF;
  IF domain_batch->>'publish' IS DISTINCT FROM 'false'
    OR domain_batch->>'persistenceState' IS DISTINCT FROM 'json_candidate_pending_postgres'
    OR domain_batch#>>'{ingestionRun,status}' IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'domain batch persistence gate denied' USING ERRCODE = '42501';
  END IF;

  FOR source_entry IN SELECT value FROM jsonb_array_elements(domain_batch->'sourceEntries')
  LOOP
    INSERT INTO strategic_intelligence.source_registry_entries (
      tenant_id, source_key, registry_version, lifecycle_status, license_status,
      compliance_approval_status, storage_level, retention_days, definition,
      content_hash, valid_from
    ) VALUES (
      tenant, source_entry->>'sourceKey', source_entry->>'registryVersion', source_entry->>'lifecycleStatus',
      source_entry->>'licenseStatus', source_entry->>'complianceApprovalStatus', source_entry->>'storageLevel',
      (source_entry->>'retentionDays')::integer, source_entry->'definition', source_entry->>'contentHash',
      (source_entry->>'validFrom')::timestamptz
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  INSERT INTO strategic_intelligence.ingestion_runs (
    tenant_id, run_key, collector_version, source_registry_version, source_registry_hash,
    config_hash, status, stats, error_code, started_at, completed_at
  ) VALUES (
    tenant, domain_batch#>>'{ingestionRun,runKey}', domain_batch#>>'{ingestionRun,collectorVersion}',
    domain_batch#>>'{ingestionRun,sourceRegistryVersion}', domain_batch#>>'{ingestionRun,sourceRegistryHash}',
    domain_batch#>>'{ingestionRun,configHash}', domain_batch#>>'{ingestionRun,status}',
    domain_batch#>'{ingestionRun,stats}', nullif(domain_batch#>>'{ingestionRun,errorCode}', ''),
    (domain_batch#>>'{ingestionRun,startedAt}')::timestamptz,
    (domain_batch#>>'{ingestionRun,completedAt}')::timestamptz
  ) ON CONFLICT (tenant_id, run_key) DO NOTHING;
  SELECT id INTO STRICT ingestion_run_id
  FROM strategic_intelligence.ingestion_runs
  WHERE tenant_id = tenant AND run_key = domain_batch#>>'{ingestionRun,runKey}';

  FOR source_decision IN SELECT value FROM jsonb_array_elements(domain_batch->'sourceDecisions')
  LOOP
    SELECT id INTO STRICT source_entry_id
    FROM strategic_intelligence.source_registry_entries
    WHERE tenant_id = tenant
      AND content_hash = (
        SELECT entry->>'contentHash'
        FROM jsonb_array_elements(domain_batch->'sourceEntries') entry
        WHERE entry->>'sourceKey' = source_decision->>'sourceKey'
        LIMIT 1
      );
    INSERT INTO strategic_intelligence.source_registry_decisions (
      tenant_id, source_entry_id, source_key, registry_version, registry_hash,
      policy_version, decision, reason_code, request_key, evaluated_at
    ) VALUES (
      tenant, source_entry_id, source_decision->>'sourceKey', source_decision->>'registryVersion',
      source_decision->>'registryHash', source_decision->>'policyVersion', source_decision->>'decision',
      source_decision->>'reasonCode', source_decision->>'requestKey',
      (source_decision->>'evaluatedAt')::timestamptz
    ) ON CONFLICT (tenant_id, request_key) DO NOTHING;
  END LOOP;

  FOR raw_snapshot IN SELECT value FROM jsonb_array_elements(domain_batch->'rawSnapshots')
  LOOP
    SELECT id INTO STRICT source_entry_id
    FROM strategic_intelligence.source_registry_entries
    WHERE tenant_id = tenant
      AND content_hash = (
        SELECT entry->>'contentHash'
        FROM jsonb_array_elements(domain_batch->'sourceEntries') entry
        WHERE entry->>'sourceKey' = raw_snapshot->>'sourceKey'
        LIMIT 1
      );
    SELECT id INTO STRICT source_decision_id
    FROM strategic_intelligence.source_registry_decisions
    WHERE tenant_id = tenant
      AND source_key = raw_snapshot->>'sourceKey'
      AND request_key = (domain_batch->>'requestKey') || ':' || (raw_snapshot->>'sourceKey');
    INSERT INTO strategic_intelligence.raw_snapshots (
      tenant_id, ingestion_run_id, source_decision_id, source_entry_id, snapshot_key, source_key,
      source_reference, fetched_at, valid_from, recorded_at, content_hash, dedup_key, idempotency_key,
      content_type, byte_length, payload_bytes, storage_tier, retention_expires_at, classification,
      sanitization_status, collector_version, source_registry_version
    ) VALUES (
      tenant, ingestion_run_id, source_decision_id, source_entry_id, raw_snapshot->>'snapshotKey',
      raw_snapshot->>'sourceKey', raw_snapshot->>'sourceReference', (raw_snapshot->>'fetchedAt')::timestamptz,
      (raw_snapshot->>'validFrom')::timestamptz, (domain_batch->>'compiledAt')::timestamptz,
      raw_snapshot->>'contentHash', raw_snapshot->>'dedupKey', raw_snapshot->>'idempotencyKey',
      raw_snapshot->>'contentType', (raw_snapshot->>'byteLength')::bigint, null,
      raw_snapshot->>'storageTier', (raw_snapshot->>'retentionExpiresAt')::timestamptz,
      raw_snapshot->>'classification', raw_snapshot->>'sanitizationStatus',
      raw_snapshot->>'collectorVersion', raw_snapshot->>'sourceRegistryVersion'
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  FOR observation IN SELECT value FROM jsonb_array_elements(domain_batch->'observations')
  LOOP
    SELECT id INTO STRICT snapshot_id FROM strategic_intelligence.raw_snapshots
    WHERE tenant_id = tenant AND snapshot_key = observation->>'snapshotKey';
    INSERT INTO strategic_intelligence.external_observations (
      tenant_id, snapshot_id, observation_key, source_external_key, observed_at, valid_from,
      recorded_at, parser_version, schema_version, payload, payload_hash, data_quality_status,
      freshness_status, conflict_status, classification, purpose, status
    ) VALUES (
      tenant, snapshot_id, observation->>'observationKey', observation->>'sourceItemId',
      (observation->>'observedAt')::timestamptz, (observation->>'validFrom')::timestamptz,
      (observation->>'recordedAt')::timestamptz, observation->>'parserVersion', 'shadow-domain-batch-1.0.0',
      jsonb_build_object('sourceKey', observation->>'sourceKey', 'title', observation->>'title',
        'url', observation->>'url', 'summary', observation->>'summary'), observation->>'payloadHash',
      observation->>'dataQualityStatus', observation->>'freshnessStatus', observation->>'conflictStatus',
      observation->>'classification', observation->>'purpose', observation->>'status'
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  FOR signal IN SELECT value FROM jsonb_array_elements(domain_batch->'signals')
  LOOP
    INSERT INTO strategic_intelligence.strategic_signals (
      tenant_id, signal_key, signal_type, title, first_seen_at, last_seen_at, valid_from, recorded_at,
      strength, confidence, signal_status, data_quality_status, freshness_status, conflict_status,
      ontology_version, causal_graph_version, classification, purpose, payload
    ) VALUES (
      tenant, signal->>'signalKey', signal->>'signalType', signal->>'title',
      (signal->>'firstSeenAt')::timestamptz, (signal->>'lastSeenAt')::timestamptz,
      (signal->>'validFrom')::timestamptz, (signal->>'recordedAt')::timestamptz,
      (signal->>'strength')::numeric, (signal->>'confidence')::numeric, signal->>'signalStatus',
      signal->>'dataQualityStatus', signal->>'freshnessStatus', signal->>'conflictStatus',
      signal->>'ontologyVersion', signal->>'causalGraphVersion', signal->>'classification',
      signal->>'purpose', signal->'payload'
    ) ON CONFLICT DO NOTHING;
    SELECT id INTO STRICT signal_id FROM strategic_intelligence.strategic_signals
    WHERE tenant_id = tenant AND signal_key = signal->>'signalKey' AND recorded_at = (signal->>'recordedAt')::timestamptz;
    FOR input_record IN SELECT value FROM jsonb_array_elements(signal->'observationKeys')
    LOOP
      SELECT id INTO STRICT observation_id FROM strategic_intelligence.external_observations
      WHERE tenant_id = tenant AND observation_key = input_record#>>'{}';
      INSERT INTO strategic_intelligence.signal_observations (tenant_id, signal_id, observation_id, contribution_weight)
      VALUES (tenant, signal_id, observation_id, 0) ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  FOR evidence_record IN SELECT value FROM jsonb_array_elements(domain_batch->'evidence')
  LOOP
    SELECT id INTO STRICT observation_id FROM strategic_intelligence.external_observations
    WHERE tenant_id = tenant AND observation_key = evidence_record->>'observationKey';
    SELECT id INTO STRICT signal_id FROM strategic_intelligence.strategic_signals
    WHERE tenant_id = tenant AND signal_key = evidence_record->>'signalKey' AND recorded_at = (evidence_record->>'recordedAt')::timestamptz;
    SELECT id INTO STRICT snapshot_id FROM strategic_intelligence.raw_snapshots
    WHERE tenant_id = tenant AND snapshot_key = evidence_record->>'snapshotKey';
    INSERT INTO strategic_intelligence.evidence (
      tenant_id, evidence_key, observation_id, signal_id, snapshot_id, evidence_kind, summary,
      confidence, valid_from, recorded_at, status, classification, purpose, provenance
    ) VALUES (
      tenant, evidence_record->>'evidenceKey', observation_id, signal_id, snapshot_id,
      evidence_record->>'evidenceKind', evidence_record->>'summary', (evidence_record->>'confidence')::numeric,
      (evidence_record->>'validFrom')::timestamptz, (evidence_record->>'recordedAt')::timestamptz,
      evidence_record->>'status', evidence_record->>'classification', evidence_record->>'purpose',
      evidence_record->'provenance'
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  FOR hypothesis IN SELECT value FROM jsonb_array_elements(domain_batch->'impactHypotheses')
  LOOP
    INSERT INTO strategic_intelligence.impact_hypotheses (
      tenant_id, hypothesis_key, external_factor_key, goal_facet_key, transmission_path,
      impact_direction, impact_strength, expected_lag_days, generation_status, verification_status,
      activation_status, causal_graph_version, valid_from
    ) VALUES (
      tenant, hypothesis->>'hypothesisKey', hypothesis->>'externalFactorKey', hypothesis->>'goalFacetKey',
      hypothesis->'transmissionPath', hypothesis->>'impactDirection', nullif(hypothesis->>'impactStrength', '')::numeric,
      nullif(hypothesis->>'expectedLagDays', '')::integer, hypothesis->>'generationStatus',
      hypothesis->>'verificationStatus', hypothesis->>'activationStatus', hypothesis->>'causalGraphVersion',
      (hypothesis->>'validFrom')::timestamptz
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  FOR assessment IN SELECT value FROM jsonb_array_elements(domain_batch->'impactAssessments')
  LOOP
    SELECT id INTO STRICT hypothesis_id FROM strategic_intelligence.impact_hypotheses
    WHERE tenant_id = tenant AND hypothesis_key = assessment->>'hypothesisKey'
      AND causal_graph_version = assessment->>'causalGraphVersion';
    INSERT INTO strategic_intelligence.impact_assessments (
      tenant_id, assessment_key, hypothesis_id, window_start, window_end, evidence_cutoff_at,
      impact_direction, impact_magnitude, confidence_band, assessment_status, ontology_version,
      causal_graph_version, model_provider, model_id, prompt_version, input_hash, valid_from,
      recorded_at, classification, purpose
    ) VALUES (
      tenant, assessment->>'assessmentKey', hypothesis_id, (assessment->>'windowStart')::timestamptz,
      (assessment->>'windowEnd')::timestamptz, (assessment->>'evidenceCutoffAt')::timestamptz,
      assessment->>'impactDirection', nullif(assessment->>'impactMagnitude', '')::numeric,
      assessment->>'confidenceBand', assessment->>'assessmentStatus', assessment->>'ontologyVersion',
      assessment->>'causalGraphVersion', nullif(assessment->>'modelProvider', ''),
      nullif(assessment->>'modelId', ''), nullif(assessment->>'promptVersion', ''), assessment->>'inputHash',
      (assessment->>'validFrom')::timestamptz, (domain_batch->>'compiledAt')::timestamptz,
      assessment->>'classification', assessment->>'purpose'
    ) ON CONFLICT DO NOTHING;
    SELECT id INTO STRICT assessment_id FROM strategic_intelligence.impact_assessments
    WHERE tenant_id = tenant AND assessment_key = assessment->>'assessmentKey'
      AND recorded_at = (domain_batch->>'compiledAt')::timestamptz;
    FOR input_record IN SELECT value FROM jsonb_array_elements(assessment->'evidenceKeys')
    LOOP
      SELECT id INTO STRICT evidence_id FROM strategic_intelligence.evidence
      WHERE tenant_id = tenant AND evidence_key = input_record#>>'{}';
      INSERT INTO strategic_intelligence.assessment_evidence (tenant_id, assessment_id, evidence_id, relationship)
      VALUES (tenant, assessment_id, evidence_id, 'context') ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  FOR report_run IN SELECT value FROM jsonb_array_elements(domain_batch->'reportRuns')
  LOOP
    SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO snapshot_ids
    FROM strategic_intelligence.raw_snapshots
    WHERE tenant_id = tenant
      AND snapshot_key IN (SELECT jsonb_array_elements_text(report_run->'sourceSnapshotIds'));
    INSERT INTO strategic_intelligence.report_input_sets (
      tenant_id, input_set_key, report_type, period_start, period_end, evidence_cutoff_at,
      input_hash, source_snapshot_ids, source_registry_version, ontology_version,
      causal_graph_version, input_manifest
    ) VALUES (
      tenant, report_run->>'reportRunKey', report_run->>'reportType',
      (report_run->>'periodStart')::timestamptz, (report_run->>'periodEnd')::timestamptz,
      (report_run->>'evidenceCutoffAt')::timestamptz, report_run->>'inputHash', snapshot_ids,
      report_run->>'sourceRegistryVersion', report_run->>'ontologyVersionUsed',
      report_run->>'causalGraphVersion', report_run->'inputManifest'
    ) ON CONFLICT DO NOTHING;
    SELECT id INTO STRICT report_input_set_id FROM strategic_intelligence.report_input_sets
    WHERE tenant_id = tenant AND input_set_key = report_run->>'reportRunKey';
    INSERT INTO strategic_intelligence.report_runs (
      tenant_id, report_run_key, report_type, period_start, period_end, evidence_cutoff_at,
      input_hash, source_registry_version, ontology_version, causal_graph_version, model_provider,
      model_id, prompt_version, input_tokens, output_tokens, cost_microunits, duration_ms, status,
      error_code, retry_count, started_at, completed_at, recorded_at, input_set_id
    ) VALUES (
      tenant, report_run->>'reportRunKey', report_run->>'reportType',
      (report_run->>'periodStart')::timestamptz, (report_run->>'periodEnd')::timestamptz,
      (report_run->>'evidenceCutoffAt')::timestamptz, report_run->>'inputHash',
      report_run->>'sourceRegistryVersion', report_run->>'ontologyVersionUsed',
      report_run->>'causalGraphVersion', report_run->>'modelProvider', report_run->>'modelId',
      report_run->>'promptVersion', (report_run->>'inputTokens')::bigint,
      (report_run->>'outputTokens')::bigint, (report_run->>'costMicrounits')::bigint,
      (report_run->>'durationMs')::bigint, report_run->>'status', nullif(report_run->>'errorCode', ''),
      (report_run->>'retryCount')::integer, (report_run->>'startedAt')::timestamptz,
      (report_run->>'completedAt')::timestamptz, (domain_batch->>'compiledAt')::timestamptz,
      report_input_set_id
    ) ON CONFLICT (tenant_id, report_run_key) DO NOTHING;
    SELECT id INTO STRICT report_run_id FROM strategic_intelligence.report_runs
    WHERE tenant_id = tenant AND report_run_key = report_run->>'reportRunKey';
    FOR input_record IN SELECT value FROM jsonb_array_elements(report_run#>'{inputManifest,inputs}')
    LOOP
      resolved_input_id := null;
      CASE input_record->>'type'
        WHEN 'raw_snapshot' THEN SELECT id INTO resolved_input_id FROM strategic_intelligence.raw_snapshots WHERE tenant_id = tenant AND snapshot_key = input_record->>'id';
        WHEN 'observation' THEN SELECT id INTO resolved_input_id FROM strategic_intelligence.external_observations WHERE tenant_id = tenant AND observation_key = input_record->>'id';
        WHEN 'signal' THEN SELECT id INTO resolved_input_id FROM strategic_intelligence.strategic_signals WHERE tenant_id = tenant AND signal_key = input_record->>'id' ORDER BY recorded_at DESC LIMIT 1;
        WHEN 'evidence' THEN SELECT id INTO resolved_input_id FROM strategic_intelligence.evidence WHERE tenant_id = tenant AND evidence_key = input_record->>'id' ORDER BY recorded_at DESC LIMIT 1;
        WHEN 'impact_assessment' THEN SELECT id INTO resolved_input_id FROM strategic_intelligence.impact_assessments WHERE tenant_id = tenant AND assessment_key = input_record->>'id' ORDER BY recorded_at DESC LIMIT 1;
      END CASE;
      IF resolved_input_id IS NULL THEN
        RAISE EXCEPTION 'report input cannot be resolved: % %', input_record->>'type', input_record->>'id';
      END IF;
      INSERT INTO strategic_intelligence.report_run_inputs (tenant_id, report_run_id, input_type, input_id, input_hash)
      VALUES (tenant, report_run_id, input_record->>'type', resolved_input_id, input_record->>'hash')
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  FOR report_draft IN SELECT value FROM jsonb_array_elements(domain_batch->'reportDrafts')
  LOOP
    SELECT id INTO STRICT report_run_id FROM strategic_intelligence.report_runs
    WHERE tenant_id = tenant AND report_run_key = report_draft->>'reportRunKey';
    INSERT INTO strategic_intelligence.reports (
      tenant_id, report_run_id, report_key, audience_scope, report_status, structured_body,
      projection_version, classification, purpose
    ) VALUES (
      tenant, report_run_id, report_draft->>'reportKey', report_draft->>'audienceScope',
      report_draft->>'reportStatus', report_draft->'structuredBody', report_draft->>'projectionVersion',
      report_draft->>'classification', report_draft->>'purpose'
    ) ON CONFLICT (tenant_id, report_key, projection_version) DO NOTHING;
  END LOOP;
END
$persist_shadow_domain$;

COMMIT;

SELECT json_build_object(
  'persisted', true,
  'runId', '${safeRunId}',
  'batchHash', '${batchHash}',
  'persistenceState', 'postgres_committed'
)::text;
`

await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(outputFile), sql, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, runId: batch.runId, batchHash, outputFile: path.basename(outputFile) }, null, 2)}\n`)
