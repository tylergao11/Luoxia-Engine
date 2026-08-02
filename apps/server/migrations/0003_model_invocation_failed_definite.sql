-- Explicit upgrade for databases created before internal model invocation
-- stage failed_definite. Engine does not run migrations; apply once with psql
-- against the target database after confirming the prior CHECK shape.
-- Fresh installs use 0001_atomic_packet_store.sql only (already includes this stage).

BEGIN;

ALTER TABLE luoxia_engine.model_invocations
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_output_summary jsonb,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

ALTER TABLE luoxia_engine.model_invocations
  DROP CONSTRAINT model_invocations_status_closed;

ALTER TABLE luoxia_engine.model_invocations
  DROP CONSTRAINT model_invocations_status_shape;

ALTER TABLE luoxia_engine.model_invocations
  DROP CONSTRAINT model_invocations_documents_object;

ALTER TABLE luoxia_engine.model_invocations
  ADD CONSTRAINT model_invocations_status_closed CHECK (
    invocation_status IN (
      'prepared',
      'dispatched_ambiguous',
      'failed_definite',
      'verified'
    )
  );

ALTER TABLE luoxia_engine.model_invocations
  ADD CONSTRAINT model_invocations_documents_object CHECK (
    jsonb_typeof(snapshot_document) = 'object'
    AND jsonb_typeof(request_document) = 'object'
    AND (
      response_document IS NULL
      OR jsonb_typeof(response_document) = 'object'
    )
    AND (
      proof_document IS NULL
      OR jsonb_typeof(proof_document) = 'object'
    )
    AND (
      failure_output_summary IS NULL
      OR jsonb_typeof(failure_output_summary) = 'object'
    )
  );

ALTER TABLE luoxia_engine.model_invocations
  ADD CONSTRAINT model_invocations_status_shape CHECK (
    (
      invocation_status = 'prepared'
      AND dispatched_at IS NULL
      AND response_document IS NULL
      AND proof_document IS NULL
      AND verified_at IS NULL
      AND failure_code IS NULL
      AND failure_output_summary IS NULL
      AND failed_at IS NULL
    )
    OR (
      invocation_status = 'dispatched_ambiguous'
      AND dispatched_at IS NOT NULL
      AND response_document IS NULL
      AND proof_document IS NULL
      AND verified_at IS NULL
      AND failure_code IS NULL
      AND failure_output_summary IS NULL
      AND failed_at IS NULL
    )
    OR (
      invocation_status = 'failed_definite'
      AND dispatched_at IS NOT NULL
      AND response_document IS NULL
      AND proof_document IS NULL
      AND verified_at IS NULL
      AND failure_code IS NOT NULL
      AND char_length(failure_code) BETWEEN 1 AND 256
      AND failure_code = btrim(failure_code)
      AND failure_code !~ E'[\\r\\n]'
      AND failure_output_summary IS NOT NULL
      AND jsonb_typeof(failure_output_summary) = 'object'
      AND failed_at IS NOT NULL
    )
    OR (
      invocation_status = 'verified'
      AND dispatched_at IS NOT NULL
      AND response_document IS NOT NULL
      AND proof_document IS NOT NULL
      AND verified_at IS NOT NULL
      AND failure_code IS NULL
      AND failure_output_summary IS NULL
      AND failed_at IS NULL
    )
  );

COMMIT;
