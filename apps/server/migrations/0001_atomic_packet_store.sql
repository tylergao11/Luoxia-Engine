BEGIN;

CREATE SCHEMA luoxia_engine;

CREATE TABLE luoxia_engine.worlds (
  world_id uuid PRIMARY KEY,
  revision bigint NOT NULL,
  state_document jsonb NOT NULL,
  world_content_lock_document jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT worlds_revision_safe_integer CHECK (
    revision >= 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT worlds_state_document_object CHECK (
    jsonb_typeof(state_document) = 'object'
  ),
  CONSTRAINT worlds_world_content_lock_document_object CHECK (
    jsonb_typeof(world_content_lock_document) = 'object'
  )
);

CREATE TABLE luoxia_engine.committed_events (
  event_id uuid PRIMARY KEY,
  packet_id uuid NOT NULL,
  world_id uuid NOT NULL REFERENCES luoxia_engine.worlds(world_id),
  revision_before bigint NOT NULL,
  revision_after bigint NOT NULL,
  committed_at timestamptz NOT NULL,
  event_document jsonb NOT NULL,
  result_document jsonb NOT NULL,
  CONSTRAINT committed_events_packet_id_unique UNIQUE (packet_id),
  CONSTRAINT committed_events_world_revision_before_unique UNIQUE (world_id, revision_before),
  CONSTRAINT committed_events_world_revision_after_unique UNIQUE (world_id, revision_after),
  CONSTRAINT committed_events_world_event_unique UNIQUE (world_id, event_id),
  CONSTRAINT committed_events_revision_before_safe_integer CHECK (
    revision_before >= 0 AND revision_before <= 9007199254740991
  ),
  CONSTRAINT committed_events_revision_after_safe_integer CHECK (
    revision_after >= 1 AND revision_after <= 9007199254740991
  ),
  CONSTRAINT committed_events_revision_step CHECK (
    revision_after = revision_before + 1
  ),
  CONSTRAINT committed_events_documents_object CHECK (
    jsonb_typeof(event_document) = 'object'
    AND jsonb_typeof(result_document) = 'object'
  ),
  CONSTRAINT committed_events_document_identity CHECK (
    event_document ? 'event_id'
    AND event_document ? 'world_id'
    AND event_document ? 'revision_before'
    AND event_document ? 'revision_after'
    AND event_document ? 'committed_at'
    AND event_document ? 'packet'
    AND jsonb_typeof(event_document -> 'packet') = 'object'
    AND event_document #>> '{event_id}' IS NOT NULL
    AND event_document #>> '{world_id}' IS NOT NULL
    AND event_document #>> '{revision_before}' IS NOT NULL
    AND event_document #>> '{revision_after}' IS NOT NULL
    AND event_document #>> '{committed_at}' IS NOT NULL
    AND event_document #>> '{packet,packet_id}' IS NOT NULL
    AND event_document #>> '{event_id}' = event_id::text
    AND event_document #>> '{world_id}' = world_id::text
    AND event_document #>> '{revision_before}' = revision_before::text
    AND event_document #>> '{revision_after}' = revision_after::text
    AND (event_document #>> '{committed_at}')::timestamptz = committed_at
    AND event_document #>> '{packet,packet_id}' = packet_id::text
  ),
  CONSTRAINT committed_events_result_identity CHECK (
    result_document ? 'packet_id'
    AND result_document ? 'committed_event_id'
    AND result_document ? 'world_revision'
    AND result_document ? 'status'
    AND result_document #>> '{packet_id}' IS NOT NULL
    AND result_document #>> '{committed_event_id}' IS NOT NULL
    AND result_document #>> '{world_revision}' IS NOT NULL
    AND result_document #>> '{status}' IS NOT NULL
    AND result_document #>> '{packet_id}' = packet_id::text
    AND result_document #>> '{committed_event_id}' = event_id::text
    AND result_document #>> '{world_revision}' = revision_after::text
    AND result_document #>> '{status}' = 'committed'
  )
);

CREATE TABLE luoxia_engine.materialization_requests (
  request_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  requested_by_event_id uuid NOT NULL,
  ordinal integer NOT NULL,
  request_document jsonb NOT NULL,
  inserted_at timestamptz NOT NULL,
  CONSTRAINT materialization_requests_event_foreign_key FOREIGN KEY (world_id, requested_by_event_id)
    REFERENCES luoxia_engine.committed_events(world_id, event_id),
  CONSTRAINT materialization_requests_event_ordinal_unique UNIQUE (requested_by_event_id, ordinal),
  CONSTRAINT materialization_requests_ordinal_nonnegative CHECK (ordinal >= 0),
  CONSTRAINT materialization_requests_document_object CHECK (
    jsonb_typeof(request_document) = 'object'
  ),
  CONSTRAINT materialization_requests_document_identity CHECK (
    request_document ? 'request_id'
    AND request_document ? 'world_id'
    AND request_document ? 'requested_by_event_id'
    AND request_document #>> '{request_id}' IS NOT NULL
    AND request_document #>> '{world_id}' IS NOT NULL
    AND request_document #>> '{requested_by_event_id}' IS NOT NULL
    AND request_document #>> '{request_id}' = request_id::text
    AND request_document #>> '{world_id}' = world_id::text
    AND request_document #>> '{requested_by_event_id}' = requested_by_event_id::text
  )
);

CREATE INDEX materialization_requests_status_index
  ON luoxia_engine.materialization_requests ((request_document ->> 'status'));

CREATE TABLE luoxia_engine.model_invocations (
  request_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  world_revision bigint NOT NULL,
  request_kind text NOT NULL,
  invocation_status text NOT NULL,
  snapshot_document jsonb NOT NULL,
  request_document jsonb NOT NULL,
  response_document jsonb,
  proof_document jsonb,
  prepared_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT model_invocations_world_foreign_key FOREIGN KEY (world_id)
    REFERENCES luoxia_engine.worlds(world_id),
  CONSTRAINT model_invocations_request_world_kind_unique
    UNIQUE (request_id, world_id, request_kind),
  CONSTRAINT model_invocations_world_revision_safe CHECK (
    world_revision >= 0 AND world_revision <= 9007199254740991
  ),
  CONSTRAINT model_invocations_status_closed CHECK (
    invocation_status IN (
      'prepared',
      'dispatched_ambiguous',
      'verified'
    )
  ),
  CONSTRAINT model_invocations_documents_object CHECK (
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
  ),
  CONSTRAINT model_invocations_status_shape CHECK (
    (
      invocation_status = 'prepared'
      AND dispatched_at IS NULL
      AND response_document IS NULL
      AND proof_document IS NULL
      AND verified_at IS NULL
    )
    OR (
      invocation_status = 'dispatched_ambiguous'
      AND dispatched_at IS NOT NULL
      AND response_document IS NULL
      AND proof_document IS NULL
      AND verified_at IS NULL
    )
    OR (
      invocation_status = 'verified'
      AND dispatched_at IS NOT NULL
      AND response_document IS NOT NULL
      AND proof_document IS NOT NULL
      AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT model_invocations_prepared_identity CHECK (
    snapshot_document #>> '{world_id}' IS NOT NULL
    AND snapshot_document #>> '{world_revision}' IS NOT NULL
    AND request_document #>> '{request_id}' IS NOT NULL
    AND request_document #>> '{request_kind}' IS NOT NULL
    AND request_document #>> '{basis_revision}' IS NOT NULL
    AND snapshot_document #>> '{world_id}' = world_id::text
    AND snapshot_document #>> '{world_revision}' = world_revision::text
    AND request_document #>> '{request_id}' = request_id::text
    AND request_document #>> '{request_kind}' = request_kind
    AND request_document #>> '{basis_revision}' = world_revision::text
  ),
  CONSTRAINT model_invocations_verified_identity CHECK (
    response_document IS NULL
    OR (
      proof_document IS NOT NULL
      AND response_document #>> '{request_id}' IS NOT NULL
      AND proof_document #>> '{request_id}' IS NOT NULL
      AND response_document #>> '{request_kind}' IS NOT NULL
      AND proof_document #>> '{request_kind}' IS NOT NULL
      AND response_document #>> '{basis_revision}' IS NOT NULL
      AND proof_document #>> '{basis_revision}' IS NOT NULL
      AND response_document #>> '{dynamic_input_digest}' IS NOT NULL
      AND proof_document #>> '{dynamic_input_digest}' IS NOT NULL
      AND response_document #>> '{resident_context_digest}' IS NOT NULL
      AND proof_document #>> '{resident_context_digest}' IS NOT NULL
      AND response_document #>> '{output_digest}' IS NOT NULL
      AND proof_document #>> '{output_digest}' IS NOT NULL
      AND request_document #>> '{dynamic_input_digest}' IS NOT NULL
      AND request_document #>> '{resident_context,resident_digest}' IS NOT NULL
      AND response_document #>> '{request_id}' = request_id::text
      AND proof_document #>> '{request_id}' = request_id::text
      AND response_document #>> '{request_kind}' = request_kind
      AND proof_document #>> '{request_kind}' = request_kind
      AND response_document #>> '{basis_revision}' = world_revision::text
      AND proof_document #>> '{basis_revision}' = world_revision::text
      AND response_document #>> '{dynamic_input_digest}'
        = request_document #>> '{dynamic_input_digest}'
      AND proof_document #>> '{dynamic_input_digest}'
        = response_document #>> '{dynamic_input_digest}'
      AND response_document #>> '{resident_context_digest}'
        = request_document #>> '{resident_context,resident_digest}'
      AND proof_document #>> '{resident_context_digest}'
        = response_document #>> '{resident_context_digest}'
      AND proof_document #>> '{output_digest}'
        = response_document #>> '{output_digest}'
    )
  )
);

CREATE INDEX model_invocations_world_revision_index
  ON luoxia_engine.model_invocations (world_id, world_revision);

CREATE TABLE luoxia_engine.rule_plugin_proposal_receipts (
  proposal_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  basis_revision bigint NOT NULL,
  plugin_id text NOT NULL,
  operation_id text NOT NULL,
  request_id uuid NOT NULL,
  deterministic_context_id uuid NOT NULL,
  deterministic_context_digest text NOT NULL,
  request_document jsonb NOT NULL,
  response_document jsonb NOT NULL,
  proposal_document jsonb NOT NULL,
  authorized_at timestamptz NOT NULL,
  CONSTRAINT rule_plugin_proposal_receipts_world_foreign_key
    FOREIGN KEY (world_id) REFERENCES luoxia_engine.worlds(world_id),
  CONSTRAINT rule_plugin_proposal_receipts_request_id_unique
    UNIQUE (request_id),
  CONSTRAINT rule_plugin_proposal_receipts_basis_revision_safe CHECK (
    basis_revision >= 0 AND basis_revision <= 9007199254740991
  ),
  CONSTRAINT rule_plugin_proposal_receipts_documents_object CHECK (
    jsonb_typeof(request_document) = 'object'
    AND jsonb_typeof(response_document) = 'object'
    AND jsonb_typeof(proposal_document) = 'object'
  ),
  CONSTRAINT rule_plugin_proposal_receipts_document_identity CHECK (
    request_document #>> '{request_id}' IS NOT NULL
    AND response_document #>> '{request_id}' IS NOT NULL
    AND proposal_document #>> '{proposal_id}' IS NOT NULL
    AND request_document #>> '{readonly_world,world_id}' IS NOT NULL
    AND request_document #>> '{readonly_world,world_revision}' IS NOT NULL
    AND request_document #>> '{basis_revision}' IS NOT NULL
    AND response_document #>> '{basis_revision}' IS NOT NULL
    AND proposal_document #>> '{basis_revision}' IS NOT NULL
    AND request_document #>> '{plugin_lock,plugin_id}' IS NOT NULL
    AND response_document #>> '{plugin_lock,plugin_id}' IS NOT NULL
    AND proposal_document #>> '{proposed_by,plugin_id}' IS NOT NULL
    AND request_document #>> '{operation_id}' IS NOT NULL
    AND response_document #>> '{operation_id}' IS NOT NULL
    AND proposal_document #>> '{proposed_by,operation_id}' IS NOT NULL
    AND proposal_document #>> '{proposed_by,request_id}' IS NOT NULL
    AND request_document #>> '{operation_kind}' IS NOT NULL
    AND response_document #>> '{operation_kind}' IS NOT NULL
    AND request_document #>> '{deterministic_context,context_id}' IS NOT NULL
    AND response_document #>> '{deterministic_context_id}' IS NOT NULL
    AND proposal_document #>> '{deterministic_context_id}' IS NOT NULL
    AND request_document #>> '{deterministic_context,context_digest}' IS NOT NULL
    AND response_document #>> '{deterministic_context_digest}' IS NOT NULL
    AND proposal_document #>> '{deterministic_context_digest}' IS NOT NULL
    AND response_document #>> '{output,output_kind}' IS NOT NULL
    AND request_document #>> '{request_id}' = request_id::text
    AND response_document #>> '{request_id}' = request_id::text
    AND proposal_document #>> '{proposal_id}' = proposal_id::text
    AND request_document #>> '{readonly_world,world_id}' = world_id::text
    AND request_document #>> '{readonly_world,world_revision}'
      = basis_revision::text
    AND request_document #>> '{basis_revision}' = basis_revision::text
    AND response_document #>> '{basis_revision}' = basis_revision::text
    AND proposal_document #>> '{basis_revision}' = basis_revision::text
    AND request_document #>> '{plugin_lock,plugin_id}' = plugin_id
    AND proposal_document #>> '{proposed_by,plugin_id}' = plugin_id
    AND request_document #>> '{operation_id}' = operation_id
    AND response_document #>> '{operation_id}' = operation_id
    AND proposal_document #>> '{proposed_by,operation_id}' = operation_id
    AND proposal_document #>> '{proposed_by,request_id}' = request_id::text
    AND request_document #>> '{deterministic_context,context_id}'
      = deterministic_context_id::text
    AND response_document #>> '{deterministic_context_id}'
      = deterministic_context_id::text
    AND proposal_document #>> '{deterministic_context_id}'
      = deterministic_context_id::text
    AND request_document #>> '{deterministic_context,context_digest}'
      = deterministic_context_digest
    AND response_document #>> '{deterministic_context_digest}'
      = deterministic_context_digest
    AND proposal_document #>> '{deterministic_context_digest}'
      = deterministic_context_digest
    AND request_document -> 'plugin_lock'
      = response_document -> 'plugin_lock'
    AND request_document #>> '{operation_kind}'
      = response_document #>> '{operation_kind}'
    AND response_document #>> '{output,output_kind}' = 'packet.proposal'
    AND response_document #> '{output,proposal}' IS NOT NULL
    AND response_document #> '{output,proposal}' = proposal_document
  )
);

CREATE INDEX rule_plugin_proposal_receipts_world_revision_index
  ON luoxia_engine.rule_plugin_proposal_receipts (world_id, basis_revision);

CREATE TABLE luoxia_engine.daily_settlement_runs (
  run_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  day bigint NOT NULL,
  model_request_id uuid NOT NULL,
  request_kind text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT daily_settlement_runs_world_foreign_key FOREIGN KEY (world_id)
    REFERENCES luoxia_engine.worlds(world_id),
  CONSTRAINT daily_settlement_runs_model_invocation_foreign_key
    FOREIGN KEY (model_request_id, world_id, request_kind)
    REFERENCES luoxia_engine.model_invocations (
      request_id,
      world_id,
      request_kind
    ),
  CONSTRAINT daily_settlement_runs_world_day_unique UNIQUE (world_id, day),
  CONSTRAINT daily_settlement_runs_model_request_unique
    UNIQUE (model_request_id),
  CONSTRAINT daily_settlement_runs_day_safe CHECK (
    day >= 1 AND day <= 9007199254740991
  ),
  CONSTRAINT daily_settlement_runs_request_kind CHECK (
    request_kind = 'director.daily_settlement'
  )
);

COMMIT;
