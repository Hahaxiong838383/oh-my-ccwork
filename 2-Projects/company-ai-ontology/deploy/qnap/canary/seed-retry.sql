\set ON_ERROR_STOP on
SELECT set_config('app.tenant_id', :'tenant_id', false);
INSERT INTO delivery.outbox (
  tenant_id, channel, recipient_key, event_type, payload, idempotency_key,
  status, attempt_count, next_attempt_at
)
VALUES (
  :'tenant_id'::uuid, 'company-bot', 'demo-person-01', 'canary_retry',
  jsonb_build_object('simulation', true, 'runId', :'run_id'),
  'canary-retry:' || :'run_id', 'pending', 1, now()
)
ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
  status = 'pending',
  provider_message_id = NULL,
  attempt_count = delivery.outbox.attempt_count + 1,
  next_attempt_at = now(),
  updated_at = now();
