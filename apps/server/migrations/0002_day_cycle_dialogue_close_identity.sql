-- Explicit upgrade for databases created from 0001 before dialogue.close
-- day-cycle execution identities. Engine does not run migrations; apply once
-- with psql against the target database after confirming the prior CHECK shape.
-- Fresh installs use 0001_atomic_packet_store.sql only (already includes this kind).

BEGIN;

ALTER TABLE luoxia_engine.day_cycle_execution_identities
  DROP CONSTRAINT day_cycle_execution_identities_kind_closed;

ALTER TABLE luoxia_engine.day_cycle_execution_identities
  DROP CONSTRAINT day_cycle_execution_identities_subject_shape;

ALTER TABLE luoxia_engine.day_cycle_execution_identities
  ADD CONSTRAINT day_cycle_execution_identities_kind_closed CHECK (
    execution_kind IN (
      'transition.autonomous_to_director',
      'transition.director_to_player',
      'transition.player_to_autonomous',
      'dialogue.close',
      'state_machine.advance',
      'character.react',
      'automatic_event.resolve'
    )
  );

ALTER TABLE luoxia_engine.day_cycle_execution_identities
  ADD CONSTRAINT day_cycle_execution_identities_subject_shape CHECK (
    (
      execution_kind IN (
        'dialogue.close',
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
  );

COMMIT;
