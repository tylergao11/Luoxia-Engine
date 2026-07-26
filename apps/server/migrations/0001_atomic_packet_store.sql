BEGIN;

CREATE SCHEMA luoxia_engine;

CREATE TABLE luoxia_engine.worlds (
  world_id uuid PRIMARY KEY,
  revision bigint NOT NULL,
  state_document jsonb NOT NULL,
  world_content_lock_document jsonb NOT NULL,
  save_schema_version text NOT NULL,
  engine_contract_version text NOT NULL,
  dependency_bundle_locks_document jsonb NOT NULL,
  rule_plugin_locks_document jsonb NOT NULL,
  stage_module_locks_document jsonb NOT NULL,
  event_cursor bigint NOT NULL,
  event_log_floor_revision bigint NOT NULL,
  asset_hashes_document jsonb NOT NULL,
  migration_history_document jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT worlds_revision_safe_integer CHECK (
    revision >= 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT worlds_state_document_object CHECK (
    jsonb_typeof(state_document) = 'object'
  ),
  CONSTRAINT worlds_world_content_lock_document_object CHECK (
    jsonb_typeof(world_content_lock_document) = 'object'
  ),
  CONSTRAINT worlds_save_schema_version_semver CHECK (
    save_schema_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT worlds_engine_contract_version_semver CHECK (
    engine_contract_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT worlds_save_documents_arrays CHECK (
    jsonb_typeof(dependency_bundle_locks_document) = 'array'
    AND jsonb_typeof(rule_plugin_locks_document) = 'array'
    AND jsonb_typeof(stage_module_locks_document) = 'array'
    AND jsonb_typeof(asset_hashes_document) = 'array'
    AND jsonb_typeof(migration_history_document) = 'array'
  ),
  CONSTRAINT worlds_event_cursor_safe_integer CHECK (
    event_cursor >= 0 AND event_cursor <= 9007199254740991
  ),
  CONSTRAINT worlds_event_cursor_matches_revision CHECK (
    event_cursor = revision
  ),
  CONSTRAINT worlds_event_log_floor_safe_integer CHECK (
    event_log_floor_revision >= 0
    AND event_log_floor_revision <= event_cursor
  )
);

CREATE TABLE luoxia_engine.engine_sessions (
  session_id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES luoxia_engine.worlds(world_id),
  control_binding_id uuid NOT NULL,
  player_entity_id uuid NOT NULL,
  view_revision bigint NOT NULL,
  world_revision bigint NOT NULL,
  next_server_sequence bigint NOT NULL,
  nonce uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT engine_sessions_view_revision_safe CHECK (
    view_revision >= 0 AND view_revision <= 9007199254740991
  ),
  CONSTRAINT engine_sessions_world_revision_safe CHECK (
    world_revision >= 0 AND world_revision <= 9007199254740991
  ),
  CONSTRAINT engine_sessions_next_server_sequence_safe CHECK (
    next_server_sequence >= 0
    AND next_server_sequence <= 9007199254740991
  )
);

CREATE INDEX engine_sessions_world_index
  ON luoxia_engine.engine_sessions (world_id);

CREATE TABLE luoxia_engine.command_journal (
  session_id uuid NOT NULL REFERENCES luoxia_engine.engine_sessions(session_id),
  command_id uuid NOT NULL,
  command_kind text NOT NULL,
  request_digest text NOT NULL,
  request_document jsonb NOT NULL,
  accepted_world_id uuid NOT NULL,
  accepted_control_binding_id uuid NOT NULL,
  accepted_player_entity_id uuid NOT NULL,
  accepted_view_revision bigint NOT NULL,
  accepted_world_revision bigint NOT NULL,
  accepted_nonce uuid NOT NULL,
  dialogue_id uuid,
  human_turn_id uuid,
  human_rule_request_id uuid,
  character_model_request_id uuid,
  character_turn_id uuid,
  character_rule_request_id uuid,
  event_card_packet_id uuid,
  command_status text NOT NULL,
  result_document jsonb,
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (session_id, command_id),
  CONSTRAINT command_journal_human_turn_id_unique UNIQUE (human_turn_id),
  CONSTRAINT command_journal_human_rule_request_id_unique
    UNIQUE (human_rule_request_id),
  CONSTRAINT command_journal_character_model_request_id_unique
    UNIQUE (character_model_request_id),
  CONSTRAINT command_journal_character_turn_id_unique UNIQUE (character_turn_id),
  CONSTRAINT command_journal_character_rule_request_id_unique
    UNIQUE (character_rule_request_id),
  CONSTRAINT command_journal_event_card_packet_id_unique
    UNIQUE (event_card_packet_id),
  CONSTRAINT command_journal_request_digest_sha256 CHECK (
    request_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT command_journal_accepted_view_revision_safe CHECK (
    accepted_view_revision >= 0
    AND accepted_view_revision <= 9007199254740991
  ),
  CONSTRAINT command_journal_accepted_world_revision_safe CHECK (
    accepted_world_revision >= 0
    AND accepted_world_revision <= 9007199254740991
  ),
  CONSTRAINT command_journal_status_closed CHECK (
    command_status IN ('received', 'completed')
  ),
  CONSTRAINT command_journal_documents_object CHECK (
    jsonb_typeof(request_document) = 'object'
    AND (
      result_document IS NULL
      OR jsonb_typeof(result_document) = 'object'
    )
  ),
  CONSTRAINT command_journal_status_shape CHECK (
    (
      command_status = 'received'
      AND result_document IS NULL
      AND completed_at IS NULL
    )
    OR (
      command_status = 'completed'
      AND result_document IS NOT NULL
      AND completed_at IS NOT NULL
      AND result_document #>> '{status}' IS NOT NULL
      AND result_document #>> '{status}' IN ('accepted', 'rejected')
    )
  ),
  CONSTRAINT command_journal_request_identity CHECK (
    request_document #>> '{session_id}' IS NOT NULL
    AND request_document #>> '{message,command_id}' IS NOT NULL
    AND request_document #>> '{message,type}' IS NOT NULL
    AND request_document #>> '{message,basis_token}' IS NOT NULL
    AND request_document #>> '{session_id}' = session_id::text
    AND request_document #>> '{message,command_id}' = command_id::text
    AND request_document #>> '{message,type}' = command_kind
  ),
  CONSTRAINT command_journal_dialogue_identity_shape CHECK (
    (
      command_kind IN ('dialogue.start', 'dialogue.continue')
      AND dialogue_id IS NOT NULL
      AND human_turn_id IS NOT NULL
      AND human_rule_request_id IS NOT NULL
       AND character_model_request_id IS NOT NULL
       AND character_turn_id IS NOT NULL
       AND character_rule_request_id IS NOT NULL
       AND dialogue_id <> human_turn_id
       AND dialogue_id <> human_rule_request_id
       AND dialogue_id <> character_model_request_id
       AND dialogue_id <> character_turn_id
       AND dialogue_id <> character_rule_request_id
       AND human_turn_id <> character_turn_id
       AND human_turn_id <> human_rule_request_id
       AND human_turn_id <> character_model_request_id
       AND human_turn_id <> character_rule_request_id
       AND human_rule_request_id <> character_model_request_id
       AND human_rule_request_id <> character_turn_id
       AND human_rule_request_id <> character_rule_request_id
       AND character_model_request_id <> character_turn_id
       AND character_model_request_id <> character_rule_request_id
       AND character_turn_id <> character_rule_request_id
      AND (
        command_kind = 'dialogue.start'
        OR request_document #>> '{message,dialogue_id}' = dialogue_id::text
      )
    )
    OR (
      command_kind NOT IN ('dialogue.start', 'dialogue.continue')
      AND dialogue_id IS NULL
      AND human_turn_id IS NULL
      AND human_rule_request_id IS NULL
      AND character_model_request_id IS NULL
      AND character_turn_id IS NULL
      AND character_rule_request_id IS NULL
    )
  ),
  CONSTRAINT command_journal_event_card_identity_shape CHECK (
    (
      command_kind = 'event_card.trigger'
      AND event_card_packet_id IS NOT NULL
    )
    OR (
      command_kind <> 'event_card.trigger'
      AND event_card_packet_id IS NULL
    )
  ),
  CONSTRAINT command_journal_result_identity CHECK (
    result_document IS NULL
    OR (
      result_document #>> '{command_id}' IS NOT NULL
      AND result_document #>> '{command_id}' = command_id::text
    )
  )
);

CREATE UNIQUE INDEX command_journal_active_world_unique
  ON luoxia_engine.command_journal (accepted_world_id)
  WHERE command_status = 'received';

CREATE TABLE luoxia_engine.command_server_envelopes (
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  response_ordinal integer NOT NULL,
  server_sequence bigint NOT NULL,
  message_id uuid NOT NULL,
  message_type text NOT NULL,
  envelope_document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, command_id, response_ordinal),
  CONSTRAINT command_server_envelopes_command_foreign_key
    FOREIGN KEY (session_id, command_id)
    REFERENCES luoxia_engine.command_journal (session_id, command_id),
  CONSTRAINT command_server_envelopes_session_sequence_unique
    UNIQUE (session_id, server_sequence),
  CONSTRAINT command_server_envelopes_message_id_unique UNIQUE (message_id),
  CONSTRAINT command_server_envelopes_ordinal_safe CHECK (
    response_ordinal >= 0
  ),
  CONSTRAINT command_server_envelopes_sequence_safe CHECK (
    server_sequence >= 0
    AND server_sequence <= 9007199254740991
  ),
  CONSTRAINT command_server_envelopes_document_object CHECK (
    jsonb_typeof(envelope_document) = 'object'
  ),
  CONSTRAINT command_server_envelopes_identity CHECK (
    envelope_document #>> '{envelope_type}' = 'server'
    AND envelope_document #>> '{message_id}' = message_id::text
    AND envelope_document #>> '{session_id}' = session_id::text
    AND envelope_document #>> '{sequence}' = server_sequence::text
    AND envelope_document #>> '{message,type}' = message_type
  )
);

CREATE TABLE luoxia_engine.dialogue_director_runs (
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  world_id uuid NOT NULL REFERENCES luoxia_engine.worlds(world_id),
  dialogue_id uuid NOT NULL,
  request_kind text NOT NULL,
  model_request_id uuid NOT NULL,
  response_turn_id uuid,
  response_rule_request_id uuid,
  prepared_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, command_id),
  CONSTRAINT dialogue_director_runs_command_foreign_key
    FOREIGN KEY (session_id, command_id)
    REFERENCES luoxia_engine.command_journal (session_id, command_id),
  CONSTRAINT dialogue_director_runs_model_request_id_unique
    UNIQUE (model_request_id),
  CONSTRAINT dialogue_director_runs_response_turn_id_unique
    UNIQUE (response_turn_id),
  CONSTRAINT dialogue_director_runs_response_rule_request_id_unique
    UNIQUE (response_rule_request_id),
  CONSTRAINT dialogue_director_runs_request_kind_closed CHECK (
    request_kind IN (
      'director.dialogue_events',
      'director.system_dialogue'
    )
  ),
  CONSTRAINT dialogue_director_runs_response_identity_shape CHECK (
    (
      request_kind = 'director.dialogue_events'
      AND response_turn_id IS NULL
      AND response_rule_request_id IS NULL
    )
    OR (
      request_kind = 'director.system_dialogue'
      AND response_turn_id IS NOT NULL
      AND response_rule_request_id IS NOT NULL
      AND model_request_id <> response_turn_id
      AND model_request_id <> response_rule_request_id
      AND response_turn_id <> response_rule_request_id
    )
  )
);

CREATE TABLE luoxia_engine.dialogue_director_proposal_runs (
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  proposal_kind text NOT NULL,
  proposal_id uuid NOT NULL,
  proposal_ordinal integer NOT NULL,
  world_record_id uuid,
  rule_request_id uuid NOT NULL,
  prepared_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, command_id, proposal_kind, proposal_id),
  CONSTRAINT dialogue_director_proposal_runs_run_foreign_key
    FOREIGN KEY (session_id, command_id)
    REFERENCES luoxia_engine.dialogue_director_runs (session_id, command_id),
  CONSTRAINT dialogue_director_proposal_runs_proposal_id_unique
    UNIQUE (session_id, command_id, proposal_id),
  CONSTRAINT dialogue_director_proposal_runs_ordinal_unique
    UNIQUE (session_id, command_id, proposal_kind, proposal_ordinal),
  CONSTRAINT dialogue_director_proposal_runs_world_record_id_unique
    UNIQUE (world_record_id),
  CONSTRAINT dialogue_director_proposal_runs_request_id_unique
    UNIQUE (rule_request_id),
  CONSTRAINT dialogue_director_proposal_runs_kind_closed CHECK (
    proposal_kind IN ('definition', 'goal_plan', 'event_card')
  ),
  CONSTRAINT dialogue_director_proposal_runs_world_record_shape CHECK (
    (
      proposal_kind IN ('definition', 'goal_plan')
      AND world_record_id IS NOT NULL
    )
    OR (
      proposal_kind = 'event_card'
      AND world_record_id IS NULL
    )
  ),
  CONSTRAINT dialogue_director_proposal_runs_ordinal_safe CHECK (
    proposal_ordinal >= 0
  )
);

CREATE INDEX command_journal_world_index
  ON luoxia_engine.command_journal (
    accepted_world_id,
    accepted_world_revision
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

-- RulePlugin requests may be prepared while apply_packet holds the matching
-- world row FOR UPDATE. This journal deliberately has no worlds FK: acquiring
-- a second-transaction FK key lock would invert that lock order. The validated
-- readonly_world snapshot and the identity constraints below bind the request.
CREATE TABLE luoxia_engine.rule_plugin_invocations (
  request_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  basis_revision bigint NOT NULL,
  plugin_id text NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL,
  deterministic_context_id uuid NOT NULL,
  deterministic_context_digest text NOT NULL,
  request_digest text NOT NULL,
  invocation_status text NOT NULL,
  request_document jsonb NOT NULL,
  response_document jsonb,
  proposal_id uuid,
  proposal_document jsonb,
  prepared_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT rule_plugin_invocations_proposal_id_unique
    UNIQUE (proposal_id),
  CONSTRAINT rule_plugin_invocations_basis_revision_safe CHECK (
    basis_revision >= 0 AND basis_revision <= 9007199254740991
  ),
  CONSTRAINT rule_plugin_invocations_request_digest_sha256 CHECK (
    request_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT rule_plugin_invocations_status_closed CHECK (
    invocation_status IN ('prepared', 'resolved')
  ),
  CONSTRAINT rule_plugin_invocations_documents_object CHECK (
    jsonb_typeof(request_document) = 'object'
    AND (
      response_document IS NULL
      OR jsonb_typeof(response_document) = 'object'
    )
    AND (
      proposal_document IS NULL
      OR jsonb_typeof(proposal_document) = 'object'
    )
  ),
  CONSTRAINT rule_plugin_invocations_status_shape CHECK (
    (
      invocation_status = 'prepared'
      AND response_document IS NULL
      AND proposal_id IS NULL
      AND proposal_document IS NULL
      AND resolved_at IS NULL
    )
    OR (
      invocation_status = 'resolved'
      AND response_document IS NOT NULL
      AND resolved_at IS NOT NULL
      AND response_document #>> '{output,output_kind}' IS NOT NULL
      AND (
        (
          response_document #>> '{output,output_kind}' = 'packet.proposal'
          AND proposal_id IS NOT NULL
          AND proposal_document IS NOT NULL
        )
        OR (
          response_document #>> '{output,output_kind}' <> 'packet.proposal'
          AND proposal_id IS NULL
          AND proposal_document IS NULL
        )
      )
    )
  ),
  CONSTRAINT rule_plugin_invocations_request_identity CHECK (
    request_document #>> '{request_id}' IS NOT NULL
    AND request_document #>> '{readonly_world,world_id}' IS NOT NULL
    AND request_document #>> '{readonly_world,world_revision}' IS NOT NULL
    AND request_document #>> '{basis_revision}' IS NOT NULL
    AND request_document #>> '{plugin_lock,plugin_id}' IS NOT NULL
    AND request_document #>> '{operation_id}' IS NOT NULL
    AND request_document #>> '{operation_kind}' IS NOT NULL
    AND request_document #>> '{deterministic_context,context_id}' IS NOT NULL
    AND request_document #>> '{deterministic_context,context_digest}' IS NOT NULL
    AND request_document #>> '{request_id}' = request_id::text
    AND request_document #>> '{readonly_world,world_id}' = world_id::text
    AND request_document #>> '{readonly_world,world_revision}'
      = basis_revision::text
    AND request_document #>> '{basis_revision}' = basis_revision::text
    AND request_document #>> '{plugin_lock,plugin_id}' = plugin_id
    AND request_document #>> '{operation_id}' = operation_id
    AND request_document #>> '{operation_kind}' = operation_kind
    AND request_document #>> '{deterministic_context,context_id}'
      = deterministic_context_id::text
    AND request_document #>> '{deterministic_context,context_digest}'
      = deterministic_context_digest
  ),
  CONSTRAINT rule_plugin_invocations_response_identity CHECK (
    response_document IS NULL
    OR (
      response_document #>> '{request_id}' IS NOT NULL
      AND response_document #>> '{basis_revision}' IS NOT NULL
      AND response_document #>> '{plugin_lock,plugin_id}' IS NOT NULL
      AND response_document #>> '{operation_id}' IS NOT NULL
      AND response_document #>> '{operation_kind}' IS NOT NULL
      AND response_document #>> '{deterministic_context_id}' IS NOT NULL
      AND response_document #>> '{deterministic_context_digest}' IS NOT NULL
      AND response_document -> 'plugin_lock' IS NOT NULL
      AND response_document #>> '{request_id}' = request_id::text
      AND response_document #>> '{basis_revision}' = basis_revision::text
      AND response_document #>> '{plugin_lock,plugin_id}' = plugin_id
      AND response_document #>> '{operation_id}' = operation_id
      AND response_document #>> '{operation_kind}' = operation_kind
      AND response_document #>> '{deterministic_context_id}'
        = deterministic_context_id::text
      AND response_document #>> '{deterministic_context_digest}'
        = deterministic_context_digest
      AND response_document -> 'plugin_lock'
        = request_document -> 'plugin_lock'
    )
  ),
  CONSTRAINT rule_plugin_invocations_proposal_identity CHECK (
    proposal_document IS NULL
    OR (
      proposal_document #>> '{proposal_id}' IS NOT NULL
      AND proposal_document #>> '{basis_revision}' IS NOT NULL
      AND proposal_document #>> '{proposed_by,plugin_id}' IS NOT NULL
      AND proposal_document #>> '{proposed_by,operation_id}' IS NOT NULL
      AND proposal_document #>> '{proposed_by,request_id}' IS NOT NULL
      AND proposal_document #>> '{deterministic_context_id}' IS NOT NULL
      AND proposal_document #>> '{deterministic_context_digest}' IS NOT NULL
      AND response_document #> '{output,proposal}' IS NOT NULL
      AND proposal_document #>> '{proposal_id}' = proposal_id::text
      AND proposal_document #>> '{basis_revision}' = basis_revision::text
      AND proposal_document #>> '{proposed_by,plugin_id}' = plugin_id
      AND proposal_document #>> '{proposed_by,operation_id}' = operation_id
      AND proposal_document #>> '{proposed_by,request_id}' = request_id::text
      AND proposal_document #>> '{deterministic_context_id}'
        = deterministic_context_id::text
      AND proposal_document #>> '{deterministic_context_digest}'
        = deterministic_context_digest
      AND response_document #> '{output,proposal}' = proposal_document
    )
  )
);

CREATE INDEX rule_plugin_invocations_world_revision_index
  ON luoxia_engine.rule_plugin_invocations (world_id, basis_revision);

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

CREATE TABLE luoxia_engine.day_cycle_execution_identities (
  execution_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  day bigint NOT NULL,
  execution_kind text NOT NULL,
  subject_id uuid,
  created_at timestamptz NOT NULL,
  CONSTRAINT day_cycle_execution_identities_world_foreign_key
    FOREIGN KEY (world_id)
    REFERENCES luoxia_engine.worlds(world_id),
  CONSTRAINT day_cycle_execution_identities_scope_unique
    UNIQUE NULLS NOT DISTINCT (
      world_id,
      day,
      execution_kind,
      subject_id
    ),
  CONSTRAINT day_cycle_execution_identities_day_safe CHECK (
    day >= 1 AND day <= 9007199254740991
  ),
  CONSTRAINT day_cycle_execution_identities_kind_closed CHECK (
    execution_kind IN (
      'transition.autonomous_to_director',
      'transition.director_to_player',
      'transition.player_to_autonomous',
      'state_machine.advance',
      'character.react',
      'automatic_event.resolve'
    )
  ),
  CONSTRAINT day_cycle_execution_identities_subject_shape CHECK (
    (
      execution_kind IN (
        'state_machine.advance',
        'character.react',
        'automatic_event.resolve'
      )
      AND subject_id IS NOT NULL
    )
    OR
    (
      execution_kind IN (
        'transition.autonomous_to_director',
        'transition.director_to_player',
        'transition.player_to_autonomous'
      )
      AND subject_id IS NULL
    )
  )
);

CREATE TABLE luoxia_engine.player_day_end_runs (
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  world_id uuid NOT NULL,
  from_day bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, command_id),
  CONSTRAINT player_day_end_runs_command_foreign_key
    FOREIGN KEY (session_id, command_id)
    REFERENCES luoxia_engine.command_journal(session_id, command_id),
  CONSTRAINT player_day_end_runs_world_foreign_key
    FOREIGN KEY (world_id)
    REFERENCES luoxia_engine.worlds(world_id),
  CONSTRAINT player_day_end_runs_world_day_unique
    UNIQUE (world_id, from_day),
  CONSTRAINT player_day_end_runs_day_safe CHECK (
    from_day >= 1 AND from_day < 9007199254740991
  )
);

COMMIT;
