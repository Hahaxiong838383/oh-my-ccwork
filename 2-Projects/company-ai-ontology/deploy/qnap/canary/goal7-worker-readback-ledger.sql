WITH matched AS (
  SELECT route_key, prompt_tokens, completion_tokens, estimated_cost_micros,
         retry_count, outcome, provider, model, credential_mode
    FROM runtime.h_engine_usage_events
   WHERE tenant_id = :'tenant_id'::uuid
     AND request_id = :'request_id'
), summarized AS (
  SELECT count(*)::integer AS row_count,
         min(route_key) AS route_key,
         min(prompt_tokens)::integer AS prompt_tokens,
         min(completion_tokens)::integer AS completion_tokens,
         min(estimated_cost_micros)::bigint AS estimated_cost_micros,
         min(retry_count)::integer AS retry_count,
         min(outcome) AS outcome,
         min(provider) AS provider,
         min(model) AS model,
         min(credential_mode) AS credential_mode
    FROM matched
)
SELECT jsonb_build_object(
  'evidenceVersion', '1.0.0',
  'evidenceType', 'goal7-h-worker-ledger-row',
  'sourceCommit', :'source_commit'::text,
  'hLiteSourceCommit', :'h_lite_source_commit'::text,
  'capturedAt', :'captured_at'::text,
  'rowCount', row_count,
  'requestIdHash', :'request_id_hash'::text,
  'routeKey', route_key,
  'provider', provider,
  'model', model,
  'credentialModeTag', credential_mode,
  'retryCount', retry_count,
  'outcome', outcome,
  'usage', jsonb_build_object(
    'promptTokens', prompt_tokens,
    'completionTokens', completion_tokens,
    'totalTokens', prompt_tokens + completion_tokens,
    'estimatedCostMicros', estimated_cost_micros
  ),
  'sensitivePayloadPersisted', false
)
FROM summarized;
