import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type SaveEnvelopeDocument,
} from "@luoxia/contracts-runtime";
import type { Pool } from "pg";

import type { RuntimeSaveRepository } from "../../application/runtime-persistence.js";
import { assertSaveEnvelopeRelationships } from "../../application/runtime-save.js";
import {
  parseSafeUnsignedInteger,
  requireAtMostOne,
  requireExactlyOne,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresRuntimeSaveRepositoryDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

interface SaveWorldRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
  readonly world_content_lock_document: unknown;
  readonly save_schema_version: string;
  readonly engine_contract_version: string;
  readonly dependency_bundle_locks_document: unknown;
  readonly rule_plugin_locks_document: unknown;
  readonly stage_module_locks_document: unknown;
  readonly event_cursor_text: string;
  readonly event_log_floor_revision_text: string;
  readonly asset_hashes_document: unknown;
  readonly migration_history_document: unknown;
  readonly updated_at: Date | string;
}

export function createPostgresRuntimeSaveRepository(
  dependencies: PostgresRuntimeSaveRepositoryDependencies,
): RuntimeSaveRepository {
  return new PostgresRuntimeSaveRepository(dependencies);
}

class PostgresRuntimeSaveRepository implements RuntimeSaveRepository {
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;

  public constructor(
    dependencies: PostgresRuntimeSaveRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
  }

  public async exportCandidate(worldId: string): Promise<unknown> {
    this.#contracts.assert(CONTRACT_REF.uuid, worldId);
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      async (client) => {
        const query = await client.query<SaveWorldRow>(
          `${selectSaveWorldColumns()}
             FROM luoxia_engine.worlds
            WHERE world_id = $1::uuid`,
          [worldId],
        );
        const row = requireAtMostOne(
          query.rows,
          "runtime.save.database_corrupt",
          "Save export world lookup returned more than one row",
          { world_id: worldId },
        );
        if (row === undefined) {
          throw new EngineFault(
            "runtime.save.world_missing",
            "Cannot export a world that does not exist",
            { world_id: worldId },
          );
        }
        if (row.world_id !== worldId) {
          throw new EngineFault(
            "runtime.save.database_corrupt",
            "Save export row identity differs from the requested world",
            { world_id: worldId, row_world_id: row.world_id },
          );
        }
        return assembleSaveEnvelope(this.#contracts, row).value;
      },
    );
  }

  public async insert(
    envelope: SaveEnvelopeDocument,
    persistedAt: string,
  ): Promise<unknown> {
    const validated = this.#contracts.assertObject(
      CONTRACT_REF.saveEnvelope,
      envelope.value,
    );
    assertSaveEnvelopeRelationships(this.#contracts, validated);
    const value = validated.value;
    const worldId = expectString(value, "world_id", "SaveEnvelope");
    const worldRevision = expectInteger(
      value,
      "world_revision",
      "SaveEnvelope",
    );
    const eventCursor = expectInteger(
      value,
      "event_cursor",
      "SaveEnvelope",
    );
    const timestamp = canonicalTimestamp(persistedAt);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const inserted = await client.query<SaveWorldRow>(
            `INSERT INTO luoxia_engine.worlds (
               world_id,
               revision,
               state_document,
               world_content_lock_document,
               save_schema_version,
               engine_contract_version,
               dependency_bundle_locks_document,
               rule_plugin_locks_document,
               stage_module_locks_document,
               event_cursor,
               event_log_floor_revision,
               asset_hashes_document,
               migration_history_document,
               updated_at
             ) VALUES (
               $1::uuid,
               $2::bigint,
               $3::jsonb,
               $4::jsonb,
               $5::text,
               $6::text,
               $7::jsonb,
               $8::jsonb,
               $9::jsonb,
               $10::bigint,
               $11::bigint,
               $12::jsonb,
               $13::jsonb,
               $14::timestamptz
             )
             RETURNING
               world_id::text AS world_id,
               revision::text AS revision_text,
               state_document,
               world_content_lock_document,
               save_schema_version,
               engine_contract_version,
               dependency_bundle_locks_document,
               rule_plugin_locks_document,
               stage_module_locks_document,
               event_cursor::text AS event_cursor_text,
               event_log_floor_revision::text
                 AS event_log_floor_revision_text,
               asset_hashes_document,
               migration_history_document,
               updated_at`,
            [
              worldId,
              worldRevision.toString(),
              JSON.stringify(
                expectProperty(value, "world_state", "SaveEnvelope"),
              ),
              JSON.stringify(
                expectProperty(
                  value,
                  "world_content_lock",
                  "SaveEnvelope",
                ),
              ),
              expectString(
                value,
                "save_schema_version",
                "SaveEnvelope",
              ),
              expectString(
                value,
                "engine_contract_version",
                "SaveEnvelope",
              ),
              JSON.stringify(
                expectProperty(
                  value,
                  "dependency_bundle_locks",
                  "SaveEnvelope",
                ),
              ),
              JSON.stringify(
                expectProperty(
                  value,
                  "rule_plugin_locks",
                  "SaveEnvelope",
                ),
              ),
              JSON.stringify(
                expectProperty(
                  value,
                  "stage_module_locks",
                  "SaveEnvelope",
                ),
              ),
              eventCursor.toString(),
              eventCursor.toString(),
              JSON.stringify(
                expectProperty(value, "asset_hashes", "SaveEnvelope"),
              ),
              JSON.stringify(
                expectProperty(
                  value,
                  "migration_history",
                  "SaveEnvelope",
                ),
              ),
              timestamp,
            ],
          );
          const row = requireExactlyOne(
            inserted.rows,
            "runtime.save.database_corrupt",
            "SaveEnvelope insert did not return exactly one world row",
            { world_id: worldId },
          );
          const stored = assembleSaveEnvelope(this.#contracts, row);
          if (
            !jsonEquals(stored.value, validated.value) ||
            formatDatabaseTimestamp(row.updated_at) !== timestamp
          ) {
            throw new EngineFault(
              "runtime.save.database_corrupt",
              "Inserted world row does not exactly reassemble the authorized SaveEnvelope",
              { world_id: worldId },
            );
          }
          return stored.value;
        },
      );
    } catch (error: unknown) {
      if (postgresErrorCode(error) === "23505") {
        throw new EngineFault(
          "runtime.save.world_conflict",
          "Save import cannot overwrite an existing world",
          { world_id: worldId },
        );
      }
      throw error;
    }
  }
}

function assembleSaveEnvelope(
  contracts: ContractValidator,
  row: SaveWorldRow,
): SaveEnvelopeDocument {
  const revision = parseSafeUnsignedInteger(
    row.revision_text,
    "runtime.save.database_corrupt",
    "Save world revision",
    { world_id: row.world_id, revision: row.revision_text },
  );
  const eventCursor = parseSafeUnsignedInteger(
    row.event_cursor_text,
    "runtime.save.database_corrupt",
    "Save event cursor",
    { world_id: row.world_id, event_cursor: row.event_cursor_text },
  );
  const eventHistoryFloor = parseSafeUnsignedInteger(
    row.event_log_floor_revision_text,
    "runtime.save.database_corrupt",
    "Save event history floor",
    {
      world_id: row.world_id,
      event_log_floor_revision: row.event_log_floor_revision_text,
    },
  );
  if (eventCursor !== revision || eventHistoryFloor > eventCursor) {
    throw new EngineFault(
      "runtime.save.database_corrupt",
      "PostgreSQL save cursor relationships are invalid",
      {
        world_id: row.world_id,
        world_revision: revision,
        event_cursor: eventCursor,
        event_log_floor_revision: eventHistoryFloor,
      },
    );
  }

  const envelope = contracts.assertObject(CONTRACT_REF.saveEnvelope, {
    contract_version: "world-runtime.v1",
    record_type: "save.envelope",
    save_schema_version: row.save_schema_version,
    world_id: row.world_id,
    world_revision: revision,
    engine_contract_version: row.engine_contract_version,
    world_content_lock: row.world_content_lock_document,
    dependency_bundle_locks: row.dependency_bundle_locks_document,
    rule_plugin_locks: row.rule_plugin_locks_document,
    stage_module_locks: row.stage_module_locks_document,
    world_state: row.state_document,
    event_cursor: eventCursor,
    asset_hashes: row.asset_hashes_document,
    migration_history: row.migration_history_document,
  });
  assertSaveEnvelopeRelationships(contracts, envelope);
  return envelope;
}

function selectSaveWorldColumns(): string {
  return `SELECT world_id::text AS world_id,
                 revision::text AS revision_text,
                 state_document,
                 world_content_lock_document,
                 save_schema_version,
                 engine_contract_version,
                 dependency_bundle_locks_document,
                 rule_plugin_locks_document,
                 stage_module_locks_document,
                 event_cursor::text AS event_cursor_text,
                 event_log_floor_revision::text
                   AS event_log_floor_revision_text,
                 asset_hashes_document,
                 migration_history_document,
                 updated_at`;
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new EngineFault(
      "runtime.save.timestamp_invalid",
      "Save persistence timestamp must be a canonical UTC ISO-8601 instant",
      { persisted_at: value },
    );
  }
  return value;
}

function formatDatabaseTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new EngineFault(
      "runtime.save.database_corrupt",
      "PostgreSQL returned an invalid save updated_at timestamp",
    );
  }
  return date.toISOString();
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
