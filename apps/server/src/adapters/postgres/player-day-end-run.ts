import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";
import type { Pool, PoolClient } from "pg";

import type { StoredReceivedCommand } from "../../application/command-journal.js";
import type {
  PlayerDayEndRun,
  PlayerDayEndRunJournal,
} from "../../application/player-day-end-run.js";
import {
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresPlayerDayEndRunJournalDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

interface RunRow {
  readonly session_id: string;
  readonly command_id: string;
  readonly world_id: string;
  readonly from_day_text: string;
}

interface LockedWorldRow {
  readonly revision_text: string;
  readonly state_document: unknown;
}

/**
 * Owns only `(session_id, command_id) → from_day` while the accepted world
 * revision is still current. Per-dialogue `dialogue.close` request identities
 * for this command are reserved through
 * `DayCycleExecutionIdentityJournal` (`dialogue.close` + dialogue subject),
 * matching `day_cycle.advance` crash recovery — not stored on this row.
 */
export function createPostgresPlayerDayEndRunJournal(
  dependencies: PostgresPlayerDayEndRunJournalDependencies,
): PlayerDayEndRunJournal {
  return Object.freeze({
    prepare(command: StoredReceivedCommand): Promise<PlayerDayEndRun> {
      return prepareRun(dependencies, command);
    },
  });
}

async function prepareRun(
  dependencies: PostgresPlayerDayEndRunJournalDependencies,
  command: StoredReceivedCommand,
): Promise<PlayerDayEndRun> {
  if (command.commandKind !== "player_day.end") {
    throw new EngineFault(
      "player_day.run.command_kind_invalid",
      "Player-day run accepts only player_day.end commands",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
        command_kind: command.commandKind,
      },
    );
  }
  const sessionId = assertUuid(
    dependencies.contracts,
    command.session.sessionId,
  );
  const commandId = assertUuid(dependencies.contracts, command.commandId);
  const worldId = assertUuid(dependencies.contracts, command.session.worldId);

  try {
    return await withPostgresTransaction(
      dependencies.pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const existing = await readRun(
          client,
          dependencies.contracts,
          sessionId,
          commandId,
          "FOR UPDATE",
        );
        if (existing !== undefined) {
          assertRunMatchesCommand(existing, command);
          return existing;
        }

        const commandQuery = await client.query<{
          readonly command_status: string;
          readonly command_kind: string;
          readonly accepted_world_id: string;
          readonly accepted_world_revision_text: string;
        }>(
          `SELECT command_status,
                  command_kind,
                  accepted_world_id::text AS accepted_world_id,
                  accepted_world_revision::text
                    AS accepted_world_revision_text
             FROM luoxia_engine.command_journal
            WHERE session_id = $1::uuid
              AND command_id = $2::uuid
            FOR UPDATE`,
          [sessionId, commandId],
        );
        const commandRow = requireAtMostOne(
          commandQuery.rows,
          "player_day.run.database_corrupt",
          "Player-day Command Journal lookup returned more than one row",
          { session_id: sessionId, command_id: commandId },
        );
        if (
          commandRow === undefined ||
          commandRow.command_status !== "received" ||
          commandRow.command_kind !== "player_day.end" ||
          commandRow.accepted_world_id !== worldId ||
          commandRow.accepted_world_revision_text !==
            command.session.worldRevision.toString()
        ) {
          throw new EngineFault(
            "player_day.run.command_boundary_conflict",
            "Player-day command no longer owns its accepted Command Journal boundary",
            { session_id: sessionId, command_id: commandId },
          );
        }

        const worldQuery = await client.query<LockedWorldRow>(
          `SELECT revision::text AS revision_text,
                  state_document
             FROM luoxia_engine.worlds
            WHERE world_id = $1::uuid
            FOR SHARE`,
          [worldId],
        );
        const worldRow = requireAtMostOne(
          worldQuery.rows,
          "player_day.run.database_corrupt",
          "Player-day world lookup returned more than one row",
          { world_id: worldId },
        );
        if (
          worldRow === undefined ||
          worldRow.revision_text !== command.session.worldRevision.toString()
        ) {
          throw new EngineFault(
            "player_day.run.world_boundary_conflict",
            "Player-day source identity must be persisted before the world changes",
            {
              world_id: worldId,
              accepted_world_revision: command.session.worldRevision,
              current_world_revision: worldRow?.revision_text ?? null,
            },
          );
        }
        const worldState = dependencies.contracts.assertObject(
          CONTRACT_REF.worldState,
          worldRow.state_document,
        ).value;
        const dayCycle = expectJsonObject(
          expectProperty(worldState, "day_cycle", "WorldState"),
          "WorldState.day_cycle",
        );
        const phase = expectString(dayCycle, "phase", "DayCycleState");
        if (phase !== "player") {
          throw new EngineFault(
            "player_day.run.phase_invalid",
            "player_day.end can be prepared only during player phase",
            { world_id: worldId, phase },
          );
        }
        const fromDay = expectInteger(dayCycle, "day", "DayCycleState");
        const insert = await client.query(
          `INSERT INTO luoxia_engine.player_day_end_runs (
             session_id,
             command_id,
             world_id,
             from_day,
             created_at
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4::bigint,
             clock_timestamp()
           )
           ON CONFLICT DO NOTHING`,
          [sessionId, commandId, worldId, fromDay.toString()],
        );
        if (insert.rowCount !== 1) {
          const raced = await readRun(
            client,
            dependencies.contracts,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          if (raced === undefined) {
            throw new EngineFault(
              "player_day.run.identity_conflict",
              "Player-day source identity conflicts with another command",
              {
                session_id: sessionId,
                command_id: commandId,
                world_id: worldId,
                from_day: fromDay,
              },
            );
          }
          assertRunMatchesCommand(raced, command);
          return raced;
        }
        const stored = await readRun(
          client,
          dependencies.contracts,
          sessionId,
          commandId,
          "FOR UPDATE",
        );
        if (stored === undefined) {
          throw new EngineFault(
            "player_day.run.database_corrupt",
            "Inserted player-day source identity could not be read back",
            { session_id: sessionId, command_id: commandId },
          );
        }
        return stored;
      },
    );
  } catch (error: unknown) {
    if (error instanceof EngineFault) {
      throw error;
    }
    throw new EngineFault(
      "player_day.run.database_failure",
      "PostgreSQL rejected player-day source identity preparation",
      {
        session_id: sessionId,
        command_id: commandId,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function readRun(
  client: PoolClient,
  contracts: ContractValidator,
  sessionId: string,
  commandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<PlayerDayEndRun | undefined> {
  const query = await client.query<RunRow>(
    `SELECT session_id::text AS session_id,
            command_id::text AS command_id,
            world_id::text AS world_id,
            from_day::text AS from_day_text
       FROM luoxia_engine.player_day_end_runs
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      ${lockClause}`,
    [sessionId, commandId],
  );
  const row = requireAtMostOne(
    query.rows,
    "player_day.run.database_corrupt",
    "Player-day run lookup returned more than one row",
    { session_id: sessionId, command_id: commandId },
  );
  if (row === undefined) {
    return undefined;
  }
  return Object.freeze({
    sessionId: assertUuid(contracts, row.session_id),
    commandId: assertUuid(contracts, row.command_id),
    worldId: assertUuid(contracts, row.world_id),
    fromDay: parseSafeUnsignedInteger(
      row.from_day_text,
      "player_day.run.database_corrupt",
      "Player-day source day",
      { session_id: sessionId, command_id: commandId },
    ),
  });
}

function assertRunMatchesCommand(
  run: PlayerDayEndRun,
  command: StoredReceivedCommand,
): void {
  if (
    run.sessionId !== command.session.sessionId ||
    run.commandId !== command.commandId ||
    run.worldId !== command.session.worldId ||
    run.fromDay < 1
  ) {
    throw new EngineFault(
      "player_day.run.identity_conflict",
      "Persisted player-day source identity differs from its command",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
      },
    );
  }
}
