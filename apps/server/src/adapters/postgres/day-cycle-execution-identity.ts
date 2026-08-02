import {
  EngineFault,
  type ContractValidator,
} from "@luoxia/contracts-runtime";
import type { Pool } from "pg";

import type {
  DayCycleExecutionIdentityFactory,
  DayCycleExecutionIdentityJournal,
  DayCycleExecutionKind,
} from "../../application/day-cycle-execution-identity.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  requireAtMostOne,
  withPostgresClient,
} from "./persistence-support.js";

const EXECUTION_KINDS = Object.freeze([
  "transition.autonomous_to_director",
  "transition.director_to_player",
  "transition.player_to_autonomous",
  "dialogue.close",
  "state_machine.advance",
  "character.react",
  "automatic_event.resolve",
] as const satisfies readonly DayCycleExecutionKind[]);

const SUBJECT_EXECUTION_KINDS = new Set<DayCycleExecutionKind>([
  "dialogue.close",
  "state_machine.advance",
  "character.react",
  "automatic_event.resolve",
]);

export interface PostgresDayCycleExecutionIdentityDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly idFactory: DayCycleExecutionIdentityFactory;
}

interface IdentityRow {
  readonly execution_id: string;
  readonly world_id: string;
  readonly day_text: string;
  readonly execution_kind: string;
  readonly subject_id: string | null;
}

export function createPostgresDayCycleExecutionIdentityJournal(
  dependencies: PostgresDayCycleExecutionIdentityDependencies,
): DayCycleExecutionIdentityJournal {
  return Object.freeze({
    reserve(input: {
      readonly worldId: string;
      readonly day: number;
      readonly executionKind: DayCycleExecutionKind;
      readonly subjectId?: string;
    }): Promise<string> {
      return reserveIdentity(dependencies, input);
    },
  });
}

async function reserveIdentity(
  dependencies: PostgresDayCycleExecutionIdentityDependencies,
  input: {
    readonly worldId: string;
    readonly day: number;
    readonly executionKind: DayCycleExecutionKind;
    readonly subjectId?: string;
  },
): Promise<string> {
  const worldId = assertUuid(dependencies.contracts, input.worldId);
  assertSafeUnsignedInteger(
    input.day,
    "day_cycle.identity.day_invalid",
    "day",
    { world_id: worldId, day: input.day },
  );
  if (input.day < 1) {
    throw new EngineFault(
      "day_cycle.identity.day_invalid",
      "Day-cycle execution day must be positive",
      { world_id: worldId, day: input.day },
    );
  }
  if (!EXECUTION_KINDS.includes(input.executionKind)) {
    throw new EngineFault(
      "day_cycle.identity.kind_invalid",
      "Unknown day-cycle execution identity kind",
      { execution_kind: input.executionKind },
    );
  }
  const subjectRequired = SUBJECT_EXECUTION_KINDS.has(input.executionKind);
  if (subjectRequired !== (input.subjectId !== undefined)) {
    throw new EngineFault(
      "day_cycle.identity.subject_shape",
      "Day-cycle execution subject identity does not match its kind",
      {
        execution_kind: input.executionKind,
        subject_id: input.subjectId ?? null,
      },
    );
  }
  const subjectId =
    input.subjectId === undefined
      ? null
      : assertUuid(dependencies.contracts, input.subjectId);
  const generatedId = assertUuid(
    dependencies.contracts,
    dependencies.idFactory.createId(),
  );
  if (generatedId !== generatedId.toLowerCase()) {
    throw new EngineFault(
      "day_cycle.identity.generated_noncanonical",
      "Server-generated day-cycle execution UUID must be lowercase canonical text",
      { execution_id: generatedId },
    );
  }

  try {
    return await withPostgresClient(dependencies.pool, async (client) => {
      const insert = await client.query<{ readonly execution_id: string }>(
        `INSERT INTO luoxia_engine.day_cycle_execution_identities (
           execution_id,
           world_id,
           day,
           execution_kind,
           subject_id,
           created_at
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::bigint,
           $4,
           $5::uuid,
           clock_timestamp()
         )
         ON CONFLICT ON CONSTRAINT
           day_cycle_execution_identities_scope_unique
         DO NOTHING
         RETURNING execution_id::text AS execution_id`,
        [
          generatedId,
          worldId,
          input.day.toString(),
          input.executionKind,
          subjectId,
        ],
      );
      if (insert.rowCount === 1) {
        const insertedId = insert.rows[0]?.execution_id;
        if (insertedId === undefined) {
          throw new EngineFault(
            "day_cycle.identity.database_corrupt",
            "Day-cycle identity INSERT returned no execution UUID",
            {
              world_id: worldId,
              day: input.day,
              execution_kind: input.executionKind,
            },
          );
        }
        return assertUuid(
          dependencies.contracts,
          insertedId,
        );
      }

      const query = await client.query<IdentityRow>(
        `SELECT execution_id::text AS execution_id,
                world_id::text AS world_id,
                day::text AS day_text,
                execution_kind,
                subject_id::text AS subject_id
           FROM luoxia_engine.day_cycle_execution_identities
          WHERE world_id = $1::uuid
            AND day = $2::bigint
            AND execution_kind = $3
            AND subject_id IS NOT DISTINCT FROM $4::uuid`,
        [worldId, input.day.toString(), input.executionKind, subjectId],
      );
      const row = requireAtMostOne(
        query.rows,
        "day_cycle.identity.database_corrupt",
        "Day-cycle execution scope lookup returned more than one identity",
        {
          world_id: worldId,
          day: input.day,
          execution_kind: input.executionKind,
          subject_id: subjectId,
        },
      );
      if (
        row === undefined ||
        row.world_id !== worldId ||
        row.day_text !== input.day.toString() ||
        row.execution_kind !== input.executionKind ||
        row.subject_id !== subjectId
      ) {
        throw new EngineFault(
          "day_cycle.identity.database_corrupt",
          "Day-cycle execution identity could not be recovered exactly",
          {
            world_id: worldId,
            day: input.day,
            execution_kind: input.executionKind,
            subject_id: subjectId,
          },
        );
      }
      return assertUuid(dependencies.contracts, row.execution_id);
    });
  } catch (error: unknown) {
    if (error instanceof EngineFault) {
      throw error;
    }
    throw new EngineFault(
      "day_cycle.identity.database_failure",
      "PostgreSQL rejected the day-cycle execution identity reservation",
      {
        world_id: worldId,
        day: input.day,
        execution_kind: input.executionKind,
        subject_id: subjectId,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
